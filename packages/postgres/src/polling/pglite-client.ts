import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlRow } from "../sql/index.ts";

/**
 * A `SqlClient` over an in-process PGlite, so the polling connector's own SQL text runs on a real
 * Postgres engine in unit tests with nothing installed. PGlite is one connection and one superuser:
 * it proves the SQL, not roles or two workers (those are `*.db.test.ts` on a real Postgres).
 * `close` leaves the database open: the test owns it, and shares it with the application's edits.
 */
export function pgliteClient(db: PGlite): SqlClient {
  return {
    query: async (text, params = []) => {
      const result = await db.query<SqlRow>(text, [...params]);
      return result.rows;
    },
    transaction: (work) =>
      db.transaction((tx) =>
        work(async (text, params = []) => {
          const result = await tx.query<SqlRow>(text, [...params]);
          return result.rows;
        }),
      ),
    close: () => Promise.resolve(),
  };
}
