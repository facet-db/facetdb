// The catalog's reads, shared with the runtime connector and doctor, which read the same views
// under the worker login; the queries themselves for the scripted catalog of the tests.
export {
  AZURE_SQL_DATABASE,
  AZURE_SQL_MANAGED_INSTANCE,
  type CatalogColumn,
  type CatalogObject,
  COLUMNS_QUERY,
  columnType,
  DATABASE_WORKER_QUERY,
  GRANTS_QUERY,
  KEY_QUERY,
  OBJECTS_QUERY,
  OWNER_QUERY,
  QUEUE_USERS_QUERY,
  ROLES_QUERY,
  readColumns,
  readGrants,
  readKey,
  readMarker,
  readObjects,
  readServer,
  SERVER_QUERY,
  type ServerFacts,
  sharedObject,
  sideTableOf,
  TABLE_FACTS_QUERY,
  type TableFacts,
  viewOf,
  WORKER_QUERY,
  type WorkerGrant,
} from "./catalog.ts";
// Change Tracking as the capture: the plan's reads, refusals and statements, the mark the runtime
// connector and doctor read.
export {
  databaseTrackingStatement,
  MARK_QUERY,
  MIN_RETENTION_MINUTES,
  markOf,
  readMark,
  readTracking,
  STATE_HASH,
  STATE_HASH_TYPE,
  TRACKING_ENABLED,
  TRACKING_FOUND,
  TRACKING_QUERY,
  type TrackingFacts,
  type TrackingMark,
  trackedColumns,
  trackedTablesQuery,
  versionText,
} from "./change-tracking.ts";
export { containedUsers, LOGIN_NOTE, planInstall, REMAP_NOTE, SIDE_RIGHTS } from "./install.ts";
export { createInstaller, type MssqlInstaller } from "./installer.ts";
export { anotherProject, markerQuery, SCRIPT_ERROR, SCRIPT_PREFIX } from "./marker.ts";
export {
  COLUMN_MARK,
  CREATION_COLUMN,
  DEFAULT_SCHEMA,
  JOBS_TABLE,
  MARKER_TABLE,
  type OwnedColumn,
  ownedColumns,
  QUEUE_KEY_COLLATION,
  QUEUE_KEY_LENGTH,
  QUEUE_NAME_LENGTH,
  SHARED_SCHEMA,
  sideTableName,
  type TableNames,
  tableNames,
  triggerName,
  viewName,
  WORKER_USER,
} from "./objects.ts";
export {
  type DroppedColumn,
  droppedColumns,
  KEPT_REASON,
  keptColumns,
  planPrune,
} from "./prune.ts";
export { keyText, keyTextLength } from "./queue.ts";
export { ONE_TRANSACTION, render } from "./render.ts";
export { runPlan } from "./run.ts";
export {
  answerColumnsOf,
  BOUND_TO_VIEW_QUERY,
  sameView,
  sideKeyType,
  viewText,
} from "./side-table.ts";
export { type Storage, sameTrigger, triggerText } from "./trigger.ts";
export { planUninstall, ranNote, WORKER_KEPT } from "./uninstall.ts";
