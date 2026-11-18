import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { DatabaseEngine, DoctorCheck } from "@facetdb/core";
import postgres from "postgres";
import type {
  ColumnFacts,
  LoginRule,
  PollingConnect,
  PollingQuery,
  PollingRow,
  SqlDialect,
  TableFacts,
  TableRef,
  TlsVerdict,
} from "../dialect/index.ts";
import { databaseLabel, plainMessage, pollingEngine } from "../engine/index.ts";

/**
 * CockroachDB as a polling dialect. CockroachDB speaks the Postgres wire, so the driver is
 * postgres.js and most of the text is Postgres's: `$n` placeholders, `::text` reads, `add column if
 * not exists`, `drop column if exists`, `now()`, row-value keyset paging, column comments as the
 * marks. What differs, each proven on a CockroachDB 24.3 node with its default settings
 * (cockroach.db.test.ts):
 *
 * - A plan is not one transaction (`transactionalDdl: false`): a schema change in an explicit
 *   transaction runs as a job after the commit, and one that fails there leaves the transaction's
 *   other statements committed (SQLSTATE XXA00); a plan holding a dozen of them and the login would
 *   be all or nothing only in name. A run that stops keeps what ran, and a fresh plan completes it.
 * - A small group is (`atomic`): one column's `add column` and its `comment on` commit together
 *   (proven on the node, a failing comment leaving no column), so a run stopped anywhere, a Ctrl-C
 *   during a backfill CockroachDB finishes on its own included, leaves no unmarked FacetDB column
 *   that the next plan would refuse as the application's. Each group sets
 *   `autocommit_before_ddl` off for itself: on by default from 25.1, it commits before every DDL
 *   statement, and the node showed the column staying while the comment failed.
 * - No `lock table` (a syntax error), so the install claims the table instead: its first group adds
 *   `facetdb_state_hash` without `if not exists`, with the project's mark, so of two projects'
 *   installs racing on one table one adds it and the other's add fails; `run` reads the mark right
 *   after the claim and after a failed one, and stops with the ownership refusal, and `open`
 *   refuses a table another project's mark claims. No header either: an `alter table` is an online
 *   schema change that queues none of the application's queries (Postgres's `lock_timeout`
 *   reason), and `standard_conforming_strings` cannot be turned off.
 * - No column-level grants (`grant select (…)` is a syntax error): the worker gets `select` and
 *   `update` on the whole table, and the plan's note says so.
 * - No row-level security in 24.3 and no trigger install of FacetDB's: the catalog reads no
 *   policies and no triggers. No `do` blocks: the worker login is one `create user if not exists …
 *   with login password $1`, bound to a SCRAM verifier, never the password.
 * - A table without a primary key has a hidden `rowid` one; hidden columns are left out of every
 *   catalog read, so such a table is refused for its missing key, as on Postgres, and never keyed
 *   by a column the application cannot see.
 */

const quoteIdent = (name: string): string => {
  if (name.length === 0 || name.includes("\0")) {
    throw new Error("an identifier must be non-empty text without a NUL character");
  }
  return `"${name.replaceAll('"', '""')}"`;
};

/** A literal for the plans; a backslash is itself (`standard_conforming_strings` is always on). */
const quoteLiteral = (text: string): string => {
  if (text.includes("\0")) {
    throw new Error("a literal must not contain a NUL character");
  }
  return `'${text.replaceAll("'", "''")}'`;
};

const quoteTable = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

const table = (ref: TableRef) => quoteTable(ref.schema, ref.name);

const RELATION = `to_regclass(format('%I.%I', $1::text, $2::text))`;

const PRESENT = `select ${RELATION} is not null as present`;

/** The columns CockroachDB hides (a table's implicit `rowid`): never the application's, never a key. */
const NOT_HIDDEN = `not exists (select 1 from information_schema.columns c
                   where c.table_schema = $1 and c.table_name = $2
                     and c.column_name = a.attname and c.is_hidden = 'YES')`;

