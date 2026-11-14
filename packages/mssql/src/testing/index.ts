import { URL_VARIABLES, type UrlVariable } from "../index.ts";

// The scripted catalog of a database the install, uninstall, prune, connector and doctor tests
// read.
export {
  AZURE_SQL,
  answer,
  COLLATION,
  CONTAINED_SQL_SERVER,
  catalogColumn,
  DATABASE,
  everyType,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  listings,
  SQL_SERVER,
  typed,
  type World,
  type WorldColumn,
  type WorldGrant,
  type WorldMarkerRow,
  type WorldObject,
  type WorldServer,
  type WorldTable,
} from "./catalog-world.ts";
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

/** The hosts of this machine, where the test container listens. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The test server's URL as the db suites connect with it. The container `scripts/test-databases.sh
 * up mssql` starts presents a self-signed certificate, which tedious refuses by default, and
 * `MSSQL_URL` as the script prints it says nothing of TLS. So a URL that names this machine and
 * says nothing of `encrypt` or `trustServerCertificate` gets `trustServerCertificate=true` here,
 * and nowhere else: only the db suites call this, a customer's connection string never passes
 * through it, and the URL rule (`tlsProblem`) still refuses that setting toward any other machine.
 * A URL that names another host, or a TLS setting of its own, is returned as it is.
 */
export function testServerUrl(variable: UrlVariable, env: Environment = process.env): string {
  const url = serverUrl(variable, env);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const said = [...parsed.searchParams.keys()].some((key) =>
    ["encrypt", "trustservercertificate"].includes(key.toLowerCase()),
  );
  if (said || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return url;
  }
  parsed.searchParams.set("trustServerCertificate", "true");
  return parsed.toString();
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
