/**
 * @facetdb/sqlite: FacetDB on SQLite files through Node's built-in node:sqlite, and on libSQL
 * servers (Turso, sqld) through @libsql/client.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "sqlite";

/**
 * The variable naming the libSQL test server its `*.db.test.ts` run on (`scripts/test-databases.sh`
 * prints it). A SQLite file needs none: node:sqlite opens it in-process.
 */
export const URL_VARIABLES = ["LIBSQL_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];
