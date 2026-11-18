import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  KeptObject,
  ObjectKind,
  PlanResult,
  UninstallOptions,
} from "@facetdb/core";
import { quoteIdent } from "../sql/index.ts";
import {
  blockedMessage,
  dropBlockers,
  type FacetdbTables,
  integerOf,
  inWords,
  readInstalled,
  type SqliteQuery,
  sameName,
  textOf,
} from "./catalog.ts";
import { UNMARKED_KEPT, unmarkedCopies } from "./marks.ts";
import { refused } from "./plan.ts";
import {
  dropColumnStatement,
  dropSharedStatements,
  dropTriggerStatements,
  forgetJobsStatement,
  forgetOwnerStatement,
  JOBS_TABLE,
  OWNERS_TABLE,
  QUEUE_TRIGGERS,
  triggerNames,
} from "./sql.ts";

/**
 * `facetdb uninstall` on a SQLite file: the two triggers first, so nothing is queued while the rest
 * goes; then each column carrying FacetDB's mark, the table's queued jobs and its marker row; and
 * FacetDB's shared tables once nothing still needs them. The statements never depend on the run's
 * other tables (UninstallOptions.alsoUninstalling, which changes the words only): each shared table
 * goes by a statement whose guard `run` checks as it runs (`guardOf`), since SQLite has no
 * conditional DDL, so the first table's run of two leaves the queue under the second's trigger and
 * the second's run, planned the same before and after the first, drops it. Run by hand with
 * `sqlite3 -bail`, the same guard stops the script instead, and nothing of it is committed.
 *
 * A column of FacetDB's name without its mark is the application's and stays; one of FacetDB's type
 * too (a rebuild's copy, or the application's own) is listed in keeps with why. A marked column an
 * application's index, view or trigger uses is refused before anything runs, naming what uses it.
 * `--purge` adds nothing here: the decision log is in the FacetDB store, which the CLI's store door
 * purges.
 */

export type SqliteUninstallOptions = Pick<UninstallOptions, "alsoUninstalling">;

/**
 * Why the file stays in WAL mode after an uninstall; a libSQL server's plan leaves it out: install
 * set no journal mode there.
 */
export const WAL_KEPT =
  "The file stays in WAL mode: install set it and the mode is persistent; pragma journal_mode = delete switches it back once no other connection has the file open.";

/** How the statements marked `unless this finds a row` run, and how to run the script by hand. */
const GUARDED =
  "SQLite has no conditional DDL: facetdb uninstall runs each drop marked `unless this finds a row` only when its query finds no row (another table of this file still installed keeps FacetDB's shared tables). Run by hand, run the script with sqlite3 -bail: the guard under each such line then stops it there, and nothing of it is committed.";

/** `1 queued job`, `1,240 queued jobs`: a count in a reason, as the CLI formats every count. */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** What the rest of the file still holds, outside this run, as read now: the words' forecast. */
type Forecast = {
  /** Tables outside the run with a `facetdb_` trigger that writes to the queue. */
  readonly queueTriggers: readonly string[];
  /** Queued jobs of tables outside the run. */
  readonly queuedElsewhere: number;
  /** Tables outside the run in the marker. */
  readonly ownersElsewhere: readonly string[];
};

async function forecast(
  query: SqliteQuery,
  run: readonly string[],
  tables: FacetdbTables,
): Promise<Forecast> {
  const outside = (name: string) => !run.some((table) => sameName(table, name));
  /** The distinct tables a query names in `field`, outside the run, in order. */
  const tablesOf = async (sql: string, field: string) =>
    [...new Set((await query(sql)).map((row) => textOf(row, field)))].filter(outside).sort();
  const queued = tables.jobs
    ? await query(
        `select table_name, count(*) as n from ${quoteIdent(JOBS_TABLE)} group by table_name`,
      )
    : [];
  return {
    queueTriggers: await tablesOf(QUEUE_TRIGGERS, "tbl_name"),
    queuedElsewhere: queued
      .filter((row) => outside(textOf(row, "table_name")))
      .reduce((sum, row) => sum + integerOf(row, "n"), 0),
    ownersElsewhere: tables.owners
      ? await tablesOf(`select table_name from ${quoteIdent(OWNERS_TABLE)}`, "table_name")
      : [],
  };
}

/** A run-wide object: it goes, or stays, once for the whole run (`scope: "run"`). */
function runObject(kind: ObjectKind, name: string): EngineObject {
  return { kind, name, scope: "run" };
}

