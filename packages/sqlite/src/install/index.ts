// The install, uninstall and prune plans, their script and their run on a file, and their run
// through a client (a libSQL server).
export {
  readInstalled,
  readTable,
  type SqliteQuery,
  type SqliteRow,
  type SqliteValue,
  sameName,
  sqliteQuery,
  type TableFacts,
  textOf,
} from "./catalog.ts";
export { keyOf, NO_USERS, ONE_WORKER, planInstall, WAL_NOTE } from "./install.ts";
// FacetDB's columns a table rebuild copied without their marks.
export {
  absentColumns,
  applicationColumns,
  type LostMarks,
  lostMarks,
  UNMARKED_KEPT,
  unmarkedCopies,
  unmarkedNamesakes,
} from "./marks.ts";
export { NOTHING } from "./plan.ts";
export { KEPT_REASON, planPrune } from "./prune.ts";
export {
  BUSY_TIMEOUT_MS,
  type OpenDatabase,
  openSource,
  type RunClient,
  type RunStatements,
  render,
  run,
  runThrough,
} from "./run.ts";
export {
  beforeTransaction,
  COLUMN_MARK,
  GUARDED_SCRIPT,
  guardOf,
  guardsInMain,
  JOBS_TABLE,
  JOURNAL_MODE,
  OWNERS_TABLE,
  triggerNames,
} from "./sql.ts";
export { planUninstall, type SqliteUninstallOptions, WAL_KEPT } from "./uninstall.ts";
