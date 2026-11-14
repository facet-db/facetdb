import type { UrlVariable } from "../index.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  COCKROACH_URL: "a CockroachDB node; scripts/test-databases.sh up cockroach starts one",
  ORACLE_URL: "an Oracle Database 19c or later; scripts/test-databases.sh up oracle starts one",
};

/**
 * The test server `variable` names, for `*.db.test.ts`. Missing, it is an environment error, not
 * a code one.
 */
export function serverUrl(variable: UrlVariable): string {
  const url = process.env[variable];
  if (url === undefined || url === "") {
    throw new Error(
      `environment, not code: ${variable} is unset (point it at ${SERVERS[variable]})`,
    );
  }
  return url;
}
