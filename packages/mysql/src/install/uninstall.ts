import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  KeptObject,
  PlanResult,
  PlanStatement,
  UninstallOptions,
} from "@facetdb/core";
import {
  adminUrlRefusal,
  type MysqlConnect,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  withClient,
} from "../sql/index.ts";
import {
  type Catalog,
  droppedColumnsNote,
  NO_RIGHTS,
  otherQueueTables,
  readCatalog,
  readSession,
  readViews,
  readWorkerRights,
  rightsOn,
  type WorkerRights,
  workerExists,
} from "./catalog.ts";
import { noDatabaseRefusal, uninstallRefused } from "./refusals.ts";
import {
  deleteJobsStatement,
  dropTrigger,
  JOBS_TABLE,
  OWNED_MARK,
  OWNERS_TABLE,
  revokeStatement,
  SETTINGS,
  sourceStatement,
  triggerNames,
  WORKER_ACCOUNT,
} from "./sql.ts";

/**
 * `planUninstall` on MySQL and MariaDB: what install added to the table goes, in an order that
 * keeps a stopped run finishable: the triggers first, so nothing is queued while the rest goes; the
 * worker's rights on the table; FacetDB's marked columns; the table's jobs in the queue the
 * database's tables share; the table's marker row; then, once no table uses them, the queue and the
 * marker table. The worker login stays: other projects on the server may share it. The decision log
 * is the store's, so `purge` adds nothing here (the CLI's store door deletes it); the operator
 * types the project's name back.
 */

/** The plan's note for a run that stops part way. */
export const UNINSTALL_RERUN_NOTE =
  "MySQL runs these statements one by one, with no transaction around them: if one fails, the ones before it stay done, and running facetdb uninstall again completes it.";

/** Why the login stays, in the words Postgres's uninstall prints. */
const LOGIN_KEPT = "uninstall never drops it: every project on the server may share it";

/** Why a grant stays on a table that is gone: MySQL does not drop a table's grants with it. */
const DROPPED_TABLE_GRANTS =
  "the table is gone, and MySQL keeps the grants of a dropped table: they go with the login";

/**
 * Why the worker's grants stay on a shared table the run drops: whether the table goes is decided
 * as the script runs, and a revoke cannot be made to wait for that.
 */
const SHARED_TABLE_GRANTS =
  "MySQL keeps a dropped table's grants, and whether this table goes is decided as the script runs: they go with the login";

/**
 * The run-time checks ("an existence check on MySQL") that drop the shared tables once no table
 * uses them: the queue once no FacetDB trigger left in the schema writes to it and no row is left
 * in the marker (`information_schema.triggers` lists only the triggers the running account may
 * see), the marker table once it is empty. They are in every table's plan, so the last table's run
 * of a multi-table uninstall drops them and the first never drops them under another table. MySQL
 * has no conditional DDL outside a stored program, so each statement is chosen at run time and run
 * as a prepared one; `do 0` does nothing.
 */
function cleanupStatements(
  schema: string,
  jobs: boolean,
  owners: boolean,
): readonly PlanStatement[] {
  const guarded = (condition: string, table: string) => [
    sourceStatement(
      "cleanup",
      `set @facetdb_cleanup = if(${condition},\n  ${quoteLiteral(`drop table if exists ${quoteTable(schema, table)}`)}, 'do 0')`,
    ),
    sourceStatement("cleanup", "prepare facetdb_cleanup from @facetdb_cleanup"),
    sourceStatement("cleanup", "execute facetdb_cleanup"),
  ];
  const unwritten = `(select count(*) from information_schema.triggers
       where trigger_schema = ${quoteLiteral(schema)} and left(trigger_name, 8) = 'facetdb_'
         and locate(${quoteLiteral(JOBS_TABLE)}, action_statement) > 0) = 0`;
  const empty = `(select count(*) from ${quoteTable(schema, OWNERS_TABLE)}) = 0`;
  const steps = [
    ...(jobs ? guarded(owners ? `${unwritten}\n    and ${empty}` : unwritten, JOBS_TABLE) : []),
    ...(owners ? guarded(empty, OWNERS_TABLE) : []),
  ];
  return steps.length === 0
    ? []
    : [...steps, sourceStatement("cleanup", "deallocate prepare facetdb_cleanup")];
}

