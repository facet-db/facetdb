import { type DoctorCheck, type EngineTarget, STATE_HASH_COLUMN } from "@facetdb/core";
import { pollerLock, versionRun } from "../connector/index.ts";
import {
  type CatalogObject,
  databaseTrackingStatement,
  MIN_RETENTION_MINUTES,
  readMark,
  type TableNames,
  versionText,
  WORKER_USER,
  type WorkerGrant,
} from "../install/index.ts";
import type { MssqlQuery, MssqlRow } from "../sql/index.ts";
import type { OpenCursors } from "./engine.ts";

/**
 * doctor's look at Change Tracking as a source's capture, under the worker login, in the trigger
 * check's place: tracking on the database and on the table with its columns, the retention, the
 * worker's `view change tracking`, and the version the worker stored in the FacetDB store against
 * the oldest the database still keeps, which says whether its next start reads on or reads the
 * whole table once (the reconcile). Nothing is changed.
 */

export const CHANGE_TRACKING_CHECK = {
  name: "change-tracking",
  looksAt:
    'with capture: "change-tracking", in place of the trigger check: tracking on the database and on the table with column tracking, the retention, the worker\'s view change tracking right, and the version stored in the FacetDB store against the oldest the database still keeps',
} as const;

/** Units of `sys.change_tracking_databases.retention_period_units`, in minutes and in words. */
const UNITS: Readonly<Record<number, { readonly minutes: number; readonly word: string }>> = {
  1: { minutes: 1, word: "minute" },
  2: { minutes: 60, word: "hour" },
  3: { minutes: 24 * 60, word: "day" },
};

/** What the worker reads of tracking, `@p1` the table as `[schema].[table]`. */
const TRACKING_STATE_QUERY = `select convert(nvarchar(20), change_tracking_current_version()) as now,
       convert(nvarchar(20), change_tracking_min_valid_version(object_id(@p1, N'U'))) as min,
       cast(d.retention_period as int) as retention_period,
       cast(d.retention_period_units as int) as retention_units,
       cast(has_perms_by_name(@p1, N'OBJECT', N'VIEW CHANGE TRACKING') as int) as can_view,
       cast(t.is_track_columns_updated_on as int) as columns_on
  from (select db_id() as id) x
  left join sys.change_tracking_databases d on d.database_id = x.id
  left join sys.change_tracking_tables t on t.object_id = object_id(@p1, N'U')`;

/** What the worker lacks of this capture's rights: `view change tracking` and `facetdb_state_hash`. */
export function trackingRightsMissing(
  names: TableNames,
  grants: readonly WorkerGrant[],
): readonly string[] {
  const holds = (permission: string, column?: string) =>
    grants.some(
      (grant) =>
        grant.schema === names.schema &&
        grant.object === names.table &&
        grant.permission === permission &&
        (grant.column === undefined || grant.column === column),
    );
  return [
    ...(holds("VIEW CHANGE TRACKING") ? [] : ["view change tracking"]),
    ...(holds("SELECT", STATE_HASH_COLUMN) ? [] : [`select on ${STATE_HASH_COLUMN}`]),
    ...(holds("UPDATE", STATE_HASH_COLUMN) ? [] : [`update on ${STATE_HASH_COLUMN}`]),
  ];
}

function wholeOrNull(row: MssqlRow, column: string): number | null {
  const value = row[column];
  return typeof value === "number" ? value : null;
}

/** The stored version as the store's cursors hold it, or why it could not be read. */
async function storedVersion(
  open: OpenCursors | undefined,
  target: EngineTarget,
  allowInsecure: boolean,
): Promise<{ readonly version: string | undefined } | { readonly unread: string }> {
  if (open === undefined) {
    return { unread: "this engine was made without the store's cursors" };
  }
  let opened: Awaited<ReturnType<OpenCursors>> | undefined;
  try {
    opened = await open({ allowInsecure });
    const saved = await opened.cursors.load(versionRun(target));
    if (saved === undefined || saved.cursor === null) {
      return { version: undefined };
    }
    return /^\d+$/.test(saved.cursor)
      ? { version: saved.cursor }
      : { unread: `the store holds "${saved.cursor}", which is not a version` };
  } catch (error) {
    return { unread: error instanceof Error ? error.message : String(error) };
  } finally {
    await opened?.close().catch(() => undefined);
  }
}

/**
 * The check, never throwing for what it finds: a reading that fails is the caller's to report as
 * this check's failure.
 */
