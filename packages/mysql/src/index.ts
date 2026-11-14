/**
 * @facetdb/mysql: FacetDB on MySQL 8 and MariaDB 10.5 and later, one SQL text for both engines
 * through mysql2.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mysql";

/**
 * The variables naming the test servers its `*.db.test.ts` run on, one per engine it serves
 * (`scripts/test-databases.sh` prints them).
 */
export const URL_VARIABLES = ["MYSQL_URL", "MARIADB_URL"] as const;

export type UrlVariable = (typeof URL_VARIABLES)[number];

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
} from "./sql/index.ts";
