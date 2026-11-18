import { type CursorStore, type DatabaseEngine, EngineRefusal } from "@facetdb/core";
import {
  connectMssqlPool,
  createMssqlConnector,
  MSSQL_CAPABILITIES,
  type MssqlPoolConnect,
  noteOnStderr,
  warnOnStderr,
} from "../connector/index.ts";
import { createInstaller, DEFAULT_SCHEMA } from "../install/index.ts";
import { connectMssql, MSSQL_SCHEMES, type MssqlConnect, workerUrlRefusal } from "../sql/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";

/**
 * The SQL Server and Azure SQL engine: the install's plans and run over one admin connection per
 * call, the runtime connector over a pool under the worker login, doctor's checks. The CLI picks it
 * for `mssql:` and `sqlserver:` connection strings (cli/engines.ts), and loads this package only
 * then: tedious brings @azure/identity and MSAL with it. The store is never this database (it is
 * Postgres), so a plan holds no `store` statement and the CLI's store door owns the log. A source
 * with `capture: "change-tracking"` keeps the version it has read up to in the store's cursors,
 * which come through `cursors`, opened only once its `watch` or doctor's version check needs them,
 * as MongoDB's resume token does.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mssql";

/** The store's cursors for a connector, and how to let go of what was opened for them. */
export type OpenedCursors = {
  readonly cursors: CursorStore;
  close(): Promise<void>;
};

/** Opens the store's cursors, under the same `--allow-insecure` the source was opened with. */
export type OpenCursors = (options: { readonly allowInsecure: boolean }) => Promise<OpenedCursors>;

export type MssqlEngineOptions = {
  /** One connection for the plans, their run and doctor: tedious by default, a test passes its own. */
  readonly connect?: MssqlConnect;
  /** The runtime connector's pool: tedious by default, a test passes its own. */
  readonly pool?: MssqlPoolConnect;
  /**
   * The store's cursors, for `capture: "change-tracking"`. Without them a connector with that
   * capture serves everything but `watch`, which refuses in words, and doctor says the version was
   * not read: tools and tests that never follow changes need no store.
   */
  readonly cursors?: OpenCursors;
  /** Where a connector's warnings go (a lost Change Tracking version): stderr by default. */
  readonly warn?: (line: string) => void;
  /** Where a connector says, once, whether it polls Change Tracking or claims only: stderr by default. */
  readonly note?: (line: string) => void;
};

const NO_CURSORS: OpenCursors = () =>
  Promise.reject(
    new Error(
      'this SQL Server engine was made without the store\'s cursors, where capture: "change-tracking" keeps the version it has read up to: the composition root passes them (createMssqlEngine({ cursors }))',
    ),
  );

/** The store's cursors opened on first use and closed with whoever asked for them. */
export function lazyCursors(open: OpenCursors, allowInsecure: boolean): OpenedCursors {
  let opened: Promise<OpenedCursors> | undefined;
  const cursors = () => {
    opened ??= open({ allowInsecure });
    return opened.then((ready) => ready.cursors);
  };
  return {
    cursors: {
      load: async (run) => (await cursors()).load(run),
      save: async (run, progress) => (await cursors()).save(run, progress),
    },
    async close() {
      const ready = await opened?.catch(() => undefined);
      await ready?.close();
    },
  };
}

/** The source's connection string as the words name it: its variable, else as the contract says. */
function subjectOf(target: { readonly urlVariable?: string }): string {
  return target.urlVariable ?? "the source's connection string";
}

export function createMssqlEngine(options: MssqlEngineOptions = {}): DatabaseEngine {
  const connect = options.connect ?? connectMssql;
  const pool = options.pool ?? connectMssqlPool;
  const openCursors = options.cursors ?? NO_CURSORS;
  const warn = options.warn ?? warnOnStderr;
  const note = options.note ?? noteOnStderr;
  return {
    name: ENGINE_NAME,
    schemes: MSSQL_SCHEMES,
    capabilities: MSSQL_CAPABILITIES,
    checks: DOCTOR_CHECKS,
    // A bare name is in `dbo`, as every plan reads it.
    label: (target) => `${target.schema ?? DEFAULT_SCHEMA}.${target.table}`,
    ...createInstaller({ connect }),
    checkUrl: (target, url, deps) => workerUrlRefusal(url, deps.allowInsecure, subjectOf(target)),
    async open(target, url, openOptions) {
      const refused = workerUrlRefusal(url, openOptions.allowInsecure, subjectOf(target));
      if (refused !== undefined) {
        throw new EngineRefusal(refused);
      }
      if (target.capture !== "change-tracking") {
        return createMssqlConnector(target, url, {
          clock: openOptions.clock,
          connect: pool,
          ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
          ...(openOptions.maxConnections === undefined
            ? {}
            : { maxConnections: openOptions.maxConnections }),
        });
      }
      const store = lazyCursors(openCursors, openOptions.allowInsecure);
      const connector = await createMssqlConnector(target, url, {
        clock: openOptions.clock,
        connect: pool,
        cursors: store.cursors,
        warn,
        note,
        ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
        ...(openOptions.maxConnections === undefined
          ? {}
          : { maxConnections: openOptions.maxConnections }),
      });
      return {
        ...connector,
        async close() {
          try {
            await connector.close();
          } finally {
            await store.close();
          }
        },
      };
    },
    doctor: (target, url, deps) => doctorChecks(connect, target, url, deps, openCursors),
  };
}

/** The engine over tedious, for tools and tests; the CLI's composition root makes its own. */
export const mssqlEngine: DatabaseEngine = createMssqlEngine();
