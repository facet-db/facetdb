import type {
  EngineObject,
  EnginePlan,
  KeptObject,
  ObjectKind,
  PlanResult,
  PlanStatement,
} from "@facetdb/core";
import {
  ENQUEUE_ROLE,
  type InstallDraft,
  type InstallStatement,
  KEPT_REASON,
  type PruneDraft,
  renderStatement,
  type SourceLog,
  type UninstallDraft,
  type UninstallPlan,
  WORKER_ROLE,
} from "../install/index.ts";
import { STORE_TABLES, STORE_VERSION_TABLE } from "../store/index.ts";

/**
 * Today's install, uninstall and prune, as the engine contract's plans: every statement as printed,
 * tagged by the database it serves; what goes and what stays as typed objects carrying the words
 * the CLI prints today. The old-field → new-place table is in engine.ts.
 */

/** The fix of every refusal of a plan, as the CLI words it today (`refused` in its database.ts). */
export const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/** A refusal with today's code (`migrate-refused`, `uninstall-refused`, `prune-refused`) and words. */
export function refusedPlan(code: string, message: string): PlanResult {
  return { ok: false, refusal: { code, message, fix: REFUSED_FIX } };
}

/** One statement as the plan holds it: its text exactly as printed, the password's a comment. */
function planStatement(statement: InstallStatement): PlanStatement {
  const printed: PlanStatement = {
    database: statement.database,
    purpose: statement.purpose,
    text: renderStatement(statement),
  };
  return statement.redacted === true ? { ...printed, secret: true } : printed;
}

/**
 * The statements of a script for the plan: all of them when the store is the source's database
 * (today's one script, byte for byte), the source's alone otherwise.
 */
function planStatements(
  statements: readonly InstallStatement[],
  storeShared: boolean,
): readonly PlanStatement[] {
  return statements
    .filter((statement) => storeShared || statement.database === "source")
    .map(planStatement);
}

export function installPlan(
  draft: Extract<InstallDraft, { readonly ok: true }>,
  storeShared: boolean,
): EnginePlan {
  return {
    statements: planStatements(draft.statements, storeShared),
    transactional: true,
    removes: [],
    keeps: [],
    // The store's migration notes (`rekeyNotes`) are about the store: its door says them otherwise.
    notes: storeShared ? draft.notes : [],
  };
}

/**
 * A prune's plan. A dropped column carries the connector's reason; a revoked read is the worker's
 * grant on the column (named bare, as the plan is one table's), its reason the words the CLI
 * prints in its line, naming another role's grant that stays; a kept column says why it stays.
 */
export function prunePlan(draft: Extract<PruneDraft, { readonly ok: true }>): EnginePlan {
  const grantors = (column: string) =>
    draft.foreignGrants.filter((grant) => grant.column === column).map((grant) => grant.grantor);
  return {
    statements: planStatements(draft.statements, true),
    transactional: true,
    removes: [
      ...draft.dropped.map(
        ({ column, reason }): EngineObject => ({
          kind: "column",
          name: column,
          of: draft.table,
          scope: "source",
          reason,
        }),
      ),
      ...draft.revoked.map((column): EngineObject => {
        const by = grantors(column);
        return {
          kind: "grant",
          name: WORKER_ROLE,
          of: column,
          scope: "source",
          reason:
            by.length === 0
              ? "read no longer lists it"
              : `a grant by ${by.join(", ")} remains, see note`,
        };
      }),
    ],
    keeps: draft.keptColumns.map(
      (name): KeptObject => ({
        kind: "column",
        name,
        of: draft.table,
        scope: "source",
        reason: KEPT_REASON,
      }),
    ),
    notes: draft.notes,
  };
}

const JOBS = "facetdb.jobs";
const OWNERS = "facetdb.table_owners";
const PROJECTS = "facetdb.projects";
const DECISIONS = "facetdb.decisions";
const VERSIONS = "facetdb.question_set_versions";
/** Where a source's resume rows are: its backfills' places, and a stream's token. */
const CURSORS = "facetdb.cursors";

