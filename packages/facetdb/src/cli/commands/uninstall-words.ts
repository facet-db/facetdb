import { ENQUEUE_ROLE, type SourceLog, type UninstallPlan, WORKER_ROLE } from "@facetdb/postgres";

/**
 * The words `facetdb uninstall` prints about what goes and what stays, each built from a field of
 * the connector's plan, never guessed here. A table's own words (its columns, trigger, grants, its
 * source's log) come from that table's plan; the run's words (the project entry, the queue, the
 * shared tables, the schema) come from the plan of the run's last table, which counts the run's
 * other tables as gone (`alsoUninstalling`).
 */

/** `1,240 decisions`, `1 decision`. */
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

function logSize(log: SourceLog & { readonly status: "found" }): string {
  return `${counted(log.decisions, "decision", "decisions")}, ${counted(log.versions, "question-set version", "question-set versions")}`;
}

/**
 * The server-wide roles stay whatever the run removes: the worker login, and the enqueue role that
 * owns the trigger functions, with the admin's membership in it (install grants it).
 */
export const ROLES_KEPT = `the ${WORKER_ROLE} and ${ENQUEUE_ROLE} logins (uninstall never drops them: every project on the server may share them)`;

/** Why the store's shared tables stay, one phrase per reason the plan gives. */
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
          `a backfill is unfinished (run ${inWords(plan.unfinishedCursors)}; it finishes, or its cursor is deleted)`,
        );
        break;
      default:
        // A reason the connector adds later must get its words here before it can be printed.
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

/** What one table's script removes from the table and from its source's log. */
export function tableRemoved(plan: UninstallPlan): readonly string[] {
  const removal = plan.tableRemoval;
  const table = `${plan.schema}.${plan.table}`;
  const parts =
    removal === undefined
      ? []
      : [
          ...(removal.columns.length === 0
            ? []
            : [
                `${counted(removal.columns.length, "FacetDB column", "FacetDB columns")} (${removal.columns.join(", ")})`,
              ]),
          ...(removal.sideTable === undefined ? [] : [`the side table ${removal.sideTable}`]),
          ...(removal.view === undefined ? [] : [`the view ${removal.view}`]),
          ...(removal.trigger === undefined ? [] : [`the trigger ${removal.trigger}`]),
          ...(removal.policies.length === 0
            ? []
            : [
                `${removal.policies.length === 1 ? "the policy" : "the policies"} ${inWords(removal.policies)}`,
              ]),
          "its queued jobs",
          ...(removal.workerGrants ? [`the ${WORKER_ROLE} login's rights on it`] : []),
        ];
  return [
    ...(parts.length === 0 ? [] : [`from ${table}: ${inWords(parts)}`]),
    ...(plan.purge && plan.log.status === "found"
      ? [`the decision log of source ${plan.log.given} (${logSize(plan.log)})`]
      : []),
  ];
}

/** What the run removes besides its tables: the project's entry, the queue, the shared tables. */
export function runRemoved(plan: UninstallPlan): readonly string[] {
  const schemas = plan.schemaUsageRevoked;
  return [
    // The last script in a schema takes the worker's usage of it, so it is the run's, not a table's.
    ...(schemas.length === 0
      ? []
      : [
          `the ${WORKER_ROLE} login's usage of ${schemas.length === 1 ? "schema" : "schemas"} ${inWords(schemas)}`,
        ]),
    ...(plan.projectKeptBy.length === 0 && !plan.sharedTablesDropped
      ? [`project ${plan.projectId}'s entry in the FacetDB store (nothing of it remains)`]
      : []),
    ...(plan.queueFunctionsDropped
      ? ["the enqueue trigger functions (no trigger uses them any more)"]
      : []),
    ...(plan.jobsTableDropped
      ? ["the jobs table and the table-ownership marks (facetdb.jobs, facetdb.table_owners)"]
      : plan.markerTablesDropped
        ? ["the table-ownership marks (facetdb.table_owners)"]
        : []),
    ...(plan.sharedTablesDropped
      ? ["the shared FacetDB tables and the alert history in them (no project remains)"]
      : []),
    ...(plan.logTablesDropped ? ["the decision log tables, now empty"] : []),
    ...(plan.schemaDropped ? ["the facetdb schema, now empty"] : []),
  ];
}

/** What stays of one table: its source's log, and what the script leaves in place on purpose. */
export function tableKept(plan: UninstallPlan): readonly string[] {
  const { log } = plan;
  const kept: string[] = [];
  if (!plan.purge) {
    if (log.status === "found" && log.decisions + log.versions > 0) {
      const later = plan.logOnlyPurge;
      // A purge waits while any other table is installed: it may share this source's log.
      kept.push(
        later === undefined
          ? `the decision log of source ${log.given} (${logSize(log)}), which ${inWords(plan.otherTables.map((other) => other.name))} may share: run \`facetdb uninstall --purge --source ${log.given}\` once no other table is installed to delete it`
          : `the decision log of source ${log.given} (${logSize(log)}): run \`${later.command}\` later to delete it`,
      );
    } else {
      kept.push("the decision log tables (only --purge deletes a log)");
    }
  } else {
    for (const other of plan.otherSourceLogs) {
      kept.push(
        `the decision log of source ${other.source} (${counted(other.decisions, "decision", "decisions")}), another source of project ${plan.projectId}: run \`facetdb uninstall --purge --source ${other.source}\` if it was this table's under an earlier name`,
      );
    }
    if (!plan.logTablesDropped && plan.otherSourceLogs.length === 0) {
      kept.push(
        log.status === "found"
          ? "the decision log tables, which other sources or the FacetDB store still use"
          : log.logged === 0
            ? `the decision log tables (no decisions were ever logged for source ${log.given})`
            : `the decision log: no source named "${log.given}" belongs to this table's project, so none of it is deleted (sources found: ${log.found.length === 0 ? "none" : log.found.join(", ")})`,
      );
    }
  }
  for (const name of plan.leftInPlace) {
    kept.push(`${name}, left in place (see the note above)`);
  }
  return kept;
}

/** What the run leaves of FacetDB's shared objects, each with why; the worker login always. */
export function runKept(plan: UninstallPlan): readonly string[] {
  return [
    ...(plan.sharedTablesDropped
      ? []
      : [`the shared FacetDB tables, because ${inWords(sharedTablesReasons(plan))}`]),
    ...(plan.markerTablesDropped && (plan.queueTriggers.length > 0 || plan.queuedElsewhere > 0)
      ? [
          plan.queueTriggers.length > 0
            ? `the jobs table and the enqueue functions (a trigger on ${inWords(plan.queueTriggers)} still uses them)`
            : `the jobs table (it holds ${counted(plan.queuedElsewhere, "queued job", "queued jobs")} of other tables)`,
        ]
      : []),
    ROLES_KEPT,
  ];
}

/** Each phrase once, in first-seen order: the tables of a run share the run's words. */
export function once(phrases: readonly string[]): readonly string[] {
  return [...new Set(phrases)];
}
