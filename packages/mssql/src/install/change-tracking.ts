import {
  type EngineTarget,
  type PlanStatement,
  type Refusal,
  STATE_HASH_COLUMN,
  STATUS_COLUMN,
} from "@facetdb/core";
import { type MssqlQuery, type MssqlRow, quoteName, quoteString } from "../sql/index.ts";
import type { CatalogObject, WorkerGrant } from "./catalog.ts";
import {
  MARKER_TABLE,
  type OwnedColumn,
  sourceStatement,
  type TableNames,
  WORKER_USER,
} from "./objects.ts";

/**
 * Change Tracking as a SQL Server table's capture, for a shop that forbids triggers on its tables.
 * The database keeps a version per row change, and with column tracking which columns each change
 * set; the worker reads `changetable(changes …)` every second, keeps the inserts and the updates of
 * a state column, sets those rows pending itself and queues them in the same `facetdb_jobs` the
 * trigger fills, so the claim, the read and the hash-guarded write are the connector's.
 *
 * What install adds beside the columns, queue, marker and worker: tracking on the table, with
 * column tracking, when it is not on yet; `facetdb_state_hash`, the hash of the state each decision
 * was made on, which the worker compares when the database no longer holds the changes since its
 * stored version (the reconcile: the polling connector's memory); the worker's `view change
 * tracking` on the table. Tracking on the database is the admin's to turn on (it serves every table
 * of the database and sizes its own storage), so install refuses until it is on, with the statement
 * to run.
 *
 * Install marks the table with an extended property, as it marks FacetDB's columns: its name says
 * who turned tracking on (`facetdb_tracking_enabled`: this install, so uninstall turns it off;
 * `facetdb_tracking_found`: it was on already, so uninstall leaves it on), its value the version
 * the worker's first start follows changes from, so nothing changed between the install and that
 * start is missed. The mark lives and goes with the table, as tracking does.
 */

/** The SQL Server type of `facetdb_state_hash`: core's `stateHash`, a SHA-256 in hex. */
export const STATE_HASH_TYPE = "varchar(64)";

/** The column a decision's state hash is kept in, as install adds it for this capture. */
export const STATE_HASH: OwnedColumn = { name: STATE_HASH_COLUMN, type: STATE_HASH_TYPE };

/**
 * The shortest retention FacetDB takes: a worker stopped for a weekend still finds every change
 * since its stored version. A shorter one is refused at install, since every outage longer than it
 * costs a read of the whole table (the reconcile).
 */
export const MIN_RETENTION_MINUTES = 2 * 24 * 60;

/** The mark of a table whose tracking this install turned on: uninstall turns it off. */
export const TRACKING_ENABLED = "facetdb_tracking_enabled";

/** The mark of a table whose tracking was on before the install: uninstall leaves it on. */
export const TRACKING_FOUND = "facetdb_tracking_found";

/** What the statement an admin runs to turn tracking on in the database says. */
export function databaseTrackingStatement(database: string): string {
  return `alter database ${quoteName(database)} set change_tracking = on (change_retention = 2 days, auto_cleanup = on)`;
}

/** Every column FacetDB owns on a table this capture watches: the install's, then `facetdb_state_hash`. */
export function trackedColumns(owned: readonly OwnedColumn[]): readonly OwnedColumn[] {
  return [...owned, STATE_HASH];
}

/** Change Tracking as the database and the table are set now, read with the admin credential. */
export type TrackingFacts = {
  /** Tracking on the database; undefined when it is off. */
  readonly database:
    | {
        /** How long a change is kept, in minutes; undefined when the units are not minutes, hours or days. */
        readonly retentionMinutes: number | undefined;
        /** The retention as `sys.change_tracking_databases` says it: `2 DAYS`, `12 HOURS`. */
        readonly retention: string;
      }
    | undefined;
  /** Tracking on the table; undefined when it is off. */
  readonly table: { readonly columnsTracked: boolean } | undefined;
  /** FacetDB's mark on the table, when an install set it. */
  readonly mark: TrackingMark | undefined;
};

