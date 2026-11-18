import type { EnginePlan, EngineTarget, PlanResult } from "@facetdb/core";
import {
  markedColumns,
  readFacetdbTables,
  readOwner,
  readTable,
  type SqliteQuery,
  sameName,
  type TableFacts,
} from "./catalog.ts";
import { applicationColumns, lostMarks } from "./marks.ts";
import { anotherProject, refused } from "./plan.ts";
import {
  addColumnStatement,
  type CaptureTable,
  claimStatement,
  declaredType,
  JOURNAL_MODE,
  jobsTableStatements,
  ownedColumns,
  ownersTableStatement,
  triggerStatements,
} from "./sql.ts";

/**
 * `facetdb migrate` on a SQLite file: inspect the table, refuse what install must not touch, and
 * plan the answer and status columns the table lacks, the queue, the marker and the two triggers.
 * Idempotent: on an installed table the plan adds no column, and its other statements (`if not
 * exists`, `or ignore`, the triggers dropped and created again) leave the file as it was. Nothing
 * is read or written but through `query`, and nothing is changed: `run` executes the plan.
 */

/** SQLite's own name for a rowid table's key, which a source may name as its key. */
const ROWID = "rowid";

/** The schema SQLite gives the file FacetDB opens: a table is named bare, or `main.<table>`. */
const MAIN = "main";

/**
 * For SQLite: the notes every install plan carries. Exported for the libSQL engine, which says what
 * a server does instead of these three.
 */
export const NO_USERS =
  "SQLite has no users: whoever can open the file can read and change it, so the file's path and its permissions are the credential; this install creates no login and grants nothing.";

export const ONE_WORKER = "One worker may run on this file at a time.";

export const WAL_NOTE =
  "The file is put in WAL mode before the transaction opens (SQLite cannot change the journal mode inside one) and stays in it: the mode is persistent, and it lets the application and the worker read and write without blocking each other.";

function rowidNote(table: string): string {
  return `${table} is keyed by its rowid, and no integer primary key holds it: VACUUM may renumber such rowids, and the queue and the decision log would then name other rows. Give the table an integer primary key to keep its keys stable.`;
}

/** What the config asks that SQLite does not offer, before anything is read. */
function configRefusal(target: EngineTarget): string | undefined {
  if (target.storage === "side-table") {
    return `${target.table}: SQLite keeps answers in inline columns only; set the source's storage to "inline".`;
  }
  if (target.schema !== undefined && !sameName(target.schema, MAIN)) {
    return `${target.schema}.${target.table}: a SQLite source names its table bare (or main.${target.table}); the file is the database, and FacetDB opens it with no other schema attached.`;
  }
  return undefined;
}

/**
 * The key the queue holds for each record: the table's one-column primary key, or its rowid when
 * named; or why the table has none FacetDB can key by. Doctor's `marks` check reads it too.
 */
export function keyOf(target: EngineTarget, table: TableFacts): CaptureTable["key"] | string {
  const label = table.name;
  const column = (name: string) => table.columns.find((one) => sameName(one.name, name));
  if (target.key !== undefined && sameName(target.key, ROWID) && column(ROWID) === undefined) {
    return table.withoutRowid
      ? `${label} is a WITHOUT ROWID table, so it has no rowid to key by; name its primary key as the source's key.`
      : { kind: "rowid" };
  }
  const primary = table.columns.filter((one) => one.pk > 0).sort((a, b) => a.pk - b.pk);
  const [first] = primary;
  if (first === undefined) {
    return `${label} has no primary key; FacetDB keys its jobs and decisions by it. Add one, or name rowid as the source's key, and run migrate again.`;
  }
  if (primary.length > 1) {
    return `${label} has a composite primary key (${primary.map((one) => one.name).join(", ")}); FacetDB supports single-column keys only for now. Add a surrogate key${table.withoutRowid ? "" : ", or name rowid as the source's key"}.`;
  }
  if (target.key !== undefined && !sameName(target.key, first.name)) {
    return `${label}'s primary key is ${first.name}, not ${target.key}; the config and the table disagree.`;
  }
  return { kind: "column", name: first.name };
}

/**
 * The state fields as the trigger needs them: columns of the table the application sets. The
 * trigger fires on updates of exactly those columns and SQLite does not check the names it is
 * given, so a misspelled or generated one would leave a change unseen without a word.
 */
