import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { EngineRefusal } from "@facetdb/core";
import type { SqliteRow } from "../install/index.ts";
import { BUSY_TIMEOUT_MS } from "../install/index.ts";

/**
 * How the runtime connector talks to a SQLite database: three calls, asynchronous so libSQL's
 * client implements them over the network as node:sqlite's does in-process. Rows are a boundary:
 * the connector checks every field it reads.
 */

/** A value bound to a `?`: SQLite's text, numbers and NULL (a boolean is bound as 0 or 1). */
export type SqliteParam = string | number | null;

/** What a statement that writes reports. */
export type SqliteChanges = { readonly changes: number };

/** The statements a client runs, alone or inside a transaction. */
export type SqliteStatements = {
  run(sql: string, params?: readonly SqliteParam[]): Promise<SqliteChanges>;
  all(sql: string, params?: readonly SqliteParam[]): Promise<readonly SqliteRow[]>;
};

export type SqliteClient = SqliteStatements & {
  /**
   * Runs `work` inside `begin immediate` … `commit` (the write lock taken at once, so the
   * transaction never fails half way to upgrade a read lock), and rolls back when it throws.
   * `work` awaits nothing but `tx`'s statements: a transaction never spans a model call, a timer
   * or any other I/O, so the application's writes wait on it no longer than its statements take.
   */
  transaction<T>(work: (tx: SqliteStatements) => Promise<T>): Promise<T>;
  /** Lets go of the database; whoever opened the client closes it. */
  close(): Promise<void>;
};

/** Opens the client of a SQLite database at `path`; the engine and the tests pass their own. */
export type OpenSqlite = (path: string) => SqliteClient;

/** FacetDB opens an existing SQLite file and never creates one (`run` says the same). */
export function noFileRefusal(path: string): EngineRefusal {
  return new EngineRefusal({
    code: "no-file",
    message: `${path} does not exist; FacetDB opens an existing SQLite file and never creates one`,
    fix: "check the file's path in the source's connection string, and run facetdb migrate on it first",
  });
}

/**
 * node:sqlite's handle as a `SqliteClient`. node:sqlite is synchronous, so every call runs whole
 * when its turn comes, and the turns are one queue per handle: a transaction's `work` awaits its own
 * statements, and in the meantime nothing else of this process runs a statement on the handle, which
 * would otherwise join the open transaction (and be rolled back with it). Each statement is prepared
 * once per handle.
 */
export function nodeSqliteClient(db: DatabaseSync): SqliteClient {
  const prepared = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const statementOf = (sql: string) => {
    let statement = prepared.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      prepared.set(sql, statement);
    }
    return statement;
  };
  const direct: SqliteStatements = {
    run: (sql, params = []) => {
      const result = statementOf(sql).run(...params);
      return Promise.resolve({ changes: Number(result.changes) });
    },
    all: (sql, params = []) => Promise.resolve(statementOf(sql).all(...params)),
  };
  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    run: (sql, params) => inTurn(() => direct.run(sql, params)),
    all: (sql, params) => inTurn(() => direct.all(sql, params)),
    transaction: (work) =>
      inTurn(async () => {
        db.exec("begin immediate");
        try {
          const result = await work(direct);
          db.exec("commit");
          return result;
        } catch (error) {
          if (db.isTransaction) {
            db.exec("rollback");
          }
          throw error;
        }
      }),
    close: () =>
      inTurn(() => {
        if (db.isOpen) {
          db.close();
        }
        return Promise.resolve();
      }),
  };
}

/**
 * Opens the SQLite file at `path` for the worker: never creating it (a missing file is refused),
 * waiting up to `BUSY_TIMEOUT_MS` behind the application's write (node:sqlite's default is 0).
 */
export function openNodeSqlite(path: string): SqliteClient {
  if (!existsSync(path)) {
    throw noFileRefusal(path);
  }
  return nodeSqliteClient(new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS }));
}
