/**
 * @facetdb/postgres: the Postgres connector (trigger and jobs table, LISTEN/NOTIFY, skip locked),
 * the polling connector and the FacetDB store. Everything FacetDB adds to a customer's database
 * lives in this schema or under this prefix, so `facetdb uninstall` can find all of it.
 */
export const FACETDB_SCHEMA = "facetdb";
export const FACETDB_PREFIX = "facetdb_";

export * from "./capture/index.ts";
export * from "./install/index.ts";
export * from "./polling/index.ts";
export * from "./scan/index.ts";
// The driver, for the composition roots that wire it (the facetdb CLI) and the tests that fake it.
export {
  connectPostgres,
  DEFAULT_MAX_CONNECTIONS,
  type SqlClient,
  type SqlConnect,
  type SqlConnectOptions,
  type SqlQuery,
  type SqlRow,
} from "./sql/index.ts";
export * from "./store/index.ts";
