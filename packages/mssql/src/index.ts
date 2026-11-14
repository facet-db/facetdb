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

// The install, uninstall and prune plans, their script and their run.
export * from "./install/index.ts";
// The driver, for the composition root that wires it and the tests that fake it.
export * from "./sql/index.ts";
