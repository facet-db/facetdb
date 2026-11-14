/**
 * @facetdb/sql-polling: the polling connector for any SQL database, a state hash read through the
 * standard driver behind a dialect: Postgres where triggers are forbidden (its dialect lives in
 * `@facetdb/postgres`), CockroachDB through postgres, Oracle through oracledb in thin mode.
 */

/**
 * How the CLI names this engine (`DatabaseEngine.name`); a source on a SQL database picks it with
 * `connector: "polling"`.
 */
export const ENGINE_NAME = "polling";

/**
 * The variables naming the test servers its `*.db.test.ts` run on, one per dialect it is proven on
 * (`scripts/test-databases.sh` prints them).
 */
export const URL_VARIABLES = ["COCKROACH_URL", "ORACLE_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];

// The connector the engine opens, moved from @facetdb/postgres.
export * from "./connector/index.ts";
// What a database must say to be polled: its SQL text and its catalog reads.
export * from "./dialect/index.ts";
// The engine the CLI calls for `connector: "polling"` and for the SQL databases polled by default.
export * from "./engine/index.ts";
// What a polling install adds and how a table is read: the marks, the columns, the statements.
export * from "./install/index.ts";
