import {
  type DatabaseEngine,
  EngineRefusal,
  type EngineTarget,
  type KeyText,
  type OpenConnector,
  type OpenOptions,
  type RecordKey,
  type Refusal,
  type RunResult,
} from "@facetdb/core";
import type { ConnectorChoice, SourceConfig } from "../config/index.ts";
import { CliError, type EngineEntry } from "./program.ts";

/**
 * Which engine serves a source: the scheme of its connection string names an engine key in the
 * static table below, and the entry the composition root registered under that key
 * (`CliDeps.engines`: main.ts registers the Postgres engine, other engines append theirs) is loaded
 * on first use, so no driver is imported for a scheme no source has; `connector:` names another
 * engine instead. Nothing here connects, so an unknown scheme is refused before any connection,
 * naming the engines registered and the page of the databases FacetDB reads. The words never echo a
 * connection string: it may carry a password.
 */

/** A database FacetDB connects to, as the CLI's words name it. */
export type KnownDatabase = {
  /** The key its engine is registered under in `CliDeps.engines`. */
  readonly key: string;
  readonly name: string;
  readonly schemes: readonly string[];
  /** Whether it is a SQL database, which the polling connector can scan. */
  readonly sql: boolean;
  /**
   * The worker's connection string as init and doctor show its shape: the login the install
   * creates, a placeholder for its password, and the TLS parameter the engine reads.
   */
  readonly workerUrl: string;
  /** Whether its trigger engine keeps answers in a side table (`storage: "side-table"`). */
  readonly sideTable: boolean;
  /**
   * Whether the engine its scheme picks is a polling engine itself (CockroachDB, Oracle), so
   * `connector: "polling"` names the engine the scheme picks already.
   */
  readonly polls: boolean;
  /** What `facetdb types` writes for a source on it. */
  readonly types: EngineTypes;
};

/**
 * How a database keeps FacetDB's answers, as `facetdb types` writes them: static words, read with
 * no driver loaded. The declaration file types what a raw driver read returns; the ORM snippets use
 * the Drizzle core and the Prisma provider the database has, or say there is none.
 */
export type EngineTypes = {
  /** The `drizzle-orm/<core>` its tables are built with; absent where Drizzle has no driver for it. */
  readonly drizzle?: "pg-core" | "mysql-core" | "sqlite-core";
  /** The Prisma datasource provider; absent where Prisma has none for it. */
  readonly prisma?: "postgresql" | "cockroachdb" | "mysql" | "sqlserver" | "sqlite" | "mongodb";
  /** A yes-or-no answer: the type the install gives it, and what a raw read returns. */
  readonly boolean: { readonly stored: string; readonly read: "boolean" | "0 | 1" };
  /** A probability, confidence or expected value: the type the install gives it (read as a number). */
  readonly real: string;
  /**
   * A choice's probabilities: the type the install gives them, and what a raw read returns
   * (`clob fetched as text`: node-oracledb hands back a Lob unless the application fetches a clob
   * as a string).
   */
  readonly json: {
    readonly stored: string;
    readonly read: "object" | "text" | "object or text" | "clob fetched as text";
  };
  /** Where the answers live: columns of the table, or fields of each document's `facetdb` subdocument. */
  readonly answersIn: "columns" | "subdocument";
  /**
   * When a read finds `facetdb_status` null, in words ("a row the trigger has not seen yet"): the
   * install adds it nullable with no default, and pending is set only once a row is reached (SQL
   * Server; the polling installs). Absent where the install adds it not null with the pending
   * default.
   */
  readonly statusNullUntil?: string;
  /** `facetdb_reviewed` as the install adds it: whether a read can find it null, and whether it starts false. */
  readonly reviewed: { readonly nullable: boolean; readonly defaultFalse: boolean };
  /** Where a side table lives: in the `facetdb` schema, or beside the table as `facetdb_<table>_answers`. */
  readonly sideTableIn: "facetdb schema" | "beside the table";
};

/** Postgres's types: what `facetdb types` writes for an API source and a source with no connection string. */
export const POSTGRES_TYPES: EngineTypes = {
  drizzle: "pg-core",
  prisma: "postgresql",
  boolean: { stored: "boolean", read: "boolean" },
  real: "real",
  json: { stored: "jsonb", read: "object" },
  answersIn: "columns",
  reviewed: { nullable: false, defaultFalse: true },
  sideTableIn: "facetdb schema",
};

/**
 * FacetDB's own columns as a polling install adds them (`@facetdb/sql-polling`'s `ownedColumns`):
 * the status nullable with no default, set to pending only when the poller reaches the row;
 * reviewed nullable with a false default. CockroachDB and Oracle are always polled, and `connector:
 * "polling"` polls a Postgres table the same way.
 */
