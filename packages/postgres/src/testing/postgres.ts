import { randomBytes } from "node:crypto";
import { enqueueRole, workerRole } from "../install/index.ts";
import { connectPostgres, quoteIdent } from "../sql/index.ts";

/**
 * A scratch database on the server `DATABASE_URL` names, for `*.db.test.ts`: created with a random
 * name, dropped (with force) when the test is done, so a database that holds a FacetDB install or
 * store is never touched. `DATABASE_URL` is a server, not a database; the role needs `createdb`
 * and `createrole` (the CI one is a superuser). Missing, it is an environment error, not a code one.
 *
 * Roles are cluster-wide, so each scratch database also has its own role suffix: a suite installs
 * with `roleSuffix` and logs in as `workerRole`, and `drop` removes exactly those two roles. Files
 * run in parallel, and two `test:db` runs share a server, without touching each other's logins.
 */
export type ScratchDatabase = {
  /** The connection string of the scratch database, same server and role as `DATABASE_URL`. */
  readonly url: string;
  readonly name: string;
  /** This database's role suffix (`_t` and 6 hex digits): pass it to `migrate`, `prune` and `uninstall`. */
  readonly roleSuffix: string;
  /** The worker login an install with `roleSuffix` creates. */
  readonly workerRole: string;
  /** The trigger functions' owner an install with `roleSuffix` creates. */
  readonly enqueueRole: string;
  /** The same database as another role (the worker login), for permission tests. */
  as(user: string, password: string): string;
  /** Runs one statement on the server's maintenance connection (role and database administration). */
  admin(text: string): Promise<void>;
  /**
   * Drops the database, then its two roles (`workerRole`, `enqueueRole`): every step is tried, and
   * the first error is thrown once all have been.
   */
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

/**
 * Runs statements in order on one connection to `url`, closed afterwards. Each runs whatever the
 * ones before it did, and the first error is thrown once all have run: a cleanup that fails
 * half-way still does all it can.
 */
async function run(url: string, ...texts: readonly string[]): Promise<void> {
  const client = connectPostgres(url);
  const errors: unknown[] = [];
  try {
    for (const text of texts) {
      try {
        await client.query(text);
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    await client.close();
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}

export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const name = `facetdb_test_${randomBytes(6).toString("hex")}`;
  const roleSuffix = `_t${randomBytes(3).toString("hex")}`;
  const roles = [workerRole(roleSuffix), enqueueRole(roleSuffix)] as const;
  const admin = (text: string): Promise<void> => run(serverUrl(), text);
  await admin(`create database ${quoteIdent(name)}`);
  const withDatabase = new URL(serverUrl());
  withDatabase.pathname = `/${name}`;
  const url = withDatabase.toString();
  return {
    url,
    name,
    roleSuffix,
    workerRole: roles[0],
    enqueueRole: roles[1],
    as(user, password) {
      const login = new URL(url);
      login.username = user;
      login.password = password;
      return login.toString();
    },
    admin,
    drop() {
      // Everything the two roles own or were granted is in this database, so dropping it (with
      // force: a connection left open is ended) leaves them nothing, and `drop role` succeeds.
      // `drop owned` inside the database would not: the trigger functions the enqueue role owns
      // are what the admin's triggers depend on. Only this database's two roles, never another
      // file's or another run's. Each step runs even when one before it failed (`run`): no login
      // role stays on the shared server only because an earlier statement threw.
      return run(
        serverUrl(),
        `drop database if exists ${quoteIdent(name)} with (force)`,
        ...roles.map((role) => `drop role if exists ${quoteIdent(role)}`),
      );
    },
  };
}
