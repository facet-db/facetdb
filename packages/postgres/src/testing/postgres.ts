import { randomBytes } from "node:crypto";
import { connectPostgres, quoteIdent } from "../sql/index.ts";

/**
 * A scratch database on the server `DATABASE_URL` names, for `*.db.test.ts`: created with a random
 * name, dropped (with force) when the test is done, so a database that holds a FacetDB install or
 * store is never touched. `DATABASE_URL` is a server, not a database; the role needs `createdb`
 * (the CI one is a superuser). Missing, it is an environment error, not a code one.
 */
export type ScratchDatabase = {
  /** The connection string of the scratch database, same server and role as `DATABASE_URL`. */
  readonly url: string;
  readonly name: string;
  /** The same database as another role (the worker login), for permission tests. */
  as(user: string, password: string): string;
  /** Runs one statement on the server's maintenance connection (role and database administration). */
  admin(text: string): Promise<void>;
  drop(): Promise<void>;
};

export function serverUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "environment, not code: DATABASE_URL is unset (point it at a Postgres 13+; the CI workflow starts one)",
    );
  }
  return url;
}

export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const name = `facetdb_test_${randomBytes(6).toString("hex")}`;
  const admin = async (text: string): Promise<void> => {
    const client = connectPostgres(serverUrl());
    try {
      await client.query(text);
    } finally {
      await client.close();
    }
  };
  await admin(`create database ${quoteIdent(name)}`);
  const withDatabase = new URL(serverUrl());
  withDatabase.pathname = `/${name}`;
  return {
    url: withDatabase.toString(),
    name,
    as(user, password) {
      const url = new URL(withDatabase.toString());
      url.username = user;
      url.password = password;
      return url.toString();
    },
    admin,
    drop: () => admin(`drop database if exists ${quoteIdent(name)} with (force)`),
  };
}
