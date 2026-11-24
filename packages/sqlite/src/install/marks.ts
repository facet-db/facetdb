import type { QuestionSet } from "@facetdb/core";
import { quoteIdent } from "../sql/index.ts";
import {
  dropBlockers,
  inWords,
  markedColumns,
  type SqliteQuery,
  sameName,
  type TableFacts,
} from "./catalog.ts";
import { type CaptureTable, COLUMN_MARK, declaredType, ownedColumns, triggerNames } from "./sql.ts";

/**
 * FacetDB's columns that lost their marks. SQLite keeps each column's mark in the table's stored
 * definition (`COLUMN_MARK`), and a table rebuilt the SQLite way (a new table, the rows copied, the
 * old one dropped, the new one renamed: an ORM migration that copies every column, or a
 * hand-written `create table … as select`) copies FacetDB's columns and their values but not their
 * marks, and drops FacetDB's triggers with the old table. A rebuild is named only where it shows:
 * no column marked, neither trigger there, the marker this project's; anything less is the
 * application's own column of FacetDB's name. FacetDB never adopts an unmarked column, and SQLite
 * cannot mark one without rebuilding the table again, so `migrate` refuses, `doctor` fails its
 * `marks` check, and `uninstall` keeps them, all in the words below.
 *
 * The recovery loses nothing and asks the model for nothing answered at the record's current state:
 * with the worker stopped, the copies are dropped, `facetdb migrate` adds the columns back marked
 * with the triggers, and `facetdb backfill --from-log` writes each answered record's latest
 * decision back from the decision log, which keeps every answer and every human decision, with no
 * model call and no action. A plain `facetdb backfill` alone would not do it: it skips a record the
 * log has answered at its current state, and the record's columns would stay empty.
 */

/** SQLite's affinity of a declared type (§3.1 of its datatype rules), as a rebuild may respell it. */
function affinity(type: string): "integer" | "text" | "blob" | "real" | "numeric" {
  const declared = type.toLowerCase();
  if (declared.includes("int")) {
    return "integer";
  }
  if (["char", "clob", "text"].some((part) => declared.includes(part))) {
    return "text";
  }
  if (declared === "" || declared.includes("blob")) {
    return "blob";
  }
  if (["real", "floa", "doub"].some((part) => declared.includes(part))) {
    return "real";
  }
  return "numeric";
}

/**
 * The columns of the question set (answers, then `facetdb_status`, `facetdb_updated_at`,
 * `facetdb_reviewed`) the table has with FacetDB's name and type but without FacetDB's mark, as the
 * table spells them. The type is compared by affinity: `create table … as select` declares a copied
 * `integer` column `INT`.
 */
export function unmarkedCopies(table: TableFacts, questionSet: QuestionSet): readonly string[] {
  const marked = markedColumns(table);
  return ownedColumns(questionSet).flatMap(([name, definition]) => {
    const column = table.columns.find((one) => sameName(one.name, name));
    return column !== undefined &&
      !marked.includes(column.name) &&
      affinity(column.type) === affinity(declaredType(definition))
      ? [column.name]
      : [];
  });
}

/** The columns of the question set the table lacks: a migrate adds them (doctor's `marks` check). */
export function absentColumns(table: TableFacts, questionSet: QuestionSet): readonly string[] {
  return ownedColumns(questionSet)
    .map(([name]) => name)
    .filter((name) => !table.columns.some((column) => sameName(column.name, name)));
}

/** Why uninstall keeps such a column, as the CLI prints a kept object's reason. */
export const UNMARKED_KEPT = `it has FacetDB's name and type but not FacetDB's mark (${COLUMN_MARK} in the table's definition): a table rebuild that copies every column (an ORM migration, or a hand-written create table … as select) copies FacetDB's columns without their marks, or the application made it, and FacetDB drops only the columns it marked; if it is FacetDB's copy, drop it by hand (its answers stay in the decision log)`;

/** What `migrate` and `doctor` say about the copies, and the recovery, step by step. */
export type LostMarks = {
  /** The copies, as the table spells them. */
  readonly columns: readonly string[];
  /** What FacetDB found. */
  readonly message: string;
  /** What to do. */
  readonly fix: string;
};

/**
 * The refusal for columns of FacetDB's names that FacetDB did not add: they are the application's,
 * whatever their type, unless the table shows a rebuild (`lostMarks`). Install and doctor both say
 * it.
 */
export function applicationColumns(table: string, names: readonly string[]): string {
  const one = names.length === 1;
  return `${table} already has ${one ? "a column" : "columns"} named ${names.join(", ")} that ${one ? "is" : "are"} the application's: FacetDB marks every column it adds (${COLUMN_MARK} in the table's definition), and ${one ? "this one has" : "these have"} no mark, so FacetDB neither writes nor drops ${one ? "it" : "them"}. Rename the question or the column.`;
}

