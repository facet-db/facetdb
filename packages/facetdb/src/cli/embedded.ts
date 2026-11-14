import { mkdir, rm } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Clock, DatabaseEngine } from "@facetdb/core";
import { createPostgresEngine, createStore, pgliteClient, type SqlClient } from "@facetdb/postgres";
import type { EmbeddedDatabase, EmbeddedDatabases, OpenStore } from "./program.ts";

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

/** What `facetdb dev` runs on, made over its embedded database (its store for every engine). */
export type EmbeddedParts = {
  /** The FacetDB store, in the embedded database: a PGlite store is `facetdb dev`'s alone. */
  readonly store: OpenStore;
  /** The one client every connection of the embedded database is: PGlite is one connection. */
  readonly client: SqlClient;
  /** The Postgres engine over that client: dev installs and opens its table sources with it. */
  readonly engine: DatabaseEngine;
};

/**
 * The store and the engine over an embedded database, wired here so the `dev` command reaches the
 * database through them alone, as the other commands reach theirs through main.ts. The caller
 * closes the store; the database stays its opener's.
 */
export async function embeddedParts(
  database: EmbeddedDatabase,
  options: { readonly secret: string; readonly clock: Clock },
): Promise<EmbeddedParts> {
  const client = pgliteClient(database.pglite);
  const store = await createStore({
    pglite: database.pglite,
    secret: options.secret,
    clock: options.clock,
  });
  // No network reaches it, so there is no PGHOST to judge a URL by.
  return {
    store,
    client,
    engine: createPostgresEngine({ connect: () => client, pgHost: undefined }),
  };
}