export async function changeTrackingCheck(
  query: MssqlQuery,
  target: EngineTarget,
  names: TableNames,
  database: string,
  trigger: CatalogObject | undefined,
  open: OpenCursors | undefined,
  allowInsecure: boolean,
): Promise<DoctorCheck> {
  const name = CHANGE_TRACKING_CHECK.name;
  const fail = (detail: string, fix: string): DoctorCheck => ({
    name,
    status: "fail",
    detail,
    fix,
  });
  const [row] = await query(TRACKING_STATE_QUERY, [names.relation]);
  if (row === undefined || row["now"] === null) {
    return fail(
      `Change Tracking is off in the database ${database}, so no change of ${names.label} reaches the queue`,
      `as the database's owner, run: ${databaseTrackingStatement(database)}; then run facetdb migrate`,
    );
  }
  if (row["can_view"] !== 1) {
    return fail(
      `${WORKER_USER} may not read ${names.label}'s changes: it lacks view change tracking on the table`,
      "run facetdb migrate: it grants what is missing and nothing more",
    );
  }
  if (row["min"] === null || row["columns_on"] === null) {
    return fail(
      `Change Tracking is off for ${names.label}, so no change of the table reaches the queue`,
      "run facetdb migrate: it turns tracking on for the table",
    );
  }
  if (row["columns_on"] !== 1) {
    return fail(
      `Change Tracking is on for ${names.label} without column tracking, so a change of a state column cannot be told from any other`,
      `as an admin: alter table ${names.relation} disable change_tracking; then alter table ${names.relation} enable change_tracking with (track_columns_updated = on); then run facetdb migrate`,
    );
  }
  if (trigger !== undefined) {
    return fail(
      `the trigger ${names.trigger} is still on ${names.label}, which Change Tracking watches: both would queue every change`,
      "run facetdb migrate: it drops the trigger",
    );
  }
  const min = versionText(row["min"], "change_tracking_min_valid_version()");
  const period = wholeOrNull(row, "retention_period");
  const units = UNITS[wholeOrNull(row, "retention_units") ?? 0];
  if (period !== null && units !== undefined && period * units.minutes < MIN_RETENTION_MINUTES) {
    return fail(
      `${database} keeps its tracked changes for ${period} ${units.word}${period === 1 ? "" : "s"}, under the two days FacetDB needs: a worker stopped longer than that makes FacetDB read the whole of ${names.label} again`,
      `as the database's owner, run: alter database [${database.replaceAll("]", "]]")}] set change_tracking (change_retention = 2 days)`,
    );
  }
  const retention =
    period === null || units === undefined
      ? "for its retention"
      : `for ${period} ${units.word}${period === 1 ? "" : "s"}`;
  const stored = await storedVersion(open, target, allowInsecure);
  const reconcile = `its next start reads every row of ${names.label} once and queues those whose state changed since their last answer, with a warning`;
  if ("unread" in stored) {
    return {
      name,
      status: "warn",
      detail: `Change Tracking is on for ${names.label} with column tracking, kept ${retention}; the version the worker stored was not read (${stored.unread}), so whether it resumes or reads the table again is not known`,
    };
  }
  if (stored.version === undefined) {
    const mark = await readMark(query, names);
    if (mark === undefined) {
      return fail(
        `${names.label} carries no mark of FacetDB's Change Tracking install, so the worker has no version to start from`,
        'run facetdb migrate with capture: "change-tracking"',
      );
    }
    return BigInt(mark.since) < BigInt(min)
      ? {
          name,
          status: "warn",
          detail: `the worker has not run yet, and the changes since the install (version ${mark.since}) are gone: the oldest the database keeps is version ${min}; ${reconcile}`,
        }
      : {
          name,
          status: "ok",
          detail: `Change Tracking is on for ${names.label} with column tracking, kept ${retention}; the worker has not run yet and starts from the install's version ${mark.since}`,
        };
  }
  return BigInt(stored.version) < BigInt(min)
    ? {
        name,
        status: "warn",
        detail: `the changes of ${names.label} since version ${stored.version}, where the worker stopped, are gone: the oldest the database keeps is version ${min}; ${reconcile}`,
      }
    : {
        name,
        status: "ok",
        detail: `Change Tracking is on for ${names.label} with column tracking, kept ${retention}; the worker resumes from version ${stored.version}, and the database keeps changes back to version ${min}; ${await pollerWords(query, names)}`,
      };
}

/**
 * Whether a worker polls the table now: the poller's application lock taken or free. Which process
 * holds it would need VIEW SERVER STATE (`sys.dm_tran_locks`), which the worker never has; each
 * worker says it in its own log at start ("polls" or "claiming only").
 */
async function pollerWords(query: MssqlQuery, names: TableNames): Promise<string> {
  const [row] = await query(
    "select applock_test(N'public', @p1, N'Exclusive', N'Session') as free",
    [pollerLock(names)],
  );
  return row?.["free"] === 1
    ? "no worker polls it now (none runs, or none has started watching); the first to watch polls"
    : "a worker polls it now (each worker's log says at start whether it polls or claims only)";
}
