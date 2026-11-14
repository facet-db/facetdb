import { createPool } from "mysql2";
import type { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";
import type { MysqlRow } from "../sql/index.ts";

/**
 * The driver door of the runtime connector: a mysql2 pool under the worker login, as many
 * connections as the worker has lanes, one statement per call, with the rows a select returns and
 * the rows a write matched; and a short transaction on one connection for the settles. The install
 * plans go through `connectMysql` (one admin connection for the moment of a run); the connector
 * lives for the process and serves the worker's lanes at once, so it pools. A test passes its own
 * `MysqlPoolConnect` through the same parameter: no module is patched.
 */

/** What one statement did: a select's rows, or how many rows a write matched. */
export type MysqlResult = {
  readonly rows: readonly MysqlRow[];
  /**
   * The rows an insert, update or delete matched (mysql2 connects with `FOUND_ROWS`, so a row set
   * to the values it already holds counts); 0 for a select.
   */
  readonly affectedRows: number;
};

/**
 * Runs one statement. With `params` the driver writes each value in place of a `?`, escaped as a
 * literal, an array as a comma-separated list (`in (?)`); without them the text goes to the server
 * as it is. The connector never sends two statements in one text.
 */
export type MysqlStatement = (text: string, params?: readonly unknown[]) => Promise<MysqlResult>;

export type MysqlPool = {
  /** One statement on any connection of the pool, committed on its own. */
  readonly query: MysqlStatement;
  /**
   * `work` on one connection inside `begin` … `commit`, rolled back when it throws: the settles'
   * probe and write. The statements it sends count as the transaction's, `begin` and `commit`
   * included.
   */
  transaction<T>(work: (statement: MysqlStatement) => Promise<T>): Promise<T>;
  /** Ends every connection of the pool; one that never opened has nothing to end. */
  close(): Promise<void>;
};

export type MysqlPoolOptions = {
  /** The most connections open at once: the worker's in-flight limit plus two (`OpenOptions`). */
  readonly maxConnections: number;
};

/** Opens a pool for the worker login's connection string: the composition root passes this, or a fake. */
export type MysqlPoolConnect = (url: string, options: MysqlPoolOptions) => MysqlPool;

/** mysql2's default when `connectionLimit` is not given, and what the connector asks for when `open` names none. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * What every connection of the pool runs as it opens, before any statement of the connector's:
 *
 * - The session's `sql_mode` without `NO_BACKSLASH_ESCAPES`: mysql2 escapes the values it binds
 *   (a record's state, a key) with backslashes whatever the server's mode, so under that mode a
 *   value could end its literal and run as SQL. Install refuses a server set so, and the
 *   worker's own sessions never run under it, whatever a DBA set after the install. The mode list is
 *   wrapped in commas so the one word goes whole, wherever it sits, with its comma.
 * - `read committed`: the claim's `update … order by … limit` then locks only the rows it stamps,
 *   not the gaps between the rows it scans, and skips a row whose latest committed version no
 *   longer matches instead of waiting for the transaction that holds it (InnoDB's semi-consistent
 *   read). Every other statement of the connector is a single row by its key, or a settle's probe
 *   that never waits, so the level changes nothing else.
 */
export const SESSION_STATEMENTS: readonly string[] = [
  "set session sql_mode = trim(both ',' from replace(concat(',', @@session.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))",
  "set session transaction isolation level read committed",
];

/**
 * The mysql2 pool: TLS and the rest of the connection read from the URL as mysql2 reads it (judged
 * first by `tlsProblem`), `connectionLimit` from the options. `multipleStatements` stays off, so no
 * text ever carries a second statement. Dates are never asked of the driver: every time the
 * connector reads comes back as text (`cast(… as char)`), so the driver's timezone setting plays no
 * part. Each connection runs `SESSION_STATEMENTS` as it opens, queued ahead of the statement that
 * waited for it; one that fails is destroyed, so no statement ever runs in an unprepared session.
 */
export function connectMysqlPool(url: string, options: MysqlPoolOptions): MysqlPool {
  let pool: Pool | undefined;
  const opened = (): Pool => {
    if (pool === undefined) {
      // The callback pool emits `connection` with the connection as it opened, before the request
      // that waited for it gets it: statements queued here run first. The promise view of the same
      // pool serves everything else.
      const base = createPool({ uri: url, connectionLimit: options.maxConnections });
      base.on("connection", (connection) => {
        for (const text of SESSION_STATEMENTS) {
          connection.query(text, (error) => {
            if (error !== null) {
              connection.destroy();
            }
          });
        }
      });
      pool = base.promise();
    }
    return pool;
  };
  const statementOn =
    (runner: Pick<Pool, "query">): MysqlStatement =>
    async (text, params) => {
      const [result] = await runner.query(text, params === undefined ? undefined : [...params]);
      return Array.isArray(result)
        ? { rows: result as readonly MysqlRow[], affectedRows: 0 }
        : { rows: [], affectedRows: (result as ResultSetHeader).affectedRows };
    };
  return {
    query: (text, params) => statementOn(opened())(text, params),
    async transaction(work) {
      const connection: PoolConnection = await opened().getConnection();
      const statement = statementOn(connection);
      try {
        await statement("begin");
        try {
          const result = await work(statement);
          await statement("commit");
          return result;
        } catch (error) {
          await statement("rollback").catch(() => undefined);
          throw error;
        }
      } finally {
        connection.release();
      }
    },
    async close() {
      const open = pool;
      pool = undefined;
      await open?.end();
    },
  };
}

/**
 * A pool's statements as the catalog readers take them (`MysqlQuery`: rows alone), for the reads
 * the connector shares with the install's plans.
 */
export function rowsOf(
  query: MysqlStatement,
): (text: string, params?: readonly unknown[]) => Promise<readonly MysqlRow[]> {
  return async (text, params) => (await query(text, params)).rows;
}
