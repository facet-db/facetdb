import {
  type DatabaseEngine,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  type OpenOptions,
  type Refusal,
  type RunResult,
} from "@facetdb/core";
import type { ConnectorChoice } from "../config/index.ts";
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

/** Every database FacetDB connects to: its engine's key and schemes. */
const DATABASES: readonly {
  /** The key its engine is registered under in `CliDeps.engines`. */
  readonly key: string;
  readonly name: string;
  readonly schemes: readonly string[];
  /** Whether it is a SQL database, which the polling connector can scan. */
  readonly sql: boolean;
}[] = [
  { key: "postgres", name: "Postgres", schemes: ["postgres", "postgresql"], sql: true },
  { key: "mysql", name: "MySQL or MariaDB", schemes: ["mysql", "mariadb"], sql: true },
  { key: "mssql", name: "SQL Server", schemes: ["mssql", "sqlserver"], sql: true },
  { key: "sqlite", name: "SQLite", schemes: ["sqlite", "file"], sql: true },
  { key: "libsql", name: "libSQL", schemes: ["libsql"], sql: true },
  { key: "mongodb", name: "MongoDB", schemes: ["mongodb", "mongodb+srv"], sql: false },
  { key: "cockroachdb", name: "CockroachDB", schemes: ["cockroachdb"], sql: true },
  { key: "oracle", name: "Oracle", schemes: ["oracle"], sql: true },
];

/** The key `connector: "polling"` picks, once the polling connector registers it. */
const POLLING = "polling";

/** The page that lists the databases FacetDB connects to and the scheme of each one's string. */
export const DATABASES_PAGE = "https://docs.facetdb.dev/databases";

/** `scheme:` at the start of a connection string (a URL's, per RFC 3986). */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** A file path with no scheme names a SQLite database by its extension. */
const SQLITE_FILE = /\.(db|sqlite|sqlite3)$/i;

/**
 * The scheme a connection string is read by: its own, lowercased; `sqlite` for a bare file path
 * ending in `.db`, `.sqlite` or `.sqlite3`; `libsql` for an `https` URL with `libsql` in its host
 * (a libSQL server over HTTP). Undefined when it names none.
 */
export function schemeOf(url: string): string | undefined {
  const text = url.trim();
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return SQLITE_FILE.test(text) ? "sqlite" : undefined;
  }
  if (scheme === "https") {
    let host = "";
    try {
      host = new URL(text).hostname.toLowerCase();
    } catch {
      // Not a URL past its scheme: an https string that names no host is no libSQL server.
    }
    return host.includes("libsql") ? "libsql" : scheme;
  }
  return scheme;
}

/** The database a connection string's scheme names, from the static table; nothing is loaded. */
function databaseOf(url: string): (typeof DATABASES)[number] | undefined {
  const scheme = schemeOf(url);
  return scheme === undefined
    ? undefined
    : DATABASES.find((database) => database.schemes.includes(scheme));
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
 * `"polling"` for a SQL scheme, from the polling engine once it is registered. Only that engine is
 * loaded. Refused before anything connects: an unknown scheme, a database whose engine is not
 * registered here, polling on a database that is not SQL, or polling before its engine exists.
 */
export async function engineFor(
  entries: readonly EngineEntry[],
  url: string,
  override?: ConnectorChoice,
): Promise<DatabaseEngine> {
  const scheme = schemeOf(url);
  const database = databaseOf(url);
  if (override === "polling") {
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
        'the source asks for connector: "polling", and polling is not in this build yet; this FacetDB watches a table with a trigger only',
        'remove connector: "polling" from the source in facetdb.config.ts to watch the table with a trigger, or run a FacetDB that has the polling connector',
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