/** FacetDB's mark: who turned tracking on, and the version the worker's first start follows from. */
export type TrackingMark = {
  /** True when FacetDB's install turned tracking on (uninstall turns it off). */
  readonly enabled: boolean;
  /** The version, as text: a `bigint` exceeds a JavaScript number. */
  readonly since: string;
};

/** `retention_period_units` of `sys.change_tracking_databases`, in minutes. */
const UNIT_MINUTES: Readonly<Record<number, number>> = { 1: 1, 2: 60, 3: 24 * 60 };

/** How the units read in words. */
const UNIT_WORDS: Readonly<Record<number, string>> = { 1: "minute", 2: "hour", 3: "day" };

/**
 * Tracking on the database and the table, and FacetDB's mark, `@p1` the table as `[schema].[table]`.
 * One row whatever is on: the left joins leave a NULL for what is off.
 */
export const TRACKING_QUERY = `select cast(case when d.database_id is null then 0 else 1 end as bit) as database_on,
       cast(d.retention_period as int) as retention_period,
       cast(d.retention_period_units as int) as retention_units,
       cast(case when t.object_id is null then 0 else 1 end as bit) as table_on,
       cast(coalesce(t.is_track_columns_updated_on, 0) as bit) as columns_on,
       p.name as mark_name,
       convert(nvarchar(20), p.value) as mark_since
  from (select db_id() as id) x
  left join sys.change_tracking_databases d on d.database_id = x.id
  left join sys.change_tracking_tables t on t.object_id = object_id(@p1, N'U')
  left join sys.extended_properties p on p.class = 1 and p.major_id = object_id(@p1, N'U')
        and p.minor_id = 0 and p.name in (${quoteString(TRACKING_ENABLED)}, ${quoteString(TRACKING_FOUND)})`;

function flag(row: MssqlRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean") {
    throw new Error(`the catalog's ${column} is ${String(value)}, not true or false`);
  }
  return value;
}

function wholeOrNull(row: MssqlRow, column: string): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`the catalog's ${column} is ${String(value)}, not a whole number`);
  }
  return value;
}

/** A version as the catalog gives it in text: digits only, or the row is not what it promised. */
export function versionText(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${what} is ${String(value)}, not a Change Tracking version`);
  }
  return value;
}

/** FacetDB's mark as a row carries it in `mark_name` and `mark_since`, or undefined. */
export function markOf(row: MssqlRow): TrackingMark | undefined {
  const name = row["mark_name"];
  if (name === null || name === undefined) {
    return undefined;
  }
  if (name !== TRACKING_ENABLED && name !== TRACKING_FOUND) {
    throw new Error(`the catalog's mark_name is ${String(name)}, not one of FacetDB's marks`);
  }
  return {
    enabled: name === TRACKING_ENABLED,
    since: versionText(row["mark_since"], `the mark ${name}'s value`),
  };
}

/**
 * FacetDB's mark on the table alone, `@p1` the table as `[schema].[table]`: no row when there is
 * none. Uninstall and the worker read it, whatever capture the config names now.
 */
export const MARK_QUERY = `select p.name as mark_name, convert(nvarchar(20), p.value) as mark_since
  from sys.extended_properties p
 where p.class = 1 and p.major_id = object_id(@p1, N'U') and p.minor_id = 0
   and p.name in (${quoteString(TRACKING_ENABLED)}, ${quoteString(TRACKING_FOUND)})`;

export async function readMark(
  query: MssqlQuery,
  names: TableNames,
): Promise<TrackingMark | undefined> {
  const [row] = await query(MARK_QUERY, [names.relation]);
  return row === undefined ? undefined : markOf(row);
}