export const POLLED_COLUMNS = {
  statusNullUntil: "a row the poller has not reached yet",
  reviewed: { nullable: true, defaultFalse: true },
} as const satisfies Pick<EngineTypes, "statusNullUntil" | "reviewed">;

/** Every database FacetDB connects to: its engine's key and schemes. */
const DATABASES: readonly KnownDatabase[] = [
  {
    key: "postgres",
    name: "Postgres",
    schemes: ["postgres", "postgresql"],
    sql: true,
    sideTable: true,
    polls: false,
    workerUrl:
      "postgres://facetdb_worker:<a long random password>@<host>:5432/<database>?sslmode=require",
    types: POSTGRES_TYPES,
  },
  {
    key: "mysql",
    name: "MySQL or MariaDB",
    schemes: ["mysql", "mariadb"],
    sql: true,
    sideTable: true,
    polls: false,
    workerUrl:
      'mysql://facetdb_worker:<a long random password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}',
    // mysql2 reads tinyint(1) as a number; MySQL's json comes back parsed, MariaDB's (a longtext) as text.
    types: {
      drizzle: "mysql-core",
      prisma: "mysql",
      boolean: { stored: "boolean, which is tinyint(1)", read: "0 | 1" },
      real: "float",
      json: { stored: "json", read: "object or text" },
      answersIn: "columns",
      reviewed: { nullable: false, defaultFalse: true },
      sideTableIn: "beside the table",
    },
  },
  {
    key: "mssql",
    name: "SQL Server",
    schemes: ["mssql", "sqlserver"],
    sql: true,
    sideTable: true,
    polls: false,
    workerUrl: "mssql://facetdb_worker:<a long random password>@<host>:1433/<database>",
    types: {
      prisma: "sqlserver",
      boolean: { stored: "bit", read: "boolean" },
      real: "real",
      json: { stored: "nvarchar(max)", read: "text" },
      answersIn: "columns",
      statusNullUntil: "a row the trigger has not seen yet",
      reviewed: { nullable: true, defaultFalse: false },
      sideTableIn: "beside the table",
    },
  },
  {
    key: "sqlite",
    name: "SQLite",
    schemes: ["sqlite", "file"],
    sql: true,
    sideTable: false,
    polls: false,
    workerUrl: "sqlite:///absolute/path/to/app.db",
    types: {
      drizzle: "sqlite-core",
      prisma: "sqlite",
      boolean: { stored: "integer", read: "0 | 1" },
      real: "real",
      json: { stored: "text", read: "text" },
      answersIn: "columns",
      reviewed: { nullable: false, defaultFalse: true },
      sideTableIn: "beside the table",
    },
  },
  {
    key: "libsql",
    name: "libSQL",
    schemes: ["libsql"],
    sql: true,
    sideTable: false,
    polls: false,
    workerUrl: "libsql://<database>-<organization>.turso.io",
    types: {
      drizzle: "sqlite-core",
      prisma: "sqlite",
      boolean: { stored: "integer", read: "0 | 1" },
      real: "real",
      json: { stored: "text", read: "text" },
      answersIn: "columns",
      reviewed: { nullable: false, defaultFalse: true },
      sideTableIn: "beside the table",
    },
  },
  {
    key: "mongodb",
    name: "MongoDB",
    schemes: ["mongodb", "mongodb+srv"],
    sql: false,
    sideTable: false,
    polls: false,
    workerUrl:
      "mongodb://facetdb_worker:<a long random password>@<host>:27017/<database>?replicaSet=rs0",
    types: {
      prisma: "mongodb",
      boolean: { stored: "a BSON boolean", read: "boolean" },
      real: "a double",
      json: { stored: "an embedded document", read: "object" },
      answersIn: "subdocument",
      // Written only as true, once a person decides; absent until then.
      reviewed: { nullable: true, defaultFalse: false },
      sideTableIn: "beside the table",
    },
  },
  {
    key: "cockroachdb",
    name: "CockroachDB",
    schemes: ["cockroachdb"],
    sql: true,
    sideTable: false,
    polls: true,
    workerUrl:
      "cockroachdb://facetdb_worker:<a long random password>@<host>:26257/<database>?sslmode=verify-full",
    types: {
      drizzle: "pg-core",
      prisma: "cockroachdb",
      boolean: { stored: "boolean", read: "boolean" },
      real: "real",
      json: { stored: "jsonb", read: "object" },
      answersIn: "columns",
      ...POLLED_COLUMNS,
      sideTableIn: "facetdb schema",
    },
  },
  {
    key: "oracle",
    name: "Oracle",
    schemes: ["oracle"],
    sql: true,
    sideTable: false,
    polls: true,
    workerUrl:
      "oracle://facetdb_worker:<a long random password>@<host>:2484/<service>?protocol=tcps",
    // node-oracledb reads number(1) as a number, and a clob as a Lob unless the application fetches
    // clobs as strings (FacetDB's own connection does: sql-polling's oracle-connect.ts).
    types: {
      boolean: { stored: "number(1)", read: "0 | 1" },
      real: "number",
      json: { stored: "clob", read: "clob fetched as text" },
      answersIn: "columns",
      ...POLLED_COLUMNS,
      sideTableIn: "beside the table",
    },
  },
];

