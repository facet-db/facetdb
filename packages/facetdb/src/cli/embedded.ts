import { mkdir, rm } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Clock, DatabaseEngine } from "@facetdb/core";
import {
  createPostgresEngine,
  createStore,
  pgliteClient,
  type SqlClient,
  type SqlConnect,
  WORKER_ROLE,
} from "@facetdb/postgres";
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
  /**
   * The Postgres engine over that client: dev installs and opens its table sources with it. An
   * address whose user is the worker login runs as that role (`asWorkerRole`); no address is judged
   * for TLS (`offline`).
   */
  readonly engine: DatabaseEngine;
};

/**
 * The embedded database is one superuser session (PGlite has no logins), while on a server the
 * worker's string logs in as `facetdb_worker`: a connection on an address whose user is the worker
 * login runs each statement as that role (`set local role`, inside one transaction with it), so the
 * doctor's login check reads as it does on a server and the connector writes under the install's
 * grants (the reload starts a source the setup installed on the doctor's word). `pipeline` and
 * `listen` stay the session's: a queued key and a notification are the same under either role.
 */
function asWorkerRole(client: SqlClient): SqlClient {
  const become = `set local role ${WORKER_ROLE}`;
  return {
    ...client,
    query: (text, params) =>
      client.transaction(async (query) => {
        await query(become);
        return query(text, params);
      }),
    transaction: (work) =>
      client.transaction(async (query) => {
        await query(become);
        return work(query);
      }),
  };
}

/** The user an address logs in as, decoded; undefined for a string that is no URL. */
function userOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return undefined;
  }
}

/**
 * No network reaches the embedded database, and its client ignores every address, so there is no
 * host to judge a connection string by: every call is made as on this machine, whatever the caller
 * knows of the address (the studio's doors judge an admin string as remote until told otherwise).
 */
function offline(engine: DatabaseEngine): DatabaseEngine {
  const trusted = <Options extends { readonly allowInsecure: boolean }>(
    options: Options,
  ): Options => ({
    ...options,
    allowInsecure: true,
  });
  const { inspect, readRows, estimateRows } = engine;
  return {
    ...engine,
    planInstall: (target, url, options) => engine.planInstall(target, url, trusted(options)),
    planUninstall: (target, url, options) => engine.planUninstall(target, url, trusted(options)),
    planPrune: (target, url, deps) => engine.planPrune(target, url, trusted(deps)),
    run: (target, plan, url, options) => engine.run(target, plan, url, trusted(options)),
    checkUrl: () => undefined,
    open: (target, url, options) => engine.open(target, url, trusted(options)),
    doctor: (target, url, deps) => engine.doctor(target, url, trusted(deps)),
    ...(inspect === undefined ? {} : { inspect: (url, options) => inspect(url, trusted(options)) }),
    ...(readRows === undefined
      ? {}
      : { readRows: (target, url, options) => readRows(target, url, trusted(options)) }),
    ...(estimateRows === undefined
      ? {}
      : { estimateRows: (target, url, deps) => estimateRows(target, url, trusted(deps)) }),
  };
}

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
  const worker = asWorkerRole(client);
  const connect: SqlConnect = (url) => (userOf(url) === WORKER_ROLE ? worker : client);
  // No network reaches it, so there is no PGHOST to judge a URL by.
  return {
    store,
    client,
    engine: offline(createPostgresEngine({ connect, pgHost: undefined })),
  };
}
