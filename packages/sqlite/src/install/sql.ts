import {
  type AnswerColumnKind,
  answerColumns,
  type OnChange,
  type PlanStatement,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  type StatementPurpose,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { quoteIdent, quoteLiteral } from "../sql/index.ts";

/**
 * The SQL FacetDB writes into a SQLite file ("SQLite and libSQL: trigger and `facetdb_jobs` table
 * ... inline columns"), for install, uninstall and prune alike. Every statement is plain text with
 * its values as literals, so what the operator reads is what runs; every identifier goes through
 * `quoteIdent`; everything FacetDB adds carries the `facetdb_` prefix.
 */

/** The prefix of everything FacetDB adds to a database. */
const PREFIX = "facetdb_";

/**
 * The queue: one row per queued record of every installed table of the file, so a key is scoped by
 * its table (key 1 of two tables is two jobs). The key is text, as core's `RecordKey`: an integer key
 * is stored as '42' and still equals 42 against the table's own integer column, since SQLite applies
 * that column's affinity when it compares.
 */
export const JOBS_TABLE = "facetdb_jobs";

/** The marker: which project installed on which table, one row per installed table. */
export const OWNERS_TABLE = "facetdb_table_owners";

/**
 * How FacetDB marks each column it adds, as Postgres marks one with a comment on the column: a
 * comment inside the column's definition, between its name and its type, which SQLite keeps
 * verbatim in the table's stored `create table` text. The mark lives and dies with the column: it
 * survives other columns' drops and renames and a rename of the table, and a column the application
 * rebuilds or drops and adds again under the same name has none, so it is the application's: never
 * adopted, never dropped.
 */
export const COLUMN_MARK = "/* facetdb */";

/** The queue's index, for a claim's oldest-first scan of one table's jobs. */
const JOBS_INDEX = "facetdb_jobs_queue";

/**
 * The database's clock as ISO 8601 UTC with milliseconds, the form `Date.toISOString` writes, so the
 * times the worker writes from its own clock and the ones SQLite writes compare as text.
 */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

function statement(purpose: StatementPurpose, text: string): PlanStatement {
  return { database: "source", purpose, text };
}

/**
 * An install's first statement, run before the transaction opens: WAL, so the application and the
 * worker never block each other. SQLite refuses to change the journal mode inside a transaction,
 * and the mode is persistent: set once, it stays with the file.
 */
export const JOURNAL_MODE: PlanStatement = statement(
  "settings",
  `-- WAL: readers never wait for the writer and the writer never waits for readers, so the
-- application and the FacetDB worker do not block each other. The mode is persistent (the file
-- keeps it after this script), and SQLite cannot change it inside a transaction, so it runs
-- before begin.
pragma journal_mode = wal`,
);

/** Whether a statement runs before the transaction opens: the journal mode, which cannot run in one. */
export function beforeTransaction(planned: PlanStatement): boolean {
  return planned.text === JOURNAL_MODE.text;
}

/** SQLite's type for each kind of answer column: booleans 0 or 1, JSON as text. */
const SQL_TYPES: Readonly<Record<AnswerColumnKind, string>> = {
  boolean: "integer",
  text: "text",
  real: "real",
  json: "text",
};

/**
 * FacetDB's own columns on every record, in install order. The status is not null with the pending
 * default, as on Postgres, so a row the application inserts with no trigger yet (a bulk load) reads
 * as pending; the time is ISO text in `NOW`'s form; reviewed is 0 or 1.
 */
const STATUS_COLUMNS: readonly (readonly [string, string])[] = [
  [STATUS_COLUMN, "text not null default 'pending'"],
  [UPDATED_AT_COLUMN, "text"],
  [REVIEWED_COLUMN, "integer not null default 0"],
];

/** Every column FacetDB owns on a table under this question set, with its definition, answers first. */
export function ownedColumns(
  questionSet: QuestionSet,
): readonly (readonly [name: string, definition: string])[] {
  return [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map(({ name, kind }): readonly [string, string] => [
        name,
        SQL_TYPES[kind],
      ]),
    ),
    ...STATUS_COLUMNS,
  ];
}

