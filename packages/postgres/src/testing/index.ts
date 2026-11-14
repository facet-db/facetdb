import type { PGlite } from "@electric-sql/pglite";
import type { Clock } from "@facetdb/core";
import { createStore, type Store } from "../store/index.ts";

export {
  createPgliteWorld,
  freshPglite,
  type PgliteWorld,
  resetPglite,
  resetPgliteWorld,
} from "./pglite.ts";
export { createScratchDatabase, type ScratchDatabase, serverUrl } from "./postgres.ts";

/** The secret every test store is made with; it protects nothing. */
export const TEST_SECRET = "a-long-random-secret-for-tests-only";

/** The engine type, for tests of packages that use PGlite through these helpers only (the server). */
export type { PGlite } from "@electric-sql/pglite";

/**
 * The real FacetDB store over the test file's in-memory PGlite, for tests of packages that use the
 * store but do not depend on PGlite themselves (the check API). The file boots the engine once
 * (`freshPglite` in `beforeAll`) and resets it after each test; `close` lets go of the store
 * and leaves the engine to the file.
 */
export async function createMemoryStore(
  clock: Clock,
  pglite: PGlite,
): Promise<{ readonly store: Store; close(): Promise<void> }> {
  const store = await createStore({ pglite, secret: TEST_SECRET, clock });
  return { store, close: () => store.close() };
}
