import type { QuestionSet } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installSql, migrate } from "../install/index.ts";
import type { SqlQuery } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";

/**
 * Store migration 9: the outbox widened so a row carries a plugin's action, one heartbeat row per
 * worker, and the `'plugin-source'` kind. One migration, so the features that use them never race
 * for a version number. PGlite proves the shape, that a version-8 store's rows stay, the worker
 * login's rights as the install grants them, and that the migration's text run again takes no lock;
 * the rights a real login holds are the store's real-Postgres suites'.
 */

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** One engine for the file, emptied after every test. */
let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

const recorded = (version: number) =>
  `insert into facetdb.store_migrations (version) values (${version}) on conflict (version) do nothing`;

/** Migration 9's statements as the install prints them: between version 8's row and its own. */
function migration9(): string[] {
  const statements = storeInstallStatements();
  return statements.slice(statements.indexOf(recorded(8)) + 1, statements.indexOf(recorded(9)));
}

/** A store as migration 8 left it: the released text up to and including version 8's row. */
async function version8Store(): Promise<void> {
  const statements = storeInstallStatements();
  await world.client.transaction(async (query) => {
    for (const statement of statements.slice(0, statements.indexOf(recorded(8)) + 1)) {
      await query(statement);
    }
  });
}

/** Everything a rerun could change: the three tables' columns, constraints and indexes, the rows. */
async function catalog(): Promise<unknown> {
  const tables = ["webhook_outbox", "worker_heartbeats", "sources", "heartbeats"];
  return {
    columns: await world.client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'facetdb' and table_name = any($1) order by 1, ordinal_position`,
      [tables],
    ),
    constraints: await world.client.query(
      `select conrelid::regclass::text as on_table, conname, pg_get_constraintdef(oid) as def
         from pg_constraint where connamespace = 'facetdb'::regnamespace
          and conrelid::regclass::text = any($1) order by 1, 2`,
      [tables.map((table) => `facetdb.${table}`)],
    ),
    indexes: await world.client.query(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'facetdb' and tablename = any($1) order by 1`,
      [tables],
    ),
    versions: await world.client.query(`select version from facetdb.store_migrations order by 1`),
    outbox: await world.client.query(`select * from facetdb.webhook_outbox order by id`),
    heartbeats: await world.client.query(`select * from facetdb.heartbeats order by project`),
    sources: await world.client.query(`select id, kind from facetdb.sources order by id`),
  };
}

/** The modes this session holds on `relation`, inside the transaction `query` runs in. */
async function heldOn(query: SqlQuery, relation: string): Promise<readonly string[]> {
  const rows = await query(
    `select mode from pg_catalog.pg_locks
      where pid = pg_backend_pid() and relation = to_regclass($1) order by mode`,
    [relation],
  );
  return rows.map((row) => String(row["mode"]));
}

const OUTBOX_COLUMNS =
  "id, project_id, endpoint, payload, attempts, created_at, next_attempt_at, delivered_at, gave_up_at, last_error, claimed_by";