/**
 * Every visible column with its type, comment (FacetDB's marks), whether it holds a time and allows
 * NULL, and whether the connection's own login may select it (CockroachDB answers from the table's
 * grant: the worker's, in `open` and doctor).
 */
const COLUMNS = `select a.attname::text as name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
       pg_catalog.col_description(a.attrelid, a.attnum) as comment,
       a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype) as time,
       not a.attnotnull as nullable,
       pg_catalog.has_column_privilege(a.attrelid, a.attnum, 'SELECT') as readable
  from pg_catalog.pg_attribute a
 where a.attrelid = ${RELATION}
   and a.attnum > 0 and not a.attisdropped
   and ${NOT_HIDDEN}
 order by a.attnum`;

const PRIMARY_KEY = `select a.attname::text as name
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
 where i.indrelid = ${RELATION} and i.indisprimary
   and ${NOT_HIDDEN}
 order by a.attnum`;

const ROLE_EXISTS = "select 1 from pg_catalog.pg_roles where rolname = $1";

const names = (rows: readonly PollingRow[]) => rows.map((row) => String(row["name"]));

/** The catalog's facts of a table, read with whichever login the call has (the worker's in doctor). */
async function tableFacts(query: PollingQuery, ref: TableRef): Promise<TableFacts | undefined> {
  const at = [ref.schema, ref.name];
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
    // No row-level security before CockroachDB 25.2, and FacetDB installs no trigger here.
    policies: [],
    triggers: [],
    // Grants are on the whole table: there is no column-level select to take back.
    workerSelect: [],
  };
}

/**
 * A SCRAM-SHA-256 verifier of the worker password, so the plaintext never reaches the server, not
 * even as a bind parameter (the Postgres install's rule, packages/postgres/src/install/scram.ts; this
 * package cannot import @facetdb/postgres, which imports it). CockroachDB stores a pre-hashed
 * password as given (`server.user_login.store_client_pre_hashed_passwords.enabled`, on by default),
 * and 4096 iterations is the least its cost setting accepts.
 */
const SCRAM_ITERATIONS = 4096;

export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const WORKER = "facetdb_worker";
const worker = quoteIdent(WORKER);

/**
 * The worker login in one statement (CockroachDB has no `do` block to branch in): created when
 * missing, with the verifier bound; `if not exists` keeps an existing login's password, as the
 * Postgres install does. A cluster started with `--insecure` refuses any password (SQLSTATE 28P01,
 * "setting or updating a password is not supported in insecure mode"), and logs anyone in without
 * one: there the login is made by hand, `create user facetdb_worker`, and the plan skips this.
 */
const CREATE_LOGIN = `create user if not exists ${worker} with login password $1`;

const LOGIN: LoginRule = {
  name: WORKER,
  exists: async (query) => (await query(ROLE_EXISTS, [WORKER])).length > 0,
  secretText: `-- the worker login: facetdb migrate runs ${CREATE_LOGIN} here, with a SCRAM verifier of the password bound, never printed;\n-- run by hand, create it first: create user ${worker} with login password '<a long random password>'`,
  secret: (password) => ({ text: CREATE_LOGIN, params: [scramVerifier(password)] }),
  create: () => [],
  // Table-level: `grant select (…)` does not parse on CockroachDB. The note below says so.
  grants: (ref) => [
    `grant usage on schema ${quoteIdent(ref.schema)} to ${worker}`,
    `grant select on table ${table(ref)} to ${worker}`,
    `grant update on table ${table(ref)} to ${worker}`,
  ],
  grantsNote: (label) =>
    `CockroachDB has no column-level grants, so the worker login ${WORKER} may read and update every column of ${label}, not only its key, the state fields and FacetDB's own columns (FacetDB reads and writes only those); keep a column the worker must never read in another table`,
  schemaUsage: true,
  revoke: (ref) => [`revoke all on table ${table(ref)} from ${worker}`],
  // Nothing to take back column by column: the worker's read is the whole table's.
  revokeSelect: () => [],
  whoami: "select current_user::text as name",
  urlShape: `cockroachdb://${WORKER}:<a long random password>@<host>:26257/<database>?sslmode=verify-full`,
};

