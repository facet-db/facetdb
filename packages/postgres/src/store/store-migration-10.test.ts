import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlQuery } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";

/**
 * Store migration 10: one partial index on the outbox's batched rows, which the digest rule reads
 * by batch key and time. PGlite proves the index, that a version-9 store's rows stay, and that its
 * text run again over its own index takes no lock.
 */

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

/** Migration 10's statements as the install prints them: between version 9's row and its own. */
function migration10(): string[] {
  const statements = storeInstallStatements();
  return statements.slice(statements.indexOf(recorded(9)) + 1, statements.indexOf(recorded(10)));
}

/** A store as migration 9 left it: the released text up to and including version 9's row. */
async function version9Store(): Promise<void> {
  const statements = storeInstallStatements();
  await world.client.transaction(async (query) => {
    for (const statement of statements.slice(0, statements.indexOf(recorded(9)) + 1)) {
      await query(statement);
    }
  });
}

async function outboxIndexes(): Promise<unknown> {
  return world.client.query(
    `select indexname, indexdef from pg_indexes
      where schemaname = 'facetdb' and tablename = 'webhook_outbox' order by 1`,
  );
}

const BATCH_INDEX = {
  indexname: "webhook_outbox_batch",
  indexdef:
    "CREATE INDEX webhook_outbox_batch ON facetdb.webhook_outbox USING btree (project_id, batch_key, created_at, id) WHERE (batch_key IS NOT NULL)",
};

describe("store migration 10", () => {
  it("indexes a version-9 store's batched rows, keeping every row as it was", async () => {
    await version9Store();
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, batch_key)
       values ('p', '{}', 1000, 1000, 'p:issues', '42', '@facetdb/slack', 'notify', 0, '["issues",0,"slack:#ops"]'),
              ('p', '{}', 1100, 1100, 'p:issues', '43', '@facetdb/github', 'label', 1, null)`,
    );
    const before = await world.client.query(`select * from facetdb.webhook_outbox order by id`);
    expect(await outboxIndexes()).not.toContainEqual(BATCH_INDEX);

    expect(await migrateStore(world.client)).toEqual([]);

    expect(SCHEMA_VERSION).toBe(10);
    expect(await storeVersion(world.client.query)).toEqual({
      kind: "found",
      newest: 10,
      current: true,
    });
    expect(await outboxIndexes()).toContainEqual(BATCH_INDEX);
    expect(await world.client.query(`select * from facetdb.webhook_outbox order by id`)).toEqual(
      before,
    );
  });

  it("changes nothing and takes no lock on the outbox when it runs again over its own index", async () => {
    await version9Store();
    await migrateStore(world.client);
    const before = await outboxIndexes();

    const held = await world.client.transaction(async (query: SqlQuery) => {
      for (const statement of migration10()) {
        await query(statement);
      }
      const rows = await query(
        `select mode from pg_catalog.pg_locks
          where pid = pg_backend_pid() and relation = to_regclass('facetdb.webhook_outbox')`,
      );
      return rows.map((row) => String(row["mode"]));
    });
    expect(held).toEqual([]);
    expect(migration10()).toHaveLength(1);
    expect(migration10()[0]).toMatch(/^do \$\$\nbegin\n {2}if /);

    await world.client.query(`delete from facetdb.store_migrations where version = 10`);
    expect(await migrateStore(world.client)).toEqual([]);
    expect(await outboxIndexes()).toEqual(before);
  });
});
