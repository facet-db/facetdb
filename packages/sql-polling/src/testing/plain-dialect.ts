import type {
  ColumnFacts,
  LoginRule,
  PollingQuery,
  PollingRow,
  SqlDialect,
  TableFacts,
  TableRef,
  TlsVerdict,
} from "../dialect/index.ts";

/**
 * A reference dialect for this package's own tests: plain SQL for an imagined database with none of
 * Postgres's conveniences, so every branch of the generic connector and engine that Postgres does
 * not take runs here on a recording client. It has no comments (the marks are rows of
 * `facetdb_table_owners`), no `add column if not exists` (install inspects first), no transactional
 * DDL (each column is marked as it is added), `:n` placeholders, `fetch first`, no row-value
 * comparison (the keyset condition is spelled out), whole-table reads for the worker, and a login
 * created by a statement that binds the password. Nothing runs it against a server; its text is
 * proven by the conformance snapshot plain.dialect.sql, the generic code by polling.test.ts.
 */

const quoteIdent = (name: string): string => {
  if (name.length === 0 || name.includes("\0")) {
    throw new Error("an identifier must be non-empty text without a NUL character");
  }
  return `"${name.replaceAll('"', '""')}"`;
};

const quoteLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const quoteTable = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

const table = (ref: TableRef) => quoteTable(ref.schema, ref.name);

/** The marks' table, `facetdb_table_owners`, in the schema the connection starts in. */
const OWNERS = quoteIdent("facetdb_table_owners");

/**
 * The catalog read of a table's columns: no row at all for a table that does not exist. A test's
 * answer may leave out `readable`: a column is readable unless the answer says false.
 */
export const PLAIN_COLUMNS = `select column_name as name, data_type as type, is_nullable as nullable, holds_time as time, can_select as readable
  from information_schema.columns
 where table_schema = :1 and table_name = :2
 order by ordinal_position`;

export const PLAIN_KEY = `select column_name as name
  from information_schema.key_column_usage
 where table_schema = :1 and table_name = :2 and constraint_name = 'primary'
 order by ordinal_position`;

export const PLAIN_MARKS = `select column_name as name, mark from ${OWNERS} where table_schema = :1 and table_name = :2`;

export const PLAIN_LOGIN = "select 1 from information_schema.users where user_name = :1";

const names = (rows: readonly PollingRow[]) => rows.map((row) => String(row["name"]));

async function tableFacts(query: PollingQuery, ref: TableRef): Promise<TableFacts | undefined> {
  const columns = (await query(PLAIN_COLUMNS, [ref.schema, ref.name])).map(
    (row): ColumnFacts => ({
      name: String(row["name"]),
      type: String(row["type"]),
      comment: null,
      time: row["time"] === true,
      nullable: row["nullable"] === true,
      readable: row["readable"] !== false,
    }),
  );
  if (columns.length === 0) {
    return undefined;
  }
  return {
    columns,
    key: names(await query(PLAIN_KEY, [ref.schema, ref.name])),
    policies: [],
    triggers: [],
    workerSelect: [],
  };
}

const WORKER = "facetdb_worker";

const login: LoginRule = {
  name: WORKER,
  exists: async (query) => (await query(PLAIN_LOGIN, [WORKER])).length > 0,
  secretText:
    "-- the worker login: created by facetdb migrate with the password bound, never printed",
  secret: (password) => ({
    text: `create user ${quoteIdent(WORKER)} password :1`,
    params: [password],
  }),
  create: () => [`grant connect to ${quoteIdent(WORKER)}`],
  grants: (ref, _select, update) => [
    // Whole-table reads: this database has no column-level select.
    `grant select on ${table(ref)} to ${quoteIdent(WORKER)}`,
    `grant update (${update.map(quoteIdent).join(", ")}) on ${table(ref)} to ${quoteIdent(WORKER)}`,
  ],
  schemaUsage: false,
  revoke: (ref) => [`revoke all on ${table(ref)} from ${quoteIdent(WORKER)}`],
  revokeSelect: () => [],
  whoami: "select current_user as name from dual",
  urlShape: `plain://${WORKER}:<a long random password>@<host>/<database>`,
};

