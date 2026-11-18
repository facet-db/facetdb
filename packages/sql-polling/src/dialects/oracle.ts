import { type DatabaseEngine, EngineRefusal } from "@facetdb/core";
import type {
  ColumnFacts,
  LoginRule,
  PollingQuery,
  SqlDialect,
  TableFacts,
  TableRef,
  TlsVerdict,
} from "../dialect/index.ts";
import { type PollingEngineOptions, pollingEngine } from "../engine/index.ts";
import { connectOracle } from "./oracle-connect.ts";

/**
 * Oracle Database as a polling dialect, through `oracledb` in thin mode (oracle-connect.ts). What
 * differs from Postgres lives here:
 *
 * - Every identifier is quoted as written. Oracle folds an unquoted name to capitals, so a table
 *   the application created unquoted is `LISTINGS` and one created as `"listings"` is `listings`;
 *   the config spells the name as the database does, and FacetDB's own columns are its lower-case
 *   names, quoted (`"facetdb_status"`). A name holding a double quote cannot exist in Oracle, and
 *   is refused before any SQL is written.
 * - The schema is the owning user, and Oracle has no default the worker shares (its own schema is
 *   `FACETDB_WORKER`'s), so a source names it: `table: "APP.LISTINGS"`.
 * - `:1` placeholders, bound by name ("1"), so `after()` uses one placeholder twice for one value.
 * - Booleans are `number(1)` (19c has no SQL boolean), bound as 1 or 0 and read back through
 *   `booleans`; answers' reals are `number`, which keeps the worker's decimal exactly (a
 *   `binary_float` prints nine digits, 0.93 as 9.30000007E-001, and Oracle has no shortest-text
 *   conversion of it); text is `varchar2(255 char)`, JSON `clob`, times `timestamp(3)` in UTC.
 * - A state field is read by its catalog type, whichever door made the connector (the engine's
 *   `open` passes the columns; a connector made without them reads the catalog itself): a CLOB
 *   whole, since `to_char` stops past 4000 bytes, a JSON value serialized to a CLOB and read whole,
 *   since `to_char` reads one past 4000 bytes as NULL, and any type outside the readable list (a BLOB,
 *   RAW, LONG, XMLTYPE, ROWID, BFILE…) refused before any poll, since `to_char` cannot read it as
 *   text.
 * - DDL commits each statement: no plan runs in a transaction, so there is no table lock (none
 *   would outlive its statement) and the run reads the mark before anything; each column is marked
 *   right after it is added. The marks are column comments.
 * - The worker login is a user with `create session`, reading the whole table (Oracle grants no
 *   column-level select) and updating its own columns only (column-level update).
 */

/** The worker login: Oracle's own spelling of an unquoted `facetdb_worker`, so a URL may write it in any case. */
const WORKER = "FACETDB_WORKER";

/** An identifier as written, quoted: Oracle has no escape for a double quote inside one. */
function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes('"') || name.includes("\0")) {
    throw new Error(
      `Oracle cannot name a table, column or schema ${JSON.stringify(name)}: a name is non-empty and holds no double quote ("); rename it in the config`,
    );
  }
  return `"${name}"`;
}

const quoteLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** A table, qualified by its schema; unqualified (the session's own schema) when the schema is empty. */
const quoteTable = (schema: string, name: string): string =>
  schema === "" ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`;

const table = (ref: TableRef): string => quoteTable(ref.schema, ref.name);

const worker = quoteIdent(WORKER);

/** The catalog's types of a character LOB, read whole as text (`all_tab_columns.data_type`). */
const LOB_TEXT: ReadonlySet<string> = new Set(["CLOB", "NCLOB"]);

/**
 * The catalog's types a state field is read as text by, as `all_tab_columns.data_type` prints them:
 * character data, numbers, dates and times, intervals, character LOBs (read whole, `stateAsText`),
 * JSON (serialized to a CLOB, read whole), and 23ai's BOOLEAN. Every other type is refused at
 * install and `open` before a poll fails on it: `to_char` refuses a RAW, LONG, LONG RAW, XMLTYPE,
 * VECTOR or ROWID (ORA-00932 on 23ai), opens the file of a BFILE (ORA-22288), and hands a BLOB's
 * bytes over undecoded; an object type has no text either. LONG stays refused, though it holds
 * text.
 */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "VARCHAR2",
  "NVARCHAR2",
  "CHAR",
  "NCHAR",
  "NUMBER",
  "FLOAT",
  "BINARY_FLOAT",
  "BINARY_DOUBLE",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "INTERVAL DAY TO SECOND",
  "INTERVAL YEAR TO MONTH",
  "CLOB",
  "NCLOB",
  "JSON",
  "BOOLEAN",
]);

/**
 * Whether `type` is one of `TEXT_TYPES`, its precision and case aside: the catalog prints
 * `TIMESTAMP(6) WITH TIME ZONE` and `INTERVAL DAY(2) TO SECOND(6)`, DDL writes `varchar2(255 char)`.
 */
const readsAsText = (type: string): boolean =>
  TEXT_TYPES.has(type.toUpperCase().replaceAll(/\([^)]*\)/g, ""));

/** Placeholders `:1` to `:count`. */
const placeholders = (count: number): string =>
  Array.from({ length: count }, (_, index) => `:${index + 1}`).join(", ");

/** Every column of the table with its type, comment (FacetDB's marks), whether it holds a time and allows NULL. */
const COLUMNS = `select c.column_name, c.data_type,
       m.comments as remark,
       case when c.data_type = 'DATE' or c.data_type like 'TIMESTAMP%' then 1 else 0 end as holds_time,
       c.nullable
  from all_tab_columns c
  left join all_col_comments m
    on m.owner = c.owner and m.table_name = c.table_name and m.column_name = c.column_name
 where c.owner = :1 and c.table_name = :2
 order by c.column_id`;

const PRIMARY_KEY = `select k.column_name
  from all_constraints p
  join all_cons_columns k
    on k.owner = p.owner and k.constraint_name = p.constraint_name and k.table_name = p.table_name
 where p.owner = :1 and p.table_name = :2 and p.constraint_type = 'P'
 order by k.position`;

const LOGIN_EXISTS = "select 1 as found from all_users where username = :1";

/**
 * The errors a select of a table the login may not read stops with: ORA-00942 (refused as
 * `polling-table`), ORA-01031, and 23ai's ORA-41900 (a missing privilege, named).
 */
const UNREADABLE = new Set(["polling-table", "ORA-01031", "ORA-41900"]);

/**
 * Whether the connection's login may read the table: Oracle's privileges come by grant, role and
 * system privilege (`select any table`), so the read itself answers, touching no row. Oracle grants
 * no column-level select, so the answer is every column's.
 */
async function readable(query: PollingQuery, ref: TableRef): Promise<boolean> {
  try {
    await query(`select 1 as found from ${table(ref)} where 1 = 0`);
    return true;
  } catch (error) {
    const code =
      error instanceof EngineRefusal
        ? error.refusal.code
        : typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
    if (UNREADABLE.has(code)) {
      return false;
    }
    throw error;
  }
}

/** The catalog row's text, which the catalog always fills. */
const text = (value: unknown): string => String(value);

/**
 * The catalog's facts of a table, read with whichever login the call has (the worker's in `open`
 * and doctor): the `all_` views show it the tables it has a right on. No policy, trigger or
 * column-level select of FacetDB's exists on Oracle (no trigger install, no row-level policy, no
 * column-level select).
 */
async function tableFacts(query: PollingQuery, ref: TableRef): Promise<TableFacts | undefined> {
  if (ref.schema === "") {
    throw new EngineRefusal({
      code: "oracle-schema",
      message: `the source's table ${ref.name} names no schema, and Oracle has no default schema the worker shares (the worker logs in as ${WORKER}, whose own schema holds no table)`,
      fix: `name the table with the schema (the user) that owns it, as the database spells both: table: "APP.LISTINGS", or "APP.listings" for a table created with a quoted lower-case name`,
    });
  }
  const at = [ref.schema, ref.name];
  const rows = await query(COLUMNS, at);
  if (rows.length === 0) {
    return undefined;
  }
  const canRead = await readable(query, ref);
  const columns = rows.map(
    (row): ColumnFacts => ({
      name: text(row["column_name"]),
      type: text(row["data_type"]),
      comment: row["remark"] === null ? null : text(row["remark"]),
      time: row["holds_time"] === 1,
      nullable: row["nullable"] === "Y",
      readable: canRead,
    }),
  );
  return {
    columns,
    key: (await query(PRIMARY_KEY, at)).map((row) => text(row["column_name"])),
    policies: [],
    triggers: [],
    workerSelect: [],
  };
}

