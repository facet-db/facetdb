import { URL_VARIABLES, type UrlVariable } from "../index.ts";

export {
  DEFAULT_SQL_MODE,
  MARIADB_SQL_MODE,
  type ScriptedColumn,
  type ScriptedDatabase,
  type ScriptedRights,
  type ScriptedTable,
  type ScriptedTrigger,
  scriptedDatabase,
} from "./catalog.ts";
export {
  ADMIN_URL,
  ENGINE_DEPS,
  freshListings,
  installedListings,
  LISTINGS_JOBS,
  LISTINGS_PROJECT,
  LISTINGS_QUESTIONS,
  LISTINGS_TABLE,
  LISTINGS_TRIGGERS,
  listingsTarget,
} from "./listings.ts";
export {
  type Answer,
  mysqlError,
  type RecordingDriver,
  recordingDriver,
  type Sent,
} from "./recording.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  MYSQL_URL: "a MySQL 8 server; scripts/test-databases.sh up mysql starts one",
  MARIADB_URL: "a MariaDB 10.5 or later server; scripts/test-databases.sh up mariadb starts one",
};

/** Where the variables are read: `process.env`, or a test's own. */
type Environment = Readonly<Record<string, string | undefined>>;

function isSet(env: Environment, variable: UrlVariable): boolean {
  return (env[variable] ?? "") !== "";
}

function unsetError(variable: UrlVariable): Error {
  return new Error(
    `environment, not code: ${variable} is unset (point it at ${SERVERS[variable]})`,
  );
}

/**
 * The test server `variable` names, for `*.db.test.ts`. Missing, it is an environment error, not
 * a code one. `env` is a parameter only so a test can pass its own.
 */
export function serverUrl(variable: UrlVariable, env: Environment = process.env): string {
  const url = env[variable];
  if (url === undefined || url === "") {
    throw unsetError(variable);
  }
  return url;
}

/**
 * Whether the suite on `variable`'s server is skipped, for `describe.skipIf`: true when `variable`
 * is unset while another of this package's variables is set (a machine runs the engines it has
 * started), after printing the line that says so; never a silent pass. With none of them set the
 * suite fails as `serverUrl` does: environment, not code.
 *
 *   for (const variable of URL_VARIABLES) {
 *     describe.skipIf(skipUnless(variable))(`the connector on ${variable}`, () => { … });
 *   }
 *
 * The line goes straight to stderr: a vitest reporter may keep a passing file's console quiet.
 * `env` and `print` are parameters only so a test can pass its own.
 */
export function skipUnless(
  variable: UrlVariable,
  env: Environment = process.env,
  print: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): boolean {
  if (isSet(env, variable)) {
    return false;
  }
  if (!URL_VARIABLES.some((other) => isSet(env, other))) {
    throw unsetError(variable);
  }
  print(`SKIPPED: the suite on ${variable} (unset; point it at ${SERVERS[variable]})`);
  return true;
}