/** `?tls=on` asks for TLS; this machine's own host needs none. */
function verdict(url: string, allowInsecure: boolean): TlsVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid";
  }
  const authority = url.slice(url.indexOf("//") + 2).split("/")[0] ?? "";
  if (authority.split("@").length > 2) {
    return "ambiguous";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return allowInsecure || local || parsed.searchParams.get("tls") === "on"
    ? undefined
    : { host: parsed.hostname };
}

export const plainDialect: SqlDialect = {
  name: "Plain SQL",
  schemes: ["plain"],
  defaultSchema: "main",
  transactionalDdl: false,
  // No settings to pin, and no lock: each statement commits on its own, so none would outlive it.
  header: [],

  placeholder: (index) => `:${index}`,
  quoteIdent,
  quoteTable,
  quoteLiteral,
  keyAsText: (column) => `cast(${quoteIdent(column)} as varchar(4000))`,
  inList: (count) =>
    `in (${Array.from({ length: count }, (_, index) => `:${index + 1}`).join(", ")})`,
  // Oracle's limit, which the reference keeps so the conformance suite chunks a long list.
  maxInList: 1000,

  types: {
    boolean: "boolean",
    text: "varchar(4000)",
    real: "real",
    json: "clob",
    timestamp: "timestamp(3)",
    hash: "varchar(64)",
  },
  falseValue: "false",
  timeFromMs: (placeholder) =>
    `timestamp '1970-01-01 00:00:00' + ${placeholder} * interval '0.001' second`,
  msOfTime: (column) => `cast(epoch_ms(${quoteIdent(column)}) as varchar(20))`,
  excluded: (where) =>
    where === undefined ? "false" : `case when (${where}) then false else true end`,

  addColumn: "inspect-first",
  addColumns: (ref, columns) =>
    columns.map(
      ([name, definition]) => `alter table ${table(ref)} add ${quoteIdent(name)} ${definition}`,
    ),
  dropColumns: (ref, columns) =>
    columns.map((name) => `alter table ${table(ref)} drop column ${quoteIdent(name)}`),

  limit: (placeholder) => `fetch first ${placeholder} rows only`,
  // No row-value comparison: the tie-breaker spelled out, each value bound once per use.
  after: ([first = "", second = ""], [over = "", tie = ""]) =>
    `(${quoteIdent(first)} > ${over} or (${quoteIdent(first)} = ${over} and ${quoteIdent(second)} > ${tie}))`,

  ownership: {
    kind: "table",
    create: () => [
      `create table if not exists ${OWNERS} (
  table_schema varchar(128) not null,
  table_name varchar(128) not null,
  column_name varchar(128) not null,
  mark varchar(4000) not null,
  primary key (table_schema, table_name, column_name)
)`,
    ],
    markColumn: (ref, column, text) => [
      `delete from ${OWNERS} where table_schema = ${quoteLiteral(ref.schema)} and table_name = ${quoteLiteral(ref.name)} and column_name = ${quoteLiteral(column)}`,
      `insert into ${OWNERS} (table_schema, table_name, column_name, mark) values (${[ref.schema, ref.name, column, text].map(quoteLiteral).join(", ")})`,
    ],
    unmarkTable: (ref) => [
      `delete from ${OWNERS} where table_schema = ${quoteLiteral(ref.schema)} and table_name = ${quoteLiteral(ref.name)}`,
    ],
    unmarkColumns: (ref, columns) => [
      `delete from ${OWNERS} where table_schema = ${quoteLiteral(ref.schema)} and table_name = ${quoteLiteral(ref.name)} and column_name in (${columns.map(quoteLiteral).join(", ")})`,
    ],
    marks: async (query, ref) =>
      new Map(
        (await query(PLAIN_MARKS, [ref.schema, ref.name])).map(
          (row) => [String(row["name"]), String(row["mark"])] as const,
        ),
      ),
  },
  table: (query, ref) => tableFacts(query, ref),

  tls: {
    verdict,
    shape: "plain://user:password@host/database",
    secureShape: "plain://user:password@host/database?tls=on",
    ask: "add ?tls=on to",
  },
  login,
  ping: "select 1 from dual",
};
