import postgres from "postgres";

/** A row as the driver returns it: column name to value. Callers cast to text in SQL where it matters. */
export type SqlRow = Readonly<Record<string, unknown>>;

/** Runs one statement with parameters (`$1`, `$2`, …) and returns its rows. */
export type SqlQuery = (text: string, params?: readonly unknown[]) => Promise<readonly SqlRow[]>;

/**
 * What the connectors need from a database driver, and nothing more: one query function, a
 * transaction, and a way to let go of the connection. postgres.js implements it in production
 * (`connectPostgres`); a test hands in PGlite through the same type, so no module is patched.
 */
export type SqlClient = {
  readonly query: SqlQuery;
  /** Runs `work` in one transaction; it commits when `work` resolves and rolls back when it throws. */
  transaction<T>(work: (query: SqlQuery) => Promise<T>): Promise<T>;
  /**
   * Runs `text` once per parameter set, each run its own statement in its own implicit
   * transaction, run by the server in the order given and sent in bursts that do not wait run by
   * run (a few round trips for the lot, not one per set). Resolves once every run has answered.
   * After a failure no further burst is sent, and the call rejects with the first failure once the
   * runs already sent have answered; those committed or failed on their own.
   */
  pipeline(text: string, paramSets: readonly (readonly unknown[])[]): Promise<void>;
  /**
   * `LISTEN channel`: `onNotify` runs on every notification until the returned function is
   * awaited. Optional: a driver without it (a handwritten fake) leaves a connector to its poll.
   */
  listen?(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
};

/** Opens a client for a connection string. The composition root passes this (or a fake) around. */
export type SqlConnect = (url: string) => SqlClient;

/**
 * The postgres.js client. Statements are plain SQL text with parameters; the driver never
 * interpolates a value. TLS follows the connection string (`sslmode=require`), as for every driver.
 */
/**
 * A string parameter goes to the server as the text it was given, whatever type the server infers
 * for it. postgres.js learns each parameter's type from the prepared statement and then runs its
 * own serializer on the value, and two of those rewrite a string (seen on Supabase, 2026-11-01;
 * PGlite applies no serializer, so no unit test saw either):
 *  - timestamp and timestamptz (OIDs 1114, 1184) go through a JavaScript Date, which keeps
 *    milliseconds only: a keyset cursor carrying `…20:06:13.788622+00:00` compared as `…13.788`, the
 *    scan found no row equal to or older than it, and a 2,000-row table backfilled 500 rows;
 *  - json and jsonb (OIDs 114, 3802) are JSON.stringify'd again: the decision log binds
 *    `JSON.stringify(answers)` to a jsonb column, so the stored value was a JSON string holding the
 *    object, and reading it back failed with "expected a JSON object" on every record.
 * A Date still formats as ISO 8601 and an object still stringifies; a string is already the text.
 * Registered through `types` (postgres.js merges those into its serializers; a bare `serializers`
 * option is ignored); each `parse` repeats the library's own so columns still read as before.
 */
const timeAsGiven = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const jsonAsGiven = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
const TEXT_AS_GIVEN_TYPES = {
  time: { to: 1184, from: [1114, 1184], serialize: timeAsGiven, parse: (x: string) => new Date(x) },
  json: { to: 114, from: [114, 3802], serialize: jsonAsGiven, parse: (x: string) => JSON.parse(x) },
};

/** How long `close` lets statements still running finish before it destroys the connections. */
const CLOSE_TIMEOUT_S = 5;

/**
 * Runs a pipeline sends at once: postgres.js keeps at most 100 statements in flight on a
 * connection (its `max_pipeline` default) and holds the next one back until an answer comes.
 */
const PIPELINE_BURST = 100;

/**
 * The driver's error (a boundary): did the connection itself go? postgres.js's own
 * `CONNECTION_*` codes, SQLSTATE class 08 (connection exception) and class 57P (the server ended
 * the session: an administrator's `pg_terminate_backend`, a shutdown), after which it closes.
 */
function connectionLost(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return (
    typeof code === "string" &&
    (code.startsWith("CONNECTION_") || code.startsWith("08") || code.startsWith("57P"))
  );
}

export const connectPostgres: SqlConnect = (url) => {
  const sql = postgres(url, { max: 2, onnotice: () => undefined, types: TEXT_AS_GIVEN_TYPES });
  return {
    query: async (text, params = []) => {
      const rows = await sql.unsafe(text, [...params] as never[]);
      return rows as unknown as readonly SqlRow[];
    },
    transaction: (work) =>
      sql.begin(async (tx) => {
        const result = await work(async (text, params = []) => {
          const rows = await tx.unsafe(text, [...params] as never[]);
          return rows as unknown as readonly SqlRow[];
        });
        return result as never;
      }) as Promise<never>,
    // `unsafe` defaults to an unnamed statement, which postgres.js describes before every run (a
    // round trip each, and nothing else sent on that connection meanwhile): measured 2 round trips
    // per run through a counting relay (capture.db.test.ts). A named statement (`prepare: true`)
    // is described once per connection; after that runs are sent back to back, each ending in its
    // own Sync, so each is its own transaction. Only this method names statements: a
    // transaction-mode pooler that keeps no prepared statements across server connections would
    // fail it, and every other statement stays unnamed. The runs go on one reserved connection, so
    // the server runs and commits them in the order sent: the queue is ordered by `enqueued_at`,
    // and runs spread over the pool's two connections committed out of order (store.db.test.ts,
    // "passes over a job another connection holds").
    //
    // Every run must be sent to the server, never left in postgres.js's own queue for a reserved
    // connection: that queue is drained one run per answer and is never settled when the
    // connection drops, so a run left there would hang the call. A run waits there when the
    // connection is busy describing (a cold connection's first named run) or holds
    // `PIPELINE_BURST` runs in flight. So the first run goes alone and is awaited, which also
    // describes the statement, and the rest go in bursts of at most `PIPELINE_BURST`, each awaited.
    pipeline: async (text, paramSets) => {
      const connection = await sql.reserve();
      const run = (params: readonly unknown[]) =>
        connection.unsafe(text, [...params] as never[], { prepare: true });
      let failure: { readonly reason: unknown } | undefined;
      let lost = false;
      const settle = async (runs: readonly (readonly unknown[])[]): Promise<void> => {
        for (const result of await Promise.allSettled(runs.map(run))) {
          if (result.status === "rejected") {
            failure ??= { reason: result.reason };
            lost ||= connectionLost(result.reason);
          }
        }
      };
      try {
        const [first, ...rest] = paramSets;
        if (first !== undefined) {
          await settle([first]);
        }
        for (let start = 0; failure === undefined && start < rest.length; start += PIPELINE_BURST) {
          await settle(rest.slice(start, start + PIPELINE_BURST));
        }
      } finally {
        // `release` puts the connection back among the open ones whatever its state; a dropped one
        // the pool has already closed would take the next query to a socket that is gone. The pool
        // drops and replaces it on its own.
        if (!lost) {
          connection.release();
        }
      }
      if (failure !== undefined) {
        throw failure.reason;
      }
    },
    async listen(channel, onNotify) {
      // postgres.js keeps one dedicated connection for every LISTEN and resubscribes after a
      // reconnect; `unlisten` lets go of this channel's subscription.
      const { unlisten } = await sql.listen(channel, onNotify);
      return () => unlisten();
    },
    // Bounded: a connection the server ended mid-statement (a FATAL with no ReadyForQuery) keeps
    // that statement as its current one until it is reused, and a bare `end()` waits for it
    // forever; with a timeout postgres.js destroys what is still open (capture.db.test.ts, "a
    // pipeline whose connection is ended mid-way").
    close: () => sql.end({ timeout: CLOSE_TIMEOUT_S }),
  };
};
