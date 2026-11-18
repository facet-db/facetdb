import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  KeptObject,
  PlanResult,
  PlanStatement,
  UninstallOptions,
} from "@facetdb/core";
import { adminUrlRefusal, type MssqlConnect, quoteName, quoteString } from "../sql/index.ts";
import {
  type CatalogColumn,
  type CatalogObject,
  type MarkerRow,
  readColumns,
  readGrants,
  readMarker,
  readObjects,
  readQueued,
  readQueueUsers,
  sharedObject,
  sideTableOf,
  viewOf,
  type WorkerGrant,
  withAdmin,
} from "./catalog.ts";
import {
  readMark,
  readTrackedTables,
  type TrackingMark,
  trackingUninstallNote,
  trackingUninstallStatements,
} from "./change-tracking.ts";
import { markerCleanupStatement, releaseStatement, SCRIPT_ERROR, SCRIPT_PREFIX } from "./marker.ts";
import {
  JOBS_TABLE,
  MARKER_TABLE,
  SHARED_SCHEMA,
  sourceStatement,
  type TableNames,
  tableNames,
  WORKER_USER,
} from "./objects.ts";
import { dequeueStatement, queueCleanupStatement } from "./queue.ts";

/**
 * `planUninstall` on SQL Server: what install added to one table goes, in one transaction. The
 * trigger first, so nothing is queued while the rest goes; the worker's reads of the table's own
 * columns (its rights on FacetDB's columns go with them); FacetDB's marked columns and never
 * another, without `cascade`, so an index or view of the application's on one of them fails the
 * drop and rolls the whole script back with SQL Server's message naming it; in side-table mode the
 * view and then the side table, each only when it carries FacetDB's mark, whatever the config's
 * storage says now, since a source switched to inline still leaves the side table install made; the
 * table's jobs, and the database's queue once no FacetDB trigger writes to it and it holds no job;
 * the table's row of the marker, and the marker table once no table of the database is installed.
 * The worker stays: every project in the database may share it. The project's name is typed back
 * before anything runs.
 *
 * The decision log is the FacetDB store's: `--purge` deletes it through the CLI's store door after
 * this run. A table uninstalled earlier still has its log there, and its purge is a plan with one
 * statement, the source's side of the checks: the table is not installed again, and no installed
 * table of the project may be the one the source reads now.
 */

/** How long a statement waits for a lock, as install waits (`alter table` takes the table's lock). */
const LOCK_TIMEOUT_MS = 10_000;

/** Why the worker stays, in the words the CLI prints. */
export const WORKER_KEPT = "uninstall never drops it: every project in this database may share it";

/** How a log-only purge's note reads before its run, and after it (`ranNote`). */
const LOG_ONLY_PLANNED = "; only the decision log is purged.";
const LOG_ONLY_RAN = "; only the decision log was purged.";

/** A note as the run says it once it ran: what the plan said is purged, was purged. */
export function ranNote(note: string): string {
  return note.endsWith(LOG_ONLY_PLANNED)
    ? `${note.slice(0, -LOG_ONLY_PLANNED.length)}${LOG_ONLY_RAN}`
    : note;
}

