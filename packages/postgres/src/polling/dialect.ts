import type {
  ColumnFacts,
  LoginRule,
  PollingQuery,
  PollingRow,
  SqlDialect,
  TableFacts,
  TableRef,
  TlsVerdict,
} from "@facetdb/sql-polling";
import {
  PASSWORD_SETTING,
  PASSWORD_STATEMENT,
  renderStatement,
  SCHEMA_SETTING,
  SCRIPT_HEADER,
  scramVerifier,
  TABLE_SETTING,
  WORKER_ROLE,
} from "../install/index.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "../sql/index.ts";
import { AmbiguousHostError, PlaintextUrlError, requireTls } from "../store/index.ts";

/**
 * Postgres as a polling dialect: the first `SqlDialect`, for a Postgres host that forbids triggers.
 * Its text is today's polling SQL, unchanged (install.listings.polling.sql is the proof): `::text`
 * reads, `add column if not exists`, `drop column if exists`, column comments as the marks; the
 * worker login, its grants and its row-level policies are the trigger install's, the same words, as
 * are the plans' header and their lock; its client is `connectPostgres` (postgres.js), or PGlite in
 * a test, through the same type. This module imports `@facetdb/sql-polling` for its types only, so
 * this package never loads the polling engine: the CLI loads it when a source asks for it.
 */

export type PostgresDialectOptions = {
  /**
   * The environment's `PGHOST`, where the driver goes for a URL that names no host: the TLS rule
   * reads it, as the trigger engine's does. A required key, so no caller forgets it; the
   * composition root passes `env.PGHOST`.
   */
  readonly pgHost: string | undefined;
};

/** The policies a table with row-level security gets for the worker, as the trigger install names them. */
const POLICIES = ["facetdb_reads", "facetdb_writes"] as const;

const PRESENT = `select to_regclass(format('%I.%I', $1::text, $2::text)) is not null as present`;

/**
 * Every column with its type, comment (FacetDB's marks), whether it holds a time and allows NULL,
 * and whether the connection's own login may select it (the worker's, in `open` and doctor).
 */
const COLUMNS = `select a.attname::text as name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
       pg_catalog.col_description(a.attrelid, a.attnum) as comment,
       a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype) as time,
       not a.attnotnull as nullable,
       pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'SELECT') as readable
  from pg_catalog.pg_attribute a
 where a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and a.attnum > 0 and not a.attisdropped
 order by a.attnum`;

const PRIMARY_KEY = `select a.attname::text as name
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indrelid = to_regclass(format('%I.%I', $1::text, $2::text)) and i.indisprimary
 order by a.attnum`;

const FACETDB_POLICIES = `select p.policyname::text as name
  from pg_catalog.pg_policies p
 where p.schemaname = $1 and p.tablename = $2 and p.policyname = any ($3::text[])
 order by p.policyname`;

/** The triggers on the table that call a function of FacetDB's schema: a trigger install's capture. */
const FACETDB_TRIGGERS = `select t.tgname::text as name
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc f on f.oid = t.tgfoid
  join pg_catalog.pg_namespace n on n.oid = f.pronamespace
 where t.tgrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and not t.tgisinternal and n.nspname = 'facetdb'
 order by t.tgname`;

/** The columns on which a role holds a column-level select of its own (the trigger prune's query). */
const WORKER_SELECT = `select a.attname::text as name
  from pg_catalog.pg_attribute a
  cross join lateral pg_catalog.aclexplode(a.attacl) x
 where a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and a.attnum > 0 and not a.attisdropped
   and x.privilege_type = 'SELECT'
   and x.grantee = (select r.oid from pg_catalog.pg_roles r where r.rolname = $3)
 order by a.attnum`;

const ROLE_EXISTS = "select 1 from pg_catalog.pg_roles where rolname = $1";

const names = (rows: readonly PollingRow[]) => rows.map((row) => String(row["name"]));