/** A connection string cut into what the TLS rule and the driver read; undefined when it is none. */
type UrlParts = {
  /** Everything up to the query, as written. */
  readonly base: string;
  /** Each host of the list, without its port, percent-decoded as the driver decodes it. */
  readonly hosts: readonly string[];
  readonly params: URLSearchParams;
  /** More than one `@` before the path: the check and the driver would read different hosts. */
  readonly ambiguous: boolean;
};

const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;

function partsOf(url: string): UrlParts | undefined {
  if (!URL_START.test(url)) {
    return undefined;
  }
  const query = url.indexOf("?");
  const base = query === -1 ? (url.split("#")[0] ?? "") : url.slice(0, query);
  const search = query === -1 ? "" : (url.slice(query + 1).split("#")[0] ?? "");
  const authority = base.slice(base.indexOf("://") + 3).split("/")[0] ?? "";
  // postgres.js takes the host list after the first `@`; a second one is refused as ambiguous.
  const list = authority.slice(authority.indexOf("@") + 1);
  try {
    const hosts =
      list === ""
        ? []
        : list.split(",").map((one) => {
            const host = decodeURIComponent(one).toLowerCase();
            return host.startsWith("[")
              ? host.slice(0, host.indexOf("]") + 1)
              : (host.split(":")[0] ?? "");
          });
    return {
      base,
      hosts,
      params: new URLSearchParams(search),
      ambiguous: authority.split("@").length > 2,
    };
  } catch {
    return undefined;
  }
}

/** The last value of a parameter: the driver lets a later one replace an earlier one. */
const lastOf = (params: URLSearchParams, name: string) => params.getAll(name).at(-1);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The modes that never send the password in the clear (libpq's, which CockroachDB documents). */
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * "Connections use TLS", as the Postgres engine judges a Postgres URL: a URL reaching another
 * machine must ask for TLS by `sslmode=require` or stronger; this machine's own needs none (a
 * hostless URL is localhost: the connect names it, so `PGHOST` is never read). `--allow-insecure`
 * is the one explicit way out, which the compose container's `--insecure` node needs from any other
 * host; on 127.0.0.1 the loopback rule lets its `cockroachdb://root@127.0.0.1:26257/defaultdb` in.
 */
function verdict(url: string, allowInsecure: boolean): TlsVerdict {
  const parts = partsOf(url);
  if (parts === undefined) {
    return "invalid";
  }
  if (parts.ambiguous) {
    return "ambiguous";
  }
  if (allowInsecure) {
    return undefined;
  }
  const remote = parts.hosts.find((host) => !LOOPBACK.has(host));
  if (remote === undefined) {
    return undefined;
  }
  const mode = modeOf(parts.params);
  return mode !== undefined && TLS_MODES.has(mode) ? undefined : { host: remote };
}

/** The value libpq gives `sslrootcert` for the machine's own CA store (Node's default one). */
const SYSTEM_ROOTS = "system";

/**
 * The mode a URL asks for: its `sslmode`, else `verify-full` for `sslrootcert=system` alone (libpq's
 * rule, which postgres.js follows); undefined when it asks for none.
 */
function modeOf(params: URLSearchParams): string | undefined {
  return (
    lastOf(params, "sslmode") ??
    (lastOf(params, "sslrootcert") === SYSTEM_ROOTS ? "verify-full" : undefined)
  );
}

/** Reads a certificate or key file the connection string names; the connect's only file access. */
export type ReadTlsFile = (path: string) => Buffer;

