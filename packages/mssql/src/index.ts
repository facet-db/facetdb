/**
 * @facetdb/mssql: FacetDB on SQL Server 2016 and later and Azure SQL through tedious.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mssql";

/**
 * The variable naming the test server its `*.db.test.ts` run on (`scripts/test-databases.sh`
 * prints it).
 */
export const URL_VARIABLES = ["MSSQL_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];