/** The catalog's facts of a table, read with whichever login the call has (the worker's in doctor). */
async function tableFacts(
  query: PollingQuery,
  table: TableRef,
  login: string,
): Promise<TableFacts | undefined> {
  const at = [table.schema, table.name];
  if ((await query(PRESENT, at))[0]?.["present"] !== true) {
    return undefined;
  }
  const columns = (await query(COLUMNS, at)).map(
    (row): ColumnFacts => ({
      name: String(row["name"]),
      type: String(row["type"]),
      comment: row["comment"] === null ? null : String(row["comment"]),
      time: row["time"] === true,
      nullable: row["nullable"] === true,
      readable: row["readable"] === true,
    }),
  );
  return {
    columns,
    key: names(await query(PRIMARY_KEY, at)),
    policies: names(await query(FACETDB_POLICIES, [...at, POLICIES])),
    triggers: names(await query(FACETDB_TRIGGERS, at)),
    workerSelect: login === "" ? [] : names(await query(WORKER_SELECT, [...at, login])),
  };
}

/**
 * The login block the trigger install runs (install/sql.ts), the same words: it creates the worker
 * login with the password the transaction-local setting holds, set by the plan's secret statement.
 */
const ROLE_BLOCK = `do $$
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
end $$`;

/** One policy of the trigger install's block: created for the worker when the table lacks it. */
const policy = (name: string, command: "select" | "update") =>
  `  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('${SCHEMA_SETTING}')
                   and tablename = current_setting('${TABLE_SETTING}')
                   and policyname = ${quoteLiteral(name)}) then
    execute format('create policy %I on %I.%I for ${command} to %I using (true)',
                   ${quoteLiteral(name)}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), ${quoteLiteral(WORKER_ROLE)});
  end if;`;

/**
 * Supabase serves transaction mode on port 6543: Supavisor on its pooler hosts and the dedicated
 * PgBouncer beside the database (the trigger engine's doctor, the same rule).
 */
function supabaseTransactionPort(url: string): string | undefined {
  try {
    const { port, hostname } = new URL(url);
    return port === "6543" &&
      (hostname.endsWith(".pooler.supabase.com") || /^db\.[^.]+\.supabase\.co$/.test(hostname))
      ? "port 6543 of a Supabase host is its transaction-mode pooler"
      : undefined;
  } catch {
    return undefined;
  }
}

const worker = quoteIdent(WORKER_ROLE);

const LOGIN: LoginRule = {
  name: WORKER_ROLE,
  exists: async (query) => (await query(ROLE_EXISTS, [WORKER_ROLE])).length > 0,
  // The trigger install's comment, never the password and never a placeholder.
  secretText: renderStatement({ text: PASSWORD_STATEMENT, params: [""], redacted: true }),
  // A fresh SCRAM verifier, never the password: nothing the server logs can give it back.
  secret: (password) => ({ text: PASSWORD_STATEMENT, params: [scramVerifier(password)] }),
  create: () => [ROLE_BLOCK],
  grants: (table, select, update) => {
    const target = quoteTable({ schema: table.schema, name: table.name });
    return [
      `grant usage on schema ${quoteIdent(table.schema)} to ${worker}`,
      `grant select (${select.map(quoteIdent).join(", ")})\n  on ${target} to ${worker}`,
      `grant update (${update.map(quoteIdent).join(", ")})\n  on ${target} to ${worker}`,
      // The policies, for a table with row-level security on: the names reach the block as
      // settings, as in the trigger install (a `$$` body cannot quote a name).
      `select set_config('${SCHEMA_SETTING}', ${quoteLiteral(table.schema)}, true), set_config('${TABLE_SETTING}', ${quoteLiteral(table.name)}, true)`,
      `do $$\nbegin\n${policy("facetdb_reads", "select")}\n${policy("facetdb_writes", "update")}\nend $$`,
    ];
  },
  schemaUsage: true,
  revoke: (table, policies) => {
    const target = quoteTable({ schema: table.schema, name: table.name });
    return [
      ...policies.map((name) => `drop policy if exists ${quoteIdent(name)} on ${target}`),
      `revoke all on ${target} from ${worker}`,
    ];
  },
  revokeSelect: (table, columns) => [
    `revoke select (${columns.map(quoteIdent).join(", ")}) on ${quoteTable({ schema: table.schema, name: table.name })} from ${worker}`,
  ],
  whoami: "select current_user::text as name",
  urlShape: `postgres://${WORKER_ROLE}:<a long random password>@<host>/<database>`,
};

