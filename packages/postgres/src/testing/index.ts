import { PGlite } from "@electric-sql/pglite";
import type { Clock } from "@facetdb/core";
import { createStore, type Store } from "../store/index.ts";

/** The secret every test store is made with; it protects nothing. */
export const TEST_SECRET = "a-long-random-secret-for-tests-only";

/**
 * The real FacetDB store over an in-memory PGlite, for tests of packages that use the store but do
 * not depend on PGlite themselves (the check API). `close` also closes the PGlite the store leaves open.
 */
export async function createMemoryStore(
  clock: Clock,
): Promise<{ readonly store: Store; close(): Promise<void> }> {
  const pglite = new PGlite();
  const store = await createStore({ pglite, secret: TEST_SECRET, clock });
  return {
    store,
    async close() {
      await store.close();
      await pglite.close();
    },
  };
}
