/**
 * @facetdb/mongodb: FacetDB on MongoDB and Atlas through the mongodb driver, by change streams, so
 * on a replica set. The pinned driver talks to 4.4 and later only (`SERVER_FLOOR`).
 */

/**
 * The variable naming the test server its `*.db.test.ts` run on (`scripts/test-databases.sh`
 * prints it).
 */
export const URL_VARIABLES = ["MONGODB_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];

// The runtime connector under the worker login: the change stream and the queue.
export * from "./connector/index.ts";
// The engine the CLI registers for mongodb: and mongodb+srv:.
export * from "./engine/index.ts";
// The install, uninstall and prune plans, their mongosh script and their run.
export {
  type AdminClient,
  type AdminConnect,
  connectAdmin,
  JOB_COLLECTION_FIELD,
  JOBS_COLLECTION,
  KEY_TYPES,
  type KeyType,
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