/** The marker's row of the table: the last thing of the table to go, so a rerun still sees it. */
function deleteOwnerStatement(schema: string, table: string): PlanStatement {
  return sourceStatement(
    "marker",
    `delete from ${quoteTable(schema, OWNERS_TABLE)} where ${quoteIdent("table_name")} = ${quoteLiteral(table)}`,
  );
}

/**
 * What the whole run removes, or keeps, of the queue and the marker table, each with why. The
 * statements are the same either way (`alsoUninstalling` changes the words only); the tables of
 * this run's other sources in the schema are gone by its last table's run.
 */
function sharedObjects(
  catalog: Catalog,
  table: string,
  rights: WorkerRights,
  inRun: ReadonlySet<string>,
): {
  readonly statements: readonly PlanStatement[];
  readonly removes: readonly EngineObject[];
  readonly keeps: readonly KeptObject[];
} {
  const { schema } = catalog;
  const statements = cleanupStatements(schema, catalog.jobs.present, catalog.ownersPresent);
  const shared = [
    ...(catalog.jobs.present
      ? [{ kind: "jobs-table", table: JOBS_TABLE, reason: "no table uses it any more" } as const]
      : []),
    ...(catalog.ownersPresent
      ? [{ kind: "marker", table: OWNERS_TABLE, reason: "now empty" } as const]
      : []),
  ];
  const others = otherQueueTables(catalog, table).filter((other) => !inRun.has(other));
  if (others.length > 0) {
    const reason = `${others.map((other) => `${schema}.${other}`).join(", ")} still ${others.length === 1 ? "uses" : "use"} it`;
    return {
      statements,
      removes: [],
      keeps: shared.map(({ kind, table: name }) => ({
        kind,
        name: `${schema}.${name}`,
        scope: "run",
        reason,
      })),
    };
  }
  return {
    statements,
    removes: shared.map(({ kind, table: name, reason }) => ({
      kind,
      name: `${schema}.${name}`,
      scope: "run",
      reason,
    })),
    keeps: shared
      .filter(({ table: name }) => rights.tables.some((held) => held.table === name))
      .map(({ table: name }) => ({
        kind: "grant",
        name: WORKER_ACCOUNT,
        of: `${schema}.${name}`,
        scope: "run",
        reason: SHARED_TABLE_GRANTS,
      })),
  };
}

/** What the plan reads beyond the catalog: the worker's rights, and the views a drop may break. */
type Context = {
  readonly rights: WorkerRights;
  readonly claimed: boolean;
  readonly inRun: ReadonlySet<string>;
  /** `readViews`: undefined where the server cannot list them. */
  readonly views: readonly string[] | undefined;
};