/** `a`, `a and b`, `a, b and c`. */
function inWords(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** `1 queued job`, `3 queued jobs`. */
function queuedJobs(n: number): string {
  return `${n.toLocaleString("en-US")} queued ${n === 1 ? "job" : "jobs"}`;
}

/** The table's FacetDB trigger, when it is there. */
function ownTrigger(
  names: TableNames,
  objects: readonly CatalogObject[],
): CatalogObject | undefined {
  return objects.find(
    (object) =>
      object.schema === names.schema &&
      object.name === names.trigger &&
      object.type === "TR" &&
      object.parentSchema === names.schema &&
      object.parentTable === names.table,
  );
}

/**
 * The columns of the table the worker reads that stay on it (the key and the state columns), in
 * the table's order: its rights on FacetDB's own columns go with them.
 */
function workerReads(
  names: TableNames,
  columns: readonly CatalogColumn[],
  grants: readonly WorkerGrant[],
): readonly string[] {
  const read = new Set(
    grants
      .filter(
        (grant) =>
          grant.schema === names.schema &&
          grant.object === names.table &&
          grant.permission === "SELECT",
      )
      .flatMap((grant) => (grant.column === undefined ? [] : [grant.column])),
  );
  return columns
    .filter((column) => !column.marked && read.has(column.name))
    .map((column) => column.name);
}

/** The database's queue as the uninstall of one table finds it. */
type QueueFacts = {
  /** This table's jobs. */
  readonly queued: number;
  /** Jobs of tables outside this run: any keeps the queue. */
  readonly elsewhere: number;
  /** Tables outside this run whose FacetDB trigger writes the queue: any keeps it. */
  readonly users: readonly string[];
  /** Installed tables outside this run that Change Tracking watches: any keeps it. */
  readonly tracked: readonly string[];
};

/** What the uninstall of an installed table read. */
type Installed = {
  readonly row: MarkerRow;
  /** Installed tables outside this run, as `schema.table`: any keeps the marker table. */
  readonly others: readonly string[];
  readonly columns: readonly CatalogColumn[];
  readonly trigger: CatalogObject | undefined;
  /** Side-table mode's view and side table, each when it is there and FacetDB's. */
  readonly view: CatalogObject | undefined;
  readonly side: CatalogObject | undefined;
  readonly grants: readonly WorkerGrant[];
  readonly queue: QueueFacts | undefined;
  /** FacetDB's Change Tracking mark on the table, when its install set one. */
  readonly tracking: TrackingMark | undefined;
};

function uninstallStatements(names: TableNames, installed: Installed): readonly PlanStatement[] {
  const reads = workerReads(names, installed.columns, installed.grants);
  return [
    sourceStatement("settings", `set lock_timeout ${LOCK_TIMEOUT_MS}`),
    // Change capture first, so nothing is queued while the rest goes.
    ...(installed.trigger === undefined
      ? []
      : [sourceStatement("capture", `drop trigger if exists ${names.triggerRelation}`)]),
    // Change Tracking: off only where FacetDB turned it on, its mark gone either way.
    ...trackingUninstallStatements(names, installed.tracking, installed.grants),
    ...(reads.length === 0
      ? []
      : [
          sourceStatement(
            "grants",
            `if database_principal_id(${quoteString(WORKER_USER)}) is not null\n  revoke select (${reads.map(quoteName).join(", ")}) on ${names.relation} from ${quoteName(WORKER_USER)}`,
          ),
        ]),
    // Side-table mode: the view first (it reads the side table), then the side table, its answers,
    // its foreign key and the worker's rights on it with it. Each only when it carries FacetDB's
    // mark, so an object of the application's under either name is never dropped.
    ...(installed.view === undefined
      ? []
      : [sourceStatement("columns", `drop view if exists ${names.viewRelation}`)]),
    ...(installed.side === undefined
      ? []
      : [sourceStatement("columns", `drop table if exists ${names.sideRelation}`)]),
    ...installed.columns
      .filter((column) => column.marked)
      .map((column) =>
        sourceStatement(
          "columns",
          `alter table ${names.relation} drop column if exists ${quoteName(column.name)}`,
        ),
      ),
    ...(installed.queue === undefined
      ? []
      : [dequeueStatement(names), queueCleanupStatement(names)]),
    releaseStatement(names),
    markerCleanupStatement(names),
  ];
}

function uninstallPlan(names: TableNames, installed: Installed): EnginePlan {
  const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
    kind,
    name,
    of: names.label,
    scope: "source",
  });
  const queueName = `${SHARED_SCHEMA}.${JOBS_TABLE}`;
  const markerName = `${SHARED_SCHEMA}.${MARKER_TABLE}`;
  const { queue, others } = installed;
  const queueKept =
    queue === undefined
      ? undefined
      : queue.users.length > 0
        ? `a trigger on ${inWords(queue.users)} still uses it`
        : queue.tracked.length > 0
          ? `the worker still queues the changes Change Tracking keeps of ${inWords(queue.tracked)} in it`
          : queue.elsewhere > 0
            ? `it holds ${queuedJobs(queue.elsewhere)} of other tables`
            : undefined;
  const removes: readonly EngineObject[] = [
    ...(installed.trigger === undefined ? [] : [own("trigger", names.trigger)]),
    // The capture in Change Tracking mode: turned off only where FacetDB's install turned it on
    // (`trackingUninstallStatements`); tracking that was on before stays, among the keeps.
    ...(installed.tracking?.enabled === true
      ? [{ ...own("change-tracking", names.label), reason: "FacetDB's install turned it on" }]
      : []),
    ...(installed.grants.some(
      (grant) => grant.schema === names.schema && grant.object === names.table,
    )
      ? [own("grant", WORKER_USER)]
      : []),
    ...(installed.view === undefined ? [] : [own("view", names.view)]),
    ...(installed.side === undefined ? [] : [own("side-table", names.sideTable)]),
    ...installed.columns
      .filter((column) => column.marked)
      .map((column) => own("column", column.name)),
    // The table's part of the shared queue: its jobs.
    ...(queue === undefined ? [] : [{ ...own("jobs-table", queueName), count: queue.queued }]),
    own("marker", markerName),
    ...(queue === undefined || queueKept !== undefined
      ? []
      : [
          {
            kind: "jobs-table",
            name: queueName,
            scope: "run",
            reason: "no trigger uses it any more",
          } as const,
        ]),
    ...(others.length === 0
      ? [{ kind: "marker", name: markerName, scope: "run", reason: "now empty" } as const]
      : []),
  ];
  const keeps: readonly KeptObject[] = [
    // Tracking that was on before the install stays on, said among what stays.
    ...(installed.tracking?.enabled === false
      ? [
          {
            ...own("change-tracking", names.label),
            reason: "it was on before FacetDB's install",
          },
        ]
      : []),
    ...(queue === undefined || queueKept === undefined
      ? []
      : [
          {
            kind: "jobs-table",
            name: queueName,
            scope: "run",
            ...(queue.users.length === 0 && queue.tracked.length === 0
              ? { count: queue.elsewhere }
              : {}),
            reason: queueKept,
          } as const,
        ]),
    ...(others.length === 0
      ? []
      : [
          {
            kind: "marker",
            name: markerName,
            scope: "run",
            reason: `${inWords(others)} ${others.length === 1 ? "is" : "are"} still installed`,
          } as const,
        ]),
    { kind: "login", name: WORKER_USER, scope: "run", reason: WORKER_KEPT },
  ];
  return {
    statements: uninstallStatements(names, installed),
    transactional: true,
    removes,
    keeps,
    notes:
      installed.tracking === undefined ? [] : [trackingUninstallNote(names, installed.tracking)],
    confirm: { kind: "project", name: installed.row.projectName },
  };
}