/**
 * The store's shared tables, as the uninstall's sweep drops them once no project remains: every
 * store table but the decision log's two and the queue (the source's), with the version table.
 */
const SHARED_TABLES: readonly string[] = [
  ...STORE_TABLES.filter((name) => !["decisions", "question_set_versions", "jobs"].includes(name)),
  STORE_VERSION_TABLE,
].map((name) => `facetdb.${name}`);

/** Why the logins stay, in the words the CLI prints (`ROLES_KEPT`). */
const LOGINS_KEPT = "uninstall never drops them: every project on the server may share them";

/** `1,240 decisions`, `1 decision`: a count in a reason, formatted as the CLI formats every count. */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** `a`, `a and b`, `a, b and c`. */
function inWords(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** Why the store's shared tables stay, one phrase per reason the forecast gives. */
function sharedTablesReasons(plan: UninstallPlan): readonly string[] {
  const own: string[] = [];
  const store: string[] = [];
  for (const reason of plan.projectKeptBy) {
    switch (reason) {
      case "another-table":
        own.push(
          `another installed table (${inWords(
            plan.otherTables
              .filter((other) => other.projectId === plan.projectId)
              .map((other) => other.name),
          )})`,
        );
        break;
      case "usage":
        own.push("usage");
        break;
      case "heartbeats":
        own.push("worker heartbeats");
        break;
      case "pending-deliveries":
        own.push(
          counted(plan.pendingDeliveries, "pending webhook delivery", "pending webhook deliveries"),
        );
        break;
      case "records":
        own.push("records of an API or plugin source");
        break;
      case "store-in-use":
        store.push("the FacetDB store still registers a source, a credential or an API key");
        break;
      case "cursors":
        store.push(
          `a backfill cursor that names no source is unfinished (run ${inWords(plan.unfinishedCursors)}; no backfill resumes it, so it stays until it is deleted)`,
        );
        break;
      default:
        // A reason the forecast adds later must get its words here before it can be planned.
        throw new Error(`no words for why a project stays: ${reason satisfies never}`);
    }
  }
  const foreignTables = plan.otherTables
    .filter((other) => other.projectId !== plan.projectId)
    .map((other) => other.name);
  return [
    ...(own.length === 0 ? [] : [`project ${plan.projectId} still has ${inWords(own)}`]),
    ...store,
    ...(foreignTables.length === 0
      ? []
      : [`${inWords(foreignTables)} ${foreignTables.length === 1 ? "is" : "are"} still installed`]),
    ...(plan.otherProjects.length === 0
      ? []
      : [
          `${plan.otherProjects.length === 1 ? "project" : "projects"} ${inWords(plan.otherProjects)} ${plan.otherProjects.length === 1 ? "remains" : "remain"}`,
        ]),
    ...(plan.pendingElsewhere === 0
      ? []
      : [
          `${counted(plan.pendingElsewhere, "webhook delivery", "webhook deliveries")} of other projects ${plan.pendingElsewhere === 1 ? "is" : "are"} pending`,
        ]),
  ];
}

/** A run-wide object: it goes, or stays, once for the whole run (`scope: "run"`). */
function runObject(
  kind: ObjectKind,
  name: string,
  more: Pick<EngineObject, "of" | "count" | "reason"> = {},
): EngineObject {
  return { kind, name, scope: "run", ...more };
}

/** One source's entries in the decision log and its question-set versions, with their counts. */
function logEntries(
  source: string,
  counts: Pick<SourceLog & { readonly status: "found" }, "decisions" | "versions">,
): readonly EngineObject[] {
  return [
    { kind: "log", name: DECISIONS, of: source, scope: "source", count: counts.decisions },
    { kind: "log", name: VERSIONS, of: source, scope: "source", count: counts.versions },
  ];
}

/** The decision log's two tables, kept (or dropped) as a whole, with why. */
function logTables(scope: EngineObject["scope"], reason: string): readonly KeptObject[] {
  return [DECISIONS, VERSIONS].map((name) => ({ kind: "log", name, scope, reason }));
}

/**
 * The store's shared tables, going or staying for `reason`. With the store elsewhere they are not
 * in this database: what stands for them here is `facetdb.projects`, the marks' own table.
 */
function sharedTables(storeShared: boolean, reason: string): readonly KeptObject[] {
  return storeShared
    ? SHARED_TABLES.map((name) => ({ kind: "store-table", name, scope: "run", reason }))
    : [{ kind: "marker", name: PROJECTS, scope: "run", reason }];
}

/** What one table's script removes from it, and with `--purge` its source's log entries. */
function tableRemoves(plan: UninstallPlan, storeShared: boolean): readonly EngineObject[] {
  const table = `${plan.schema}.${plan.table}`;
  const removal = plan.tableRemoval;
  const own = (kind: ObjectKind, name: string): EngineObject => ({
    kind,
    name,
    of: table,
    scope: "source",
  });
  return [
    ...(removal === undefined
      ? []
      : [
          ...removal.columns.map((column) => own("column", column)),
          ...(removal.sideTable === undefined ? [] : [own("side-table", removal.sideTable)]),
          ...(removal.view === undefined ? [] : [own("view", removal.view)]),
          ...(removal.trigger === undefined ? [] : [own("trigger", removal.trigger)]),
          ...removal.policies.map((policy) => own("policy", policy)),
          // Its queued jobs: the table's part of the shared queue.
          own("jobs-table", JOBS),
          ...(removal.workerGrants ? [own("grant", WORKER_ROLE)] : []),
        ]),
    ...(storeShared && plan.purge && plan.log.status === "found"
      ? logEntries(plan.log.given, plan.log)
      : []),
    // The source's resume rows go with or without a purge: its own, so `source`-scoped, and named
    // by the source (`of`), since a run of several sources deletes each one's.
    ...(storeShared && plan.resumeRows.length > 0
      ? [
          {
            kind: "store-table",
            name: CURSORS,
            of: plan.log.given,
            scope: "source",
            count: plan.resumeRows.length,
          } satisfies EngineObject,
        ]
      : []),
  ];
}

/** What the whole run removes, once nothing of it needs them; the run's last script drops them. */
function runRemoves(
  plan: UninstallPlan,
  queueFunctions: readonly string[],
  storeShared: boolean,
): readonly EngineObject[] {
  return [
    ...plan.schemaUsageRevoked.map((schema) => runObject("grant", WORKER_ROLE, { of: schema })),
    ...(plan.projectKeptBy.length === 0 && !plan.sharedTablesDropped
      ? [runObject("marker", PROJECTS, { of: plan.projectId, reason: "nothing of it remains" })]
      : []),
    ...(plan.queueFunctionsDropped
      ? queueFunctions.map((name) =>
          runObject("function", `facetdb.${name}`, { reason: "no trigger uses them any more" }),
        )
      : []),
    ...(plan.jobsTableDropped ? [runObject("jobs-table", JOBS)] : []),
    ...(plan.markerTablesDropped ? [runObject("marker", OWNERS)] : []),
    ...(plan.sharedTablesDropped ? sharedTables(storeShared, "no project remains") : []),
    ...(storeShared && plan.logTablesDropped ? logTables("run", "now empty") : []),
    ...(plan.schemaDropped ? [runObject("schema", "facetdb", { reason: "now empty" })] : []),
  ];
}

/** What stays of one table: its source's log and why, and what the script leaves on purpose. */
function tableKeeps(plan: UninstallPlan, storeShared: boolean): readonly KeptObject[] {
  const { log } = plan;
  const kept: KeptObject[] = [];
  if (storeShared && !plan.purge) {
    if (log.status === "found" && log.decisions + log.versions > 0) {
      const command = `facetdb uninstall --purge --source ${log.given}`;
      const reason =
        plan.logOnlyPurge === undefined
          ? `which ${inWords(plan.otherTables.map((other) => other.name))} may share: run \`${command}\` once no other table is installed to delete it`
          : `run \`${plan.logOnlyPurge.command}\` later to delete it`;
      kept.push(...logEntries(log.given, log).map((entry) => ({ ...entry, reason })));
    } else {
      kept.push(...logTables("source", "only --purge deletes a log"));
    }
  }
  if (storeShared && plan.purge) {
    for (const other of plan.otherSourceLogs) {
      kept.push({
        kind: "log",
        name: DECISIONS,
        of: other.source,
        scope: "source",
        count: other.decisions,
        reason: `another source of project ${plan.projectId}: run \`facetdb uninstall --purge --source ${other.source}\` if it was this table's under an earlier name`,
      });
    }
    if (!plan.logTablesDropped && plan.otherSourceLogs.length === 0) {
      if (log.status === "found") {
        kept.push(...logTables("source", "which other sources or the FacetDB store still use"));
      } else if (log.logged === 0) {
        kept.push(...logTables("source", `no decisions were ever logged for source ${log.given}`));
      } else {
        kept.push({
          kind: "log",
          name: DECISIONS,
          of: log.given,
          scope: "source",
          count: log.logged,
          reason: `no source named "${log.given}" belongs to this table's project, so none of it is deleted (sources found: ${log.found.length === 0 ? "none" : log.found.join(", ")})`,
        });
      }
    }
  }
  for (const name of plan.leftInPlace) {
    kept.push({ kind: "side-table", name, scope: "source", reason: "see the note above" });
  }
  return kept;
}

/** What the run leaves of FacetDB's shared objects, each with why; the logins always. */
function runKeeps(
  plan: UninstallPlan,
  queueFunctions: readonly string[],
  storeShared: boolean,
): readonly KeptObject[] {
  const queueKept = plan.markerTablesDropped && plan.queueTriggers.length > 0;
  const queuedKept = plan.markerTablesDropped && !queueKept && plan.queuedElsewhere > 0;
  const triggers = `a trigger on ${inWords(plan.queueTriggers)} still uses them`;
  return [
    ...(plan.sharedTablesDropped
      ? []
      : sharedTables(storeShared, inWords(sharedTablesReasons(plan)))),
    ...(queueKept
      ? [
          { ...runObject("jobs-table", JOBS), reason: triggers },
          ...queueFunctions.map((name) => ({
            ...runObject("function", `facetdb.${name}`),
            reason: triggers,
          })),
        ]
      : []),
    ...(queuedKept
      ? [
          {
            ...runObject("jobs-table", JOBS, { count: plan.queuedElsewhere }),
            reason: `it holds ${counted(plan.queuedElsewhere, "queued job", "queued jobs")} of other tables`,
          },
        ]
      : []),
    ...[WORKER_ROLE, ENQUEUE_ROLE].map((name) => ({
      ...runObject("login", name),
      reason: LOGINS_KEPT,
    })),
  ];
}

/**
 * An uninstall's plan: the table's own removes and keeps (`scope: "source"`), then the run's
 * (`scope: "run"`), each in the order the CLI words them; the name typed back is the project's for
 * a table, the source's for a log-only purge. Without `storeShared` the log and the store's tables
 * are the CLI's store door's: no statement, object or note of theirs is here.
 */
export function uninstallPlan(
  draft: Extract<UninstallDraft, { readonly ok: true }>,
  storeShared: boolean,
): EnginePlan {
  const { plan, queueFunctions } = draft;
  return {
    statements: planStatements(draft.statements, storeShared),
    transactional: true,
    removes: [...tableRemoves(plan, storeShared), ...runRemoves(plan, queueFunctions, storeShared)],
    keeps: [...tableKeeps(plan, storeShared), ...runKeeps(plan, queueFunctions, storeShared)],
    notes: draft.notes,
    confirm: { kind: plan.mode === "log-only" ? "source" : "project", name: plan.confirmName },
  };
}
