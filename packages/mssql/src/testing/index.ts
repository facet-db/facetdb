import { URL_VARIABLES, type UrlVariable } from "../index.ts";

// The statement-recording fake driver the unit tests hand in through `MssqlConnect`.
export {
  type RecordedStatement,
  type RecordingClient,
  type RecordingScript,
  recordingClient,
  serverError,
  serverErrors,
  type TransactionEnd,
} from "./recording-client.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  MSSQL_URL: "a SQL Server 2016 or later; scripts/test-databases.sh up mssql starts one",
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
 * suite fails as `serverUrl` does: environment, not code. This package has one server, so its suite
 * never skips: it runs, or fails.
 *
 *   describe.skipIf(skipUnless("MSSQL_URL"))("the connector on SQL Server", () => { … });
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
