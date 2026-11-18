import {
  type DatabaseEngine,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
} from "@facetdb/core";
import { createSqliteConnector, SQLITE_CAPABILITIES, sharedClients } from "../connector/index.ts";
import { logOnlyPurge } from "../engine/index.ts";
import {
  planInstall,
  planPrune,
  planUninstall,
  readInstalled,
  render,
  runThrough,
  type SqliteQuery,
} from "../install/index.ts";
import { type LibsqlConfig, type OpenLibsql, openLibsql } from "./client.ts";
import { LIBSQL_DOCTOR_CHECKS, libsqlDoctor } from "./doctor.ts";
import { forServer } from "./plan.ts";
import {
  connectionOf,
  type Environment,
  isRefusal,
  type LibsqlConnection,
  labelOf,
} from "./server.ts";

/**
 * The libSQL engine: Turso and sqld through @libsql/client, with SQLite's SQL and triggers and its
 * connector, unchanged. The CLI picks it for `libsql:` URLs and for `https:` and `http:` ones with
 * `turso.io` or `libsql` in the host (cli/engines.ts).
 *
 * - Every call reads the URL and the auth token first (`connectionOf`, libsql/server.ts) and refuses
 *   before it connects; the token comes from the environment it is made with, never the config.
 * - The plans are SQLite's, read through the client, with the journal mode left out (the server owns
 *   it, libsql/plan.ts); `run` is the same order through the client, inside `begin immediate`.
 * - One worker, as on SQLite: the lock is the SQLite connector's, a row of
 *   `facetdb_table_owners` taken and renewed in the claim's transaction, which on a server holds for
 *   workers on other machines too while their clocks agree (the lock and the lease compare each
 *   worker's own time); `multipleWorkers` is false, so `facetdb worker` runs one.
 * - One client per URL for the connectors of one process (`sharedClients`), so their statements
 *   take turns in the process, not on the server's write lock.
 * - `--purge`: the store is Postgres, never this database, as on a SQLite file.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const LIBSQL_ENGINE_NAME = "libsql";

export type LibsqlEngineOptions = {
  /** Where the auth token is read: `process.env` in the CLI's composition root, a test's record. */
  readonly env: Environment;
  /** Opens a server's client; @libsql/client over HTTP by default, a test passes its own. */
  readonly open?: OpenLibsql;
};

function configOf(connection: LibsqlConnection): LibsqlConfig {
  return {
    url: connection.server.url,
    ...(connection.token === undefined ? {} : { authToken: connection.token.value }),
  };
}

export function createLibsqlEngine(options: LibsqlEngineOptions): DatabaseEngine {
  const { env } = options;
  const open = options.open ?? openLibsql;
  /** What each connector key opens: a server's URL and the token read for it. */
  const configs = new Map<string, LibsqlConfig>();
  /** One client per key for the connectors of this engine; the last to close closes it. */
  const share = sharedClients(
    (key) => {
      const config = configs.get(key);
      if (config === undefined) {
        throw new Error("a libSQL connector opened before its server was read");
      }
      return open(config);
    },
    (key) => key,
  );

  /** Plans through a client of its own, closed whatever happens. */
  async function planning(
    target: EngineTarget,
    url: string,
    allowInsecure: boolean,
    plan: (query: SqliteQuery, where: string) => Promise<PlanResult>,
  ): Promise<PlanResult> {
    const connection = connectionOf(target, url, env, allowInsecure);
    if (isRefusal(connection)) {
      return { ok: false, refusal: connection };
    }
    const client = open(configOf(connection));
    try {
      return forServer(
        await plan((sql, params) => client.all(sql, params), labelOf(connection.server)),
      );
    } finally {
      await client.close();
    }
  }

  return {
    name: LIBSQL_ENGINE_NAME,
    schemes: ["libsql", "https", "http"],
    capabilities: SQLITE_CAPABILITIES,
    checks: LIBSQL_DOCTOR_CHECKS,
    // As SQLite: no schema but `main`, said only where the config does.
    label: (target) =>
      target.schema === undefined ? target.table : `${target.schema}.${target.table}`,

    planInstall: (target, url, installOptions) =>
      planning(target, url, installOptions.allowInsecure, (query) => planInstall(target, query)),

    planUninstall: (target, url, uninstallOptions) =>
      planning(target, url, uninstallOptions.allowInsecure, async (query, where) => {
        if (uninstallOptions.purge) {
          const installed = await readInstalled(query, target.table);
          if ("reason" in installed) {
            return { ok: true, plan: logOnlyPurge(target, installed.reason, where) };
          }
        }
        return planUninstall(target, query, {
          alsoUninstalling: uninstallOptions.alsoUninstalling,
        });
      }),

    planPrune: (target, url, deps) =>
      planning(target, url, deps.allowInsecure, (query) => planPrune(target, query)),

    render,

    async run(target, plan, url, runOptions) {
      const connection = connectionOf(target, url, env, runOptions.allowInsecure);
      if (isRefusal(connection)) {
        return { ran: [], stopped: { at: 0, refusal: connection }, removed: [], notes: [] };
      }
      const client = open(configOf(connection));
      try {
        return await runThrough(target, plan, client, labelOf(connection.server));
      } finally {
        await client.close();
      }
    },

    checkUrl: (target, url, deps) => {
      const connection = connectionOf(target, url, env, deps.allowInsecure);
      return isRefusal(connection) ? connection : undefined;
    },

    async open(target, url, openOptions) {
      const connection = connectionOf(target, url, env, openOptions.allowInsecure);
      if (isRefusal(connection)) {
        throw new EngineRefusal(connection);
      }
      // The key names the URL and the token's variable, never the token: it is the connector's
      // `path`, which its words would fall back on without the label.
      const key = `${connection.server.url} ${connection.token?.variable ?? "(no token)"}`;
      configs.set(key, configOf(connection));
      return createSqliteConnector(target, key, {
        clock: openOptions.clock,
        open: share,
        label: labelOf(connection.server),
        ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
      });
    },

    doctor: (target, url, deps) => libsqlDoctor(target, url, deps, env, open),
  };
}
