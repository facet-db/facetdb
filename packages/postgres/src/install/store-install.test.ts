import type { QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlClient, SqlConnect } from "../sql/index.ts";
import {
  createStore,
  SCHEMA_VERSION,
  STORE_SEQUENCES,
  STORE_TABLES,
  STORE_VERSION_TABLE,
  StoreNotInstalledError,
} from "../store/index.ts";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "../testing/index.ts";
import { migrate } from "./migrate.ts";

/**
 * The store's tables are made by `facetdb migrate` with the admin credential, so the worker login
 * creates nothing (found on Supabase, 2026-11-01). PGlite runs as a superuser and cannot show the
 * refusal a least-privilege login gets, so these tests prove the shape (the tables, the version
 * rows, no DDL at a current store) and `install.db.test.ts` proves the rights on a real Postgres.
 */

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const worlds: PgliteWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close();
  }
});

async function installed(): Promise<PgliteWorld> {
  const world = await createPgliteWorld();
  worlds.push(world);
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
      expect(byTable.get(table)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }
    expect(byTable.get(STORE_VERSION_TABLE)).toEqual(["SELECT"]);
    expect(byTable.has("table_owners")).toBe(false);
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
    const world = await createPgliteWorld();
    worlds.push(world);
    const store = await createStore({
      url: "postgres://admin@localhost/store",
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
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(StoreNotInstalledError);
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/listings",
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(/facetdb migrate/);
    } finally {
      await world.client.query(`reset role`);
    }
  });

  it("a store at version 1 (installed before the outbox moved in) names its version, and migrate brings it to 2", async () => {
    // The state every install made before this migration is in (the Supabase project of the
    // example among them): the worker login says how far behind it is and what to run; the
    // admin's second `facetdb migrate` adds the outbox and the worker's rights on it.
    const world = await installed();
    await world.client.query(`delete from facetdb.store_migrations where version = 2`);
    await world.client.query(`drop table facetdb.webhook_outbox`);
    await world.client.query(`create role plain_login login`);
    await world.client.query(`grant usage on schema facetdb to plain_login`);
    await world.client.query(`grant select on facetdb.store_migrations to plain_login`);
    await world.client.query(`set role plain_login`);
    try {
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/listings",
          connect: () => world.client,
          secret: TEST_SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(/at schema version 1, behind this FacetDB \(2\).*facetdb migrate/);
    } finally {
      await world.client.query(`reset role`);
    }
    await install(world);
    expect(
      await world.client.query(
        `select version::int as version from facetdb.store_migrations order by 1`,
      ),
    ).toEqual([{ version: 1 }, { version: 2 }]);
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
