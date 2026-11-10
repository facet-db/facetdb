import {
  type AnswerColumnKind,
  answerColumns,
  type OnChange,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { OWNED_MARK } from "../polling/index.ts";
import { JOBS_TABLE, jobsTableSql, quoteIdent, quoteLiteral, quoteTable } from "../sql/index.ts";

/**
 * The install SQL for a table source. One generator, one order of statements; `migrate` prints
 * what this returns and runs exactly that.
 * Every identifier from the config goes through `quoteIdent`; every value, and every name that a
 * `do` block needs, travels as a parameter (a `$$` body cannot quote a name safely, so names reach
 * it through `set_config` and `current_setting`, never through its text); the only literals left in
 * DDL are the trigger's two arguments, which go through `quoteLiteral` in a plain statement.
 */

/** The table a source watches and where its columns live (inline mode). */
export type TableSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string;
  /** The single-column primary key; `migrate` reads it from the catalog and refuses a composite one. */
  readonly key: string;
  /** Defaults to `reset`: a changed record goes back to pending until the new decision lands. */
  readonly onChange?: OnChange;
};

/** The project that owns the install: the marker `migrate` checks before touching a table. */
export type ProjectRef = {
  readonly id: string;
  readonly name: string;
};

/**
 * One statement as `migrate` runs it: text with `$n` placeholders and the parameters for them.
 * `redacted` marks a statement whose parameter is a secret (the worker password): the printed
 * script shows a placeholder for it and nothing else ever renders it.
 */
export type InstallStatement = {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly redacted?: boolean;
};

/** The one login FacetDB creates in a customer's database; the only credential it ever stores. */
export const WORKER_ROLE = "facetdb_worker";

/**
 * The owner of the trigger functions: a role that cannot log in and may only insert into the
 * queue. A `security definer` function runs as its owner, so whatever a row's column types do when
 * the key is read happens with these rights, not the admin's.
 */
export const ENQUEUE_ROLE = "facetdb_enqueue";

/**
 * Transaction-local settings that carry values into the `do` blocks, which take no parameter:
 * the worker password (`create role` is DDL) and the source's schema and table (a `$$` body cannot
 * quote a name). Each is set by `set_config($n, true)` and read by `current_setting`.
 */
export const PASSWORD_SETTING = "facetdb.worker_password";
const SCHEMA_SETTING = "facetdb.install_schema";
const TABLE_SETTING = "facetdb.install_table";

const SCHEMA = "facetdb";
const PROJECTS_TABLE = `${quoteIdent(SCHEMA)}.${quoteIdent("projects")}`;
const OWNERS_TABLE = `${quoteIdent(SCHEMA)}.${quoteIdent("table_owners")}`;
const ENQUEUE_FUNCTIONS: Readonly<Record<OnChange, string>> = {
  reset: "enqueue",
  keep: "enqueue_keep",
};

const SQL_TYPES: Readonly<Record<AnswerColumnKind, string>> = {
  boolean: "boolean",
  text: "text",
  real: "real",
  json: "jsonb",
};

/**
 * FacetDB's own columns on every record, in install order. `facetdb_status` is not null with the
 * pending default so that the generated `facetdb types` declaration (non-null) and the table agree,
 * and a row inserted by the app without the trigger (a bulk load) still reads as pending.
 */
const STATUS_COLUMNS: readonly (readonly [string, string])[] = [
  [STATUS_COLUMN, "text not null default 'pending'"],
  [UPDATED_AT_COLUMN, "timestamptz"],
  [REVIEWED_COLUMN, "boolean not null default false"],
];

/** Every column FacetDB owns on the table under this question set, answers first. */
export function installOwnedColumns(questionSet: QuestionSet): readonly string[] {
  return ownedColumnDefinitions(questionSet).map(([name]) => name);
}

