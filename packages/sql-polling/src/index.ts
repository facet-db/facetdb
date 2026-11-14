/**
 * @facetdb/sql-polling: the polling connector for any SQL database, a state hash read through the
 * standard driver behind a dialect: CockroachDB through postgres, Oracle through oracledb in thin
 * mode.
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