/** The plan once the table is known to be the project's, or to have nothing of FacetDB's left. */
function uninstallPlan(target: EngineTarget, catalog: Catalog, context: Context): EnginePlan {
  const { rights, claimed, inRun, views } = context;
  const { schema } = catalog;
  const { table } = target;
  const label = `${schema}.${table}`;
  // FacetDB's triggers on the table, in their own order whatever order the catalog lists them in.
  const names = triggerNames(table);
  const triggers = [names.pending, names.insert, names.update].filter((name) =>
    catalog.triggers.some((trigger) => trigger.name === name && trigger.table === table),
  );
  const marked = catalog.columns
    .filter((column) => column.comment === OWNED_MARK)
    .map((column) => column.name);
  const present = catalog.tableType !== undefined;
  const existing = new Set(catalog.columns.map((column) => column.name));
  const revoke = present
    ? revokeStatement(schema, table, rightsOn(rights, table, existing))
    : undefined;
  const heldOnTable =
    rights.columns.some((held) => held.table === table) ||
    rights.tables.some((held) => held.table === table);
  const shared = sharedObjects(catalog, table, rights, inRun);
  const viewsNote = marked.length === 0 ? undefined : droppedColumnsNote(label, views);
  const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
    kind,
    name,
    of: label,
    scope: "source",
  });
  return {
    statements: [
      SETTINGS,
      ...triggers.map((name) => dropTrigger(schema, name)),
      ...(revoke === undefined ? [] : [revoke]),
      // FacetDB's marked columns only, in one statement. MySQL and MariaDB drop a column a view
      // reads without a word, and the view fails with error 1356 afterwards: a note says so.
      ...(marked.length === 0
        ? []
        : [
            sourceStatement(
              "columns",
              `alter table ${quoteTable(schema, table)}\n${marked.map((name) => `  drop column ${quoteIdent(name)}`).join(",\n")}`,
            ),
          ]),
      // Its queued jobs: the table's part of the queue the database's tables share.
      ...(claimed && catalog.jobs.present ? [deleteJobsStatement(schema, table)] : []),
      ...(claimed ? [deleteOwnerStatement(schema, table)] : []),
      ...shared.statements,
    ],
    transactional: false,
    removes: [
      ...triggers.map((name) => own("trigger", name)),
      ...(revoke === undefined ? [] : [own("grant", WORKER_ACCOUNT)]),
      ...marked.map((name) => own("column", name)),
      ...(claimed && catalog.jobs.present ? [own("jobs-table", `${schema}.${JOBS_TABLE}`)] : []),
      ...(claimed ? [own("marker", `${schema}.${OWNERS_TABLE}`)] : []),
      ...shared.removes,
    ],
    keeps: [
      ...(!present && heldOnTable
        ? [{ ...own("grant", WORKER_ACCOUNT), reason: DROPPED_TABLE_GRANTS }]
        : []),
      ...shared.keeps,
      { kind: "login", name: WORKER_ACCOUNT, scope: "run", reason: LOGIN_KEPT },
    ],
    notes: [UNINSTALL_RERUN_NOTE, ...(viewsNote === undefined ? [] : [viewsNote])],
    confirm: { kind: "project", name: target.project.name },
  };
}

export async function planUninstall(
  connect: MysqlConnect,
  target: EngineTarget,
  url: string,
  options: UninstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  return withClient(connect, url, async (query): Promise<PlanResult> => {
    const { database } = await readSession(query);
    const schema = target.schema ?? database;
    if (schema === undefined) {
      return { ok: false, refusal: noDatabaseRefusal(target) };
    }
    // The run's other tables in this schema: their objects are gone by the run's last table.
    const inRun = new Set(
      options.alsoUninstalling
        .filter((other) => (other.schema ?? database) === schema)
        .map((other) => other.table),
    );
    const catalog = await readCatalog(query, schema, target.table);
    const label = `${schema}.${target.table}`;
    const owner = catalog.owners.find((row) => row.table === target.table);
    if (owner !== undefined && owner.projectId !== target.project.id) {
      return {
        ok: false,
        refusal: uninstallRefused(
          `${label} belongs to another project (${owner.projectId}); uninstall it from that project.`,
        ),
      };
    }
    const rights = (await workerExists(query)) ? await readWorkerRights(query, schema) : NO_RIGHTS;
    const marked = catalog.columns.some((column) => column.comment === OWNED_MARK);
    const views = marked ? await readViews(query, schema, target.table) : [];
    if (owner === undefined) {
      // A run stopped after the table's row went leaves only the shared tables: the same plan
      // finishes them. Anything else without a row is no install of this project's to undo.
      const leftover =
        (catalog.jobs.present || catalog.ownersPresent) &&
        catalog.owners.length === 0 &&
        otherQueueTables(catalog, target.table).length === 0 &&
        !marked &&
        !catalog.triggers.some(
          (trigger) => trigger.table === target.table && trigger.name.startsWith("facetdb_"),
        );
      return leftover
        ? {
            ok: true,
            plan: uninstallPlan(target, catalog, { rights, claimed: false, inRun, views }),
          }
        : {
            ok: false,
            refusal: uninstallRefused(
              `FacetDB is not installed on ${label} (${schema}.${OWNERS_TABLE} has no row for it); check the source's table and database.`,
            ),
          };
    }
    return {
      ok: true,
      plan: uninstallPlan(target, catalog, { rights, claimed: true, inRun, views }),
    };
  });
}