/**
 * The key `connector: "polling"` picks: the polling engine of `@facetdb/sql-polling`, which main.ts
 * registers over the Postgres dialect. The engine refuses, in its own words, a connection string
 * its dialect does not read.
 */
const POLLING = "polling";

/** The page that lists the databases FacetDB connects to and the scheme of each one's string. */
export const DATABASES_PAGE = "https://docs.facetdb.dev/databases";

/** `scheme:` at the start of a connection string (a URL's, per RFC 3986). */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** A file path with no scheme names a SQLite database by its extension. */
const SQLITE_FILE = /\.(db|sqlite|sqlite3)$/i;

/** A Turso database's host: `<database>-<organization>.turso.io`, with a region part or without. */
const TURSO_HOST = /(^|\.)turso\.io$/;

/**
 * The scheme a connection string is read by: its own, lowercased; `sqlite` for a bare file path
 * ending in `.db`, `.sqlite` or `.sqlite3`; `libsql` for an `https` or `http` URL whose host is
 * Turso's (`turso.io`) or has `libsql` in it (a libSQL server over HTTP, whose engine refuses
 * `http` to another machine without `--allow-insecure`). Undefined when it names none.
 */
export function schemeOf(url: string): string | undefined {
  const text = url.trim();
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return SQLITE_FILE.test(text) ? "sqlite" : undefined;
  }
  if (scheme === "https" || scheme === "http") {
    let host = "";
    try {
      host = new URL(text).hostname.toLowerCase();
    } catch {
      // Not a URL past its scheme: a string that names no host is no libSQL server.
    }
    return host.includes("libsql") || TURSO_HOST.test(host) ? "libsql" : scheme;
  }
  return scheme;
}

/** The database a connection string's scheme names, from the static table; nothing is loaded. */
export function databaseOf(url: string): KnownDatabase | undefined {
  const scheme = schemeOf(url);
  return scheme === undefined
    ? undefined
    : DATABASES.find((database) => database.schemes.includes(scheme));
}

/**
 * The types of the database a connection string's scheme names, with its name and whether it is
 * SQL (which `connector: "polling"` needs); nothing is loaded.
 */
export function typesOf(
  url: string,
): { readonly database: string; readonly sql: boolean; readonly types: EngineTypes } | undefined {
  const database = databaseOf(url);
  return database === undefined
    ? undefined
    : { database: database.name, sql: database.sql, types: database.types };
}

/** Whether an engine is registered for a connection string's scheme; nothing is loaded. */
export function readsUrl(entries: readonly EngineEntry[], url: string): boolean {
  const database = databaseOf(url);
  return database !== undefined && entries.some((entry) => entry.key === database.key);
}

/** The engines registered, in words: `postgres (postgres://, postgresql://)`. */
function registered(entries: readonly EngineEntry[]): string {
  if (entries.length === 0) {
    return "none";
  }
  return entries
    .map((entry) => {
      const schemes = DATABASES.find((database) => database.key === entry.key)?.schemes ?? [];
      return schemes.length === 0
        ? entry.key
        : `${entry.key} (${schemes.map((scheme) => `${scheme}://`).join(", ")})`;
    })
    .join("; ");
}

/**
 * An engine entry that loads its engine on first use and keeps it: main.ts registers each engine
 * so, and a test registers its fake engine the same way.
 */
export function lazyEngine(key: string, load: () => Promise<DatabaseEngine>): EngineEntry {
  let loaded: Promise<DatabaseEngine> | undefined;
  return {
    key,
    load: () => {
      loaded ??= load();
      return loaded;
    },
  };
}

/**
 * The engine for a source's connection string, or the one its `connector:` override picks:
 * `"polling"` for a SQL scheme, from the polling engine; on a scheme whose engine polls already
 * (CockroachDB, Oracle), that engine, as with no override. Only that engine is loaded. Refused
 * before anything connects: an unknown scheme, a database whose engine is not registered here,
 * polling on a database that is not SQL, or polling where no polling engine is registered and the
 * scheme's own engine is no polling engine.
 */