/** The type a column of this definition reads back with from `pragma table_info`, in lower case. */
export function declaredType(definition: string): string {
  return definition.split(" ")[0] ?? definition;
}

/** The queue and its index, `if not exists`: every table's install runs them. */
export function jobsTableStatements(): readonly PlanStatement[] {
  return [
    statement(
      "queue",
      `create table if not exists ${quoteIdent(JOBS_TABLE)} (
  ${quoteIdent("table_name")} text not null,
  ${quoteIdent("record_key")} text not null,
  ${quoteIdent("enqueued_at")} text not null default ${NOW},
  ${quoteIdent("claimed_by")} text,
  ${quoteIdent("claimed_at")} text,
  primary key (${quoteIdent("table_name")}, ${quoteIdent("record_key")})
)`,
    ),
    statement(
      "queue",
      `create index if not exists ${quoteIdent(JOBS_INDEX)} on ${quoteIdent(JOBS_TABLE)} (${quoteIdent("table_name")}, ${quoteIdent("enqueued_at")})`,
    ),
  ];
}

/**
 * The marker table. `worker_id` and `heartbeat_at` hold the one worker's lock, which the runtime
 * connector takes and renews.
 */
export function ownersTableStatement(): PlanStatement {
  return statement(
    "marker",
    `create table if not exists ${quoteIdent(OWNERS_TABLE)} (
  ${quoteIdent("table_name")} text primary key,
  ${quoteIdent("project_id")} text not null,
  ${quoteIdent("installed_at")} text not null default ${NOW},
  ${quoteIdent("worker_id")} text,
  ${quoteIdent("heartbeat_at")} text
)`,
  );
}

/**
 * The claim: the table is this project's. A row another project put there first stays as it is, and
 * `run`, which reads the owner inside the transaction before any statement, stops.
 */
export function claimStatement(table: string, projectId: string): PlanStatement {
  return statement(
    "marker",
    `insert or ignore into ${quoteIdent(OWNERS_TABLE)} (${quoteIdent("table_name")}, ${quoteIdent("project_id")}) values (${quoteLiteral(table)}, ${quoteLiteral(projectId)})`,
  );
}

/** A column's definition as FacetDB writes it: its name, `COLUMN_MARK`, its type and constraints. */
function markedDefinition(name: string, definition: string): string {
  return `${quoteIdent(name)} ${COLUMN_MARK} ${definition}`;
}

/** One column, marked: SQLite adds one per `alter table`, and has no `add column if not exists`. */
export function addColumnStatement(table: string, name: string, definition: string): PlanStatement {
  return statement(
    "columns",
    `alter table ${quoteIdent(table)} add column ${markedDefinition(name, definition)}`,
  );
}

/**
 * Whether a table's stored `create table` text holds FacetDB's mark on this column, as
 * `addColumnStatement` wrote it: the quoted name, a space and `COLUMN_MARK`, at the start of a
 * definition (after `(`, `,` or a space, never inside another quoted name). Only FacetDB writes the
 * mark, so these side by side are FacetDB's column, and nothing else is.
 */