/** What postgres.js is given for a CockroachDB connection string. */
export type DriverOptions = {
  /** The URL without the TLS parameters, which the driver would send as session settings. */
  readonly url: string;
  readonly ssl: false | "prefer" | ConnectionOptions;
  /** `localhost` for a URL with no host, so the driver never falls back to `PGHOST`. */
  readonly host?: string;
};

/** The TLS parameters the connect reads; any other `ssl…` parameter is refused, never forwarded. */
const TLS_PARAMS: readonly string[] = [
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
];

/**
 * TLS from the URL, as libpq and `cockroach sql --url` read it: `sslmode` (`disable`, `allow`,
 * `prefer`, `require`, `verify-ca`, `verify-full`; none is `disable`, which the TLS rule refuses
 * for another machine), `sslrootcert` the CA to verify the node against (with `require` it means
 * `verify-ca`; `system` is this machine's CA store and needs `verify-full`: both libpq's rules),
 * `sslcert` and `sslkey` a client certificate (CockroachDB's certificate login), `sslpassword` the
 * key's passphrase. postgres.js would send every parameter it does not know to the server as a
 * session setting, the passphrase too, so the TLS ones are read here and taken off the URL, and
 * any other `ssl…` one (`sslcrl`, `sslsni`, `sslcompression`, `ssl=true`) is refused with words.
 */
export function driverOptions(url: string, read: ReadTlsFile = readFileSync): DriverOptions {
  const parts = partsOf(url);
  if (parts === undefined) {
    throw new Error(
      "the connection string cannot be read; write it as cockroachdb://user:password@host:26257/database",
    );
  }
  const { params } = parts;
  const unread = [...new Set(params.keys())].filter(
    (name) => name.toLowerCase().startsWith("ssl") && !TLS_PARAMS.includes(name),
  );
  if (unread.length > 0) {
    throw new Error(
      `the connection string has ${unread.join(", ")}, which FacetDB's CockroachDB connection does not read (it reads ${TLS_PARAMS.join(", ")}); remove ${unread.length === 1 ? "it" : "them"}, and ask for TLS with sslmode=verify-full`,
    );
  }
  const mode = modeOf(params) ?? "disable";
  const rootcert = lastOf(params, "sslrootcert");
  if (rootcert === SYSTEM_ROOTS && mode !== "verify-full") {
    throw new Error(
      `sslrootcert=system checks the node against this machine's CA store, which any public certificate chains to, so it needs sslmode=verify-full (libpq's rule), not sslmode=${mode}; use sslmode=verify-full, or name your cluster's CA file in sslrootcert`,
    );
  }
  const file = (name: string) => {
    const path = lastOf(params, name);
    return path === undefined || path === "" ? undefined : read(path);
  };
  const ca = rootcert === SYSTEM_ROOTS ? undefined : file("sslrootcert");
  const cert = file("sslcert");
  const key = file("sslkey");
  const passphrase = lastOf(params, "sslpassword");
  const certificate = {
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(passphrase === undefined || passphrase === "" ? {} : { passphrase }),
  };
  let ssl: DriverOptions["ssl"];
  switch (mode === "require" && ca !== undefined ? "verify-ca" : mode) {
    case "disable":
      ssl = false;
      break;
    case "allow":
    case "prefer":
      ssl = "prefer";
      break;
    case "require":
      ssl = { rejectUnauthorized: false, ...certificate };
      break;
    case "verify-ca":
      // The node's certificate must chain to the CA; its name is not compared with the host.
      ssl = {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        ...(ca === undefined ? {} : { ca }),
        ...certificate,
      };
      break;
    case "verify-full":
      ssl = { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }), ...certificate };
      break;
    default:
      throw new Error(
        `sslmode=${mode} is not a mode CockroachDB reads; use sslmode=verify-full (or require, verify-ca, disable)`,
      );
  }
  for (const name of TLS_PARAMS) {
    params.delete(name);
  }
  const search = params.toString();
  return {
    url: search === "" ? parts.base : `${parts.base}?${search}`,
    ssl,
    ...(parts.hosts.length === 0 ? { host: "localhost" } : {}),
  };
}

