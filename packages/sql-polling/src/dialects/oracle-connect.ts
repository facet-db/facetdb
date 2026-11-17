import { createRequire } from "node:module";
import { EngineRefusal } from "@facetdb/core";
import type { PollingClient, PollingConnect, PollingQuery, PollingRow } from "../dialect/index.ts";

/**
 * The Oracle driver behind the polling connector: `oracledb` in thin mode, pure JavaScript, never
 * the Instant Client (`initOracleClient` is never called, and a process where something else called
 * it is refused). One pool per `connect`, made on the first statement; every session it opens pins
 * the text formats the state hash is computed over (the hash is over the database's own text, so
 * `to_char` of a number, a date or a timestamp must print alike in every session, and print what
 * Oracle reads back when the cursor is bound).
 *
 * `oracle://user:password@host:1521/service`, with `?protocol=tcps` for TLS (Oracle's Easy Connect
 * protocol, port 2484 by convention). The driver's errors that the engine meets as refusals (a
 * refused login, a table that is gone or unreadable, a table busy behind another transaction) are
 * thrown as core's `EngineRefusal`, in plain words with what to do.
 */

/** What this module uses of `oracledb` (the package ships no types; this is the boundary). */
type OracleDriver = {
  /** True while the process runs the thin driver; false once `initOracleClient` was called. */
  readonly thin: boolean;
  readonly OUT_FORMAT_OBJECT: number;
  readonly STRING: number;
  readonly DB_TYPE_CLOB: unknown;
  readonly DB_TYPE_NCLOB: unknown;
  createPool(attributes: Readonly<Record<string, unknown>>): Promise<OraclePool>;
};

type OraclePool = {
  getConnection(): Promise<OracleConnection>;
  close(drainSeconds: number): Promise<void>;
};

type OracleMetadata = { readonly dbType?: unknown };

type OracleConnection = {
  execute(
    text: string,
    binds: Readonly<Record<string, unknown>>,
    options: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly rows?: readonly Readonly<Record<string, unknown>>[] }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
};

const oracledb = createRequire(import.meta.url)("oracledb") as OracleDriver;

/** The port of an Oracle listener when the URL names none. */
const DEFAULT_PORT = "1521";

/** How many connections a pool keeps at most when the caller names no number. */
const DEFAULT_MAX = 4;

/**
 * What every session runs once, before its first statement: ISO text for dates and timestamps with
 * every fraction digit (so the last-changed cursor, read with `to_char` and bound back as text,
 * compares as the same instant), `.` as the decimal mark, UTC for a timestamp with local time
 * zone, and binary comparison and sorting, so `order by` and the keyset's `>` agree on a varchar2
 * key under a linguistic database sort (a page ending at 'a' followed by `"id" > 'a'` would
 * otherwise skip 'B' and 'C'). A server whose defaults differ hashes and pages the same rows as
 * any other.
 */
export const SESSION_SETTINGS = `alter session set
  nls_date_format = 'YYYY-MM-DD HH24:MI:SS'
  nls_timestamp_format = 'YYYY-MM-DD HH24:MI:SS.FF9'
  nls_timestamp_tz_format = 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'
  nls_numeric_characters = '.,'
  nls_sort = 'BINARY'
  nls_comp = 'BINARY'
  time_zone = '+00:00'`;

/** Where a connection string points and as whom; what `oracledb` is given. */
export type OracleTarget = {
  readonly user: string;
  readonly password: string;
  /** Easy Connect: `host:port/service`, prefixed with `tcps://` for TLS. */
  readonly connectString: string;
  readonly tls: boolean;
  /** `host:port/service`, without the user or the password: what the words name. */
  readonly label: string;
};

/**
 * Reads an `oracle://` connection string, or throws what is wrong with it in plain words. The only
 * parameter is `protocol` (`tcp` or `tcps`): any other is refused, since the driver would ignore it
 * (a Postgres habit like `?sslmode=require` must not look like TLS).
 */
export function oracleTarget(url: string): OracleTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "the Oracle connection string is not a URL; write it as oracle://user:password@host:1521/service",
    );
  }
  const service = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.hostname === "" || service === "" || parsed.username === "") {
    throw new Error(
      "the Oracle connection string names no host, service or user; write it as oracle://user:password@host:1521/service",
    );
  }
  // The service is the end of an Easy Connect string: an encoded ?, ( or / in it would carry
  // Easy Connect parameters or a descriptor past the protocol-only rule below.
  if (/[?()/]/.test(service)) {
    throw new Error(
      `the Oracle connection string's service name ${JSON.stringify(service)} holds a ?, ( or /, which no service name has; write it as oracle://user:password@host:1521/service`,
    );
  }
  for (const name of parsed.searchParams.keys()) {
    if (name !== "protocol") {
      throw new Error(
        `the Oracle connection string has the parameter ${name}, which FacetDB does not read; the only one is ?protocol=tcps (TLS)`,
      );
    }
  }
  const protocol = parsed.searchParams.get("protocol") ?? "tcp";
  if (protocol !== "tcp" && protocol !== "tcps") {
    throw new Error(
      `the Oracle connection string asks for protocol ${protocol}; FacetDB reads tcps (TLS) or tcp`,
    );
  }
  const tls = protocol === "tcps";
  const label = `${parsed.hostname}:${parsed.port === "" ? DEFAULT_PORT : parsed.port}/${service}`;
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    connectString: tls ? `tcps://${label}` : label,
    tls,
    label,
  };
}

/** The server's error number on a driver's error (a boundary): 942 for ORA-00942. */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errorNum" in error)) {
    return undefined;
  }
  return typeof error.errorNum === "number" ? error.errorNum : undefined;
}

