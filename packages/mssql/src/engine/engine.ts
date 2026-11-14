import { type DatabaseEngine, EngineRefusal } from "@facetdb/core";
import {
  connectMssqlPool,
  createMssqlConnector,
  MSSQL_CAPABILITIES,
  type MssqlPoolConnect,
} from "../connector/index.ts";
import { createInstaller } from "../install/index.ts";
import { connectMssql, MSSQL_SCHEMES, type MssqlConnect, workerUrlRefusal } from "../sql/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";

/**
 * The SQL Server and Azure SQL engine: the install's plans and run over one admin connection per
 * call, the runtime connector over a pool under the worker login, doctor's checks. The CLI picks it
 * for `mssql:` and `sqlserver:` connection strings (cli/engines.ts), and loads this package only
 * then: tedious brings @azure/identity and MSAL with it. The store is never this database (it is
 * Postgres), so a plan holds no `store` statement and the CLI's store door owns the log.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mssql";

export type MssqlEngineOptions = {
  /** One connection for the plans, their run and doctor: tedious by default, a test passes its own. */
  readonly connect?: MssqlConnect;
  /** The runtime connector's pool: tedious by default, a test passes its own. */
  readonly pool?: MssqlPoolConnect;
};

/** The source's connection string as the words name it: its variable, else as the contract says. */
function subjectOf(target: { readonly urlVariable?: string }): string {
  return target.urlVariable ?? "the source's connection string";
}

export function createMssqlEngine(options: MssqlEngineOptions = {}): DatabaseEngine {
  const connect = options.connect ?? connectMssql;
  const pool = options.pool ?? connectMssqlPool;
  return {
    name: ENGINE_NAME,
    schemes: MSSQL_SCHEMES,
    capabilities: MSSQL_CAPABILITIES,
    checks: DOCTOR_CHECKS,
    ...createInstaller({ connect }),
    checkUrl: (target, url, deps) => workerUrlRefusal(url, deps.allowInsecure, subjectOf(target)),
    async open(target, url, openOptions) {
      const refused = workerUrlRefusal(url, openOptions.allowInsecure, subjectOf(target));
      if (refused !== undefined) {
        throw new EngineRefusal(refused);
      }
      return createMssqlConnector(target, url, {
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

/** The engine over tedious, for tools and tests; the CLI's composition root makes its own. */
export const mssqlEngine: DatabaseEngine = createMssqlEngine();