/** `listings is still installed`, `listings and orders are still installed`. */
function stillInstalled(tables: readonly string[]): string {
  return `${inWords(tables)} ${tables.length === 1 ? "is" : "are"} still installed`;
}

/** The shared tables the run removes, and the ones it keeps with why, as the forecast reads now. */
function shared(
  tables: FacetdbTables,
  ahead: Forecast,
): { readonly removes: readonly EngineObject[]; readonly keeps: readonly KeptObject[] } {
  const removes: EngineObject[] = [];
  const keeps: KeptObject[] = [];
  if (tables.jobs) {
    if (ahead.queueTriggers.length > 0) {
      keeps.push({
        ...runObject("jobs-table", JOBS_TABLE),
        reason: `a trigger on ${inWords(ahead.queueTriggers)} still uses it`,
      });
    } else if (ahead.queuedElsewhere > 0) {
      keeps.push({
        ...runObject("jobs-table", JOBS_TABLE),
        count: ahead.queuedElsewhere,
        reason: `it holds ${counted(ahead.queuedElsewhere, "queued job", "queued jobs")} of other tables`,
      });
    } else {
      removes.push(runObject("jobs-table", JOBS_TABLE));
    }
  }
  if (tables.owners) {
    if (ahead.ownersElsewhere.length > 0) {
      keeps.push({
        ...runObject("marker", OWNERS_TABLE),
        reason: stillInstalled(ahead.ownersElsewhere),
      });
    } else {
      removes.push(runObject("marker", OWNERS_TABLE));
    }
  }
  return { removes, keeps };
}

export async function planUninstall(
  target: EngineTarget,
  query: SqliteQuery,
  options: SqliteUninstallOptions,
): Promise<PlanResult> {
  const refuse = (message: string) => refused("uninstall-refused", message);
  const installed = await readInstalled(query, target.table);
  if ("reason" in installed) {
    return refuse(installed.reason);
  }
  const { table, owner, marked, tables } = installed;
  if (owner !== target.project.id) {
    return refuse(
      `${table.name} belongs to another project (${owner}); uninstall it from that project.`,
    );
  }
  const names = triggerNames(table.name);
  const ours = [names.insert, names.update];
  const blockers = await dropBlockers(query, table, marked, ours);
  if (blockers.length > 0) {
    return refuse(blockedMessage(table.name, blockers, "uninstall"));
  }
  const triggers = (
    await query(
      "select name from sqlite_master where type = 'trigger' and name in (?, ?) order by name",
      ours,
    )
  ).map((row) => textOf(row, "name"));
  const run = [table.name, ...options.alsoUninstalling.map((other) => other.table)];
  const own = (kind: ObjectKind, name: string): EngineObject => ({
    kind,
    name,
    of: table.name,
    scope: "source",
  });
  const { removes, keeps } = shared(tables, await forecast(query, run, tables));
  // A rebuild's unmarked copies of FacetDB's columns stay, listed: never dropped unseen, never left
  // unsaid.
  const copies = unmarkedCopies(table, target.questionSet).map(
    (column): KeptObject => ({ ...own("column", column), reason: UNMARKED_KEPT }),
  );
  const guarded = dropSharedStatements(tables);
  const plan: EnginePlan = {
    statements: [
      ...dropTriggerStatements(table.name),
      ...marked.map((column) => dropColumnStatement(table.name, column)),
      ...(tables.jobs ? [forgetJobsStatement(table.name)] : []),
      forgetOwnerStatement(table.name),
      ...guarded,
    ],
    transactional: true,
    removes: [
      ...marked.map((column) => own("column", column)),
      ...triggers.map((trigger) => own("trigger", trigger)),
      // Its queued jobs: the table's part of the shared queue.
      ...(tables.jobs ? [own("jobs-table", JOBS_TABLE)] : []),
      // Its row in the marker table, which every run deletes (`forgetOwnerStatement`), said as
      // MySQL and SQL Server say theirs: whether the marker table then goes is the run's.
      own("marker", OWNERS_TABLE),
      ...removes,
    ],
    keeps: [...copies, ...keeps],
    notes: [WAL_KEPT, ...(guarded.length > 0 ? [GUARDED] : [])],
    confirm: { kind: "project", name: target.project.name },
  };
  return { ok: true, plan };
}
