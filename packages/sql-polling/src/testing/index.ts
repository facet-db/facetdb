import { URL_VARIABLES, type UrlVariable } from "../index.ts";

// The dialect conformance suite every dialect runs, the reference dialect it runs on here, and the
// recording client both stand on.
export {
  conformanceScript,
  type DialectConformance,
  runDialectConformance,
} from "./dialect-suite.ts";
export {
  PLAIN_COLUMNS,
  PLAIN_KEY,
  PLAIN_LOGIN,
  PLAIN_MARKS,
  plainDialect,
} from "./plain-dialect.ts";
export {
  type RecordedStatement,
  type RecordingClient,
  type Responder,
  recordingClient,
  recordingConnect,
} from "./recording-client.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  COCKROACH_URL: "a CockroachDB node; scripts/test-databases.sh up cockroach starts one",
  ORACLE_URL: "an Oracle Database 19c or later; scripts/test-databases.sh up oracle starts one",
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
 *     describe.skipIf(skipUnless(variable))(`the dialect on ${variable}`, () => { … });
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