/** The columns of the question set the table has without FacetDB's mark, whatever their type. */
export function unmarkedNamesakes(table: TableFacts, questionSet: QuestionSet): readonly string[] {
  const marked = markedColumns(table);
  return ownedColumns(questionSet).flatMap(([name]) => {
    const column = table.columns.find((one) => sameName(one.name, name));
    return column !== undefined && !marked.includes(column.name) ? [column.name] : [];
  });
}

/**
 * Whether the table shows a rebuild, which strips every mark and drops both triggers: no column of
 * the table carries FacetDB's mark, and neither of FacetDB's triggers is there. Anything less (a
 * question added under the name of the application's own column, or a column the application
 * dropped and added again beside FacetDB's marked ones) is the application's column.
 */
async function rebuilt(query: SqliteQuery, table: TableFacts): Promise<boolean> {
  if (markedColumns(table).length > 0) {
    return false;
  }
  const names = triggerNames(table.name);
  const triggers = await query(
    "select name from sqlite_master where type = 'trigger' and name in (?, ?)",
    [names.insert, names.update],
  );
  return triggers.length === 0;
}

/**
 * The lost marks of a rebuilt table, or undefined when the table shows no rebuild (`rebuilt`) or
 * holds no copy of FacetDB's columns. Call it only for a table the marker names this project's:
 * without the marker, an unmarked column of FacetDB's name is the application's. `key` is install's
 * key of the table, or why it has none (a `create table … as select` drops the primary key too):
 * the recovery then asks for the key first.
 */
export async function lostMarks(
  query: SqliteQuery,
  table: TableFacts,
  questionSet: QuestionSet,
  key: CaptureTable["key"] | string,
): Promise<LostMarks | undefined> {
  const columns = unmarkedCopies(table, questionSet);
  if (columns.length === 0 || !(await rebuilt(query, table))) {
    return undefined;
  }
  const one = columns.length === 1;
  const message = `${table.name} has ${one ? "a column" : "columns"} named ${inWords(columns)} with FacetDB's ${one ? "name and type" : "names and types"} but without FacetDB's mark (${COLUMN_MARK} in the table's definition), on a table FacetDB installed for this project where no column carries the mark any more and FacetDB's two triggers are gone: the table was rebuilt since (a new table, the rows copied, the old one dropped and the new one renamed, as an ORM migration that copies every column does, or a hand-written create table … as select), which copies columns and their values but not their marks and drops the triggers, so changes made since were not queued. SQLite cannot mark a column without rebuilding the table again, and FacetDB never adopts an unmarked column: it may be the application's own.`;
  const unlessOwn = `If the application made ${one ? "this column" : "these columns"} itself, rename the question or the column instead.`;
  if (typeof key === "string") {
    return {
      columns,
      message,
      fix: `The rebuild left the table without the key FacetDB keys its records by: ${key} Then run facetdb migrate again: it names the rest of the recovery. ${unlessOwn}`,
    };
  }
  const names = triggerNames(table.name);
  const blockers = await dropBlockers(query, table, columns, [names.insert, names.update]);
  const first =
    blockers.length === 0
      ? ""
      : `First, ${inWords(blockers.map(({ by, columns: used }) => `${by} uses ${inWords(used)}`))}, and SQLite cannot drop a column in use: drop or change ${blockers.length === 1 ? "it" : "them"}. `;
  const quoted = quoteIdent(table.name);
  // Nothing is queued, with or without a facetdb_updated_at copy. The worker writing a queued
  // record back from the log would run its actions again (webhooks, plugins); `facetdb backfill
  // --from-log` writes every answered record back with none, and names the rest.
  const script = [
    "begin immediate;",
    ...columns.map((column) => `alter table ${quoted} drop column ${quoteIdent(column)};`),
    "commit;",
  ];
  return {
    columns,
    message,
    fix: [
      `${first}Nothing is lost: the decision log keeps every answer and every human decision (facetdb explain shows a record's). Stop facetdb worker, then run this on the database; it drops the ${one ? "copy" : "copies"}:`,
      ...script.map((line) => `  ${line}`),
      `Then run facetdb migrate, which adds the ${one ? "column" : "columns"} back, marked, with the triggers, and then facetdb backfill --from-log, which writes each answered record's latest logged decision back, a person's included, without asking the model or running any action, and names what is left for facetdb backfill. Then start facetdb worker again. ${unlessOwn}`,
    ].join("\n"),
  };
}
