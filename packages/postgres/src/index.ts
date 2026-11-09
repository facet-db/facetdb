/**
 * @facetdb/postgres: the Postgres connector (trigger and jobs table, LISTEN/NOTIFY, skip locked),
 * the polling connector and the FacetDB store. Everything FacetDB adds to a customer's database
 * lives in this schema or under this prefix, so `facetdb uninstall` can find all of it.
 */
export const FACETDB_SCHEMA = "facetdb";
export const FACETDB_PREFIX = "facetdb_";
