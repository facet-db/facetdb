export type { InstalledTable } from "./catalog.ts";
export {
  type MigrateOptions,
  type MigratePlan,
  type MigrateResult,
  type MigrateSource,
  migrate,
} from "./migrate.ts";
export {
  type DroppedColumn,
  type ForeignGrant,
  type PruneCatalog,
  type PruneOptions,
  type PruneResult,
  prune,
  prunedColumns,
  pruneSql,
} from "./prune.ts";
export {
  ENQUEUE_ROLE,
  type InstallStatement,
  installOwnedColumns,
  installSql,
  ownedColumnsQuery,
  PASSWORD_SETTING,
  type ProjectRef,
  queueKeyPrefix,
  renderSql,
  type TableSource,
  triggerName,
  WORKER_ROLE,
} from "./sql.ts";
export {
  type LogOnlyPurge,
  type OtherSourceLog,
  type OtherTable,
  type ProjectKeptBy,
  type SourceLog,
  type TableName,
  type TableRemoval,
  type UninstallOptions,
  type UninstallPlan,
  type UninstallResult,
  type UninstallSource,
  type UninstallTarget,
  uninstall,
  uninstallSql,
} from "./uninstall.ts";