function ownedColumnDefinitions(questionSet: QuestionSet): readonly (readonly [string, string])[] {
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

/** The trigger's name on a table: FacetDB's prefix and the table's name. */
export function triggerName(source: TableSource): string {
  return `facetdb_${source.table}`;
}

/**
 * What the trigger writes into `facetdb.jobs` for a record: the table's qualified name, a colon
 * and the key as text (`::text`, so a numeric key reads `42` and a uuid its canonical form; the
 * connector runtime compares keys in that form). The queue table is shared by every table of the
 * database (and by the store, which prefixes its sources the same way), so a bare key from two
 * tables would collide; the runtime claims with this prefix (`jobsQueries.claim`, `$1`).
 */
export function queueKeyPrefix(source: TableSource): string {
  return `${source.schema ?? "public"}.${source.table}:`;
}

function functionName(onChange: OnChange): string {
  return `${quoteIdent(SCHEMA)}.${quoteIdent(ENQUEUE_FUNCTIONS[onChange])}`;
}

/**
 * The two trigger functions, installed together so switching a source's `onChange` later changes
 * only the trigger. Both run as `facetdb_enqueue` with an empty search path (pg_catalog is
 * implicit), read only the key column named in the trigger's first argument (never the whole row:
 * converting every column would run every column type's code as the definer), insert the prefixed
 * key with `on conflict do nothing` (several changes before the worker arrives are asked once) and
 * notify, all inside the app's transaction. `enqueue` sets the status back to pending;
 * `enqueue_keep` leaves it, so a decided record keeps its decision until the new one lands.
 */
function enqueueFunctions(): readonly string[] {
  const body = (
    onChange: OnChange,
  ) => `create or replace function ${functionName(onChange)}() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
${onChange === "reset" ? `  new.${quoteIdent(STATUS_COLUMN)} := 'pending';\n` : ""}  insert into ${JOBS_TABLE} (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do nothing;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$`;
  return [body("reset"), body("keep")];
}

/**
 * The ordered statements that install a table source, idempotent as a whole: `if not exists` and
 * `or replace` everywhere, the trigger dropped and recreated (Postgres 13 has no `create or replace
 * trigger`), the roles and the policies created only when absent. Running it twice changes nothing;
 * a password given on a later run resets the worker's password and nothing else.
 */
export function installSql(
  source: TableSource,
  questionSet: QuestionSet,
  project: ProjectRef,
  options: { readonly workerPassword?: string } = {},
): readonly InstallStatement[] {
  const schema = source.schema ?? "public";
  const table = quoteTable({ schema, name: source.table });
  const columns = ownedColumnDefinitions(questionSet);
  const owned = columns.map(([name]) => name);
  const stateColumns = questionSet.read;
  const worker = quoteIdent(WORKER_ROLE);
  const enqueuer = quoteIdent(ENQUEUE_ROLE);
  const plain = (text: string): InstallStatement => ({ text, params: [] });
  const policy = (name: string, command: "select" | "update") =>
    `  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('${SCHEMA_SETTING}')
                   and tablename = current_setting('${TABLE_SETTING}')
                   and policyname = ${quoteLiteral(name)}) then
    execute format('create policy %I on %I.%I for ${command} to %I using (true)',
                   ${quoteLiteral(name)}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), ${quoteLiteral(WORKER_ROLE)});
  end if;`;

  return [
    // The literal rules this script relies on, pinned for the transaction whatever the server's
    // default: a backslash inside a quoted name is a backslash.
    plain("set local standard_conforming_strings = on"),
    // The schema and the queue, shared with the store: one definition (sql/jobs.ts).
    ...jobsTableSql().map(plain),
    // The project marker: which project installed on which table.
    plain(`create table if not exists ${PROJECTS_TABLE} (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
)`),
    plain(`create table if not exists ${OWNERS_TABLE} (
  table_schema text not null,
  table_name text not null,
  project_id text not null references ${PROJECTS_TABLE} (id),
  installed_at timestamptz not null default now(),
  primary key (table_schema, table_name)
)`),
    {
      text: `insert into ${PROJECTS_TABLE} (id, name) values ($1, $2) on conflict (id) do nothing`,
      params: [project.id, project.name],
    },
    {
      text: `insert into ${OWNERS_TABLE} (table_schema, table_name, project_id) values ($1, $2, $3) on conflict (table_schema, table_name) do nothing`,
      params: [schema, source.table, project.id],
    },
    // The answer and status columns, marked as FacetDB's (a later install adopts marked columns
    // and refuses unmarked ones; uninstall drops only marked ones).
    plain(
      `alter table ${table}\n${columns
        .map(([name, type]) => `  add column if not exists ${quoteIdent(name)} ${type}`)
        .join(",\n")}`,
    ),
    ...owned.map((name) =>
      plain(`comment on column ${table}.${quoteIdent(name)} is '${OWNED_MARK}'`),
    ),
    // The owner of the trigger functions: no login, insert on the queue and nothing else. The
    // admin takes membership so it can hand the functions over (and can again on a later run).
    plain(`do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(ENQUEUE_ROLE)}) then
    execute format('create role %I nologin', ${quoteLiteral(ENQUEUE_ROLE)});
  end if;
end $$`),
    plain(`grant ${enqueuer} to current_user`),
    plain(`grant usage on schema ${quoteIdent(SCHEMA)} to ${enqueuer}`),
    plain(`grant insert on ${JOBS_TABLE} to ${enqueuer}`),
    // `on conflict (record_key)` reads the arbiter column, so the inserter needs select on it.
    plain(`grant select (record_key) on ${JOBS_TABLE} to ${enqueuer}`),
    // Change capture: the functions and the trigger on the state columns only.
    ...enqueueFunctions().map(plain),
    // A new owner must hold CREATE on the function's schema (a superuser skips that check, a
    // customer's admin on RDS, Supabase or Neon does not); granted for the hand-over and revoked.
    plain(`grant create on schema ${quoteIdent(SCHEMA)} to ${enqueuer}`),
    plain(`alter function ${functionName("reset")}() owner to ${enqueuer}`),
    plain(`alter function ${functionName("keep")}() owner to ${enqueuer}`),
    plain(`revoke create on schema ${quoteIdent(SCHEMA)} from ${enqueuer}`),
    plain(`drop trigger if exists ${quoteIdent(triggerName(source))} on ${table}`),
    plain(
      `create trigger ${quoteIdent(triggerName(source))} before insert or update of ${stateColumns
        .map(quoteIdent)
        .join(", ")}
  on ${table} for each row execute function ${functionName(source.onChange ?? "reset")}(${quoteLiteral(source.key)}, ${quoteLiteral(queueKeyPrefix(source))})`,
    ),
    // The worker login: created once; a password given later resets it. The password
    // never appears in SQL text; without one, an existing role is left as it is.
    ...(options.workerPassword === undefined
      ? []
      : [
          {
            text: `select set_config('${PASSWORD_SETTING}', $1, true)`,
            params: [options.workerPassword],
            redacted: true,
          },
        ]),
    plain(`do $$
declare
  password text := nullif(current_setting('${PASSWORD_SETTING}', true), '');
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(WORKER_ROLE)}) then
    if password is null then
      raise exception 'FacetDB: the worker login ${WORKER_ROLE} does not exist and no password was given for it';
    end if;
    execute format('create role %I login password %L', ${quoteLiteral(WORKER_ROLE)}, password);
  elsif password is not null then
    execute format('alter role %I with login password %L', ${quoteLiteral(WORKER_ROLE)}, password);
  end if;
end $$`),
    // The least permission that works: read the key, the state columns and FacetDB's own columns
    // (an `update … where facetdb_reviewed = false` needs select on the column it tests); write
    // only FacetDB's own columns; on the queue, select and delete, plus insert
    // and update because claims are updates and a backfill enqueues (sql/jobs.ts).
    plain(`grant usage on schema ${quoteIdent(schema)} to ${worker}`),
    plain(
      `grant select (${[source.key, ...stateColumns.filter((c) => c !== source.key), ...owned]
        .map(quoteIdent)
        .join(", ")})
  on ${table} to ${worker}`,
    ),
    plain(`grant update (${owned.map(quoteIdent).join(", ")})\n  on ${table} to ${worker}`),
    // The policies, for a table with row-level security on: the names reach the block as settings.
    {
      text: `select set_config('${SCHEMA_SETTING}', $1, true), set_config('${TABLE_SETTING}', $2, true)`,
      params: [schema, source.table],
    },
    plain(`do $$
begin
${policy("facetdb_reads", "select")}
${policy("facetdb_writes", "update")}
end $$`),
    plain(`grant usage on schema ${quoteIdent(SCHEMA)} to ${worker}`),
    plain(`grant select, insert, update, delete on ${JOBS_TABLE} to ${worker}`),
  ];
}

/**
 * The script as `facetdb migrate` prints it before running anything: the statements in
 * order, each parameter shown as the literal it will be bound to, a redacted one as a placeholder.
 * A `$n` is replaced only in statements that have parameters, so a `$$` body is never touched.
 */
export function renderSql(statements: readonly InstallStatement[]): string {
  return `${statements.map(renderStatement).join(";\n\n")};\n`;
}

function renderStatement(statement: InstallStatement): string {
  if (statement.params.length === 0) {
    return statement.text;
  }
  return statement.text.replaceAll(/\$(\d+)/g, (_, index: string) => {
    if (statement.redacted) {
      return "'<the worker password, never printed>'";
    }
    const value = statement.params[Number(index) - 1];
    return quoteLiteral(String(value));
  });
}

/**
 * Which of the names FacetDB would own on the table already exist, split by the mark: `marked:
 * false` lists the application's own columns (install refuses when there is any); `marked:
 * true` lists FacetDB's from an earlier install (adopted, which keeps install idempotent). Values
 * are parameters; the table reaches `regclass` through `format('%I.%I')`.
 */
export function ownedColumnsQuery(
  source: Pick<TableSource, "table" | "schema">,
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
      installOwnedColumns(questionSet),
      OWNED_MARK,
      options.marked,
    ],
  };
}
