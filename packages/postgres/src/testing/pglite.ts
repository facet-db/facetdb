import { PGlite } from "@electric-sql/pglite";
import { pgliteClient } from "../polling/index.ts";
import type { SqlClient, SqlConnect } from "../sql/index.ts";

/**
 * One in-process PGlite for a unit test: the database, a `SqlClient` over it, and a `connect` that
 * hands the same client to any code written against `SqlConnect` (migrate, the connectors), so the
 * production code runs its own SQL on a real Postgres engine with nothing installed. PGlite is one
 * connection and one superuser: it proves SQL shape, triggers and NOTIFY, not roles or two workers
 * (those are `*.db.test.ts`, see `postgres.ts`).
 */
export type PgliteWorld = {
  readonly db: PGlite;
  readonly client: SqlClient;
  readonly connect: SqlConnect;
  close(): Promise<void>;
};

export function createPgliteWorld(): PgliteWorld {
  const db = new PGlite();
  const client = pgliteClient(db);
  return {
    db,
    client,
    connect: () => client,
    close: () => db.close(),
  };
}