function stateRefusal(target: EngineTarget, table: TableFacts): string | undefined {
  const { read } = target.questionSet;
  const owned = ownedColumns(target.questionSet).map(([name]) => name);
  // The worker writes these: a state field among them would queue every record again on each write.
  const circular = read.filter(
    (field) =>
      owned.some((name) => sameName(name, field)) || field.toLowerCase().startsWith("facetdb_"),
  );
  if (circular.length > 0) {
    return `${table.name}: the state field ${circular.join(", ")} is a column FacetDB writes; a state field must be the application's own column, or the worker's writes would re-queue every record.`;
  }
  const column = (name: string) => table.columns.find((one) => sameName(one.name, name));
  const missing = read.filter((field) => column(field) === undefined);
  if (missing.length > 0) {
    return `${table.name} has no column named ${missing.join(", ")}, which read lists; a state field is a column of the table (the trigger fires on updates of exactly those, and SQLite does not check the names).`;
  }
  const generated = read.filter((field) => column(field)?.generated === true);
  if (generated.length > 0) {
    return `${table.name}: ${generated.join(", ")} ${generated.length === 1 ? "is a generated column" : "are generated columns"}, which no update sets, so the trigger would never see a change; list the columns ${generated.length === 1 ? "it is" : "they are"} computed from in read instead.`;
  }
  return undefined;
}

export async function planInstall(target: EngineTarget, query: SqliteQuery): Promise<PlanResult> {
  const refuse = (message: string) => refused("migrate-refused", message);
  const config = configRefusal(target);
  if (config !== undefined) {
    return refuse(config);
  }
  const table = await readTable(query, target.table);
  if (table.kind === "missing") {
    return refuse(
      `${target.table} does not exist; FacetDB adds columns to a table, it does not create one.`,
    );
  }
  if (table.kind === "view") {
    return refuse(
      `${table.name} is a view; FacetDB adds columns and triggers to a table. Point the source at the table under it.`,
    );
  }
  if (table.kind === "virtual") {
    return refuse(
      `${table.name} is a virtual table, which SQLite gives neither added columns nor triggers; point the source at an ordinary table.`,
    );
  }
  const key = keyOf(target, table);
  const tables = await readFacetdbTables(query);
  const owner = await readOwner(query, table.name, tables);
  // Before the key: a `create table … as select` rebuild drops the primary key with the marks, and
  // the words name the rebuild first.
  if (owner === target.project.id) {
    const lost = await lostMarks(query, table, target.questionSet, key);
    if (lost !== undefined) {
      return {
        ok: false,
        refusal: { code: "migrate-refused", message: lost.message, fix: lost.fix },
      };
    }
  }
  if (typeof key === "string") {
    return refuse(key);
  }
  if (owner !== undefined && owner !== target.project.id) {
    return refuse(anotherProject(table.name, owner));
  }
  const state = stateRefusal(target, table);
  if (state !== undefined) {
    return refuse(state);
  }
  const owned = ownedColumns(target.questionSet);
  const marked = markedColumns(table);
  const present = owned.flatMap(([name, definition]) => {
    const column = table.columns.find((one) => sameName(one.name, name));
    return column === undefined ? [] : [{ name, definition, column }];
  });
  // A column of FacetDB's name without FacetDB's mark is never adopted: adopting it would hand the
  // app's values to the worker, and uninstall would drop it. Past `lostMarks` (a rebuild: no mark
  // left, no trigger left), it is the application's, whatever its type.
  const collisions = present.filter(({ column }) => !marked.includes(column.name));
  if (collisions.length > 0) {
    return refuse(
      applicationColumns(
        table.name,
        collisions.map(({ column }) => column.name),
      ),
    );
  }
  // FacetDB's column of another type: the question changed type, which no install does in place.
  const drifted = present.filter(
    ({ definition, column }) => column.type !== declaredType(definition),
  );
  if (drifted.length > 0) {
    return refuse(
      `${table.name}: ${drifted.map(({ name, definition, column }) => `${name} is ${column.type} and the question now needs ${declaredType(definition)}`).join("; ")}; a question's type cannot change in place. Remove the question (migrate --prune drops its columns), then add it back.`,
    );
  }
  const plan: EnginePlan = {
    statements: [
      JOURNAL_MODE,
      ...jobsTableStatements(),
      ownersTableStatement(),
      claimStatement(table.name, target.project.id),
      // Only what the table lacks, each marked: SQLite has no `add column if not exists`.
      ...owned
        .filter(([name]) => !present.some((one) => one.name === name))
        .map(([name, definition]) => addColumnStatement(table.name, name, definition)),
      ...triggerStatements({
        table: table.name,
        key,
        withoutRowid: table.withoutRowid,
        state: target.questionSet.read,
        onChange: target.onChange,
      }),
    ],
    transactional: true,
    removes: [],
    keeps: [],
    notes: [
      NO_USERS,
      ONE_WORKER,
      WAL_NOTE,
      ...(key.kind === "rowid" && table.rowidAlias === undefined ? [rowidNote(table.name)] : []),
    ],
  };
  return { ok: true, plan };
}
