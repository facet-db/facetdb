import type { PGlite } from "@electric-sql/pglite";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll } from "vitest";
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

export async function scalar(db: PGlite, sql: string): Promise<unknown> {
  const { rows } = await db.query<Record<string, unknown>>(sql);
  return Object.values(rows[0] ?? {})[0];
}
