import type { UrlVariable } from "../index.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  MSSQL_URL: "a SQL Server 2016 or later; scripts/test-databases.sh up mssql starts one",
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
