import {
  type AnswerColumnKind,
  answerColumns,
  type OnChange,
  OWNED_MARK,
  type PlanStatement,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  type StatementPurpose,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import {
  CREATION_COLUMN,
  SIDE_TABLE_SCHEMA,
  SIDE_TABLE_SETTING,
  type StorageMode,
  sideTableEnqueuerGrants,
  sideTableName,
  sideTableReaderGrants,
  sideTableSecurityStatements,
  sideTableStatements,
  sideTableWorkerGrants,
  sideViewName,
  VIEW_NAME_SETTING,
  VIEW_SCHEMA_SETTING,
} from "../scan/index.ts";
import { JOBS_TABLE, jobsTableSql, quoteIdent, quoteLiteral, quoteTable } from "../sql/index.ts";
import {
  PROJECTS_TABLE_SQL,
  STORE_APPEND_ONLY_TABLES,
  STORE_FUNCTIONS,
  STORE_SEQUENCES,
  STORE_TABLES,
  STORE_VERSION_TABLE,
  STORE_WORKER_READ_ONLY_TABLES,
  STORE_WORKER_SET_ONCE_COLUMN,
  STORE_WORKER_UPSERT_TABLES,
  storeInstallStatements,
} from "../store/index.ts";
import { scramVerifier } from "./scram.ts";

/**
 * The install SQL for a table source. One generator, one order of statements; `migrate` prints what
 * this returns and runs exactly that. Every identifier from the config goes through `quoteIdent`;
 * every value, and every name that a `do` block needs, travels as a parameter (a `$$` body cannot
 * quote a name safely, so names reach it through `set_config` and `current_setting`, never through
 * its text); the only literals left in DDL are the trigger's two arguments, which go through
 * `quoteLiteral` in a plain statement.
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
  /**
   * Where the answers live. `inline` (default) adds the columns to the table; `side-table` leaves
   * the table alone and keeps them in `facetdb.<table>_answers` with the view
   * `<table>_with_answers`. The trigger is on the source table in both modes.
   */
  readonly storage?: StorageMode;
  /** The key column's SQL type as the catalog prints it; side-table mode needs it (`migrate` reads it). */
  readonly keyType?: string;
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
 *
 * @deprecated as an export: the engine plan's `PlanStatement` (core) replaces it for every caller
 * outside this package (`postgresEngine.planInstall`).
 */
export type InstallStatement = {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly redacted?: boolean;
  /**
   * The statement that claims the table for the project (`insert … on conflict do nothing`): `migrate`
   * reads the owner back right after it, inside the same transaction, and rolls everything back when
   * the row belongs to another project (two installs racing on one table).
   */
  readonly claimsOwner?: boolean;
  /** What part of the script it is, as the engine's plan names it. */
  readonly purpose: StatementPurpose;
  /**
   * The database it serves, by the table it serves and never by the function that wrote it: `store`
   * for the FacetDB store's own tables, which the engine plans only when the store is the source's
   * database; `source` for everything the source's database needs whatever the store.
   */
  readonly database: StatementDatabase;
};

/** The database a statement serves (`PlanStatement.database`). */
export type StatementDatabase = PlanStatement["database"];

/** A statement with no parameter, printed exactly as it runs. */
export function plain(
  purpose: StatementPurpose,
  text: string,
  database: StatementDatabase = "source",
): InstallStatement {
  return { text, params: [], purpose, database };
}

/** The one login FacetDB creates in a customer's database; the only credential it ever stores. */
export const WORKER_ROLE = "facetdb_worker";

/**
 * The owner of the trigger functions: a role that cannot log in and may only insert into the
 * queue. A `security definer` function runs as its owner, so whatever a row's column types do when
 * the key is read happens with these rights, not the admin's.
 */
export const ENQUEUE_ROLE = "facetdb_enqueue";

/**
 * A suffix on both role names, for one install's own pair of roles: the real-Postgres suites give
 * every scratch database its own (`_t3f9a1c`), so files and runs sharing one server never touch
 * each other's cluster-wide roles. Production never sets it: without one the names are the
 * constants above and the script is byte for byte what it always was.
 */
export type RoleSuffix = string;

/** Lower-case letters, digits and `_` only: the name also travels inside a `$$` body's message. */
const ROLE_SUFFIX = /^[a-z0-9_]*$/;

function suffixed(role: string, suffix: RoleSuffix): string {
  if (!ROLE_SUFFIX.test(suffix)) {
    throw new Error(`a role suffix is lower-case letters, digits and _ only, not ${suffix}`);
  }
  return `${role}${suffix}`;
}

/**
 * The worker login's name under an install's role suffix (none: `facetdb_worker`). Every statement
 * of install, migrate, prune and uninstall that names a role goes through this or `enqueueRole`.
 */
export function workerRole(suffix: RoleSuffix = ""): string {
  return suffixed(WORKER_ROLE, suffix);
}

/** The trigger functions' owner under an install's role suffix (none: `facetdb_enqueue`). */
export function enqueueRole(suffix: RoleSuffix = ""): string {
  return suffixed(ENQUEUE_ROLE, suffix);
}

/**
 * Transaction-local settings that carry values into the `do` blocks, which take no parameter:
 * the worker password (`create role` is DDL) and the source's schema and table (a `$$` body cannot
 * quote a name). Each is set by `set_config($n, true)` and read by `current_setting`.
 */
export const PASSWORD_SETTING = "facetdb.worker_password";

/**
 * The statement that gives the role block its password: a fresh SCRAM verifier bound to `$1`, so
 * neither the password nor the verifier is ever SQL text. `migrate` binds it from the plan; the
 * engine's `run` binds it at the plan's `secret` statement, whose printed text is a comment.
 */
export const PASSWORD_STATEMENT = `select set_config('${PASSWORD_SETTING}', $1, true)`;

export const SCHEMA_SETTING = "facetdb.install_schema";
export const TABLE_SETTING = "facetdb.install_table";
/** The installing project's id, for the owner check in the script (a value a `do` block cannot take). */
export const PROJECT_SETTING = "facetdb.install_project";

/**
 * The SQLSTATE the script raises when the worker still holds update or delete on the logs after
 * the revoke: `migrate` reports it as a refusal, not a failure.
 */
export const LOG_GRANTS_STATE = "FD052";

/** The refusal when another project claimed the table first: `migrate` and the script say it. */
export function anotherProject(table: string, owner: string): string {
  return `${table} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/**
 * The project a message of `anotherProject` names for this table (`schema.table`), or undefined
 * when the message is any other: the engine's `run` reads the script's own owner check by it, never
 * by a guess at the words.
 */
export function anotherProjectOwner(table: string, message: string): string | undefined {
  const marker = "\u0000";
  const template = anotherProject(table, marker);
  const at = template.indexOf(marker);
  const before = template.slice(0, at);
  const after = template.slice(at + marker.length);
  return message.length > before.length + after.length &&
    message.startsWith(before) &&
    message.endsWith(after)
    ? message.slice(before.length, message.length - after.length)
    : undefined;
}

const SCHEMA = "facetdb";
const PROJECTS_TABLE = `${quoteIdent(SCHEMA)}.${quoteIdent("projects")}`;
const OWNERS_TABLE = `${quoteIdent(SCHEMA)}.${quoteIdent("table_owners")}`;

/**
 * The store's tables the source's database needs whatever the store: the queue the triggers write
 * to, and the projects `table_owners` references. Their statements and the worker's grants on them
 * are `source`; every other store table is the store's.
 */
const SOURCE_STORE_TABLES: ReadonlySet<string> = new Set(["jobs", "projects"]);

/**
 * The store's own statements the source's database needs, by the table each one makes: the
 * `facetdb` schema, the queue and its index (`jobsTableSql`, which makes the schema too), and
 * `facetdb.projects`. Compared as text, so a statement is tagged by what it creates, never by the
 * function that listed it.
 */
const SOURCE_STORE_STATEMENTS: ReadonlyMap<string, StatementPurpose> = new Map([
  ...jobsTableSql().map((text) => [text, "queue"] as const),
  [`create schema if not exists ${quoteIdent(SCHEMA)}`, "schema"],
  [PROJECTS_TABLE_SQL, "schema"],
]);

/** One statement of the store's install script, tagged by the table it serves. */
function storeStatement(text: string): InstallStatement {
  const purpose = SOURCE_STORE_STATEMENTS.get(text);
  return purpose === undefined ? plain("schema", text, "store") : plain(purpose, text);
}
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

/**
 * The type each owned column must have, as `information_schema.columns.data_type` prints it, so
 * `migrate` can refuse a marked column whose question changed type instead of adopting it with
 * the old type (the worker's writes would fail later).
 */
export function installOwnedColumnTypes(questionSet: QuestionSet): ReadonlyMap<string, string> {
  return new Map(
    ownedColumnDefinitions(questionSet).map(([name, definition]) => {
      const base = definition.split(" ")[0] ?? definition;
      return [name, base === "timestamptz" ? "timestamp with time zone" : base];
    }),
  );
}

/** The owned columns with their SQL definitions, in install order (prune rebuilds the side view from them). */
export function ownedColumnDefinitions(
  questionSet: QuestionSet,
): readonly (readonly [string, string])[] {
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
export function triggerName(source: Pick<TableSource, "table">): string {
  return `facetdb_${source.table}`;
}

/**
 * What the trigger writes into `facetdb.jobs` for a record: `t:`, the table's qualified name, a
 * colon and the key as text (`::text`, so a numeric key reads `42` and a uuid its canonical form;
 * the connector runtime compares keys in that form). The queue table is shared by every table of
 * the database (and by the store, which prefixes its sources the same way), so a bare key from two
 * tables would collide; the runtime claims with this prefix (`jobsQueries.claim`, `$1`).
 */
export function queueKeyPrefix(source: Pick<TableSource, "table" | "schema">): string {
  // The `t:` marks a table of the customer's database; the store's prefixes begin with a digit
  // (`N:<id>:`), so a store source whose id reads `schema.table` can never share a prefix with it.
  // The length makes the prefix self-delimiting: `public.a` and a table named `a:b` can never read
  // as one another's keys (`t:8:public.a:` is not a prefix of `t:10:public.a:b:`).
  const qualified = `${source.schema ?? "public"}.${source.table}`;
  return `t:${qualified.length}:${qualified}:`;
}

function functionName(onChange: OnChange): string {
  return `${quoteIdent(SCHEMA)}.${quoteIdent(ENQUEUE_FUNCTIONS[onChange])}`;
}

const SIDE_FUNCTION = `${quoteIdent(SCHEMA)}.${quoteIdent("enqueue_side")}`;

/**
 * The two trigger functions, installed together so switching a source's `onChange` later changes
 * only the trigger. Both run as `facetdb_enqueue` with an empty search path (pg_catalog is
 * implicit), read only the key column named in the trigger's first argument (never the whole row:
 * converting every column would run every column type's code as the definer), insert the prefixed
 * key and notify, all inside the app's transaction. One row per record: several changes before a
 * worker arrives are asked once; a change while a worker holds the job clears the claim instead
 * (`on conflict … do update`), so that worker's `ack`, which deletes only its own claims, leaves the
 * job for the new state to be asked (the store's `requeue` does the same). `enqueue` sets the status back to pending;
 * `enqueue_keep` leaves it, so a decided record keeps its decision until the new one lands.
 */
function enqueueFunctions(side: boolean): readonly string[] {
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
  on conflict (record_key) do update set claimed_at = null, claimed_by = null;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$`;
  return [body("reset"), body("keep"), ...(side ? [sideBody()] : [])];
}

/**
 * `onChange: reset` in side-table mode: the source table has no status column to set, so the
 * stored status lives on the side row. Same shape as `enqueue`, with one more statement: the
 * record's side row, when it has one, goes back to pending (only when it is not pending already,
 * to write nothing needlessly). A record without a side row reads as pending through the view.
 * The arguments after the key column and the queue prefix name the side table; the function reads
 * the key only (the owner holds select on the key and status columns of the side table, nothing else).
 */
function sideBody(): string {
  const status = quoteLiteral(STATUS_COLUMN);
  return `create or replace function ${SIDE_FUNCTION}() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
  execute format('update %I.%I set %I = ''pending'' where %I = ($1).%I and %I is distinct from ''pending''',
                 tg_argv[2], tg_argv[3], ${status}, tg_argv[0], tg_argv[0], ${status}) using new;
  insert into ${JOBS_TABLE} (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do update set claimed_at = null, claimed_by = null;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$`;
}

/**
 * The ordered statements that install a table source, idempotent as a whole: `if not exists` and
 * `or replace` everywhere, the trigger dropped and recreated (Postgres 13 has no `create or replace
 * trigger`), the roles and the policies created only when absent. Running it twice changes nothing;
 * a password given on a later run resets the worker's password and nothing else.
 */
/**
 * The transaction-scoped lock of one worker login's creation, keyed on its name (`workerRole`'s
 * letters, digits and `_`, written as a literal): taken by every script that may create it.
 */
export function loginLock(login: string): string {
  return `select pg_advisory_xact_lock(hashtext(${quoteLiteral(`facetdb:login:${login}`)}))`;
}

export function installSql(
  source: TableSource,
  questionSet: QuestionSet,
  project: ProjectRef,
  options: {
    readonly workerPassword?: string;
    /** Side-table mode: roles other than the owner hold select on the source now (migrate looked). */
    readonly sourceReaders?: boolean;
    /** The install's own role names (`RoleSuffix`); tests only. */
    readonly roleSuffix?: RoleSuffix;
  } = {},
): readonly InstallStatement[] {
  const schema = source.schema ?? "public";
  const table = quoteTable({ schema, name: source.table });
  const columns = ownedColumnDefinitions(questionSet);
  const owned = columns.map(([name]) => name);
  const stateColumns = questionSet.read;
  const workerName = workerRole(options.roleSuffix);
  const enqueueName = enqueueRole(options.roleSuffix);
  const worker = quoteIdent(workerName);
  const enqueuer = quoteIdent(enqueueName);
  const side = source.storage === "side-table";
  const onChange = source.onChange ?? "reset";
  const appendOnly = new Set(STORE_APPEND_ONLY_TABLES);
  const readOnly = new Set(STORE_WORKER_READ_ONLY_TABLES);
  const upsertOnly = new Set(STORE_WORKER_UPSERT_TABLES);
  const storeRights = (name: string) =>
    readOnly.has(name)
      ? "select"
      : appendOnly.has(name)
        ? "select, insert"
        : upsertOnly.has(name)
          ? "select, insert, update"
          : "select, insert, update, delete";
  const policy = (name: string, command: "select" | "update") =>
    `  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('${SCHEMA_SETTING}')
                   and tablename = current_setting('${TABLE_SETTING}')
                   and policyname = ${quoteLiteral(name)}) then
    execute format('create policy %I on %I.%I for ${command} to %I using (true)',
                   ${quoteLiteral(name)}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), ${quoteLiteral(workerName)});
  end if;`;

  return [
    // The literal rules this script relies on, pinned for the transaction whatever the server's
    // default: a backslash inside a quoted name is a backslash.
    plain("settings", "set local standard_conforming_strings = on"),
    // The script takes ACCESS EXCLUSIVE on the customer's table (its first lock, below): better a
    // failed migrate after ten seconds than the application's queries piling up behind it.
    plain("settings", "set local lock_timeout = '10s'"),
    // A script that creates the worker login (it was absent when planned) holds the login's lock
    // for its whole transaction, first of all, so two first installs on one server (two projects)
    // run one after the other: the second, once the first commits, finds the login and stops at its
    // password statement (the engine's run) instead of resetting the first's password. The store's
    // migrations take a lock of the same family (`hashtext`).
    ...(options.workerPassword === undefined ? [] : [plain("settings", loginLock(workerName))]),
    // The customer's table, before any statement on the store's tables. Two rules keep a migrate
    // beside a live application from ever closing a lock cycle with it:
    // - This table first: its trigger takes the table, then the queue (an application insert holds
    //   the table and inserts into `facetdb.jobs`), so an application write commits before this
    //   line or waits here, at the table, holding nothing of this script's. A script that locked
    //   the queue first and the table after met a live insert in the reverse order, and Postgres
    //   ended the application's write as a deadlock victim (a live suite).
    // - After it, nothing locks what any trigger writes: every installed table of the database
    //   queues into the one `facetdb.jobs`, and an application transaction that wrote another
    //   installed table holds its lock until it commits. A statement here that waited for it (the
    //   share lock of `create index if not exists`) while holding this table would deadlock with
    //   that transaction's next write to this table, so the store's indexes and columns are looked
    //   up first and created only when missing (sql/ddl.ts), and the grants on the queue take no
    //   lock on it.
    // Access exclusive, the mode the `alter table`, `drop trigger` and policies below need anyway
    // (side-table mode too), so no later statement upgrades it. An application transaction left
    // open on this table makes this statement fail after the ten seconds above, never the
    // application's. The login's lock above stays first: it is on a name, not a table, and only
    // install takes it.
    plain("settings", `lock table ${table} in access exclusive mode`),
    // The FacetDB store's whole schema, made here by the admin so the worker login creates nothing
    // (its migrations are store/schema.ts's, one definition; the queue's table is among them).
    ...storeInstallStatements().map(storeStatement),
    // The project marker: which project installed on which table; `facetdb.projects` is the
    // store's.
    plain(
      "marker",
      `create table if not exists ${OWNERS_TABLE} (
  table_schema text not null,
  table_name text not null,
  project_id text not null references ${PROJECTS_TABLE} (id),
  installed_at timestamptz not null default now(),
  primary key (table_schema, table_name)
)`,
    ),
    {
      text: `insert into ${PROJECTS_TABLE} (id, name) values ($1, $2) on conflict (id) do nothing`,
      params: [project.id, project.name],
      purpose: "marker",
      database: "source",
    },
    {
      text: `insert into ${OWNERS_TABLE} (table_schema, table_name, project_id) values ($1, $2, $3) on conflict (table_schema, table_name) do nothing`,
      params: [schema, source.table, project.id],
      claimsOwner: true,
      purpose: "marker",
      database: "source",
    },
    // The same owner check in the script itself, so the printed script run by hand later (after
    // another project claimed the table) stops here and changes nothing. The claim above waited for
    // a racing install to finish, so the row read here is the committed owner.
    {
      text: `select set_config('${SCHEMA_SETTING}', $1, true), set_config('${TABLE_SETTING}', $2, true), set_config('${PROJECT_SETTING}', $3, true)`,
      params: [schema, source.table, project.id],
      purpose: "settings",
      database: "source",
    },
    plain(
      "marker",
      `do $$
declare
  owner text;
begin
  select o.project_id into owner from ${OWNERS_TABLE} o
   where o.table_schema = current_setting('${SCHEMA_SETTING}')
     and o.table_name = current_setting('${TABLE_SETTING}');
  if owner is distinct from current_setting('${PROJECT_SETTING}') then
    raise exception using message = format(${quoteLiteral(`FacetDB: ${anotherProject("%s.%s", "%s")}`)},
      current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), owner);
  end if;
end $$`,
    ),
    ...(side
      ? // Side-table mode: the application's table is not altered. The side table carries the
        // same columns, keyed by the same key, and the view joins them; both are FacetDB's whole.
        [
          // The view's schema and name reach the grant-saving blocks as settings (a `$$` body
          // cannot quote a name; see the password and the policies).
          {
            text: `select set_config('${VIEW_SCHEMA_SETTING}', $1, true), set_config('${VIEW_NAME_SETTING}', $2, true), set_config('${SIDE_TABLE_SETTING}', $3, true), set_config('${SCHEMA_SETTING}', $4, true), set_config('${TABLE_SETTING}', $5, true)`,
            params: [
              schema,
              sideViewName(source.table),
              sideTableName(source.table),
              schema,
              source.table,
            ],
            purpose: "settings",
            database: "source",
          } satisfies InstallStatement,
          ...sideTableStatements(source, columns).map((text) => plain("columns", text)),
          // Whoever may read the source table may read its answers: the table's readers get select
          // on the side table and usage on the schema, or the security-invoker view would refuse them.
          plain(
            "grants",
            `${
              options.sourceReaders === true
                ? // No table or schema name here: a name with a newline would end the comment and
                  // run the rest as SQL.
                  "-- Readers of the source table granted after this install need `facetdb migrate` again\n-- to see its answers view.\n"
                : ""
            }${sideTableReaderGrants()}`,
          ),
        ]
      : [
          // The answer and status columns, marked as FacetDB's (a later install adopts marked
          // columns and refuses unmarked ones; uninstall drops only marked ones).
          plain(
            "columns",
            `alter table ${table}\n${columns
              .map(([name, type]) => `  add column if not exists ${quoteIdent(name)} ${type}`)
              .join(",\n")}`,
          ),
          ...owned.map((name) =>
            plain("columns", `comment on column ${table}.${quoteIdent(name)} is '${OWNED_MARK}'`),
          ),
        ]),
    // The owner of the trigger functions: no login, insert on the queue and nothing else. The
    // admin takes membership so it can hand the functions over (and can again on a later run).
    plain(
      "capture",
      `do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(enqueueName)}) then
    execute format('create role %I nologin', ${quoteLiteral(enqueueName)});
  end if;
end $$`,
    ),
    plain("capture", `grant ${enqueuer} to current_user`),
    plain("grants", `grant usage on schema ${quoteIdent(SCHEMA)} to ${enqueuer}`),
    plain("grants", `grant insert on ${JOBS_TABLE} to ${enqueuer}`),
    // `on conflict (record_key)` reads the arbiter column, so the inserter needs select on it, and
    // its `do update` clears the claim, so it needs update on those two columns and nothing else.
    plain(
      "grants",
      `grant select (record_key), update (claimed_at, claimed_by) on ${JOBS_TABLE} to ${enqueuer}`,
    ),
    ...(side ? sideTableEnqueuerGrants(source, enqueuer).map((text) => plain("grants", text)) : []),
    // Change capture: the functions and the trigger on the state columns only.
    ...enqueueFunctions(side).map((text) => plain("capture", text)),
    // A new owner must hold CREATE on the function's schema (a superuser skips that check, a
    // customer's admin on RDS, Supabase or Neon does not); granted for the hand-over and revoked.
    plain("capture", `grant create on schema ${quoteIdent(SCHEMA)} to ${enqueuer}`),
    plain("capture", `alter function ${functionName("reset")}() owner to ${enqueuer}`),
    plain("capture", `alter function ${functionName("keep")}() owner to ${enqueuer}`),
    ...(side ? [plain("capture", `alter function ${SIDE_FUNCTION}() owner to ${enqueuer}`)] : []),
    plain("capture", `revoke create on schema ${quoteIdent(SCHEMA)} from ${enqueuer}`),
    plain("capture", `drop trigger if exists ${quoteIdent(triggerName(source))} on ${table}`),
    plain(
      "capture",
      `create trigger ${quoteIdent(triggerName(source))} before insert or update of ${stateColumns
        .map(quoteIdent)
        .join(", ")}
  on ${table} for each row execute function ${
    side && onChange === "reset" ? SIDE_FUNCTION : functionName(onChange)
  }(${[
    source.key,
    queueKeyPrefix(source),
    ...(side && onChange === "reset" ? [SIDE_TABLE_SCHEMA, sideTableName(source.table)] : []),
  ]
    .map(quoteLiteral)
    .join(", ")})`,
    ),
    // The worker login: created once; a password given later resets it. The password never appears
    // in SQL text; without one, an existing role is left as it is.
    ...(options.workerPassword === undefined
      ? []
      : [
          {
            // A SCRAM verifier, never the password: nothing the server logs or keeps in an
            // error's context can give the password back (install/scram.ts).
            text: PASSWORD_STATEMENT,
            params: [scramVerifier(options.workerPassword)],
            redacted: true,
            purpose: "login",
            database: "source",
          } satisfies InstallStatement,
        ]),
    plain(
      "login",
      `do $$
declare
  password text := nullif(current_setting('${PASSWORD_SETTING}', true), '');
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(workerName)}) then
    if password is null then
      raise exception 'FacetDB: the worker login ${workerName} does not exist and no password was given for it';
    end if;
    execute format('create role %I login password %L', ${quoteLiteral(workerName)}, password);
  elsif password is not null then
    execute format('alter role %I with login password %L', ${quoteLiteral(workerName)}, password);
  end if;
end $$`,
    ),
    // The least permission that works: read the key, the state columns and FacetDB's own columns
    // (an `update … where facetdb_reviewed = false` needs select on the column it tests); write
    // only FacetDB's own columns; on the queue, select and delete, plus insert and update because
    // claims are updates and a backfill enqueues (sql/jobs.ts).
    plain("grants", `grant usage on schema ${quoteIdent(schema)} to ${worker}`),
    // Side-table mode: the worker reads the source's key and state and writes only the side table.
    plain(
      "grants",
      `grant select (${[
        source.key,
        ...stateColumns.filter((c) => c !== source.key),
        ...(side ? [] : owned),
      ]
        .map(quoteIdent)
        .join(", ")})
  on ${table} to ${worker}`,
    ),
    ...(side
      ? sideTableWorkerGrants(source, owned, worker).map((text) => plain("grants", text))
      : [
          plain(
            "grants",
            `grant update (${owned.map(quoteIdent).join(", ")})\n  on ${table} to ${worker}`,
          ),
        ]),
    // The policies, for a table with row-level security on: the names reach the block as settings.
    {
      text: `select set_config('${SCHEMA_SETTING}', $1, true), set_config('${TABLE_SETTING}', $2, true)`,
      params: [schema, source.table],
      purpose: "settings",
      database: "source",
    },
    plain(
      "grants",
      `do $$
begin
${policy("facetdb_reads", "select")}${side ? "" : `\n${policy("facetdb_writes", "update")}`}
end $$`,
    ),
    // The creation marker, when the table has one, so `scan` can order newest first: the worker
    // reads that one column more (and cannot see a column it holds no right on, so the scan would
    // fall back to the key silently). Names reach the block as settings, as for the policies.
    plain(
      "grants",
      `do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = format('%I.%I', current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'))::regclass
                and a.attname = ${quoteLiteral(CREATION_COLUMN)} and not a.attisdropped) then
    execute format('grant select (%I) on %I.%I to %I', ${quoteLiteral(CREATION_COLUMN)}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), ${quoteLiteral(workerName)});
  end if;
end $$`,
    ),
    // Side-table mode: row-level security on the side table, now that both roles exist.
    ...(side
      ? sideTableSecurityStatements(source, workerName, enqueueName).map((text) =>
          plain("grants", text),
        )
      : []),
    plain("grants", `grant usage on schema ${quoteIdent(SCHEMA)} to ${worker}`),
    // The store's tables, owned by the admin: row access and nothing else (no create, no ownership).
    // The logs are append-only (read and insert); the reviewer accounts and the version table are
    // read-only, so the worker checks a password but never makes an account, and sees the store is
    // current but never migrates; the set in force is upserted, never deleted from by the worker.
    // The queue and the projects serve the source's database whatever
    // the store; the rest are the store's.
    ...STORE_TABLES.map((name) =>
      plain(
        "grants",
        `grant ${storeRights(name)} on ${quoteIdent(SCHEMA)}.${quoteIdent(name)} to ${worker}`,
        SOURCE_STORE_TABLES.has(name) ? "source" : "store",
      ),
    ),
    // An earlier install granted update and delete on the logs too: taken back, so an existing
    // install converges on the same rights (revoking what is not held changes nothing).
    ...STORE_APPEND_ONLY_TABLES.map((name) =>
      plain(
        "grants",
        `revoke update, delete on ${quoteIdent(SCHEMA)}.${quoteIdent(name)} from ${worker}`,
        "store",
      ),
    ),
    // The first install of store migration 8 granted delete on the set in force too; the worker
    // only upserts it (uninstall and purge delete as the admin), so it converges the same way.
    ...STORE_WORKER_UPSERT_TABLES.map((name) =>
      plain(
        "grants",
        `revoke delete on ${quoteIdent(SCHEMA)}.${quoteIdent(name)} from ${worker}`,
        "store",
      ),
    ),
    // A revoke takes back only grants made by the role running it (or the owner's, for the owner or
    // a member of its role), and the driver drops the warning when it takes nothing: so the script
    // checks, and stops with who must run it (as prune does).
    plain(
      "grants",
      `do $$
declare
  held text;
  owner text;
begin
  select string_agg(format('%s on %s granted by %s', x.privilege_type, c.relname, pg_catalog.pg_get_userbyid(x.grantor)), '; '
                    order by c.relname, x.privilege_type),
         min(pg_catalog.pg_get_userbyid(c.relowner))
    into held, owner
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid in (${STORE_APPEND_ONLY_TABLES.map((name) => `${quoteLiteral(`${quoteIdent(SCHEMA)}.${quoteIdent(name)}`)}::regclass`).join(", ")})
     and x.grantee = (select oid from pg_catalog.pg_roles where rolname = ${quoteLiteral(workerName)})
     and x.privilege_type in ('UPDATE', 'DELETE');
  if held is not null then
    raise exception using errcode = ${quoteLiteral(LOG_GRANTS_STATE)}, message = format(${quoteLiteral(
      `FacetDB: the worker login still holds %s on the append-only logs after the revoke; Postgres takes back only grants made by the role that runs it. Run facetdb migrate as the owner of the store's tables (%s) or a member of its role, or have the role that granted it revoke it; nothing was changed.`,
    )}, held, owner);
  end if;
end $$`,
      "store",
    ),
    // Store migration 11: a version's model, set once by its first answer. Update on that column
    // alone, after the revoke above, which takes back every column's update with the table's and is
    // not what the check above reads (a column's grant is not in the table's privileges).
    plain(
      "grants",
      `grant update (${quoteIdent(STORE_WORKER_SET_ONCE_COLUMN.column)}) on ${quoteIdent(SCHEMA)}.${quoteIdent(STORE_WORKER_SET_ONCE_COLUMN.table)} to ${worker}`,
      "store",
    ),
    plain(
      "grants",
      `grant select on ${quoteIdent(SCHEMA)}.${quoteIdent(STORE_VERSION_TABLE)} to ${worker}`,
      "store",
    ),
    ...STORE_SEQUENCES.map((name) =>
      plain(
        "grants",
        `grant usage, select on sequence ${quoteIdent(SCHEMA)}.${quoteIdent(name)} to ${worker}`,
        "store",
      ),
    ),
    // Security invoker, so the rights above still decide what the function may touch.
    ...STORE_FUNCTIONS.map((signature) =>
      plain("grants", `grant execute on function ${signature} to ${worker}`, "store"),
    ),
  ];
}

/**
 * The script as `facetdb migrate` prints it before running anything: the statements in order, each
 * parameter shown as the literal it will be bound to, a redacted one as a placeholder. A `$n` is
 * replaced only in statements that have parameters, so a `$$` body is never touched.
 */
export function renderSql(statements: readonly ScriptStatement[]): string {
  // One transaction, as `migrate` runs it: the script relies on `set local`, transaction-local
  // settings and a temp table that lives to the commit; run statement by statement in autocommit
  // it would set the placeholder as the password and lose the view's grants.
  return `begin;\n\n${statements.map(renderStatement).join(";\n\n")};\n\ncommit;\n`;
}

/** What printing a statement reads of it: a recorded run prints the same way (uninstall's tests). */
export type ScriptStatement = Pick<InstallStatement, "text" | "params" | "redacted">;

/**
 * One statement as the printed script shows it: its parameters written as literals, the worker
 * password's as a comment. The engine's plan holds exactly this text, and `run` executes it.
 */
export function renderStatement(statement: ScriptStatement): string {
  if (statement.params.length === 0) {
    return statement.text;
  }
  if (statement.redacted === true) {
    // Not rendered at all, not even with a placeholder: inside the printed transaction a
    // placeholder would become the login's password when a human runs the script. Without the
    // setting, the role block raises FacetDB's own message and the transaction rolls back.
    return "-- the worker password: set by `facetdb migrate` for the transaction, never printed;\n-- run by hand, this script stops at the role below with a FacetDB message and changes nothing";
  }
  return statement.text.replaceAll(/\$(\d+)/g, (_, index: string) => {
    const value = statement.params[Number(index) - 1];
    return quoteLiteral(String(value));
  });
}

/**
 * Which of the names FacetDB would own on the table already exist, split by the mark: `marked:
 * false` lists the application's own columns (install refuses when there is any); `marked: true`
 * lists FacetDB's from an earlier install (adopted, which keeps install idempotent). The mark is
 * matched exactly, never as a prefix: a polling install's `facetdb:<project>` is not it. Values are
 * parameters; the table reaches `regclass` through `format('%I.%I')`.
 */
export function ownedColumnsQuery(
  source: Pick<TableSource, "table" | "schema">,
  questionSet: QuestionSet,
  options: { readonly marked: boolean },
): { readonly text: string; readonly params: readonly unknown[] } {
  return {
    text: `select c.column_name as name, c.data_type as type
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
