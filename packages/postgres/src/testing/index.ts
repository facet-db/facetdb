import type { Clock } from "@facetdb/core";
import { createStore, type Store } from "../store/index.ts";
import { freshPglite } from "./pglite.ts";

export { createPgliteWorld, freshPglite, type PgliteWorld } from "./pglite.ts";
export { createScratchDatabase, type ScratchDatabase, serverUrl } from "./postgres.ts";

/** The secret every test store is made with; it protects nothing. */
export const TEST_SECRET = "a-long-random-secret-for-tests-only";

/**
 * The real FacetDB store over an in-memory PGlite, for tests of packages that use the store but do
 * not depend on PGlite themselves (the check API). `close` also closes the PGlite the store leaves open.
 */
export async function createMemoryStore(
  clock: Clock,
): Promise<{ readonly store: Store; close(): Promise<void> }> {
  const pglite = await freshPglite();
  const store = await createStore({ pglite, secret: TEST_SECRET, clock });
  return {
    store,
    async close() {
      await store.close();
      await pglite.close();
    },
  };
}