/**
 * A string parameter goes to the server as the text it was given
 * (packages/postgres/src/sql/client.ts, seen on Supabase): postgres.js would turn a timestamptz
 * parameter into a JavaScript Date, keeping milliseconds only, and the poll's keyset cursor
 * (`updated_at` read as text, microseconds and all) would compare as an earlier time, so a full
 * page of rows sharing one millisecond would be read again forever. A json parameter would be
 * stringified twice.
 */
const timeAsGiven = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const jsonAsGiven = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
const TEXT_AS_GIVEN_TYPES = {
  time: { to: 1184, from: [1114, 1184], serialize: timeAsGiven, parse: (x: string) => new Date(x) },
  json: { to: 114, from: [114, 3802], serialize: jsonAsGiven, parse: (x: string) => JSON.parse(x) },
};

/** The pool of a client opened without a size, as the Postgres connect's. */
const DEFAULT_MAX_CONNECTIONS = 10;

/** How long `close` lets running statements finish before it destroys the connections. */
const CLOSE_TIMEOUT_S = 5;

/**
 * Every statement with parameters is a named prepared statement, described once per connection
 * (the Postgres connect's reason: one round trip per run after the first).
 */
const PREPARED = { prepare: true } as const;

/**
 * The postgres.js client for a `cockroachdb://` connection string (the Postgres package's
 * `connectPostgres`, less what polling never uses: no pipeline, no LISTEN, which CockroachDB does
 * not have). TLS is the URL's (`driverOptions`); the engine refuses a plaintext URL to another
 * machine before this is called.
 */
export const connectCockroach: PollingConnect = (url, options = {}) => {
  const driver = driverOptions(url);
  const sql = postgres(driver.url, {
    max: options.max ?? DEFAULT_MAX_CONNECTIONS,
    onnotice: () => undefined,
    types: TEXT_AS_GIVEN_TYPES,
    ssl: driver.ssl,
    ...(driver.host === undefined ? {} : { host: driver.host }),
  });
  return {
    query: async (text, params = []) => {
      const rows = await sql.unsafe(text, [...params] as never[], PREPARED);
      return rows as unknown as readonly PollingRow[];
    },
    transaction: (work) =>
      sql.begin(async (tx) => {
        const result = await work(async (text, params = []) => {
          const rows = await tx.unsafe(text, [...params] as never[], PREPARED);
          return rows as unknown as readonly PollingRow[];
        });
        return result as never;
      }) as Promise<never>,
    close: () => sql.end({ timeout: CLOSE_TIMEOUT_S }),
  };
};

/**
 * A group as the plan prints it, `begin;` through `commit`, which runs as printed by hand. `run`
 * sends what is inside (with the setting first) in the client's own transaction instead, so the
 * driver rolls back a group that fails: one sent as a single text would leave its connection in an
 * aborted transaction (SQLSTATE 25P02, seen on the node), and a pool hands that connection on.
 */
const GROUP_SETTING = "set local autocommit_before_ddl = off";
const GROUP_OPEN = `begin;\n${GROUP_SETTING};\n`;
const GROUP_CLOSE = ";\ncommit";