/** The words of a log-only purge refused because another table of the project is installed. */
function sharedLog(source: string, table: string, project: string): string {
  return `the decision log of source "${source}" may be shared with ${table} (project ${project}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`;
}

/**
 * A purge after the table was uninstalled earlier: nothing of FacetDB's is left on it, so the plan
 * checks again, inside its transaction, that the table was not installed since and that no table of
 * the project is (the store keys a log by project and source, and does not record which table a
 * source reads); the CLI's store door deletes the log after the run.
 */
function logOnlyPurge(
  target: EngineTarget,
  names: TableNames,
  marker: readonly MarkerRow[] | undefined,
): PlanResult {
  const project = target.project.id;
  const shared = marker?.find((row) => row.projectId === project);
  if (shared !== undefined) {
    return {
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message: sharedLog(target.source, `${shared.schema}.${shared.table}`, project),
        fix: "uninstall that table first, then run facetdb uninstall --purge for this source again",
      },
    };
  }
  const live = (words: string) =>
    quoteString(
      `${SCRIPT_PREFIX}the decision log of source "${target.source}" is live again: ${words}; nothing was changed`,
    );
  const check = sourceStatement(
    "marker",
    `if object_id(${quoteString(names.triggerRelation)}, N'TR') is not null
  throw ${SCRIPT_ERROR}, ${live(`${names.label} has a FacetDB trigger`)}, 1;
if object_id(${quoteString(names.markerRelation)}, N'U') is not null
begin
  if exists (select 1 from ${names.markerRelation} with (updlock, holdlock) where [project_id] = ${quoteString(project)})
    throw ${SCRIPT_ERROR}, ${live(`a table of project ${project} is now installed`)}, 1;
end`,
  );
  return {
    ok: true,
    plan: {
      statements: [check],
      transactional: true,
      removes: [],
      keeps: [{ kind: "login", name: WORKER_USER, scope: "run", reason: WORKER_KEPT }],
      notes: [`${names.label} has no FacetDB install left${LOG_ONLY_PLANNED}`],
      confirm: { kind: "source", name: target.source },
    },
  };
}