describe("store migration 9", () => {
  it("migrates a version-8 store holding webhooks and a heartbeat, keeping every row as it was", async () => {
    await version8Store();
    expect(await storeVersion(world.client.query)).toEqual({
      kind: "found",
      newest: 8,
      current: false,
    });
    expect(
      await world.client.query(`select to_regclass('facetdb.worker_heartbeats') as present`),
    ).toEqual([{ present: null }]);
    // A version-8 outbox: one webhook pending under a claim, one delivered, one given up.
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, attempts, created_at, next_attempt_at, delivered_at, gave_up_at, last_error, claimed_by)
       values ('p', 'https://hooks.example/a', '{"n":1}', 1, 1000, 2000, null, null, 'timeout', 'w1'),
              ('p', 'https://hooks.example/b', '{"n":2}', 0, 1100, 1100, 1200, null, null, null),
              ('q', 'https://hooks.example/c', '{"n":3}', 9, 1300, 9000, null, 9100, '503', null)`,
    );
    await world.client.query(`insert into facetdb.heartbeats (project, at) values ('p', 1500)`);
    const outboxBefore = await world.client.query(
      `select ${OUTBOX_COLUMNS} from facetdb.webhook_outbox order by id`,
    );

    expect(await migrateStore(world.client)).toEqual([]);

    expect(await storeVersion(world.client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    expect(
      await world.client.query(
        `select version::int as version from facetdb.store_migrations where version = 9`,
      ),
    ).toEqual([{ version: 9 }]);
    // The rows read back unchanged, the new columns null on every one of them.
    expect(
      await world.client.query(`select ${OUTBOX_COLUMNS} from facetdb.webhook_outbox order by id`),
    ).toEqual(outboxBefore);
    expect(
      await world.client.query(
        `select count(*)::int as n from facetdb.webhook_outbox
          where source_id is null and record_key is null and plugin is null and action is null
            and position is null and batch_key is null and superseded_at is null`,
      ),
    ).toEqual([{ n: 3 }]);
    expect(
      await world.client.query(`select project, at::int as at from facetdb.heartbeats`),
    ).toEqual([{ project: "p", at: 1500 }]);

    const shape = await catalog();
    expect(shape).toMatchObject({
      columns: expect.arrayContaining(
        [
          ["webhook_outbox", "endpoint", "text", "YES"],
          ["webhook_outbox", "source_id", "text", "YES"],
          ["webhook_outbox", "record_key", "text", "YES"],
          ["webhook_outbox", "plugin", "text", "YES"],
          ["webhook_outbox", "action", "text", "YES"],
          ["webhook_outbox", "position", "integer", "YES"],
          ["webhook_outbox", "batch_key", "text", "YES"],
          ["webhook_outbox", "superseded_at", "bigint", "YES"],
          ["worker_heartbeats", "project", "text", "NO"],
          ["worker_heartbeats", "worker", "text", "NO"],
          ["worker_heartbeats", "at", "bigint", "NO"],
        ].map(([table_name, column_name, data_type, is_nullable]) =>
          expect.objectContaining({ table_name, column_name, data_type, is_nullable }),
        ),
      ),
      constraints: expect.arrayContaining([
        {
          on_table: "facetdb.webhook_outbox",
          conname: "webhook_outbox_endpoint_or_plugin",
          def: "CHECK (((endpoint IS NOT NULL) OR (plugin IS NOT NULL)))",
        },
        {
          on_table: "facetdb.worker_heartbeats",
          conname: "worker_heartbeats_pkey",
          def: "PRIMARY KEY (project, worker)",
        },
        {
          on_table: "facetdb.sources",
          conname: "sources_kind_allowed",
          def: "CHECK ((kind = ANY (ARRAY['plugin'::text, 'plugin-source'::text, 'api'::text])))",
        },
      ]),
      indexes: expect.arrayContaining([
        {
          indexname: "webhook_outbox_action",
          indexdef:
            'CREATE INDEX webhook_outbox_action ON facetdb.webhook_outbox USING btree (project_id, source_id, record_key, plugin, action, "position", id) WHERE (plugin IS NOT NULL)',
        },
      ]),
    });
    // The project's heartbeat table is untouched: still one row per project.
    expect(
      await world.client.query(
        `select column_name from information_schema.columns
          where table_schema = 'facetdb' and table_name = 'heartbeats' order by ordinal_position`,
      ),
    ).toEqual([{ column_name: "project" }, { column_name: "at" }]);
    // The old kind check is gone, not doubled: one check on the kind.
    expect(
      await world.client.query(
        `select conname from pg_constraint
          where conrelid = 'facetdb.sources'::regclass and contype = 'c' order by 1`,
      ),
    ).toEqual([{ conname: "sources_kind_allowed" }]);
  });

  it("takes a plugin's action with no endpoint, refuses a row with neither, and accepts a plugin source", async () => {
    await version8Store();
    await migrateStore(world.client);

    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, batch_key)
       values ('p', '{}', 1000, 1000, 'p:issues', '42', 'github', 'label', 0, 'p:issues:github:label')`,
    );
    expect(
      await world.client.query(
        `select endpoint, plugin, action, position, superseded_at from facetdb.webhook_outbox`,
      ),
    ).toEqual([
      { endpoint: null, plugin: "github", action: "label", position: 0, superseded_at: null },
    ]);
    await expect(
      world.client.query(
        `insert into facetdb.webhook_outbox (project_id, payload, created_at, next_attempt_at)
         values ('p', '{}', 1000, 1000)`,
      ),
    ).rejects.toThrow(/webhook_outbox_endpoint_or_plugin/);

    await world.client.query(`insert into facetdb.projects (id, name) values ('p', 'P')`);
    await world.client.query(
      `insert into facetdb.sources (id, project_id, name, kind)
       values ('p:listings', 'p', 'listings', 'plugin'), ('p:checks', 'p', 'checks', 'api'),
              ('p:issues', 'p', 'issues', 'plugin-source')`,
    );
    expect(await world.client.query(`select id, kind from facetdb.sources order by id`)).toEqual([
      { id: "p:checks", kind: "api" },
      { id: "p:issues", kind: "plugin-source" },
      { id: "p:listings", kind: "plugin" },
    ]);
    await expect(
      world.client.query(
        `insert into facetdb.sources (id, project_id, name, kind) values ('p:x', 'p', 'x', 'table')`,
      ),
    ).rejects.toThrow(/sources_kind_allowed/);

    // One heartbeat row per worker of a project, refreshed in place.
    await world.client.query(
      `insert into facetdb.worker_heartbeats (project, worker, at) values ('p', 'w1', 1000), ('p', 'w2', 1000)`,
    );
    await world.client.query(
      `insert into facetdb.worker_heartbeats (project, worker, at) values ('p', 'w1', 2000)
       on conflict (project, worker) do update set at = excluded.at`,
    );
    expect(
      await world.client.query(
        `select worker, at::int as at from facetdb.worker_heartbeats order by worker`,
      ),
    ).toEqual([
      { worker: "w1", at: 2000 },
      { worker: "w2", at: 1000 },
    ]);
  });

  it("gives the worker login row access to worker_heartbeats through the install, and nothing new elsewhere", async () => {
    await world.client.query(
      `create table public.listings (id serial primary key, title text, description text)`,
    );
    await version8Store();
    // `facetdb migrate` on the version-8 store: migration 9 and the worker's grants in one run.
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
    expect(await storeVersion(world.client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });

    const rights = async () =>
      new Map(
        (
          await world.client.query(
            `select table_name, array_agg(privilege_type order by privilege_type) as privileges
               from information_schema.table_privileges
              where table_schema = 'facetdb' and grantee = 'facetdb_worker' group by 1 order by 1`,
          )
        ).map((row) => [String(row["table_name"]), row["privileges"]]),
      );
    const granted = await rights();
    expect(granted.get("worker_heartbeats")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    // The outbox and the sources keep the rights they had: rows of the outbox, rows of the sources.
    expect(granted.get("webhook_outbox")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(granted.get("sources")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(granted.get("heartbeats")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    // No DDL for the worker: no create on the schema, no ownership of the new table.
    expect(
      await world.client.query(
        `select has_schema_privilege('facetdb_worker', 'facetdb', 'create') as may_create,
                pg_get_userbyid(relowner) = 'facetdb_worker' as owns
           from pg_class where oid = 'facetdb.worker_heartbeats'::regclass`,
      ),
    ).toEqual([{ may_create: false, owns: false }]);

    // A second run of the install changes nothing: the same catalog, the same rights.
    const before = await catalog();
    const again = await migrate({
      adminUrl: "postgres://admin@unused/listings",
      connect: world.connect,
      print: () => undefined,
      plan: {
        source: { table: "listings" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
      },
    });
    expect(again).toMatchObject({ ok: true });
    expect(await catalog()).toEqual(before);
    expect(await rights()).toEqual(granted);
  });

  it("changes nothing and takes no lock when it runs again over its own objects", async () => {
    await version8Store();
    await migrateStore(world.client);
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ('p', 'https://hooks.example/a', '{}', 1000, 1000)`,
    );
    await world.client.query(
      `insert into facetdb.worker_heartbeats (project, worker, at) values ('p', 'w1', 1000)`,
    );
    const before = await catalog();

    // Migration 9's own text again, inside one transaction: every object it would make is there, so
    // it locks none of the tables it would alter (sql/ddl.ts).
    const held = await world.client.transaction(async (query) => {
      for (const statement of migration9()) {
        await query(statement);
      }
      return {
        outbox: await heldOn(query, "facetdb.webhook_outbox"),
        sources: await heldOn(query, "facetdb.sources"),
        workerHeartbeats: await heldOn(query, "facetdb.worker_heartbeats"),
      };
    });
    expect(held).toEqual({ outbox: [], sources: [], workerHeartbeats: [] });
    expect(await catalog()).toEqual(before);

    // The printed install script, twice, and migration 9 run again with its row lost.
    for (let pass = 0; pass < 2; pass += 1) {
      await world.client.transaction(async (query) => {
        for (const statement of storeInstallStatements()) {
          await query(statement);
        }
      });
    }
    expect(await catalog()).toEqual(before);
    await world.client.query(`delete from facetdb.store_migrations where version = 9`);
    expect(await migrateStore(world.client)).toEqual([]);
    expect(await catalog()).toEqual(before);
  });

  it("is looked up before every statement, and the install prints it under the store's part", () => {
    const statements = migration9();
    expect(statements).toHaveLength(12);
    for (const statement of statements) {
      // Each statement is a `do` block that reads the catalog first; none trusts Postgres's own
      // `if not exists`, which locks first and looks second.
      expect(statement).toMatch(/^do \$\$\nbegin\n {2}if /);
      expect(statement).not.toMatch(
        /(create|add)( column| table| index| constraint)? if not exists/,
      );
    }
    const script = installSql({ table: "listings", key: "id" }, listings, {
      id: "proj_listings",
      name: "Listings",
    });
    for (const text of statements) {
      expect(
        script
          .filter((statement) => statement.text === text)
          .map((statement) => statement.database),
      ).toEqual(["store"]);
    }
    // The worker's one new grant, the store's too.
    expect(
      script
        .filter((statement) => statement.text.includes(`"facetdb"."worker_heartbeats"`))
        .map((statement) => [statement.text, statement.database]),
    ).toEqual([
      [
        'grant select, insert, update, delete on "facetdb"."worker_heartbeats" to "facetdb_worker"',
        "store",
      ],
    ]);
  });
});