export async function readTracking(query: MssqlQuery, names: TableNames): Promise<TrackingFacts> {
  const [row] = await query(TRACKING_QUERY, [names.relation]);
  if (row === undefined) {
    throw new Error("the catalog gave no answer about Change Tracking");
  }
  const period = wholeOrNull(row, "retention_period");
  const units = wholeOrNull(row, "retention_units");
  const perUnit = units === null ? undefined : UNIT_MINUTES[units];
  const word = units === null ? undefined : UNIT_WORDS[units];
  return {
    database: flag(row, "database_on")
      ? {
          retentionMinutes: period === null || perUnit === undefined ? undefined : period * perUnit,
          retention:
            period === null || word === undefined
              ? "an unknown time"
              : `${period} ${word}${period === 1 ? "" : "s"}`,
        }
      : undefined,
    table: flag(row, "table_on") ? { columnsTracked: flag(row, "columns_on") } : undefined,
    mark: markOf(row),
  };
}

/**
 * Why this capture cannot be installed as the target and the database are, or undefined: side-table
 * mode with it is not built yet; tracking off in the database, which the admin turns on; a
 * retention under two days; a table tracked without its columns, whose every update would read as a
 * change of the state.
 */
export function trackingRefusal(
  target: EngineTarget,
  names: TableNames,
  database: string,
  tracking: TrackingFacts,
): Refusal | undefined {
  if (target.storage === "side-table") {
    return {
      code: "side-table",
      message: `${names.label} cannot keep its answers in a side table while Change Tracking watches it: FacetDB does not combine the two yet`,
      fix: 'remove storage: "side-table" from the source in facetdb.config.ts, or remove capture: "change-tracking" to watch the table with a trigger',
    };
  }
  const alter = databaseTrackingStatement(database);
  if (tracking.database === undefined) {
    return {
      code: "change-tracking-off",
      message: `Change Tracking is off in the database ${database}, and capture: "change-tracking" reads ${names.label}'s changes from it; turning it on serves every table of the database, so it is the database admin's to do, not FacetDB's install`,
      fix: `as the database's owner (or a login with ALTER on the database), run: ${alter}; then run facetdb migrate again`,
    };
  }
  const minutes = tracking.database.retentionMinutes;
  if (minutes === undefined || minutes < MIN_RETENTION_MINUTES) {
    return {
      code: "change-tracking-retention",
      message: `the database ${database} keeps its tracked changes for ${tracking.database.retention}, under the two days FacetDB needs: a worker stopped longer than that finds the changes since its last read gone, and FacetDB must read the whole of ${names.label} again to find them`,
      fix: `as the database's owner, run: alter database ${quoteName(database)} set change_tracking (change_retention = 2 days); then run facetdb migrate again`,
    };
  }
  if (tracking.table !== undefined && !tracking.table.columnsTracked) {
    return {
      code: "change-tracking-columns",
      message: `Change Tracking is on for ${names.label} without column tracking, so FacetDB cannot tell a change of a state column from a change of any other, and would ask the model about every update`,
      fix: `as an admin, turn column tracking on: alter table ${names.relation} disable change_tracking; then alter table ${names.relation} enable change_tracking with (track_columns_updated = on), which restarts the table's tracking (tell any other reader of it); then run facetdb migrate again`,
    };
  }
  return undefined;
}

/** The arguments that name the table to `sp_addextendedproperty` and `sp_dropextendedproperty`. */
function tableLevel(names: TableNames): string {
  return `@level0type = N'SCHEMA', @level0name = ${quoteString(names.schema)},
    @level1type = N'TABLE', @level1name = ${quoteString(names.table)}`;
}

/** Whether the table carries the mark `name`, as SQL. */
function marked(names: TableNames, name: string): string {
  return `exists (select 1 from sys.extended_properties where class = 1 and major_id = object_id(${quoteString(names.relation)}, N'U') and minor_id = 0 and name = ${quoteString(name)})`;
}

/**
 * The version a first start follows changes from: the greater of the database's current version and
 * the version tracking began at on the table, read inside the install's transaction, so a change the
 * application commits after the install has a greater one. The begin version, for a table this
 * install starts tracking: SQL Server's oldest valid version for it is never below it.
 */
