import type { UrlVariable } from "../index.ts";

/** What each variable points at, and how to start one. */
const SERVERS: Readonly<Record<UrlVariable, string>> = {
  MYSQL_URL: "a MySQL 8 server; scripts/test-databases.sh up mysql starts one",
  MARIADB_URL: "a MariaDB 10.5 or later server; scripts/test-databases.sh up mariadb starts one",
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
