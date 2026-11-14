import type { ConnectionConfiguration } from "tedious";
import {
  connectionConfig,
  type MssqlClient,
  type MssqlSession,
  openSession,
  parseMssqlUrl,
} from "../sql/index.ts";

/**
 * The driver door of the runtime connector: a pool of tedious connections under the worker login,
 * as many as the worker has lanes, one statement per call on whichever connection is free. tedious
 * has no pool of its own, and one connection runs one request at a time, so the worker's eight
 * lanes would queue behind each other on one. The install plans go through `connectMssql` (one
 * admin connection for the moment of a run); the connector lives for the process. A test passes its
 * own `MssqlPoolConnect` through the same parameter: no module is patched.
 *
 * Every connection runs as tedious's login batch sets it, plus `SESSION_STATEMENTS` below, and the
 * db suite reads each setting back from the session: `read committed` (`connectionIsolationLevel`, so
 * a claim's `readpast` skips the rows other transactions hold rather than wait for them, and no
 * statement takes range locks) and `xact_abort on` (`abortTransactionOnError`, so a failed statement
 * never leaves a transaction open on a pooled connection). Values are bound as parameters
 * (`sp_executesql`), never written into the text, so no session setting decides how a value is
 * read, as MySQL's `NO_BACKSLASH_ESCAPES` does there.
 */

export type MssqlPoolOptions = {
  /** The most connections open at once: the worker's in-flight limit plus two (`OpenOptions`). */
  readonly maxConnections: number;
};

/** Opens a pool for the worker login's connection string: the composition root passes this, or a fake. */
export type MssqlPoolConnect = (url: string, options: MssqlPoolOptions) => MssqlClient;

/** How many connections the pool opens when `open` names no width: the worker's 8 lanes plus two. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * How long one statement of the worker may run: a minute, where the admin's is ten (a plan's
 * uninstall can delete millions of jobs) and tedious's own default is 15 seconds. The longest a
 * worker's statement takes is a scan page ordered by a `created_at` without an index on a large
 * table, or a one-key settle waiting for an application transaction to end (`Connector.ack`).
 */
export const WORKER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * What every connection of the pool runs as it opens, before any statement of the connector's, as
 * a batch of its own (a `set` inside `sp_executesql` would end with that call):
 *
 * - `deadlock_priority low`: should a statement of the worker ever close a lock cycle with an
 *   application's transaction (one at repeatable read or serializable, .NET TransactionScope's
 *   default, holding a job row the worker converts a lock on), SQL Server picks the session of
 *   lower priority as the victim, so it ends the worker's statement, which the worker retries,
 *   never the customer's transaction.
 */
export const SESSION_STATEMENTS: readonly string[] = ["set deadlock_priority low"];

/** tedious's options for the worker's connections: the URL's, with the worker's request timeout. */
export function workerConfig(url: string): ConnectionConfiguration {
  const config = connectionConfig(parseMssqlUrl(url));
  return { ...config, options: { ...config.options, requestTimeout: WORKER_REQUEST_TIMEOUT_MS } };
}

type Waiter = {
  readonly resolve: (session: MssqlSession) => void;
  readonly reject: (error: unknown) => void;
};

/**
 * The pool: a statement takes a free connection, opens one while fewer than `maxConnections` are
 * open, or waits for the first to come back. A connection a socket error ended is let go and not
 * handed out again. A connection string that cannot be read throws here, before anything connects.
 */
export function connectMssqlPool(url: string, options: MssqlPoolOptions): MssqlClient {
  if (!Number.isInteger(options.maxConnections) || options.maxConnections < 1) {
    throw new Error(`a pool holds at least one connection, not ${options.maxConnections}`);
  }
  const config = workerConfig(url);
  const idle: MssqlSession[] = [];
  const waiting: Waiter[] = [];
  let size = 0;
  let closed = false;

  const closedError = () => new Error("the connector was closed: no statement runs any more");

  async function opened(): Promise<MssqlSession> {
    size += 1;
    let session: MssqlSession | undefined;
    try {
      session = await openSession(config);
      for (const text of SESSION_STATEMENTS) {
        await session.query(text);
      }
      return session;
    } catch (error) {
      size -= 1;
      // A connection whose setup failed is never handed out: no statement runs unprepared.
      await session?.close().catch(() => undefined);
      throw error;
    }
  }

  function acquire(): Promise<MssqlSession> {
    if (closed) {
      return Promise.reject(closedError());
    }
    const ready = idle.pop();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    if (size < options.maxConnections) {
      return opened();
    }
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  }

  function release(session: MssqlSession): void {
    if (closed || session.broken) {
      size -= 1;
      void session.close().catch(() => undefined);
      // The connection a waiter was promised is gone: open another for it.
      const next = closed ? undefined : waiting.shift();
      if (next !== undefined) {
        opened().then(next.resolve, next.reject);
      }
      return;
    }
    const next = waiting.shift();
    if (next === undefined) {
      idle.push(session);
    } else {
      next.resolve(session);
    }
  }

  async function using<T>(work: (session: MssqlSession) => Promise<T>): Promise<T> {
    const session = await acquire();
    try {
      return await work(session);
    } finally {
      release(session);
    }
  }

  return {
    query: (text, params) => using((session) => session.query(text, params)),
    transaction: (work) => using((session) => session.transaction(work)),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const waiter of waiting.splice(0)) {
        waiter.reject(closedError());
      }
      const open = idle.splice(0);
      size -= open.length;
      await Promise.all(open.map((session) => session.close().catch(() => undefined)));
    },
  };
}
