/**
 * @facetdb/mysql: FacetDB on MySQL 8 and MariaDB 10.5 and later, one SQL text for both engines
 * through mysql2.
 */

/**
 * The variables naming the test servers its `*.db.test.ts` run on, one per engine it serves
 * (`scripts/test-databases.sh` prints them).
 */
export const URL_VARIABLES = ["MYSQL_URL", "MARIADB_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];

// The runtime connector under the worker login and the pool it talks through.
export * from "./connector/index.ts";
// The engine the CLI registers for mysql: and mariadb:.
export * from "./engine/index.ts";
// The install, uninstall and prune plans, their script and their run.
export {
  createMysqlInstaller,
  JOBS_TABLE,
  type MysqlInstaller,
  type MysqlInstallerOptions,
  OWNERS_TABLE,
  SCRIPT_HEADER,
  WORKER_ACCOUNT,
  WORKER_USER,
} from "./install/index.ts";
export {
  connectMysql,
  type MysqlClient,
  type MysqlConnect,
  type MysqlQuery,
  type MysqlRow,
  tlsProblem,
  workerUrlRefusal,
} from "./sql/index.ts";
