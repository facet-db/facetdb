/**
 * @facetdb/postgres: the Postgres connector (trigger and jobs table, LISTEN/NOTIFY, skip locked),
 * the Postgres dialect of the polling connector (`@facetdb/sql-polling`) and the FacetDB
 * store. Everything FacetDB adds to a customer's database lives in this schema or under this
 * prefix, so `facetdb uninstall` can find all of it.
 */
export const FACETDB_SCHEMA = "facetdb";
export const FACETDB_PREFIX = "facetdb_";

export * from "./capture/index.ts";
// The engine the CLI calls: plans, render, run, open, doctor (DatabaseEngine).
export * from "./engine/index.ts";
export * from "./install/index.ts";
export * from "./polling/index.ts";
export * from "./scan/index.ts";
// The driver, for the composition roots that wire it (the facetdb CLI) and the tests that fake it.
export {
  connectPostgres,
  DEFAULT_MAX_CONNECTIONS,
  // How long FacetDB's scripts wait for a lock: the CLI's words name it.
  LOCK_TIMEOUT,
  pgliteClient,
  type SqlClient,
  type SqlConnect,
  type SqlConnectOptions,
  type SqlQuery,
  type SqlRow,
  // What a script locks, read from its statements: the store door lists its step's.
  scriptLocks,
  unlistenAll,
} from "./sql/index.ts";
export * from "./store/index.ts";