/**
 * The statement `run` executes at the plan's secret one: the password reaches the server as a bind
 * parameter, never as text in a plan or a script. Oracle's DDL takes no bind parameter, so the
 * block passes it to `create user`; a quoted password holds anything but a double quote.
 */
const CREATE_LOGIN = `declare
  secret varchar2(1024) := :1;
begin
  if secret is null or instr(secret, '"') > 0 then
    raise_application_error(-20001, 'FacetDB: the worker password must be non-empty and hold no double quote');
  end if;
  execute immediate 'create user ${worker} identified by "' || secret || '"';
end;`;

const LOGIN: LoginRule = {
  name: WORKER,
  exists: async (query) => (await query(LOGIN_EXISTS, [WORKER])).length > 0,
  secretText: `-- the worker login ${WORKER}: created by facetdb migrate with the password of the source's connection string, bound, never printed`,
  secret: (password) => ({ text: CREATE_LOGIN, params: [password] }),
  create: () => [`grant create session to ${worker}`],
  grants: (ref, _select, update) => [
    // Oracle grants no column-level select: the worker reads the whole table.
    `grant select on ${table(ref)} to ${worker}`,
    `grant update (${update.map(quoteIdent).join(", ")}) on ${table(ref)} to ${worker}`,
  ],
  schemaUsage: false,
  revoke: (ref) => [
    // `revoke all` stops with ORA-01927 when the worker holds nothing on the table (an uninstall
    // run again after one that stopped past this point); the grant before it makes it hold one.
    // It gives back only the read install gave, which the next statement takes with the rest. A
    // PL/SQL block ignoring ORA-01927 would read worse in the printed script: SQL*Plus runs a
    // block only after a `/` line, and the plan's `;` after each statement would print `end;;`.
    `grant select on ${table(ref)} to ${worker}`,
    `revoke all on ${table(ref)} from ${worker}`,
  ],
  // The worker's read is the whole table's, so a column no longer read has no grant to take back.
  revokeSelect: () => [],
  whoami: "select user as name from dual",
  urlShape: "oracle://facetdb_worker:<a long random password>@<host>:1521/<service>",
};

/** 127.0.0.0/8, ::1 and localhost: this machine, where a password in the clear goes nowhere. */
function loopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * "Connections use TLS": a URL asks for it with `?protocol=tcps`; without it, only this machine's
 * own host is reached in the clear, or any host with --allow-insecure. The driver reads the host
 * the same way (`new URL`), so no URL is ambiguous here.
 */
function verdict(url: string, allowInsecure: boolean): TlsVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid";
  }
  if (parsed.hostname === "") {
    return "invalid";
  }
  return allowInsecure ||
    parsed.searchParams.get("protocol") === "tcps" ||
    loopback(parsed.hostname)
    ? undefined
    : { host: parsed.hostname };
}

/** The interval from the epoch to `column`, a `timestamp(3)` in UTC. */
const sinceEpoch = (column: string) => `(${quoteIdent(column)} - timestamp '1970-01-01 00:00:00')`;