function sinceExpression(names: TableNames): string {
  return `(select max(v) from (values (change_tracking_current_version()), ((select t.begin_version from sys.change_tracking_tables t where t.object_id = object_id(${quoteString(names.relation)}, N'U')))) x (v))`;
}

/**
 * Tracking on the table and FacetDB's mark, when they are not there: `enable change_tracking with
 * (track_columns_updated = on)` and the `facetdb_tracking_enabled` mark together, so a table whose
 * tracking FacetDB turned on always says so; on a table tracked already, the
 * `facetdb_tracking_found` mark alone. Both guarded, so the printed script runs again and changes
 * nothing. A FacetDB trigger left from the trigger capture goes first, or both would queue. A mark
 * left on a table whose tracking was turned off by hand since is replaced: this install turns it on.
 */
export function trackingStatements(
  names: TableNames,
  tracking: TrackingFacts,
  trigger: CatalogObject | undefined,
): readonly PlanStatement[] {
  const relation = quoteString(names.relation);
  const drop =
    trigger === undefined
      ? []
      : [sourceStatement("capture", `drop trigger if exists ${names.triggerRelation}`)];
  if (tracking.table !== undefined && tracking.mark !== undefined) {
    return drop;
  }
  const mark = (name: string) =>
    `declare @since bigint = ${sinceExpression(names)};
  exec sys.sp_addextendedproperty @name = ${quoteString(name)}, @value = @since,
    ${tableLevel(names)};`;
  const stale = (name: string) =>
    `if ${marked(names, name)}
    exec sys.sp_dropextendedproperty @name = ${quoteString(name)},
    ${tableLevel(names)};`;
  return [
    ...drop,
    tracking.table === undefined
      ? sourceStatement(
          "capture",
          `if not exists (select 1 from sys.change_tracking_tables where object_id = object_id(${relation}, N'U'))
begin
  alter table ${names.relation} enable change_tracking with (track_columns_updated = on);
  ${tracking.mark === undefined ? "" : `${stale(TRACKING_ENABLED)}\n  ${stale(TRACKING_FOUND)}\n  `}${mark(TRACKING_ENABLED)}
end`,
        )
      : sourceStatement(
          "capture",
          `if not ${marked(names, TRACKING_ENABLED)} and not ${marked(names, TRACKING_FOUND)}
begin
  ${mark(TRACKING_FOUND)}
end`,
        ),
  ];
}

/** Whether the worker holds `permission` on the table, on all of it or on `column`. */
function holds(
  grants: readonly WorkerGrant[],
  names: TableNames,
  permission: string,
  column?: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.schema === names.schema &&
      grant.object === names.table &&
      grant.permission === permission &&
      (grant.column === undefined || grant.column === column),
  );
}

/**
 * The rights this capture needs beyond the install's, the part not held yet: `view change tracking`
 * on the table, which `changetable` and the oldest valid version need, and the read and write of
 * `facetdb_state_hash`. The status the worker sets pending itself is one of FacetDB's own columns,
 * which the install lets it update already.
 */
export function trackingGrants(
  names: TableNames,
  grants: readonly WorkerGrant[],
): readonly PlanStatement[] {
  const worker = quoteName(WORKER_USER);
  const hash = quoteName(STATE_HASH_COLUMN);
  return [
    ...(holds(grants, names, "VIEW CHANGE TRACKING")
      ? []
      : [
          sourceStatement("grants", `grant view change tracking on ${names.relation} to ${worker}`),
        ]),
    ...(holds(grants, names, "SELECT", STATE_HASH_COLUMN)
      ? []
      : [sourceStatement("grants", `grant select (${hash})\n  on ${names.relation} to ${worker}`)]),
    ...(holds(grants, names, "UPDATE", STATE_HASH_COLUMN)
      ? []
      : [sourceStatement("grants", `grant update (${hash})\n  on ${names.relation} to ${worker}`)]),
  ];
}

