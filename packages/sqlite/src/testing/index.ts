import type { UrlVariable } from "../index.ts";

export { FakeRepeat } from "./heartbeat.ts";
export { type TemporaryDatabase, temporaryDatabase } from "./temporary.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  LIBSQL_URL: "a libSQL server (sqld); scripts/test-databases.sh up libsql starts one",
};

/** Where the variables are read: `process.env`, or a test's own. */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The test server `variable` names, for `*.db.test.ts`. Missing, it is an environment error, not
 * a code one. `env` is a parameter only so a test can pass its own.
 *
 * This package has one server, so its suite never skips: `libsql.db.test.ts` reads its URL here as
 * it loads, and with `LIBSQL_URL` unset the run fails, whatever other engine's variable is set. A
 * two-server package's `skipUnless` (mysql, sql-polling) skips the half whose server is missing;
 * there is no such half here, so there is no `skipUnless` either.
 */
export function serverUrl(variable: UrlVariable, env: Environment = process.env): string {
  const url = env[variable];
  if (url === undefined || url === "") {
    throw new Error(
      `environment, not code: ${variable} is unset (point it at ${SERVERS[variable]})`,
    );
  }
  return url;
}