export async function engineFor(
  entries: readonly EngineEntry[],
  url: string,
  override?: ConnectorChoice,
): Promise<DatabaseEngine> {
  const scheme = schemeOf(url);
  const database = databaseOf(url);
  if (override === "polling" && database?.polls !== true) {
    if (database !== undefined && !database.sql) {
      throw new CliError(
        "connector-polling",
        `connector: "polling" scans the rows of a SQL table, and the source's connection string is ${database.name}'s (${scheme}:), which FacetDB watches by its own change feed`,
        'remove connector: "polling" from the source in facetdb.config.ts',
      );
    }
    const polling = entries.find((entry) => entry.key === POLLING);
    if (polling === undefined) {
      throw new CliError(
        "connector-polling",
        `the source asks for connector: "polling", and no polling engine is registered here; the engines registered here read ${registered(entries)}`,
        'remove connector: "polling" from the source in facetdb.config.ts to watch the table with the engine of its scheme',
      );
    }
    return polling.load();
  }
  const entry =
    database === undefined ? undefined : entries.find((one) => one.key === database.key);
  if (entry !== undefined) {
    return entry.load();
  }
  throw new CliError(
    "unknown-scheme",
    database === undefined
      ? `the connection string names no database FacetDB connects to${scheme === undefined ? " (it has no scheme, such as postgres://)" : ` (its scheme is ${scheme}:)`}; the engines registered here read ${registered(entries)}`
      : `the connection string is ${database.name}'s (${scheme}:), and no ${database.name} engine is registered here; the engines registered here read ${registered(entries)}`,
    `use a connection string one of those engines reads; the databases FacetDB connects to, and the scheme each one's string starts with, are at ${DATABASES_PAGE}`,
  );
}

/**
 * How a source's keys are written on the terminal: its engine's `keyText` (MongoDB's `_id` as the
 * user writes it), or undefined where a key is its own text (the SQL engines, the polling engine,
 * an API source). For a command that reads the store only (`export`): nothing connects, and a
 * source whose connection string is unset here, or names no engine registered here, keeps its keys
 * as stored rather than stopping a read that never needed its database (export then says so on
 * stderr, naming the variable to set).
 */
export async function keyTextFor(
  entries: readonly EngineEntry[],
  source: Pick<SourceConfig, "table" | "database" | "connector">,
): Promise<KeyText | undefined> {
  const url = source.database;
  if (source.table === undefined || url === undefined || source.connector === "polling") {
    return undefined;
  }
  return readsUrl(entries, url) ? (await engineFor(entries, url)).keyText : undefined;
}

/** A key as the terminal shows it: through the engine's `keyText` when it has one. */
export function keyWords(keyText: KeyText | undefined, key: RecordKey): string {
  return keyText === undefined ? key : keyText.toText(key);
}

/** Whether a connection string is a Postgres one: the store's kind, and the store-sharing kind. */
export function isPostgresUrl(url: string): boolean {
  return databaseOf(url)?.key === "postgres";
}

/** An engine's refusal as the error the CLI prints: its code (the page's), message and fix. */
export function refusalError(refusal: Refusal): CliError {
  return new CliError(refusal.code, refusal.message, refusal.fix);
}

/**
 * The database changed after its script was shown: planned again right before the run, it gives
 * another script, so what would run is not what was read; nothing ran.
 */
export function databaseChanged(): CliError {
  return new CliError(
    "database-changed",
    "the database changed after the SQL was shown, so the SQL to run is no longer the SQL you saw; nothing was run",
    "run the command again to see the SQL for the database as it is now",
  );
}

/**
 * Where a run stopped, as the error to print: the engine's own check refusing, in its words, or
 * the database's error as it came (an unplanned failure keeps the CLI's "unexpected" code).
 */
export function stoppedError(stopped: NonNullable<RunResult["stopped"]>): Error {
  return "refusal" in stopped ? refusalError(stopped.refusal) : new Error(stopped.error);
}

/**
 * Refuses, before anything connects, a source URL its engine would refuse to open (a password in
 * the clear to another machine): the worker asks it of every source before it opens the store.
 */
export function requireUsableUrl(
  engine: DatabaseEngine,
  target: EngineTarget,
  url: string,
  allowInsecure: boolean,
): void {
  const refused = engine.checkUrl(target, url, { allowInsecure });
  if (refused !== undefined) {
    throw refusalError(refused);
  }
}

/** A source's runtime connector from its engine; a refusal (`EngineRefusal`) is the CLI's error. */
export async function openConnector(
  engine: DatabaseEngine,
  target: EngineTarget,
  url: string,
  options: OpenOptions,
): Promise<OpenConnector> {
  try {
    return await engine.open(target, url, options);
  } catch (error) {
    if (error instanceof EngineRefusal) {
      throw refusalError(error.refusal);
    }
    throw error;
  }
}
