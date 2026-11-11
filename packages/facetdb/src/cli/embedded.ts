import { mkdir, rm } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { EmbeddedDatabases } from "./program.ts";

/**
 * The embedded Postgres of `facetdb dev` on the real disk: PGlite with its data directory under the
 * project (`.facetdb/dev/`), so what the worker wrote is still there on the next run.
 */
export const diskEmbedded: EmbeddedDatabases = {
  async open(dir) {
    await mkdir(dir, { recursive: true });
    const pglite = new PGlite(dir);
    await pglite.waitReady;
    return { pglite, close: () => pglite.close() };
  },
  wipe: (dir) => rm(dir, { recursive: true, force: true }),
};
