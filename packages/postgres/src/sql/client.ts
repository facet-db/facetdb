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
export const connectPostgres: SqlConnect = (url) => {
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
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