export const cockroachDialect: SqlDialect = {
  name: "CockroachDB",
  schemes: ["cockroachdb"],
  defaultSchema: "public",
  transactionalDdl: false,
  header: [],

  placeholder: (index) => `$${index}`,
  quoteIdent,
  quoteTable,
  quoteLiteral,
  keyAsText: (column) => `${quoteIdent(column)}::text`,
  inList: (count) =>
    `in (${Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ")})`,
  // As on Postgres: 100 bounds how many statements of different lengths each connection prepares.
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

  // One column per group here, in one transaction with its mark (`atomic`), skipped when present.
  addColumn: "if-not-exists",
  atomic: {
    group: (statements) => `${GROUP_OPEN}${statements.join(";\n")}${GROUP_CLOSE}`,
    inner: (text) =>
      text.startsWith(GROUP_OPEN) && text.endsWith(GROUP_CLOSE)
        ? `${GROUP_SETTING};\n${text.slice(GROUP_OPEN.length, -GROUP_CLOSE.length)}`
        : undefined,
    addStrict: (ref, name, definition) =>
      `alter table ${table(ref)}\n  add column ${quoteIdent(name)} ${definition}`,
  },
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
  table: (query, ref) => tableFacts(query, ref),

  tls: {
    verdict,
    shape: "cockroachdb://user:password@host:26257/database",
    secureShape: "cockroachdb://user:password@host:26257/database?sslmode=verify-full",
    ask: "add ?sslmode=verify-full to",
  },
  login: LOGIN,
  ping: "select 1",
  // A transaction-mode PgBouncer can stand in front of CockroachDB too, and the worker prepares
  // its statements: the same probe, `pg_backend_pid()` being the session's own on CockroachDB.
  pooler: {
    probe: "select pg_backend_pid() as pid, $1::int as run",
    goneState: "26000",
    known: () => undefined,
  },
};

/**
 * The CockroachDB dialect for a `postgres://` connection string that turned out to reach
 * CockroachDB: its SQL, with the Postgres dialect's schemes, TLS rule (and its `PGHOST`) and
 * worker URL shape, so the URL is judged and worded as the Postgres source it was written as.
 */
export function cockroachOnPostgresWire(postgresDialect: SqlDialect): SqlDialect {
  return {
    ...cockroachDialect,
    schemes: postgresDialect.schemes,
    tls: postgresDialect.tls,
    login: { ...LOGIN, urlShape: postgresDialect.login?.urlShape ?? LOGIN.urlShape },
  };
}

/** What `version()` starts with on every CockroachDB build: `CockroachDB CCL v24.3.37 (…)`. */
export function isCockroachVersion(version: string): boolean {
  return /^CockroachDB\b/.test(version);
}

