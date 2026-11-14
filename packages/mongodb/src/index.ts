/**
 * @facetdb/mongodb: FacetDB on MongoDB 4.2 and later and Atlas through the mongodb driver, by
 * change streams, so on a replica set.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mongodb";

/**
 * The variable naming the test server its `*.db.test.ts` run on (`scripts/test-databases.sh`
 * prints it).
 */
export const URL_VARIABLES = ["MONGODB_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];
