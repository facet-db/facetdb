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
    async listen(channel, onNotify) {
      // postgres.js keeps one dedicated connection for every LISTEN and resubscribes after a
      // reconnect; `unlisten` lets go of this channel's subscription.
      const { unlisten } = await sql.listen(channel, onNotify);
      return () => unlisten();
    },
    close: () => sql.end(),
  };
};
