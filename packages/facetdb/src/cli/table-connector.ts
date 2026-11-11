import type { Clock, QuestionSet } from "@facetdb/core";
import {
  createPostgresConnector,
  type PostgresConnector,
  type SqlClient,
  type SqlConnect,
  WORKER_ROLE,
} from "@facetdb/postgres";
import type { SourceConfig } from "../config/index.ts";
import { CliError } from "./program.ts";

/**
 * The connector of a table source (the Postgres capture runtime) as `facetdb worker`, `dev` and
 * `backfill` open it: under the worker login, keyed by the table's primary key as pg_catalog
 * reports it (the worker login can read the catalog, not the admin's view of constraints).
 */

const PRIMARY_KEY_QUERY = `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indrelid = to_regclass($1) and i.indisprimary`;

function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `schema.table`, or `table` in `public`. */
export function splitTable(table: string): { readonly schema: string; readonly table: string } {
  const dot = table.indexOf(".");
  return dot === -1
    ? { schema: "public", table }
    : { schema: table.slice(0, dot), table: table.slice(dot + 1) };
}

/** The table's single-column primary key and its type. */
async function primaryKey(
  client: SqlClient,
  schema: string,
  table: string,
): Promise<{ readonly name: string; readonly type: string }> {
  const rows = await client.query(PRIMARY_KEY_QUERY, [`${quoteName(schema)}.${quoteName(table)}`]);
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new CliError(
      "primary-key",
      `${schema}.${table} needs a single-column primary key, and ${rows.length === 0 ? "has none, or does not exist" : "has a composite one"}`,
      "run facetdb migrate first; a table needs a primary key (or a surrogate key), FacetDB keys its answers by it",
    );
  }
  return { name: String(row["name"]), type: String(row["type"]) };
}

/** The source's connection string (the worker login's), or the fix when the config left it unset. */
export function workerUrlOf(source: SourceConfig): string {
  if (source.database === undefined || source.database === "") {
    throw new CliError(
      "database-url",
      `the source "${source.name}" has no connection string`,
      `set ${source.databaseEnv ?? "DATABASE_URL"} to the worker login's connection string (postgres://${WORKER_ROLE}:…@host/db)`,
    );
  }
  return source.database;
}

export type TableConnectorOptions = {
  readonly source: SourceConfig;
  /** The worker login's connection string for the source's database. */
  readonly url: string;
  readonly connect: SqlConnect;
  readonly questionSet: QuestionSet;
  readonly clock: Clock;
  readonly workerId: string;
};

/** Reads the key, then opens the capture connector; the caller closes it. */
export async function openTableConnector(
  options: TableConnectorOptions,
): Promise<PostgresConnector> {
  const { source } = options;
  const target = splitTable(source.table ?? "");
  const probe = options.connect(options.url);
  let key: { readonly name: string; readonly type: string };
  try {
    key = await primaryKey(probe, target.schema, target.table);
  } finally {
    await probe.close();
  }
  return createPostgresConnector({
    workerUrl: options.url,
    source: {
      table: target.table,
      schema: target.schema,
      key: key.name,
      keyType: key.type,
      onChange: source.onChange,
      storage: source.storage,
    },
    questionSet: options.questionSet,
    clock: options.clock,
    workerId: options.workerId,
    connect: options.connect,
  });
}
