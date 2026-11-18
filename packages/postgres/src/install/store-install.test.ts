import type { QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient, SqlConnect } from "../sql/index.ts";
import {
  createStore,
  SCHEMA_VERSION,
  STORE_APPEND_ONLY_TABLES,
  STORE_FUNCTIONS,
  STORE_SEQUENCES,
  STORE_TABLES,
  STORE_VERSION_TABLE,
  StoreNotInstalledError,
  sourceIdOf,
} from "../store/index.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  resetPgliteWorld,
  TEST_SECRET,
} from "../testing/index.ts";
import { migrate } from "./migrate.ts";

/**
 * The store's tables are made by `facetdb migrate` with the admin credential, so the worker login
 * creates nothing (found on Supabase). PGlite runs as a superuser and cannot show the refusal a
 * least-privilege login gets, so these tests prove the shape (the tables, the version rows, no DDL
 * at a current store) and `install.db.test.ts` proves the rights on a real Postgres.
 */

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** One engine for the file, emptied after every test: a boot per test cost 440 ms. */
let shared: PgliteWorld;

beforeAll(async () => {
  shared = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(shared);
});

afterAll(async () => {
  await shared.close();
});

async function installed(): Promise<PgliteWorld> {
  const world = shared;
  await world.client.query(
    `create table public.listings (id serial primary key, title text, description text)`,
  );
  await install(world);
  return world;
}

async function install(world: PgliteWorld): Promise<void> {
  const result = await migrate({
    adminUrl: "postgres://admin@unused/listings",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      workerPassword: "a-long-random-password",
    },
  });
  expect(result).toMatchObject({ ok: true });
}

async function names(world: PgliteWorld, kind: "r" | "S"): Promise<string[]> {
  const rows = await world.client.query(
    `select c.relname as name from pg_class c where c.relnamespace = 'facetdb'::regnamespace and c.relkind = $1 order by 1`,
    [kind],
  );
  return rows.map((row) => String(row["name"]));
}

async function facetdbCatalog(world: PgliteWorld): Promise<unknown> {
  return {
    columns: await world.client.query(
      `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'facetdb' order by 1, ordinal_position`,
    ),
    versions: await world.client.query(`select version from facetdb.store_migrations order by 1`),
    grants: await world.client.query(
      `select grantee, table_name, privilege_type from information_schema.table_privileges
        where table_schema = 'facetdb' and grantee = 'facetdb_worker' order by 1, 2, 3`,
    ),
  };
}

/** A connect that hands out the world's database and records every statement text it is given. */
function recording(world: PgliteWorld): { connect: SqlConnect; statements: string[] } {
  const statements: string[] = [];
  const client: SqlClient = {
    query: (text, params) => {
      statements.push(text);
      return world.client.query(text, params);
    },
    transaction: (work) =>
      world.client.transaction((query) =>
        work((text, params) => {
          statements.push(text);
          return query(text, params);
        }),
      ),
    pipeline: (text, paramSets) => {
      statements.push(text);
      return world.client.pipeline(text, paramSets);
    },
    close: async () => undefined,
  };
  return { connect: () => client, statements };
}

