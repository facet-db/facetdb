import {
  type AnswerColumnKind,
  answerColumns,
  type OnChange,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { quoteIdent, quoteTable } from "../sql/index.ts";

/** The stored hash of the state a decision was made on; the polling connector's whole memory. */
export const STATE_HASH_COLUMN = "facetdb_state_hash";

/**
 * The column comment install puts on every column it adds. It is how a later install tells
 * FacetDB's own columns from the application's: an existing column without it is a collision and
 * install refuses; one with it is adopted, which keeps install idempotent.
 */
export const OWNED_MARK = "facetdb";

/** The table a polling connector watches and where its columns live (inline mode). */
export type PollingSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string;
  /** The single-column primary key (a composite key is refused at migrate). */
  readonly key: string;
  /** Defaults to `reset`: a changed record goes back to pending until the new decision lands. */
  readonly onChange?: OnChange;
};

const SQL_TYPES: Readonly<Record<AnswerColumnKind, string>> = {
  boolean: "boolean",
  text: "text",
  real: "real",
  json: "jsonb",
};

/** The columns the polling variant adds besides the answers, in install order. */
const STATUS_COLUMNS: readonly (readonly [string, string])[] = [
  [STATUS_COLUMN, "text"],
  [UPDATED_AT_COLUMN, "timestamptz"],
  [REVIEWED_COLUMN, "boolean default false"],
  [STATE_HASH_COLUMN, "text"],
];

/** Every column FacetDB owns on the table under this question set, answers first. */
export function pollingOwnedColumns(questionSet: QuestionSet): readonly string[] {
  return [
    ...questionSet.questions.flatMap((question) => answerColumns(question).map(({ name }) => name)),
    ...STATUS_COLUMNS.map(([name]) => name),
  ];
}

/**
 * The install variant for a database that forbids triggers or has no jobs table: the answer and
 * status columns plus `facetdb_state_hash`, no trigger, no jobs table. Idempotent
 * (`add column if not exists`, after `pollingCollisionQuery` found no column of the application's
 * in the way); every column is marked as FacetDB's. No value is interpolated, identifiers are
 * quoted.
 */
export function pollingInstallSql(source: PollingSource, questionSet: QuestionSet): string[] {
  const table = quoteTable({ schema: source.schema, name: source.table });
  const columns = [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map(({ name, kind }): readonly [string, string] => [
        name,
        SQL_TYPES[kind],
      ]),
    ),
    ...STATUS_COLUMNS,
  ];
  return [
    `alter table ${table}\n${columns
      .map(([name, type]) => `  add column if not exists ${quoteIdent(name)} ${type}`)
      .join(",\n")}`,
    ...columns.map(([name]) => `comment on column ${table}.${quoteIdent(name)} is '${OWNED_MARK}'`),
  ];
}

/**
 * The columns of the table whose names FacetDB owns under this question set, split by the mark:
 * `marked: false` lists the application's own (install refuses when there is any, so a
 * question named like an app column never has that column overwritten by `write`); `marked: true`
 * lists FacetDB's (the only ones uninstall drops). Values are parameters; the table name reaches
 * `regclass` through `format('%I.%I')`, so a quoted or mixed-case name is one identifier.
 */
export function pollingOwnedColumnsQuery(
  source: PollingSource,
  questionSet: QuestionSet,
  options: { readonly marked: boolean },
): { readonly text: string; readonly params: readonly unknown[] } {
  return {
    text: `select c.column_name as name
  from information_schema.columns c
 where c.table_schema = $1 and c.table_name = $2 and c.column_name = any($3::text[])
   and (coalesce(col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position), '') = $4) = $5
 order by c.ordinal_position`,
    params: [
      source.schema ?? "public",
      source.table,
      pollingOwnedColumns(questionSet),
      OWNED_MARK,
      options.marked,
    ],
  };
}

/**
 * Removes exactly what install added: `columns` are the marked ones `pollingOwnedColumnsQuery`
 * found, never a name alone, so a column of the application's that shares a question's name
 * survives with its data. Nothing to drop gives no statement.
 */
export function pollingUninstallSql(source: PollingSource, columns: readonly string[]): string[] {
  if (columns.length === 0) {
    return [];
  }
  return [
    `alter table ${quoteTable({ schema: source.schema, name: source.table })}\n${columns
      .map((name) => `  drop column if exists ${quoteIdent(name)}`)
      .join(",\n")}`,
  ];
}