export function markedIn(tableSql: string, column: string): boolean {
  const written = `${quoteIdent(column)} ${COLUMN_MARK}`;
  for (let at = tableSql.indexOf(written); at !== -1; at = tableSql.indexOf(written, at + 1)) {
    if (at === 0 || /[\s(,]/.test(tableSql.charAt(at - 1))) {
      return true;
    }
  }
  return false;
}

/** The two triggers on a table: FacetDB's prefix, the table's name, and what fires each. */
export function triggerNames(table: string): { readonly insert: string; readonly update: string } {
  return { insert: `${PREFIX}${table}_ins`, update: `${PREFIX}${table}_upd` };
}

/** What the change capture needs of a table. */
export type CaptureTable = {
  /** The table's name as the file declares it. */
  readonly table: string;
  /** The key column, or the rowid itself for a table keyed by its rowid. */
  readonly key: { readonly kind: "column"; readonly name: string } | { readonly kind: "rowid" };
  /** A WITHOUT ROWID table has no rowid: the status update finds the row by its key instead. */
  readonly withoutRowid: boolean;
  /** The state fields: an update of one of them queues the record. */
  readonly state: readonly string[];
  readonly onChange: OnChange;
};

/**
 * What both triggers do, inside the application's own transaction: on `reset`, the record goes back
 * to pending (only when it is not pending already, so nothing is written needlessly, as Postgres's
 * side-table trigger does); then its key is queued once. A key queued already stays one row
 *, and a change while a worker holds the job clears the claim, as on Postgres: that worker's
 * ack deletes only its own claim, so the job stays for the new state to be asked. The status update
 * sets no state column, so it fires neither trigger again (no `recursive_triggers` needed either way).
 */
function enqueueBody(capture: CaptureTable): string {
  const table = quoteIdent(capture.table);
  const status = quoteIdent(STATUS_COLUMN);
  const key = capture.key.kind === "rowid" ? "new.rowid" : `new.${quoteIdent(capture.key.name)}`;
  const row =
    capture.withoutRowid && capture.key.kind === "column"
      ? `${quoteIdent(capture.key.name)} = ${key}`
      : "rowid = new.rowid";
  return [
    "begin",
    ...(capture.onChange === "reset"
      ? [`  update ${table} set ${status} = 'pending' where ${row} and ${status} is not 'pending';`]
      : []),
    `  insert into ${quoteIdent(JOBS_TABLE)} (${quoteIdent("table_name")}, ${quoteIdent("record_key")}) values (${quoteLiteral(capture.table)}, ${key})`,
    `    on conflict (${quoteIdent("table_name")}, ${quoteIdent("record_key")}) do update set ${quoteIdent("claimed_by")} = null, ${quoteIdent("claimed_at")} = null;`,
    "end",
  ].join("\n");
}

/**
 * The change capture: `after insert`, and `after update of` the state columns only, so the worker's
 * writes to FacetDB's own columns never queue a record. Dropped and created again on every install,
 * so a changed `read` changes the trigger; SQLite has no `create or replace trigger`.
 */
export function triggerStatements(capture: CaptureTable): readonly PlanStatement[] {
  const names = triggerNames(capture.table);
  const table = quoteIdent(capture.table);
  const body = enqueueBody(capture);
  return [
    statement("capture", `drop trigger if exists ${quoteIdent(names.insert)}`),
    statement(
      "capture",
      `create trigger ${quoteIdent(names.insert)} after insert on ${table}\n${body}`,
    ),
    statement("capture", `drop trigger if exists ${quoteIdent(names.update)}`),
    statement(
      "capture",
      `create trigger ${quoteIdent(names.update)} after update of ${capture.state
        .map(quoteIdent)
        .join(", ")} on ${table}\n${body}`,
    ),
  ];
}

/** Uninstall's first statements: the change capture goes before anything it uses. */
export function dropTriggerStatements(table: string): readonly PlanStatement[] {
  const names = triggerNames(table);
  return [names.insert, names.update].map((name) =>
    statement("capture", `drop trigger if exists ${quoteIdent(name)}`),
  );
}

/** One of FacetDB's columns, never with anything else: SQLite drops one per `alter table`. */
export function dropColumnStatement(table: string, name: string): PlanStatement {
  return statement("columns", `alter table ${quoteIdent(table)} drop column ${quoteIdent(name)}`);
}

/** The table's queued jobs: its part of the shared queue. */
export function forgetJobsStatement(table: string): PlanStatement {
  return statement(
    "data",
    `delete from ${quoteIdent(JOBS_TABLE)} where ${quoteIdent("table_name")} = ${quoteLiteral(table)}`,
  );
}

/** The table's marker row. */
export function forgetOwnerStatement(table: string): PlanStatement {
  return statement(
    "marker",
    `delete from ${quoteIdent(OWNERS_TABLE)} where ${quoteIdent("table_name")} = ${quoteLiteral(table)}`,
  );
}

/**
 * How a statement that runs only when nothing still needs its object begins: SQLite has no
 * conditional DDL (Postgres decides in a `do` block), so the condition is a query printed on the
 * statement's first line, and `run` executes the statement only when that query finds no row. The
 * other tables of an uninstall run change nothing in the text (UninstallOptions.alsoUninstalling):
 * the first table's run finds the second's trigger still there and leaves the queue.
 */
const UNLESS = "-- unless this finds a row: ";

/** The query a statement waits on (`UNLESS`), or undefined for a statement that always runs. */
export function guardOf(planned: PlanStatement): string | undefined {
  if (!planned.text.startsWith(UNLESS)) {
    return undefined;
  }
  const end = planned.text.indexOf("\n");
  return planned.text.slice(UNLESS.length, end === -1 ? undefined : end);
}

/**
 * The script run by hand, which no engine checks: a guarded statement first inserts into this
 * table when its query finds a row, and the table's check fails with its own name as the message,
 * SQLite's one conditional error in plain SQL. A script run with `sqlite3 -bail` stops there,
 * before the drop, and nothing of its transaction is committed. The table is temporary: nothing of
 * it is written to the file, and it goes with the connection.
 */
const GUARD_TABLE = "facetdb_guard";

const GUARD_FAILED =
  "facetdb: another table of this file still uses it; stop and roll back, nothing of this script is committed yet";

/** What the script says above its first line when it holds a guard (render). */
export const GUARDED_SCRIPT = `-- Run by hand, run this script with sqlite3 -bail: while another table of this file still uses
-- FacetDB's shared tables, a guard below fails, and the script must stop there and roll back.
`;

function guardTableStatement(): PlanStatement {
  return statement(
    "cleanup",
    `create temp table if not exists ${quoteIdent(GUARD_TABLE)} (${quoteIdent("ok")} integer constraint ${quoteIdent(GUARD_FAILED)} check (${quoteIdent("ok")}))`,
  );
}

/** A drop that waits on `guard`: printed for `run` on its first line, enforced for a hand on its second. */
function unless(guard: string, drop: string): PlanStatement {
  return statement(
    "cleanup",
    `${UNLESS}${guard}\ninsert into temp.${quoteIdent(GUARD_TABLE)} (${quoteIdent("ok")}) select 0 where exists (${guard});\n${drop}`,
  );
}

/** The table (`tbl_name`) of each FacetDB trigger in the file that still writes to the queue. */
export const QUEUE_TRIGGERS = `select tbl_name from sqlite_master where type = 'trigger' and substr(name, 1, ${PREFIX.length}) = ${quoteLiteral(PREFIX)} and instr(sql, ${quoteLiteral(JOBS_TABLE)}) > 0`;

/**
 * FacetDB's shared tables, each dropped once nothing still needs it: the queue when no `facetdb_`
 * trigger writes to it and it holds no job, the marker table when empty. Only the ones the file has:
 * a guard on a missing table would fail.
 */
export function dropSharedStatements(present: {
  readonly jobs: boolean;
  readonly owners: boolean;
}): readonly PlanStatement[] {
  const guarded = [
    ...(present.jobs
      ? [
          unless(
            `${QUEUE_TRIGGERS} union all select 1 from ${quoteIdent(JOBS_TABLE)} limit 1`,
            `drop table if exists ${quoteIdent(JOBS_TABLE)}`,
          ),
        ]
      : []),
    ...(present.owners
      ? [
          unless(
            `select 1 from ${quoteIdent(OWNERS_TABLE)} limit 1`,
            `drop table if exists ${quoteIdent(OWNERS_TABLE)}`,
          ),
        ]
      : []),
  ];
  return guarded.length === 0 ? [] : [guardTableStatement(), ...guarded];
}
