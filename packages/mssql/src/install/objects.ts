import {
  type AnswerColumnKind,
  answerColumns,
  type EngineTarget,
  type PlanStatement,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  type StatementPurpose,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { qualifiedName } from "../sql/index.ts";

/**
 * What FacetDB adds to a SQL Server or Azure SQL database, by name and type. Everything carries the
 * `facetdb_` prefix, so `facetdb uninstall` finds all of it: the answer and status columns on the
 * table, each marked as FacetDB's; the table's trigger `facetdb_<table>` beside it; and once per
 * database, in `dbo` (the schema every database has), the queue `facetdb_jobs` every watched table
 * shares and the project marker `facetdb_table_owners`; and the worker user `facetdb_worker`, the
 * one credential FacetDB keeps.
 */

/** The schema of a table the config names without one (`EngineTarget.schema`). */
export const DEFAULT_SCHEMA = "dbo";

/** Where the database's one queue and one marker live: the schema every database has. */
export const SHARED_SCHEMA = "dbo";

/** The one user FacetDB creates (and on a server without containment, its login of the same name). */
export const WORKER_USER = "facetdb_worker";

/** The queue every watched table of the database shares. */
export const JOBS_TABLE = "facetdb_jobs";

/** The project marker: which project installed on which table of the database. */
export const MARKER_TABLE = "facetdb_table_owners";

/**
 * The longest name a job's `table_name` holds: the table as `[schema].[table]`, the brackets
 * keeping a `.` in a name from making two tables one (`[a.b].[c]` and `[a].[b.c]`).
 */
export const QUEUE_NAME_LENGTH = 128;

/**
 * The longest key a job's `record_key` holds, as text. The queue's primary key is the pair
 * (`table_name`, `record_key`), clustered, and a clustered key holds at most 900 bytes:
 * `table_name`, nvarchar(128), takes 256 of them, and the 644 left are 322 characters.
 */
export const QUEUE_KEY_LENGTH = 322;

/**
 * The collation the queue compares keys in: by code point, so two keys that differ only in case
 * stay two jobs where the table's own collation tells them apart.
 */
export const QUEUE_KEY_COLLATION = "Latin1_General_100_BIN2";

/**
 * The extended property that marks a column as FacetDB's, as Postgres marks one with a comment: a
 * later install adopts a marked column and refuses an unmarked one of the same name, and uninstall
 * and prune drop marked columns only.
 */
export const COLUMN_MARK = "facetdb";

/** SQL Server's longest name (`sysname`). */
export const NAME_LIMIT = 128;

/**
 * The column that marks when a record was created, when the table has one: `scan` orders by it,
 * so prune never takes back a read of it that the worker holds.
 */
export const CREATION_COLUMN = "created_at";

/** The table's trigger, in the table's schema. */
export function triggerName(table: string): string {
  return `facetdb_${table}`;
}

/** A source table and the names of what FacetDB adds for it. */
export type TableNames = {
  readonly schema: string;
  readonly table: string;
  /** `dbo.listings`, as the words name it. */
  readonly label: string;
  /** `[dbo].[listings]`: in SQL, and the name the table's jobs carry in the queue's `table_name`. */
  readonly relation: string;
  /** `facetdb_listings`, bare, in the table's schema. */
  readonly trigger: string;
  /** `[dbo].[facetdb_listings]` */
  readonly triggerRelation: string;
  /** `[dbo].[facetdb_jobs]` */
  readonly jobsRelation: string;
  /** `[dbo].[facetdb_table_owners]` */
  readonly markerRelation: string;
};

export function tableNames(target: Pick<EngineTarget, "schema" | "table">): TableNames {
  const schema = target.schema ?? DEFAULT_SCHEMA;
  const { table } = target;
  return {
    schema,
    table,
    label: `${schema}.${table}`,
    relation: qualifiedName(schema, table),
    trigger: triggerName(table),
    triggerRelation: qualifiedName(schema, triggerName(table)),
    jobsRelation: qualifiedName(SHARED_SCHEMA, JOBS_TABLE),
    markerRelation: qualifiedName(SHARED_SCHEMA, MARKER_TABLE),
  };
}

/** A column FacetDB owns on the table, with its SQL Server type. */
export type OwnedColumn = { readonly name: string; readonly type: string };

/** The question types, in SQL Server's types: `real`, never `float`. */
const ANSWER_TYPES: Readonly<Record<AnswerColumnKind, string>> = {
  boolean: "bit",
  text: "nvarchar(255)",
  real: "real",
  // `<name>_probabilities`, only with `storeProbabilities`: JSON in text, as SQL Server keeps it.
  json: "nvarchar(max)",
};

/**
 * FacetDB's own columns on every record. Nullable with no default, where every other engine has
 * `facetdb_status not null default 'pending'` and `facetdb_reviewed not null default false`: on SQL
 * Server Standard, adding a `not null` column with a default rewrites every row of the table under
 * its lock, while a nullable one is a change of the catalog alone. So the rows a table has at
 * install, and a row the trigger never saw (a bulk load without FIRE_TRIGGERS), read NULL: NULL is
 * pending, and not reviewed. The runtime connector reads it so in `current`, in its counts and in
 * its scans; the plan's notes tell the operator.
 */
const STATUS_COLUMNS: readonly OwnedColumn[] = [
  { name: STATUS_COLUMN, type: "varchar(16)" },
  { name: UPDATED_AT_COLUMN, type: "datetime2(3)" },
  { name: REVIEWED_COLUMN, type: "bit" },
];

/** Every column FacetDB owns on the table under this question set, answers first, in install order. */
export function ownedColumns(questionSet: QuestionSet): readonly OwnedColumn[] {
  return [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map(({ name, kind }) => ({ name, type: ANSWER_TYPES[kind] })),
    ),
    ...STATUS_COLUMNS,
  ];
}

/** One statement of a plan: every one serves the source's database (the store is Postgres). */
export function sourceStatement(purpose: StatementPurpose, text: string): PlanStatement {
  return { database: "source", purpose, text };
}