/** The first line of a driver's message: Oracle's own, without the help link thin mode appends. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/**
 * A driver's error as the engine meets it: the refusals it words for the CLI, every other error as
 * it is. ORA-01017 is a refused login, ORA-00942 a table that is gone or that the login may not
 * read (the worker reads one table, granted at install), ORA-00054 a table another transaction
 * holds when FacetDB's DDL asks for it (Oracle's default `ddl_lock_timeout` of 0, up to 21c): it
 * stops at once instead of holding the application's statements queued behind its own lock.
 */
export function oracleFailure(
  error: unknown,
  target: Pick<OracleTarget, "label" | "user">,
): unknown {
  switch (errorNumber(error)) {
    case 1017:
      return new EngineRefusal({
        code: "database-login",
        message: `Oracle refused the login of ${target.user} on ${target.label} (ORA-01017, the user name or the password is wrong)`,
        fix: "check the user and the password in the connection string, and percent-encode an @, a / or a : in the password",
      });
    case 942:
      return new EngineRefusal({
        code: "polling-table",
        message: `${firstLine(error)}: the table does not exist on ${target.label}, or ${target.user} may not read it`,
        fix: "check the source's table (schema.table, spelled as the database spells it), and run facetdb migrate: it grants the worker its read of the table",
      });
    case 54:
      return new EngineRefusal({
        code: "table-busy",
        message: `the table is busy on ${target.label}: another transaction holds it (ORA-00054), and FacetDB's changes to it do not wait behind the application's transactions`,
        fix: "run the command again once that transaction has ended; facetdb migrate prints what is left to do",
      });
    default:
      return error;
  }
}

/** Positional parameters as `oracledb` binds them by name (`:1` is the name "1"), so a repeated placeholder binds one value. */
function bindsOf(params: readonly unknown[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(params.map((value, index) => [String(index + 1), value]));
}

/**
 * A row as the connector reads it: Oracle returns an unquoted alias in capitals (`as k` comes
 * back as `K`), and every alias polling writes is lower case, unquoted, as Postgres folds them.
 * A quoted alias in mixed case keeps its name.
 */
function rowOf(row: Readonly<Record<string, unknown>>): PollingRow {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name === name.toUpperCase() ? name.toLowerCase() : name,
      value,
    ]),
  );
}

/** A CLOB (the `clob` of a choice's probabilities, an application's) comes back as text, never as a LOB stream. */
function fetchTypeHandler(metadata: OracleMetadata): { readonly type: number } | undefined {
  return metadata.dbType === oracledb.DB_TYPE_CLOB || metadata.dbType === oracledb.DB_TYPE_NCLOB
    ? { type: oracledb.STRING }
    : undefined;
}

/** The statements of one connection, committed each (`autoCommit`) or left to the transaction. */
function queryOn(
  connection: OracleConnection,
  autoCommit: boolean,
  target: OracleTarget,
): PollingQuery {
  return async (text, params = []) => {
    try {
      const result = await connection.execute(text, bindsOf(params), {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit,
        fetchTypeHandler,
      });
      return (result.rows ?? []).map(rowOf);
    } catch (error) {
      throw oracleFailure(error, target);
    }
  };
}

/** Runs the session settings on a session the pool has just opened (the pool's `sessionCallback`). */
export function settleSession(
  connection: Pick<OracleConnection, "execute">,
  _requestedTag: string,
  done: (error?: unknown) => void,
): void {
  connection.execute(SESSION_SETTINGS, {}, {}).then(
    () => {
      done();
    },
    (error: unknown) => {
      done(error);
    },
  );
}

/**
 * `PollingConnect` for Oracle: a pool of at most `max` sessions under the URL's login, made on the
 * first statement, in thin mode. Nothing connects until then, so an engine call that refuses a URL
 * before using it opens nothing.
 */
export const connectOracle: PollingConnect = (url, options) => {
  const target = oracleTarget(url);
  let pool: Promise<OraclePool> | undefined;

  async function open(): Promise<OraclePool> {
    const made = await oracledb.createPool({
      user: target.user,
      password: target.password,
      connectString: target.connectString,
      poolMin: 0,
      poolMax: options?.max ?? DEFAULT_MAX,
      poolIncrement: 1,
      sessionCallback: settleSession,
    });
    // Thin mode only. `oracledb.thin` turns false only once something in this process called
    // initOracleClient, which loads Oracle's client libraries; FacetDB never does.
    if (!oracledb.thin) {
      await made.close(0);
      throw new Error(
        "oracledb runs in thick mode in this process (something called initOracleClient); FacetDB connects to Oracle in thin mode only, with no Oracle Client libraries: remove that call",
      );
    }
    return made;
  }

  async function connection(): Promise<OracleConnection> {
    pool ??= open();
    try {
      return await (await pool).getConnection();
    } catch (error) {
      throw oracleFailure(error, target);
    }
  }

  const client: PollingClient = {
    async query(text, params) {
      const session = await connection();
      try {
        return await queryOn(session, true, target)(text, params);
      } finally {
        await session.close();
      }
    },
    async transaction(work) {
      const session = await connection();
      try {
        const result = await work(queryOn(session, false, target));
        await session.commit();
        return result;
      } catch (error) {
        // The error that stopped the work is the caller's, whatever the rollback says.
        await session.rollback().catch(() => undefined);
        throw error;
      } finally {
        await session.close();
      }
    },
    async close() {
      const opened = pool;
      pool = undefined;
      if (opened === undefined) {
        return;
      }
      // A pool that never opened (a refused login) has nothing to let go of; its error was the
      // caller's. Sessions still busy (a watch's poll) are ended: the connector is closing.
      const made = await opened.catch(() => undefined);
      await made?.close(0);
    },
  };
  return client;
};
