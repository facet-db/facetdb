import type { PGlite } from "@electric-sql/pglite";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { SqlClient } from "../sql/index.ts";
import { freshPglite, resetPglite } from "../testing/index.ts";
import { createStore, type Store } from "./store.ts";

/**
 * The world the store tests share (store.test.ts and store-queue.test.ts, split by subject so no
 * file passes 10 s): one PGlite per test file, emptied after every test, and the stores made
 * over it, closed before the reset. Each file calls `useStoreWorld()` once at its top.
 */

export const SECRET = "a-long-random-secret-for-tests-only";

/** A fake clock whose sleep lets the event loop turn, so a watch loop cannot starve the database. */
export class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** The test file's engine: booted once, emptied after every test (a boot per test cost 440 ms). */
let shared: PGlite;
const stores: Store[] = [];

/** Boots the file's engine before its first test, empties it after each, and closes it at the end. */
export function useStoreWorld(): void {
  beforeAll(async () => {
    shared = await freshPglite();
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.close();
    }
    await resetPglite(shared);
  });

  afterAll(async () => {
    await shared.close();
  });
}

/** Closes a store a test made by hand after the test, before the engine is reset. */
export function closeAfterTest(store: Store): void {
  stores.push(store);
}

/** The file's engine, emptied by the previous test's reset. */
export async function newDb(): Promise<PGlite> {
  return shared;
}

/** A store over `db` (the file's engine by default), closed after the test. */
export async function newStore(
  db?: PGlite,
  clock: FakeClock = new TurningClock(1_700_000_000_000),
  secret: string | undefined = SECRET,
): Promise<{ store: Store; db: PGlite; clock: FakeClock }> {
  const pglite = db ?? (await newDb());
  const store = await createStore({ pglite, secret, clock });
  closeAfterTest(store);
  return { store, db: pglite, clock };
}

/**
 * Takes migration 10 back off a migrated store (the outbox's batch index), with its version row,
 * for a test building an older store; store-migration-10.test.ts proves it alone.
 */
export async function takeBackMigration10(client: SqlClient): Promise<void> {
  await client.query(`drop index facetdb.webhook_outbox_batch`);
  await client.query(`delete from facetdb.store_migrations where version = 10`);
}

/**
 * Takes migration 9's objects back off a migrated store (the outbox's action columns, check and
 * index, `worker_heartbeats`, the `'plugin-source'` kind), for a test building an older store;
 * store-migration-9.test.ts proves the migration on its own. Migration 10, built on its columns,
 * goes first, with its version row; the caller deletes the version rows up to 9.
 */
export async function takeBackMigration9(client: SqlClient): Promise<void> {
  await takeBackMigration10(client);
  await client.query(`drop table facetdb.worker_heartbeats`);
  await client.query(`drop index facetdb.webhook_outbox_action`);
  await client.query(
    `alter table facetdb.webhook_outbox drop constraint webhook_outbox_endpoint_or_plugin,
       drop column source_id, drop column record_key, drop column plugin, drop column action,
       drop column position, drop column batch_key, drop column superseded_at,
       alter column endpoint set not null`,
  );
  await client.query(
    `alter table facetdb.sources drop constraint sources_kind_allowed,
       add constraint sources_kind_check check (kind in ('plugin', 'api'))`,
  );
}

export async function scalar(db: PGlite, sql: string): Promise<unknown> {
  const { rows } = await db.query<Record<string, unknown>>(sql);
  return Object.values(rows[0] ?? {})[0];
}