/** The release a `version()` names, without its build: `CockroachDB CCL v24.3.37`, `PostgreSQL 16.4`. */
function releaseOf(version: string): string {
  return version.split(/ \(| on /)[0] ?? version;
}

export type PostgresWireOptions = {
  /** The Postgres dialect, judged with the environment's `PGHOST` (the composition root's). */
  readonly postgres: SqlDialect;
  /** The Postgres driver both dialects run on: CockroachDB speaks the Postgres wire. */
  readonly connect: PollingConnect;
  readonly warn: (message: string) => void;
};

/** The server a `postgres://` URL reached, as `version()` told it. */
type Found = {
  readonly engine: DatabaseEngine;
  readonly dialect: string;
  readonly release: string;
};

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * The polling engine for `connector: "polling"` on a `postgres://` source: a `postgres://` URL may
 * reach Postgres or CockroachDB, which speak one wire and differ in their SQL, so the engine asks
 * the server `version()` before it plans, runs, opens or checks, and hands the call to the polling
 * engine over the dialect it found; doctor's first line says which. One question per URL for the
 * process's life (a server does not change kind under a URL); a failed one is asked again next
 * time. A URL the Postgres rule refuses before connecting (another scheme, a password in the clear)
 * is refused as the Postgres engine refuses it, and no question is asked: both dialects share that
 * rule.
 */
export function postgresWireEngine(options: PostgresWireOptions): DatabaseEngine {
  const { postgres: postgresDialect, connect, warn } = options;
  const onPostgres = pollingEngine(postgresDialect, connect, { warn });
  const onCockroach = pollingEngine(cockroachOnPostgresWire(postgresDialect), connect, { warn });
  const asked = new Map<string, Promise<Found>>();

  async function ask(url: string): Promise<Found> {
    // Asked without a pool size: the CLI's driver shares a sized pool under its URL with every
    // later connection to it (cli/pools.ts), and this one connection is the question's own.
    const client = connect(url);
    try {
      // Schema-qualified: a `version()` of the application's earlier on the search_path could
      // otherwise send a Postgres source to this dialect (whole-table grants, no lock).
      const version = String(
        (await client.query("select pg_catalog.version() as version"))[0]?.["version"],
      );
      return isCockroachVersion(version)
        ? { engine: onCockroach, dialect: cockroachDialect.name, release: releaseOf(version) }
        : { engine: onPostgres, dialect: postgresDialect.name, release: releaseOf(version) };
    } finally {
      await client.close();
    }
  }

  function serverOf(url: string): Promise<Found> {
    const known = asked.get(url);
    if (known !== undefined) {
      return known;
    }
    const pending = ask(url);
    asked.set(url, pending);
    pending.catch(() => asked.delete(url));
    return pending;
  }

  /** Whether the Postgres rule refuses the URL before anything connects. */
  function refusedUnseen(url: string, allowInsecure: boolean): boolean {
    const scheme = SCHEME.exec(url.trim())?.[1]?.toLowerCase();
    return (
      scheme === undefined ||
      !postgresDialect.schemes.includes(scheme) ||
      postgresDialect.tls.verdict(url, allowInsecure) !== undefined
    );
  }

  async function engineOf(url: string, allowInsecure: boolean): Promise<DatabaseEngine> {
    return refusedUnseen(url, allowInsecure) ? onPostgres : (await serverOf(url)).engine;
  }

  const skip = (detail: string): DoctorCheck => ({ name: "dialect", status: "skip", detail });

  return {
    name: onPostgres.name,
    schemes: onPostgres.schemes,
    capabilities: onPostgres.capabilities,
    checks: [
      {
        name: "dialect",
        looksAt:
          "asks the server version() to tell CockroachDB from Postgres, which both speak the Postgres wire",
      },
      ...onPostgres.checks,
    ],
    // Both dialects name a bare table in `public`.
    label: (target, url) => onPostgres.label(target, url),
    planInstall: async (target, url, install) =>
      (await engineOf(url, install.allowInsecure)).planInstall(target, url, install),
    planUninstall: async (target, url, uninstall) =>
      (await engineOf(url, uninstall.allowInsecure)).planUninstall(target, url, uninstall),
    planPrune: async (target, url, deps) =>
      (await engineOf(url, deps.allowInsecure)).planPrune(target, url, deps),
    // Both engines print a plan alike; the plan carries its own statements.
    render: (plan) => onPostgres.render(plan),
    async run(target, plan, url, run) {
      let engine: DatabaseEngine;
      try {
        engine = await engineOf(url, run.allowInsecure);
      } catch (error) {
        return {
          ran: [],
          stopped: { at: 0, error: plainMessage(error, [url, run.workerPassword]) },
          removed: [],
          notes: [],
        };
      }
      return engine.run(target, plan, url, run);
    },
    checkUrl: (target, url, deps) => onPostgres.checkUrl(target, url, deps),
    open: async (target, url, open) =>
      (await engineOf(url, open.allowInsecure)).open(target, url, open),
    async doctor(target, url, deps) {
      if (refusedUnseen(url, deps.allowInsecure)) {
        return [
          skip("not checked: the connection string was refused before connecting"),
          ...(await onPostgres.doctor(target, url, deps)),
        ];
      }
      let found: Found;
      try {
        found = await serverOf(url);
      } catch {
        // The database check that follows connects again and says why it cannot, in its words.
        return [
          skip("not checked: the database could not be reached"),
          ...(await onPostgres.doctor(target, url, deps)),
        ];
      }
      return [
        {
          name: "dialect",
          status: "ok",
          detail: `"${target.source}" on ${databaseLabel(url)} answers version() as ${found.release}, so FacetDB polls it with the ${found.dialect} dialect`,
        },
        ...(await found.engine.doctor(target, url, deps)),
      ];
    },
  };
}
