import { createClient } from "@libsql/client/http";
import type { SqliteClient, SqliteParam, SqliteStatements } from "../connector/index.ts";
import type { SqliteRow } from "../install/index.ts";

/**
 * `SqliteClient` over @libsql/client: the second implementation, beside node:sqlite's, for a libSQL
 * server (Turso, sqld). The SQL is the same text; only the transport differs.
 *
 * - The HTTP entry (`@libsql/client/http`): it speaks to `libsql:`, `https:` and `http:` URLs and
 *   loads neither the native `libsql` module (a local file is node:sqlite's) nor a
 *   WebSocket. Embedded replicas (`syncUrl`) are out of scope.
 * - `transaction` is the client's interactive `transaction("write")`, which opens with
 *   `begin immediate`: the connector's claim reads back what its update wrote (`returning`) and its
 *   write reads the state before it updates, in one transaction, which a non-interactive `batch`
 *   cannot do. It commits when `work` resolves and rolls back when it throws.
 * - One queue per client, as node:sqlite's: a call runs when the one before it has finished, so a
 *   transaction of this process never waits on the server behind another of this process, and a
 *   statement outside a transaction never lands between a transaction's statements.
 * - Rows come back as plain objects keyed by column name, the shape node:sqlite gives; integers as
 *   numbers (`intMode: "number"`), as node:sqlite reads them.
 * - The auth token and the URL never leave in an error: the client's own messages are passed on
 *   with either replaced, should one ever carry them.
 */

/** A statement as the client is handed it. */
type LibsqlStatement = { sql: string; args: SqliteParam[] };

/** What the client gives back for a statement: the column names and the rows by position. */
export type LibsqlResult = {
  readonly columns: readonly string[];
  readonly rows: readonly ArrayLike<unknown>[];
  readonly rowsAffected: number;
};

type LibsqlExecutes = {
  execute(statement: LibsqlStatement): Promise<LibsqlResult>;
  executeMultiple(sql: string): Promise<void>;
};

/** The client's interactive transaction, as this module uses it. */
export type LibsqlTransaction = LibsqlExecutes & {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
};

/** The part of @libsql/client's `Client` this module uses; a test passes its own. */
export type LibsqlDriver = LibsqlExecutes & {
  transaction(mode: "write"): Promise<LibsqlTransaction>;
  close(): void;
};

/** What a libSQL server is opened with: its URL and, from the environment, its auth token. */
export type LibsqlConfig = { readonly url: string; readonly authToken?: string };

/** Opens a libSQL server's client; the engine opens through it, a test passes its own. */
export type OpenLibsql = (config: LibsqlConfig) => SqliteClient;

/** What stands in the words for each secret a message might carry. */
type Secrets = readonly (readonly [secret: string, shown: string])[];

/** The error with every secret replaced, or the error itself when its message holds none. */
function scrubbed(error: unknown, secrets: Secrets): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const held = secrets.filter(([secret]) => secret !== "" && error.message.includes(secret));
  if (held.length === 0) {
    return error;
  }
  const message = held.reduce(
    (text, [secret, shown]) => text.replaceAll(secret, shown),
    error.message,
  );
  const clean = new Error(message);
  clean.name = error.name;
  return clean;
}

function secretsOf(config: LibsqlConfig): Secrets {
  return [
    ...(config.authToken === undefined ? [] : [[config.authToken, "<the auth token>"] as const]),
    [config.url, "<the connection string>"] as const,
  ];
}

/** A result's rows as plain objects, as node:sqlite returns them. */
function rowsOf(result: LibsqlResult): readonly SqliteRow[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
  );
}

/**
 * `driver`, opened with `config`, as a `SqliteClient`: the config's token and URL are kept out of
 * every error it throws.
 */
export function libsqlClient(driver: LibsqlDriver, config: LibsqlConfig): SqliteClient {
  const secrets = secretsOf(config);
  const guarded = <T>(work: () => Promise<T>): Promise<T> =>
    work().catch((error: unknown) => {
      throw scrubbed(error, secrets);
    });
  const statementsOf = (on: LibsqlExecutes): SqliteStatements => ({
    run: async (sql, params = []) => ({
      changes: (await guarded(() => on.execute({ sql, args: [...params] }))).rowsAffected,
    }),
    all: async (sql, params = []) =>
      rowsOf(await guarded(() => on.execute({ sql, args: [...params] }))),
    exec: (sql) => guarded(() => on.executeMultiple(sql)),
  });
  const direct = statementsOf(driver);
  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
  let closed = false;
  return {
    run: (sql, params) => inTurn(() => direct.run(sql, params)),
    all: (sql, params) => inTurn(() => direct.all(sql, params)),
    exec: (sql) => inTurn(() => direct.exec(sql)),
    transaction: (work) =>
      inTurn(async () => {
        const tx = await guarded(() => driver.transaction("write"));
        try {
          const result = await work(statementsOf(tx));
          await guarded(() => tx.commit());
          return result;
        } catch (error) {
          // The error that stopped the work is the one to report; a failed rollback ends the same
          // way, the server dropping the transaction with its stream.
          await tx.rollback().catch(() => undefined);
          throw error;
        } finally {
          tx.close();
        }
      }),
    close: () =>
      inTurn(() => {
        if (!closed) {
          closed = true;
          driver.close();
        }
        return Promise.resolve();
      }),
  };
}

/**
 * How long one HTTP request to the server may take before it is aborted. The client's calls take
 * turns, so one request the server never answers would otherwise hold every later call, `close`
 * among them, for the platform's own timeout (minutes); a statement FacetDB sends is one row's work,
 * well inside this.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `fetch` with every request aborted after `ms`; hrana calls it with a `Request` and no init. */
export function timedFetch(
  fetch: (request: Request, init?: RequestInit) => Promise<Response>,
  ms: number,
): (request: Request) => Promise<Response> {
  return (request) => fetch(request, { signal: AbortSignal.timeout(ms) });
}

/** Opens a libSQL server over HTTP (`libsql:` is HTTPS unless `?tls=0`, as @libsql/client reads it). */
export const openLibsql: OpenLibsql = (config) => {
  let driver: LibsqlDriver;
  try {
    driver = createClient({
      url: config.url,
      intMode: "number",
      fetch: timedFetch((request, init) => globalThis.fetch(request, init), REQUEST_TIMEOUT_MS),
      ...(config.authToken === undefined ? {} : { authToken: config.authToken }),
    });
  } catch (error) {
    throw scrubbed(error, secretsOf(config));
  }
  return libsqlClient(driver, config);
};
