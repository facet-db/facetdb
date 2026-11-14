/**
 * @facetdb/mongodb: FacetDB on MongoDB and Atlas through the mongodb driver, by change streams, so
 * on a replica set. The pinned driver talks to 4.4 and later only (`SERVER_FLOOR`).
 */

export {
  type AdminClient,
  type AdminConnect,
  connectAdmin,
  JOB_COLLECTION_FIELD,
  JOBS_COLLECTION,
  META_COLLECTION,
  ownedFields,
  planInstall,
  planPrune,
  planUninstall,
  renderScript,
  runPlan,
  SERVER_FLOOR,
  STATUS_FIELDS,
  SUBDOCUMENT,
  WORKER_USER,
} from "./install/index.ts";

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mongodb";

/**
 * The variable naming the test server its `*.db.test.ts` run on (`scripts/test-databases.sh`
 * prints it).
 */
export const URL_VARIABLES = ["MONGODB_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];
