import type { Connection, ConnectionConfiguration } from "tedious";
import { type MssqlUrl, parseMssqlUrl } from "./url.ts";

/** A row as the driver returns it: column name to value. */
export type MssqlRow = Readonly<Record<string, unknown>>;

/** Runs one statement with the parameters `@p1`, `@p2`, … and returns its rows. */
export type MssqlQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly MssqlRow[]>;

/**
 * What FacetDB needs from a SQL Server driver, and nothing more: one query function, a transaction,
 * and a way to let go of the connection. tedious implements it (`connectMssql`); a test hands in
 * the recording client of `@facetdb/mssql/testing` through the same type, so no module is patched.
 */
export type MssqlClient = {
  readonly query: MssqlQuery;
  /** Runs `work` in one transaction: it commits when `work` resolves and rolls back when it throws. */
  transaction<T>(work: (query: MssqlQuery) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Opens a client for a connection string; the connection itself is made on its first statement. */
export type MssqlConnect = (url: string) => MssqlClient;

/**
 * How long one statement of an admin plan may run: ten minutes, where tedious's own default is 15
 * seconds. A plan's statements change the catalog (a nullable column, a trigger, a grant: metadata
 * alone) or rows of FacetDB's own small tables, and one that waits for a lock gives up after the
 * script's 10-second `lock_timeout` first. The long one is an uninstall's delete of a table's
 * queued keys, which a backfill can make millions of rows: minutes on any server, never ten.
 */
export const ADMIN_REQUEST_TIMEOUT_MS = 600_000;

/**
 * tedious's options for a connection string, TLS as the string says (`url.ts` judged it first). The
 * session runs with `SET XACT_ABORT ON`, so a statement that fails rolls its whole transaction back
 * on the server too, as the printed script's frame says. The connector's pool sets its own request
 * timeout.
 */
export function connectionConfig(url: MssqlUrl): ConnectionConfiguration {
  return {
    // tedious takes an IPv6 address without the brackets a URL writes it in.
    server: url.host.replace(/^\[(.*)\]$/, "$1"),
    authentication: { type: "default", options: { userName: url.user, password: url.password } },
    options: {
      port: url.port,
      ...(url.database === undefined ? {} : { database: url.database }),
      encrypt: url.encrypt,
      trustServerCertificate: url.trustServerCertificate,
      abortTransactionOnError: true,
      requestTimeout: ADMIN_REQUEST_TIMEOUT_MS,
    },
  };
}

/** The server's error number on a driver's error (a boundary), when it has one. */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("number" in error)) {
    return undefined;
  }
  return typeof error.number === "number" ? error.number : undefined;
}

/**
 * A server failure as one error. SQL Server often answers one statement with several errors (a
 * column drop that an index depends on says 5074, then 4922), and tedious hands them over as an
 * AggregateError with no message and no number: its messages are joined and the first one's number
 * kept, so a stopped run says what the server said and a script's own `throw 51000` is still read
 * by its number. The highest severity among them (tedious's `class`) is kept too, so a session the
 * server ended (severity 20 and above, such as 596 after a `kill`) is told from a refused
 * statement. Any other error passes as it is.
 */
export function serverFailure(error: unknown): unknown {
  if (!(error instanceof AggregateError)) {
    return error;
  }
  const errors: readonly unknown[] = error.errors;
  const messages = errors.map((one) => (one instanceof Error ? one.message : String(one)));
  const number = errors.map(errorNumber).find((found) => found !== undefined);
  const severities = errors.flatMap((one) =>
    typeof one === "object" && one !== null && "class" in one && typeof one.class === "number"
      ? [one.class]
      : [],
  );
  return Object.assign(
    new Error(messages.join(" ")),
    number === undefined ? {} : { number },
    severities.length === 0 ? {} : { class: Math.max(...severities) },
  );
}

type Tedious = typeof import("tedious");

let driver: Promise<Tedious> | undefined;

/**
 * tedious, loaded on the first connection and never at import: it brings @azure/identity and MSAL
 * with it, which a CLI start for another engine must not pay for.
 */
function tedious(): Promise<Tedious> {
  driver ??= import("tedious");
  return driver;
}

/** A column of a row as tedious hands it over (its own type for it is `any`). */
type ColumnValue = { readonly metadata: { readonly colName: string }; readonly value: unknown };

