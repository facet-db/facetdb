import {
  type EngineTarget,
  INSPECT_MAX_TABLES,
  INSPECT_MAX_VALUE,
  INSPECT_SAMPLE_ROWS,
  type InspectOptions,
  type InspectResult,
  type ReadRowsOptions,
  type ReadRowsResult,
  type TableInspection,
} from "@facetdb/core";
import { createScan } from "../scan/index.ts";
import {
  quoteIdent,
  quoteTable,
  type SqlClient,
  type SqlConnect,
  type SqlQuery,
} from "../sql/index.ts";
import { adminUrlRefusal } from "./urls.ts";

/**
 * `DatabaseEngine.inspect` and `readRows` on Postgres: what the studio's setup flow shows before
 * anything is installed. One connection, opened with a short timeout and closed whatever happens;
 * one read-only transaction with its own statement timeout (`inReadOnly`), nothing set on the
 * session; nothing but reads: the tables the admin role may select from, for the one asked about
 * its columns, its single-column key and five rows read the way the worker reads a state field
 * (`::text`), and the newest rows of a draft source.
 */

/** How long the one connection may take to open. */
export const INSPECT_CONNECT_TIMEOUT_S = 10;

/** How long any one statement of an inspection may run, in milliseconds. */
export const INSPECT_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Schemas no source reads: Postgres's own, FacetDB's, and the ones Supabase manages for its auth,
 * storage, realtime and extensions, which a source table never lives in.
 */
const SKIPPED_SCHEMAS = [
  "information_schema",
  "facetdb",
  "auth",
  "storage",
  "realtime",
  "_realtime",
  "_analytics",
  "extensions",
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "pgbouncer",
  "net",
  "cron",
  "supabase_functions",
  "supabase_migrations",
] as const;

/** Ordinary and partitioned tables the connection may select from, `public` first. */
const TABLES_QUERY = `select n.nspname as schema, c.relname as name
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and not c.relispartition
   and n.nspname not like 'pg\\_%'
   and n.nspname <> all ($1::text[])
   and pg_catalog.has_table_privilege(c.oid, 'select')
 order by n.nspname <> 'public', n.nspname, c.relname
 limit $2`;

const COLUMNS_QUERY = `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_attribute a
 where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
 order by a.attnum`;

const KEY_QUERY = `select a.attname as name
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indrelid = to_regclass($1) and i.indisprimary`;

/** A table as the config names it: bare in `public`, `schema.table` elsewhere. */
function configName(schema: string, name: string): string {
  return schema === "public" ? name : `${schema}.${name}`;
}