export async function planUninstall(
  connect: MssqlConnect,
  target: EngineTarget,
  url: string,
  options: UninstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const names = tableNames(target);
  // The run's tables, by the words that name them and by the name their jobs carry.
  const running = [target, ...options.alsoUninstalling].map(tableNames);
  const runLabels = new Set(running.map((one) => one.label));
  const runJobs = new Set(running.map((one) => one.relation));
  return withAdmin(connect, url, async (query): Promise<PlanResult> => {
    const columns = await readColumns(query, names.schema, names.table);
    const objects = await readObjects(query, names);
    const marker = await readMarker(query, names, objects);
    const row = marker?.find((one) => one.schema === names.schema && one.table === names.table);
    const trigger = ownTrigger(names, objects);
    if (row === undefined || marker === undefined) {
      // Nothing of an install left on the table: with --purge, only its log goes (the store's).
      const left =
        trigger !== undefined ||
        columns.some((column) => column.marked) ||
        sideTableOf(objects, names) !== undefined ||
        viewOf(objects, names) !== undefined;
      if (options.purge && !left) {
        return logOnlyPurge(target, names, marker);
      }
      return {
        ok: false,
        refusal: {
          code: "not-installed",
          message:
            columns.length === 0
              ? `${names.label} does not exist; there is nothing of FacetDB's on it to remove`
              : `FacetDB is not installed on ${names.label} (${SHARED_SCHEMA}.${MARKER_TABLE} has no row for it)`,
          fix: "run facetdb migrate first, or check the source's table and schema in facetdb.config.ts",
        },
      };
    }
    if (columns.length === 0) {
      return {
        ok: false,
        refusal: {
          code: "not-installed",
          message: `${names.label} does not exist; there is nothing of FacetDB's on it to remove`,
          fix: "check the source's table and schema in facetdb.config.ts",
        },
      };
    }
    let queue: QueueFacts | undefined;
    if (sharedObject(objects, JOBS_TABLE)?.type === "U") {
      const queued = await readQueued(query, names);
      queue = {
        queued: queued.get(names.relation) ?? 0,
        elsewhere: [...queued]
          .filter(([table]) => !runJobs.has(table))
          .reduce((sum, [, n]) => sum + n, 0),
        users: (await readQueueUsers(query)).filter((label) => !runLabels.has(label)),
        // A table Change Tracking watches has no trigger, and its jobs still need the queue.
        tracked: (await readTrackedTables(query, names, objects)).filter(
          (label) => !runLabels.has(label),
        ),
      };
    }
    return {
      ok: true,
      plan: uninstallPlan(names, {
        row,
        others: marker
          .map((one) => `${one.schema}.${one.table}`)
          .filter((label) => !runLabels.has(label)),
        columns,
        trigger,
        view: viewOf(objects, names),
        side: sideTableOf(objects, names),
        grants: await readGrants(query, names),
        queue,
        tracking: await readMark(query, names),
      }),
    };
  });
}