export function createPostgresDialect(options: PostgresDialectOptions): SqlDialect {
  const { pgHost } = options;
  const table = (ref: TableRef) => quoteTable({ schema: ref.schema, name: ref.name });
  return {
    name: "Postgres",
    schemes: ["postgres", "postgresql"],
    defaultSchema: "public",
    transactionalDdl: true,
    // The trigger scripts' own header: a backslash in a quoted name is a backslash, and an `alter
    // table` queued behind a long transaction gives up after ten seconds instead of holding the
    // application's queries behind its lock.
    header: SCRIPT_HEADER.map((statement) => statement.text),
    // Self-conflicting, so two installs, prunes or uninstalls of one table run one after the other;
    // the `alter table` after it takes the table whole anyway.
    lock: (ref) => `lock table ${table(ref)} in share row exclusive mode`,

    placeholder: (index) => `$${index}`,
    quoteIdent,
    quoteTable: (schema, name) => quoteTable({ schema, name }),
    quoteLiteral,
    keyAsText: (column) => `${quoteIdent(column)}::text`,
    inList: (count) =>
      `in (${Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ")})`,
    // Postgres takes far longer lists; 100 bounds how many statements of different lengths each
    // connection prepares (postgres.js prepares every statement once per connection).
    maxInList: 100,

    types: {
      boolean: "boolean",
      text: "text",
      real: "real",
      json: "jsonb",
      timestamp: "timestamptz",
      hash: "text",
    },
    falseValue: "false",
    timeFromMs: (placeholder) => `to_timestamp(${placeholder}::double precision / 1000)`,
    msOfTime: (column) => `round(extract(epoch from ${quoteIdent(column)}) * 1000)::bigint::text`,
    excluded: (where) => (where === undefined ? "false" : `not coalesce((${where}), false)`),

    addColumn: "if-not-exists",
    addColumns: (ref, columns) => [
      `alter table ${table(ref)}\n${columns
        .map(([name, definition]) => `  add column if not exists ${quoteIdent(name)} ${definition}`)
        .join(",\n")}`,
    ],
    dropColumns: (ref, columns) => [
      `alter table ${table(ref)}\n${columns
        .map((name) => `  drop column if exists ${quoteIdent(name)}`)
        .join(",\n")}`,
    ],

    limit: (placeholder) => `limit ${placeholder}`,
    after: (columns, values) => `(${columns.map(quoteIdent).join(", ")}) > (${values.join(", ")})`,

    ownership: {
      kind: "comment",
      commentOn: (ref, column, text) =>
        `comment on column ${table(ref)}.${quoteIdent(column)} is ${quoteLiteral(text)}`,
    },
    table: tableFacts,

    tls: {
      verdict(url, allowInsecure): TlsVerdict {
        try {
          requireTls(url, allowInsecure, pgHost);
          return undefined;
        } catch (error) {
          if (error instanceof AmbiguousHostError) {
            return "ambiguous";
          }
          if (!(error instanceof PlaintextUrlError)) {
            return "invalid";
          }
          return error.viaPgHost
            ? {
                host: error.host,
                via: {
                  variable: "PGHOST",
                  fix: "point PGHOST at this machine or a socket directory",
                },
              }
            : { host: error.host };
        }
      },
      shape: "postgres://user:password@host/database",
      secureShape: "postgres://user:password@host/database?sslmode=require",
      ask: "add ?sslmode=require to",
    },
    login: LOGIN,
    ping: "select 1",
    pooler: {
      probe: "select pg_backend_pid() as pid, $1::int as run",
      goneState: "26000",
      known: supabaseTransactionPort,
    },
  };
}

/**
 * The Postgres dialect with no `PGHOST`, for tools and tests that never read the environment. The
 * CLI's composition root builds its own with `createPostgresDialect({ pgHost: env.PGHOST })`, so a
 * hostless URL is judged where the driver really goes.
 */
export const postgresDialect: SqlDialect = createPostgresDialect({ pgHost: undefined });