/** The config's name of a table split as the plans read it: a bare name is in `public`. */
function split(table: string): { readonly schema: string; readonly name: string } {
  const dot = table.indexOf(".");
  return dot === -1
    ? { schema: "public", name: table }
    : { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

async function tableOf(
  query: SqlQuery,
  table: string,
): Promise<NonNullable<TableInspection["table"]> | undefined> {
  const { schema, name } = split(table);
  const relation = quoteTable({ schema, name });
  const found = await query("select to_regclass($1) is not null as present", [relation]);
  if (found[0]?.["present"] !== true) {
    return undefined;
  }
  const columns = (await query(COLUMNS_QUERY, [relation]))
    .map((row) => ({ name: String(row["name"]), type: String(row["type"]) }))
    .filter((column) => !column.name.startsWith("facetdb_"));
  const keys = await query(KEY_QUERY, [relation]);
  const [only] = keys;
  const key = keys.length === 1 && only !== undefined ? String(only["name"]) : null;
  // Each value as the worker reads a state field, cut at a length a page shows; the newest by the
  // key first, as the preview reads them, where there is a key.
  const values = columns.map(
    (column, index) => `left(${quoteIdent(column.name)}::text, ${INSPECT_MAX_VALUE}) as c${index}`,
  );
  const rows =
    columns.length === 0
      ? []
      : await query(
          `select ${values.join(", ")} from ${relation}${
            key === null ? "" : ` order by ${quoteIdent(key)} desc`
          } limit ${INSPECT_SAMPLE_ROWS}`,
        );
  return {
    name: table,
    key,
    columns,
    rows: rows.map((row) =>
      Object.fromEntries(
        columns.map((column, index) => {
          const value = row[`c${index}`];
          return [column.name, value === null || value === undefined ? null : String(value)];
        }),
      ),
    ),
  };
}

/**
 * Runs `work` in one transaction that is read only from its first statement and carries its own
 * statement timeout (`set local`), on the one connection `client` holds. Nothing is set on the
 * session: through a transaction-mode pooler (Supabase's port 6543, PgBouncer) a session setting
 * would stay on a server connection the application then gets, and the transaction's statements
 * are the ones that run together on one server connection. A write inside it is refused by the
 * database; the transaction ends with a rollback whatever `work` did.
 */
export async function inReadOnly<T>(
  client: SqlClient,
  work: (query: SqlQuery) => Promise<T>,
): Promise<T> {
  const done: { value?: T } = {};
  try {
    await client.transaction(async (query) => {
      await query("set transaction read only");
      await query(`set local statement_timeout = ${INSPECT_STATEMENT_TIMEOUT_MS}`);
      done.value = await work(query);
      // Read only: nothing to keep. Ending in a rollback leaves the database as it was.
      throw ROLL_BACK;
    });
  } catch (error) {
    if (error !== ROLL_BACK) {
      throw error;
    }
  }
  if (!("value" in done)) {
    throw new Error("the read-only transaction ended without its result");
  }
  return done.value as T;
}

/** Thrown inside the read-only transaction to end it with a rollback; never seen outside. */
const ROLL_BACK = new Error("roll back the read-only transaction");

/** One connection for an inspection or a read of rows, opened with a short timeout. */
function connectOnce(connect: SqlConnect, url: string): SqlClient {
  return connect(url, { max: 1, connectTimeoutSeconds: INSPECT_CONNECT_TIMEOUT_S });
}

export async function inspectDatabase(
  connect: SqlConnect,
  pgHost: string | undefined,
  url: string,
  options: InspectOptions,
): Promise<InspectResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure, pgHost);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const client = connectOnce(connect, url);
  try {
    return await inReadOnly(client, async (query): Promise<InspectResult> => {
      const tables = (await query(TABLES_QUERY, [[...SKIPPED_SCHEMAS], INSPECT_MAX_TABLES])).map(
        (row) => configName(String(row["schema"]), String(row["name"])),
      );
      if (options.table === undefined) {
        return { ok: true, inspection: { tables } };
      }
      const table = await tableOf(query, options.table);
      if (table === undefined) {
        return {
          ok: false,
          refusal: {
            code: "no-table",
            message: `there is no table ${options.table} this connection can read`,
            fix: "pick one of the tables listed, or check that the connection string's role may select from it",
          },
        };
      }
      return { ok: true, inspection: { tables, table } };
    });
  } finally {
    await client.close();
  }
}

/**
 * The planner's estimate of a table's rows, and whether the table was ever analysed: Postgres 14
 * and later say -1 for a table never analysed, 13 and earlier say 0, so a 0 with no analyse on
 * record is no estimate either.
 */
const ESTIMATE_QUERY = `select c.reltuples::float8 as rows,
       (s.last_analyze is null and s.last_autoanalyze is null) as never
  from pg_catalog.pg_class c
  left join pg_catalog.pg_stat_all_tables s on s.relid = c.oid
 where c.oid = to_regclass($1)`;

/**
 * `DatabaseEngine.readRows` on Postgres: the newest rows of a table no worker runs yet, read by
 * `scan`'s own query (its states, its where filter, its order) inside `inReadOnly`, and the
 * planner's estimate of the table's size from `pg_class`, so no count runs over a large table.
 */
export async function readTableRows(
  connect: SqlConnect,
  pgHost: string | undefined,
  target: EngineTarget,
  url: string,
  options: ReadRowsOptions,
): Promise<ReadRowsResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure, pgHost);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const schema = target.schema ?? "public";
  const relation = quoteTable({ schema, name: target.table });
  const client = connectOnce(connect, url);
  try {
    return await inReadOnly(client, async (query): Promise<ReadRowsResult> => {
      const keys = await query(KEY_QUERY, [relation]);
      const [only] = keys;
      if (only === undefined || keys.length > 1) {
        return {
          ok: false,
          refusal: {
            code: "primary-key",
            message: `${schema}.${target.table} needs a single-column primary key, and ${keys.length === 0 ? "has none, or does not exist" : "has a composite one"}`,
            fix: "pick another table, or give this one a primary key, and pick it again",
          },
        };
      }
      const page = await createScan({
        query,
        source: { table: target.table, schema, key: String(only["name"]) },
        questionSet: target.questionSet,
        pageSize: Math.max(1, options.limit),
      })(null);
      const [statistics] = await query(ESTIMATE_QUERY, [relation]);
      const estimate = Number(statistics?.["rows"] ?? -1);
      const usable =
        Number.isFinite(estimate) &&
        estimate >= 0 &&
        !(estimate === 0 && statistics?.["never"] !== false);
      return {
        ok: true,
        rows: page.rows,
        estimatedRows: usable ? Math.round(estimate) : null,
      };
    });
  } finally {
    await client.close();
  }
}
