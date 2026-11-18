import { type DatabaseEngine, EngineRefusal } from "@facetdb/core";
import {
  connectMysqlPool,
  createMysqlConnector,
  MYSQL_CAPABILITIES,
  type MysqlPoolConnect,
} from "../connector/index.ts";
import { createMysqlInstaller } from "../install/index.ts";
import { connectMysql, databaseInUrl, type MysqlConnect, workerUrlRefusal } from "../sql/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";

/**
 * The MySQL and MariaDB engine: the install's plans and run over one admin connection per call, the
 * runtime connector over a pool under the worker login, doctor's checks. The CLI picks it for
 * `mysql:` and `mariadb:` connection strings (cli/engines.ts). The store is never this database (it
 * is Postgres), so a plan holds no `store` statement and the CLI's store door owns the log.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mysql";

export type MysqlEngineOptions = {
  /** One connection for the plans, their run and doctor: mysql2 by default, a test passes its own. */
  readonly connect?: MysqlConnect;
  /** The runtime connector's pool: mysql2 by default, a test passes its own. */
  readonly pool?: MysqlPoolConnect;
};

/** The source's connection string as the words name it: its variable, else as the contract says. */
function subjectOf(target: { readonly urlVariable?: string }): string {
  return target.urlVariable ?? "the source's connection string";
}

export function createMysqlEngine(options: MysqlEngineOptions = {}): DatabaseEngine {
  const connect = options.connect ?? connectMysql;
  const pool = options.pool ?? connectMysqlPool;
  return {
    name: ENGINE_NAME,
    schemes: ["mysql", "mariadb"],
    capabilities: MYSQL_CAPABILITIES,
    checks: DOCTOR_CHECKS,
    // A bare name is in the connection string's database, as the plans name it.
    label: (target, url) => {
      const database = target.schema ?? databaseInUrl(url);
      return database === undefined ? target.table : `${database}.${target.table}`;
    },
    ...createMysqlInstaller({ connect }),
    checkUrl: (target, url, deps) => workerUrlRefusal(url, deps.allowInsecure, subjectOf(target)),
    async open(target, url, openOptions) {
      const refused = workerUrlRefusal(url, openOptions.allowInsecure, subjectOf(target));
      if (refused !== undefined) {
        throw new EngineRefusal(refused);
      }
      return createMysqlConnector(target, url, {
        clock: openOptions.clock,
        connect: pool,
        ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
        ...(openOptions.maxConnections === undefined
          ? {}
          : { maxConnections: openOptions.maxConnections }),
      });
    },
    doctor: (target, url, deps) => doctorChecks(connect, target, url, deps),
  };
}

/** The engine over mysql2, for tools and tests; the CLI's composition root makes its own. */
export const mysqlEngine: DatabaseEngine = createMysqlEngine();