/** What a plan that installs this capture tells the operator. */
export function trackingNotes(
  names: TableNames,
  tracking: TrackingFacts,
  dropsTrigger: boolean,
): readonly string[] {
  return [
    `${names.label} is watched by Change Tracking, with no trigger: the worker reads its changes every second, and sets ${STATUS_COLUMN} to pending itself on the rows whose state columns changed`,
    ...(tracking.table !== undefined && tracking.mark === undefined
      ? [
          `Change Tracking was on for ${names.label} already: FacetDB reads it and leaves it as it is, and uninstall leaves it on`,
        ]
      : []),
    ...(dropsTrigger
      ? [`the trigger ${names.trigger} goes: Change Tracking watches ${names.label} from now on`]
      : []),
  ];
}

/**
 * The installed tables of the database that this capture watches (their FacetDB jobs come from the
 * worker, not a trigger), as `schema.table`, `@p1` the marker table: the queue stays while one
 * does. Read only when the marker table is there.
 */
export function trackedTablesQuery(names: TableNames): string {
  return `select m.[table_schema] as table_schema, m.[table_name] as table_name
  from ${names.markerRelation} m
  join sys.change_tracking_tables c on c.object_id = object_id(quotename(m.[table_schema]) + N'.' + quotename(m.[table_name]), N'U')
 order by 1, 2`;
}

/** The installed tables Change Tracking watches, as `schema.table`, when the marker table is there. */
export async function readTrackedTables(
  query: MssqlQuery,
  names: TableNames,
  objects: readonly CatalogObject[],
): Promise<readonly string[]> {
  const marker = objects.find((object) => object.name === MARKER_TABLE && object.type === "U");
  if (marker === undefined) {
    return [];
  }
  return (await query(trackedTablesQuery(names))).map(
    (row) => `${String(row["table_schema"])}.${String(row["table_name"])}`,
  );
}

/**
 * Uninstall's part for this capture, before the columns go (the capture first, so nothing is
 * queued while the rest goes): tracking off on the table only when FacetDB's install turned it on
 * (`facetdb_tracking_enabled`), the mark gone either way, and the worker's `view change tracking`
 * taken back.
 */
export function trackingUninstallStatements(
  names: TableNames,
  mark: TrackingMark | undefined,
  grants: readonly WorkerGrant[],
): readonly PlanStatement[] {
  const relation = quoteString(names.relation);
  const markName = mark?.enabled === true ? TRACKING_ENABLED : TRACKING_FOUND;
  return [
    ...(mark?.enabled === true
      ? [
          sourceStatement(
            "capture",
            `if exists (select 1 from sys.change_tracking_tables where object_id = object_id(${relation}, N'U'))
  alter table ${names.relation} disable change_tracking`,
          ),
        ]
      : []),
    ...(mark === undefined
      ? []
      : [
          sourceStatement(
            "capture",
            `if ${marked(names, markName)}
  exec sys.sp_dropextendedproperty @name = ${quoteString(markName)},
    ${tableLevel(names)}`,
          ),
        ]),
    ...(holds(grants, names, "VIEW CHANGE TRACKING")
      ? [
          sourceStatement(
            "grants",
            `if database_principal_id(${quoteString(WORKER_USER)}) is not null\n  revoke view change tracking on ${names.relation} from ${quoteName(WORKER_USER)}`,
          ),
        ]
      : []),
  ];
}

/** What uninstall says about the table's tracking. */
export function trackingUninstallNote(names: TableNames, mark: TrackingMark): string {
  return mark.enabled
    ? `Change Tracking on ${names.label} is turned off, because FacetDB's install turned it on; if another reader of the table's changes has relied on it since, turn it on again after the uninstall: alter table ${names.relation} enable change_tracking with (track_columns_updated = on)`
    : `Change Tracking stays on for ${names.label}: it was on before FacetDB's install`;
}