/** A parameter's type as tedious needs it, from the value: text, a whole number, a flag, nothing. */
function parameterType(types: Tedious["TYPES"], value: unknown) {
  if (typeof value === "string" || value === null || value === undefined) {
    return types.NVarChar;
  }
  if (typeof value === "boolean") {
    return types.Bit;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? types.BigInt : types.Float;
  }
  throw new Error(`a SQL Server parameter is text, a number, a flag or null, not ${typeof value}`);
}

/** One open connection, with what a socket error must reach. */
type Session = {
  readonly connection: Connection;
  /** Ends the request in flight with an error. */
  fail: ((error: unknown) => void) | undefined;
  /** What broke the connection, once something did: every later statement fails with it. */
  broken: Error | undefined;
};

/** Runs one statement on the connection: a batch without parameters, `sp_executesql` with them. */
async function execute(
  session: Session,
  text: string,
  params: readonly unknown[],
): Promise<readonly MssqlRow[]> {
  const { Request, TYPES } = await tedious();
  if (session.broken !== undefined) {
    throw session.broken;
  }
  return new Promise((resolve, reject) => {
    const rows: MssqlRow[] = [];
    session.fail = (error) => {
      session.fail = undefined;
      reject(serverFailure(error));
    };
    const request = new Request(text, (error) => {
      session.fail = undefined;
      if (error === null || error === undefined) {
        resolve(rows);
      } else {
        reject(serverFailure(error));
      }
    });
    request.on("row", (columns: readonly ColumnValue[]) => {
      rows.push(
        Object.fromEntries(columns.map((column) => [column.metadata.colName, column.value])),
      );
    });
    for (const [index, value] of params.entries()) {
      request.addParameter(`p${index + 1}`, parameterType(TYPES, value), value ?? null);
    }
    if (params.length === 0) {
      session.connection.execSqlBatch(request);
    } else {
      session.connection.execSql(request);
    }
  });
}

/** Calls one of tedious's callback methods and waits for it. */
function settled(start: (done: (error: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    start((error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(serverFailure(error));
      }
    });
  });
}

/**
 * One tedious connection, open: statements one at a time, a transaction, and its end.
 * `connectMssql` holds one for a plan's run; the runtime connector's pool holds several and lets go
 * of one that `broken` says is dead.
 */
export type MssqlSession = MssqlClient & {
  /** True once a socket error ended the connection, or it closed: no statement can run on it. */
  readonly broken: boolean;
};

/** Opens one connection with `config` and logs in; a connection that cannot is the error. */
export async function openSession(config: ConnectionConfiguration): Promise<MssqlSession> {
  const { Connection } = await tedious();
  const connection = new Connection(config);
  const session: Session = { connection, fail: undefined, broken: undefined };
  // A socket error after the login (a reset, a server restart) is emitted here: without a listener
  // Node throws it and the process ends. It ends the request in flight instead, which stops the
  // run where it was, and every later statement of the session fails with it.
  connection.on("error", (error) => {
    session.broken = error;
    session.fail?.(error);
  });
  await settled((done) => connection.connect(done));
  const query: MssqlQuery = (text, params = []) => execute(session, text, params);
  return {
    query,
    get broken() {
      return session.broken !== undefined || connection.closed;
    },
    async transaction(work) {
      await settled((done) => connection.beginTransaction(done));
      try {
        const result = await work(query);
        await settled((done) => connection.commitTransaction(done));
        return result;
      } catch (error) {
        // XACT_ABORT has usually rolled the transaction back already, and then this rollback
        // fails: the error that stopped the work is the one the caller gets either way.
        await settled((done) => connection.rollbackTransaction(done)).catch(() => undefined);
        throw error;
      }
    },
    async close() {
      if (connection.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        connection.once("end", resolve);
        connection.close();
      });
    },
  };
}

/**
 * One tedious connection per client: an install, an uninstall or a prune is a handful of
 * statements on one session, so nothing here pools (the runtime connector's pool is in
 * `connector/client.ts`). A connection string that cannot be read throws here, before anything
 * connects.
 */
export const connectMssql: MssqlConnect = (url) => {
  const config = connectionConfig(parseMssqlUrl(url));
  let opened: Promise<MssqlSession> | undefined;
  const session = (): Promise<MssqlSession> => {
    opened ??= openSession(config);
    return opened;
  };
  return {
    query: async (text, params) => (await session()).query(text, params),
    transaction: async (work) => (await session()).transaction(work),
    async close() {
      // A connection that never opened has nothing to let go of; its error was its caller's.
      const live = await opened?.catch(() => undefined);
      await live?.close();
    },
  };
};