describe("the install script and the store", () => {
  it("creates every store table, its sequences and the version row", async () => {
    const world = await installed();
    const tables = await names(world, "r");
    for (const table of [...STORE_TABLES, STORE_VERSION_TABLE]) {
      expect(tables).toContain(table);
    }
    // The list the grants and the uninstall follow is the one the migrations make: nothing else
    // in the schema but the install's own marker table.
    expect(tables.filter((table) => table !== "table_owners").sort()).toEqual(
      [...STORE_TABLES, STORE_VERSION_TABLE].sort(),
    );
    expect((await names(world, "S")).sort()).toEqual([...STORE_SEQUENCES].sort());
    // Every migration is recorded, so a worker start sees a current store and runs no DDL.
    expect(
      await world.client.query(
        `select version::int as version from facetdb.store_migrations order by version`,
      ),
    ).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, n) => ({ version: n + 1 })));
  });

  it("grants the worker row access to the store and the version table read-only", async () => {
    const world = await installed();
    const rows = await world.client.query(
      `select table_name, array_agg(privilege_type order by privilege_type) as privileges
         from information_schema.table_privileges
        where table_schema = 'facetdb' and grantee = 'facetdb_worker' group by 1 order by 1`,
    );
    const byTable = new Map(rows.map((row) => [String(row["table_name"]), row["privileges"]]));
    for (const table of STORE_TABLES) {
      expect(byTable.get(table)).toEqual(
        STORE_APPEND_ONLY_TABLES.includes(table)
          ? ["INSERT", "SELECT"]
          : ["DELETE", "INSERT", "SELECT", "UPDATE"],
      );
    }
    // The append-only logs, by name: the decision log and the question-set versions.
    expect(byTable.get("decisions")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("question_set_versions")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get(STORE_VERSION_TABLE)).toEqual(["SELECT"]);
    expect(byTable.has("table_owners")).toBe(false);
    // The store's function: the worker may call it, and no one else but its owner.
    await world.client.query(`create role someone_else`);
    for (const signature of STORE_FUNCTIONS) {
      expect(
        await world.client.query(
          `select has_function_privilege('facetdb_worker', $1, 'execute') as worker,
                  has_function_privilege('someone_else', $1, 'execute') as other`,
          [signature],
        ),
      ).toEqual([{ worker: true, other: false }]);
    }
  });

  it("an install made with the wider grant on the logs converges on select and insert", async () => {
    // Every earlier install granted update and delete on the decision log and the versions.
    const world = await installed();
    for (const table of STORE_APPEND_ONLY_TABLES) {
      await world.client.query(`grant update, delete on facetdb.${table} to facetdb_worker`);
    }
    await install(world);
    expect(
      await world.client.query(
        `select table_name, array_agg(privilege_type order by privilege_type) as privileges
           from information_schema.table_privileges
          where table_schema = 'facetdb' and grantee = 'facetdb_worker'
            and table_name in ('decisions', 'question_set_versions')
          group by 1 order by 1`,
      ),
    ).toEqual([
      { table_name: "decisions", privileges: ["INSERT", "SELECT"] },
      { table_name: "question_set_versions", privileges: ["INSERT", "SELECT"] },
    ]);
  });

  it("refuses, changing nothing, when the revoke on the logs took nothing back, and says who must run it", async () => {
    const world = await installed();
    // A DBA (not the owner of the store's tables) granted update and delete on the logs: the
    // owner's revoke takes back only the owner's own grants, and Postgres merely warns.
    await world.client.query(`create role store_dba`);
    await world.client.query(`grant usage on schema facetdb to store_dba`);
    await world.client.query(
      `grant update, delete on facetdb.decisions to store_dba with grant option`,
    );
    await world.client.query(`set role store_dba`);
    try {
      await world.client.query(`grant update, delete on facetdb.decisions to facetdb_worker`);
    } finally {
      await world.client.query(`reset role`);
    }
    const before = await facetdbCatalog(world);
    const result = await migrate({
      adminUrl: "postgres://admin@unused/listings",
      connect: world.connect,
      print: () => undefined,
      plan: {
        source: { table: "listings" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
      },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("still holds DELETE on decisions granted by store_dba");
      expect(result.reason).toContain("as the owner of the store's tables");
      expect(result.reason).toContain("nothing was changed");
    }
    expect(await facetdbCatalog(world)).toEqual(before);
    // Once that role takes its grant back, migrate converges.
    await world.client.query(`set role store_dba`);
    try {
      await world.client.query(`revoke update, delete on facetdb.decisions from facetdb_worker`);
    } finally {
      await world.client.query(`reset role`);
    }
    await install(world);
  });

  it("a store at version 2 (before reserve was one statement) is brought up by migrate, with the worker's EXECUTE", async () => {
    const world = await installed();
    await world.client.query(`delete from facetdb.store_migrations where version = 3`);
    await world.client.query(`drop function ${STORE_FUNCTIONS.join(", ")}`);
    await install(world);
    for (const signature of STORE_FUNCTIONS) {
      expect(
        await world.client.query(
          `select has_function_privilege('facetdb_worker', $1, 'execute') as may`,
          [signature],
        ),
      ).toEqual([{ may: true }]);
    }
    expect(
      await world.client.query(`select count(*)::int as n from facetdb.store_migrations`),
    ).toEqual([{ n: SCHEMA_VERSION }]);
  });

  it("a store at version 3 with rows is rekeyed to `<project>:<name>` by migration 4, with a note for a shared log", async () => {
    const world = await installed();
    const q = (sql: string, params: readonly unknown[] = []) => world.client.query(sql, params);
    await q(`delete from facetdb.store_migrations where version = 4`);
    // The old shape: ids are bare names. B's worker found A's `listings` row and wrote under it.
    await q(`insert into facetdb.projects (id, name) values ('proj_a', 'A'), ('proj_b', 'B')`);
    await q(`insert into facetdb.sources (id, project_id, name, kind) values
      ('listings', 'proj_a', 'listings', 'plugin'),
      ('tickets', 'proj_b', 'tickets', 'api'),
      ('😀', 'proj_b', '😀', 'api')`);
    for (const [source, key] of [
      ["listings", "1"],
      ["listings", "1"],
      ["listings", "2"],
      ["tickets", "t1"],
    ]) {
      await q(
        `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
         values ($1, $2, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
        [source, key],
      );
    }
    await q(`insert into facetdb.question_set_versions (source_id, version, content_hash, question_set)
      values ('listings', 1, 'h', '{}'), ('listings', 2, 'h2', '{}'), ('tickets', 1, 'h', '{}')`);
    await q(`insert into facetdb.records (source_id, record_key, state, hash, status) values
      ('tickets', 't1', '{}', 'h', 'pending'), ('tickets', 't2', '{}', 'h', 'pending'),
      ('😀', 'e1', '{}', 'h', 'pending')`);
    // The store queue's keys embed the id, length-prefixed in UTF-16 units (`queuePrefix`); a table
    // source's job (its own key, the store sharing the database) is not the store's. The control
    // job has the old prefix of `listings` exactly (`8:listings:`), and `listings` holds no
    // records, so only the rekey's records gate keeps it as it is (`9:` never matched).
    const prefix = (id: string) => `${id.length}:${id}:`;
    expect(`${prefix("listings")}x`).toBe("8:listings:x");
    await q(`insert into facetdb.jobs (record_key) values ($1), ($2), ($3), ('42'), ($4)`, [
      `${prefix("tickets")}t1`,
      `${prefix("tickets")}t2`,
      `${prefix("😀")}e1`,
      `${prefix("listings")}x`,
    ]);
    await q(`insert into facetdb.cursors (run, cursor, done) values ('all@v1', 'k', false)`);
    const count = async (table: string) =>
      (await q(`select count(*)::int as n from facetdb.${table}`))[0]?.["n"];
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          ["sources", "decisions", "question_set_versions", "records", "jobs", "cursors"].map(
            async (table) => [table, await count(table)] as const,
          ),
        ),
      );
    const before = await counts();

    const store = await createStore({
      url: "postgres://admin@localhost/listings",
      pgHost: undefined,
      connect: () => world.client,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    expect(store.migrationNotes).toEqual([
      `the decision log of source "listings" is now keyed by project proj_a and its name; if project(s) proj_b, proj_listings of this store also ran a source named "listings" before, their rows cannot be told apart from proj_a's and stay in proj_a's log`,
      `the decision log of source "tickets" is now keyed by project proj_b and its name; if project(s) proj_a, proj_listings of this store also ran a source named "tickets" before, their rows cannot be told apart from proj_b's and stay in proj_b's log`,
      `the decision log of source "😀" is now keyed by project proj_b and its name; if project(s) proj_a, proj_listings of this store also ran a source named "😀" before, their rows cannot be told apart from proj_b's and stay in proj_b's log`,
    ]);
    expect(await counts()).toEqual(before);
    const ids = async (table: string, column = "source_id") =>
      (await q(`select distinct ${column} as id from facetdb.${table} order by 1`)).map(
        (row) => row["id"],
      );
    expect(await ids("sources", "id")).toEqual([
      sourceIdOf("proj_a", "listings"),
      sourceIdOf("proj_b", "tickets"),
      sourceIdOf("proj_b", "😀"),
    ]);
    expect(await ids("decisions")).toEqual(["proj_a:listings", "proj_b:tickets"]);
    expect(await ids("question_set_versions")).toEqual(["proj_a:listings", "proj_b:tickets"]);
    expect(await ids("records")).toEqual(["proj_b:tickets", "proj_b:😀"]);
    expect(
      (await q(`select record_key from facetdb.jobs order by 1`)).map((r) => r["record_key"]),
    ).toEqual(
      [
        "14:proj_b:tickets:t1",
        "14:proj_b:tickets:t2",
        `${prefix("proj_b:😀")}e1`,
        "42",
        "8:listings:x",
      ].sort(),
    );
    // Every record's history reads as before, under the new id (what `facetdb explain` prints).
    expect(
      (await store.log(sourceIdOf("proj_a", "listings")).history("1")).map((e) => e.kind),
    ).toEqual(["answer", "answer"]);
    expect(await store.log(sourceIdOf("proj_a", "listings")).history("2")).toHaveLength(1);
    expect(await store.log("listings").history("1")).toEqual([]);
    expect(await q(`select run from facetdb.cursors`)).toEqual([{ run: "all@v1" }]);
    await store.close();

    // A store at 4 runs nothing more: the install script's rekey finds no bare id, and the
    // store opens with no note.
    await install(world);
    expect(await ids("sources", "id")).toEqual(["proj_a:listings", "proj_b:tickets", "proj_b:😀"]);
    const again = await createStore({
      url: "postgres://admin@localhost/listings",
      pgHost: undefined,
      connect: () => world.client,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    expect(again.migrationNotes).toEqual([]);
    await again.close();
  });

  it("migration 4's records gate opens for `listings` once it holds records: its `8:listings:` job is rekeyed to `15:proj_a:listings:`", async () => {
    // The other side of the control job above: the same key, the source now a store source.
    const world = await installed();
    const q = (sql: string, params: readonly unknown[] = []) => world.client.query(sql, params);
    await q(`delete from facetdb.store_migrations where version >= 4`);
    await q(`insert into facetdb.projects (id, name) values ('proj_a', 'A')`);
    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ('listings', 'proj_a', 'listings', 'plugin')`,
    );
    await q(
      `insert into facetdb.records (source_id, record_key, state, hash, status) values ('listings', 'x', '{}', 'h', 'pending')`,
    );
    await q(`insert into facetdb.jobs (record_key) values ('8:listings:x'), ('42')`);
    const store = await createStore({
      url: "postgres://admin@localhost/listings",
      pgHost: undefined,
      connect: () => world.client,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    await store.close();
    expect(
      (await q(`select record_key from facetdb.jobs order by 1`)).map((r) => r["record_key"]),
    ).toEqual(["15:proj_a:listings:x", "42"].sort());
  });

  it("a store at version 4 gets the log's (source_id, id) index from migration 5, once", async () => {
    const world = await installed();
    const q = (sql: string) => world.client.query(sql);
    const index = async () =>
      (
        await q(
          `select indexname, indexdef from pg_indexes where schemaname = 'facetdb' and tablename = 'decisions' and indexname = 'decisions_by_source'`,
        )
      ).map((row) => row["indexdef"]);
    expect(await index()).toEqual([
      "CREATE INDEX decisions_by_source ON facetdb.decisions USING btree (source_id, id)",
    ]);
    // The store as version 4 left it: no index, no row for 5.
    await q(`drop index facetdb.decisions_by_source`);
    await q(`delete from facetdb.store_migrations where version = 5`);
    const store = await createStore({
      url: "postgres://admin@localhost/listings",
      pgHost: undefined,
      connect: () => world.client,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    await store.close();
    expect(await index()).toHaveLength(1);
    expect(await q(`select max(version) as v from facetdb.store_migrations`)).toEqual([
      { v: SCHEMA_VERSION },
    ]);
    expect(SCHEMA_VERSION).toBe(5);
    // Run again, by the install script and by a store opening: nothing changes, nothing fails.
    const before = await facetdbCatalog(world);
    await install(world);
    await install(world);
    expect(await facetdbCatalog(world)).toEqual(before);
    expect(await index()).toHaveLength(1);
    // The export's page reads through it (the planner's choice, with sequential scans priced out).
    await q(`set enable_seqscan = off`);
    try {
      const plan = await q(
        `explain select id from facetdb.decisions where source_id = 'p:s' and id > 0 order by id limit 100`,
      );
      expect(JSON.stringify(plan)).toContain("decisions_by_source");
    } finally {
      await q(`reset enable_seqscan`);
    }
  });

  it("a second run changes nothing", async () => {
    const world = await installed();
    const before = await facetdbCatalog(world);
    await install(world);
    await install(world);
    expect(await facetdbCatalog(world)).toEqual(before);
  });

  it("createStore on the result runs no DDL, and records no migration", async () => {
    const world = await installed();
    const { connect, statements } = recording(world);
    const store = await createStore({
      url: "postgres://facetdb_worker@localhost/listings",
      pgHost: undefined,
      connect,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    try {
      await store.ensureProject({ id: "proj_listings", name: "Listings" });
    } finally {
      await store.close();
    }
    const ddl = statements.filter((text) =>
      /^\s*(create|alter|drop|grant|revoke)\b/i.test(text.trim()),
    );
    expect(ddl).toEqual([]);
    expect(statements.some((text) => text.includes("pg_advisory_xact_lock"))).toBe(false);
  });

  it("createStore still migrates a database the old install left, when the login may", async () => {
    const world = shared;
    const store = await createStore({
      url: "postgres://admin@localhost/store",
      pgHost: undefined,
      connect: () => world.client,
      secret: TEST_SECRET,
      clock: new FakeClock(),
    });
    expect(await names(world, "r")).toContain(STORE_VERSION_TABLE);
    expect(store).toBeDefined();
  });

  it("a login without CREATE on a store that is behind gets the fix, not 'permission denied'", async () => {
    const world = await installed();
    await world.client.query(`delete from facetdb.store_migrations`);
    // PGlite's one connection is a superuser: the privilege check is answered here by the role.
    await world.client.query(`create role plain_login login`);
    await world.client.query(`grant usage on schema facetdb to plain_login`);
    await world.client.query(`grant select on facetdb.store_migrations to plain_login`);
    await world.client.query(`set role plain_login`);
    try {
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/listings",
          pgHost: undefined,
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(StoreNotInstalledError);
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/listings",
          pgHost: undefined,
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(/facetdb migrate/);
    } finally {
      await world.client.query(`reset role`);
    }
  });

  it("a store at version 1 (installed before the outbox moved in) names its version, and migrate brings it up to date", async () => {
    // The state every install made before this migration is in (the Supabase project of the example
    // among them): the worker login says how far behind it is and what to run; the admin's second
    // `facetdb migrate` adds the outbox and the worker's rights on it.
    const world = await installed();
    await world.client.query(`delete from facetdb.store_migrations where version >= 2`);
    await world.client.query(`drop table facetdb.webhook_outbox`);
    await world.client.query(`drop function ${STORE_FUNCTIONS.join(", ")}`);
    await world.client.query(`create role plain_login login`);
    await world.client.query(`grant usage on schema facetdb to plain_login`);
    await world.client.query(`grant select on facetdb.store_migrations to plain_login`);
    await world.client.query(`set role plain_login`);
    try {
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/listings",
          pgHost: undefined,
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(
        new RegExp(
          `at schema version 1, behind this FacetDB \\(${SCHEMA_VERSION}\\).*facetdb migrate`,
        ),
      );
    } finally {
      await world.client.query(`reset role`);
    }
    await install(world);
    expect(
      await world.client.query(
        `select version::int as version from facetdb.store_migrations order by 1`,
      ),
    ).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, n) => ({ version: n + 1 })));
    expect(await names(world, "r")).toContain("webhook_outbox");
    expect(
      await world.client.query(
        `select privilege_type from information_schema.table_privileges
          where table_schema = 'facetdb' and table_name = 'webhook_outbox' and grantee = 'facetdb_worker' order by 1`,
      ),
    ).toEqual([
      { privilege_type: "DELETE" },
      { privilege_type: "INSERT" },
      { privilege_type: "SELECT" },
      { privilege_type: "UPDATE" },
    ]);
    expect(
      await world.client.query(
        `select has_sequence_privilege('facetdb_worker', 'facetdb.webhook_outbox_id_seq', 'usage') as may`,
      ),
    ).toEqual([{ may: true }]);
  });
});