export const oracleDialect: SqlDialect = {
  name: "Oracle",
  schemes: ["oracle"],
  // No default: a source names its table's owner (tableFacts refuses an empty schema).
  defaultSchema: "",
  transactionalDdl: false,
  // No setting: Oracle never queues the application's statements behind FacetDB's DDL, the harm
  // Postgres's ten-second lock_timeout guards against. Up to 21c, an `alter table` on a table
  // another transaction holds stops at once (ddl_lock_timeout's default of 0: ORA-00054, the
  // `table-busy` refusal) and a fresh plan completes it; 23ai's waits for that transaction to end
  // while the application's own statements go on (oracle.db.test.ts proves it on Oracle Free).
  header: [],

  placeholder: (index) => `:${index}`,
  quoteIdent,
  quoteTable,
  quoteLiteral,
  // The session pins the text formats (oracle-connect.ts), so the hash's text is the same everywhere.
  keyAsText: (column) => `to_char(${quoteIdent(column)})`,
  // `to_char` of a CLOB stops past 4000 bytes (ORA-22835), and one long row would stop every poll
  // of the source: a CLOB or NCLOB state field is selected as it is, and the client fetches it as
  // text (oracle-connect.ts), the same text `to_char` gives a short one, so its hash is unchanged.
  // `to_char` of a JSON value past 4000 bytes is NULL, with no error (23ai), so a large JSON state
  // field would hash as null and its changes go unnoticed: it is serialized to a CLOB and read
  // whole the same way. A short object, array or number reads as `to_char` read it; a JSON value
  // that is a string alone keeps its quotes now (`"text"`, where `to_char` gave `text`), so such a
  // row's hash changes once and the row is asked again.
  stateAsText: (column, type) =>
    LOB_TEXT.has(type)
      ? quoteIdent(column)
      : type === "JSON"
        ? `json_serialize(${quoteIdent(column)} returning clob)`
        : `to_char(${quoteIdent(column)})`,
  unreadableState: (type) => !readsAsText(type),
  inList: (count) => `in (${placeholders(count)})`,
  // ORA-01795: an `in` list holds 1000 items at most.
  maxInList: 1000,

  types: {
    boolean: "number(1)",
    text: "varchar2(255 char)",
    real: "number",
    json: "clob",
    timestamp: "timestamp(3)",
    // A state hash is SHA-256 in hex.
    hash: "varchar2(64)",
  },
  falseValue: "0",
  booleans: {
    bind: (value) => (value ? 1 : 0),
    read(value) {
      if (value === 1 || value === 0) {
        return value === 1;
      }
      throw new Error(
        `a boolean of FacetDB's came back as ${JSON.stringify(value)}, expected 1 or 0 (number(1))`,
      );
    },
  },
  // Plain arithmetic on a timestamp without a time zone: the stored time is UTC by construction.
  timeFromMs: (placeholder) =>
    `timestamp '1970-01-01 00:00:00' + numtodsinterval(${placeholder} / 1000, 'SECOND')`,
  msOfTime: (column) =>
    `to_char(extract(day from ${sinceEpoch(column)}) * 86400000 + extract(hour from ${sinceEpoch(column)}) * 3600000 + extract(minute from ${sinceEpoch(column)}) * 60000 + round(extract(second from ${sinceEpoch(column)}) * 1000))`,
  excluded: (where) => (where === undefined ? "0" : `case when (${where}) then 0 else 1 end`),

  addColumn: "inspect-first",
  addColumns: (ref, columns) => [
    `alter table ${table(ref)} add (${columns
      .map(([name, definition]) => `${quoteIdent(name)} ${definition}`)
      .join(", ")})`,
  ],
  dropColumns: (ref, columns) => [
    `alter table ${table(ref)} drop (${columns.map(quoteIdent).join(", ")})`,
  ],

  limit: (placeholder) => `fetch first ${placeholder} rows only`,
  // No row-value comparison in Oracle: the tie-breaker spelled out; a placeholder used twice binds
  // one value, since the client binds by name.
  after: ([first = "", second = ""], [over = "", tie = ""]) =>
    `(${quoteIdent(first)} > ${over} or (${quoteIdent(first)} = ${over} and ${quoteIdent(second)} > ${tie}))`,

  ownership: {
    kind: "comment",
    commentOn: (ref, column, mark) =>
      `comment on column ${table(ref)}.${quoteIdent(column)} is ${quoteLiteral(mark)}`,
  },
  table: (query, ref) => tableFacts(query, ref),

  tls: {
    verdict,
    shape: "oracle://user:password@host:1521/service",
    secureShape: "oracle://user:password@host:2484/service?protocol=tcps",
    ask: "add ?protocol=tcps to",
  },
  login: LOGIN,
  ping: "select 1 from dual",
};

/**
 * The polling engine over Oracle, for `oracle://` sources: what main.ts registers, lazily, so
 * `oracledb` loads only for a source of that scheme.
 */
export function createOracleEngine(options: PollingEngineOptions): DatabaseEngine {
  return pollingEngine(oracleDialect, connectOracle, options);
}
