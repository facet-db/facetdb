import type { CursorStore, DatabaseEngine, KeyText } from "@facetdb/core";
import {
  connectWorker,
  createMongoConnector,
  keyFromText,
  keyToText,
  MONGO_CAPABILITIES,
  type WorkerConnect,
  workerUrlRefusal,
} from "../connector/index.ts";
import {
  type AdminConnect,
  connectAdmin,
  planInstall,
  planPrune,
  planUninstall,
  renderScript,
  runPlan,
} from "../install/index.ts";
import { databaseOf, parseConnectionString, subjectOf } from "../urls/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";

/**
 * The MongoDB engine: the plans and their run over one admin connection per call, the runtime
 * connector under the worker login, doctor's checks. The CLI picks it for `mongodb:` and
 * `mongodb+srv:` connection strings (cli/engines.ts). The store is never this database (it is
 * Postgres), so a plan holds no `store` statement and the CLI's store door owns the log; the one
 * thing of the store the connector needs, the cursors its resume token lives in, comes through
 * `cursors`, which the composition root wires to the store it opens. `open` takes it lazily: only
 * `watch` reads or writes a token, so `facetdb preview`, `explain` and a backfill open a connector
 * without opening the store for it.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "mongodb";

/**
 * A document's key on the terminal: the `_id` as the user writes it, never the tagged key the store
 * and the queue hold (connector/keys.ts says the rule).
 */
export const MONGO_KEY_TEXT: KeyText = {
  toText: keyToText,
  fromText: keyFromText,
  form: "the document's _id as you write it (the 24 hex characters of an ObjectId, a number as its digits, a string as itself; a string _id that looks like an ObjectId or a number is written s:<id>)",
};

/** The store's cursors for a connector, and how to let go of what was opened for them. */
export type OpenedCursors = {
  readonly cursors: CursorStore;
  close(): Promise<void>;
};

/** Opens the store's cursors, under the same `--allow-insecure` the source was opened with. */
export type OpenCursors = (options: { readonly allowInsecure: boolean }) => Promise<OpenedCursors>;

export type MongoEngineOptions = {
  /** The admin connection for the plans and their run: the mongodb driver by default. */
  readonly connect?: AdminConnect;
  /** The worker's connection for the connector and doctor: the mongodb driver by default. */
  readonly worker?: WorkerConnect;
  /**
   * The store's cursors. Without them a connector opens and serves everything but `watch`, which
   * refuses in words: tools and tests that never follow changes need no store.
   */
  readonly cursors?: OpenCursors;
  /** Where a connector's warnings go (a lost resume token, a document it cannot key): stderr by default. */
  readonly warn?: (line: string) => void;
};

const NO_CURSORS: OpenCursors = () =>
  Promise.reject(
    new Error(
      "this MongoDB engine was made without the store's cursors, where the change stream's resume token lives: the composition root passes them (createMongoEngine({ cursors }))",
    ),
  );

/** The store's cursors opened on first use and closed with the connector. */
function lazyCursors(open: OpenCursors, allowInsecure: boolean): OpenedCursors {
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

export function createMongoEngine(options: MongoEngineOptions = {}): DatabaseEngine {
  const connect = options.connect ?? connectAdmin;
  const worker = options.worker ?? connectWorker;
  const openCursors = options.cursors ?? NO_CURSORS;
  const warn =
    options.warn ??
    ((line: string) => {
      process.stderr.write(`warning: ${line}\n`);
    });
  return {
    name: ENGINE_NAME,
    schemes: ["mongodb", "mongodb+srv"],
    capabilities: MONGO_CAPABILITIES,
    keyText: MONGO_KEY_TEXT,
    checks: DOCTOR_CHECKS,
    // The collection in its database: the config's, else the connection string's, as the plans name
    // it (`sourceDatabase`).
    label: (target, url) => {
      const database = target.schema ?? databaseOf(url);
      return database === undefined ? target.table : `${database}.${target.table}`;
    },
    // A replica set's string names several hosts, which `new URL` refuses: the login is read as the
    // driver splits the string.
    login: (url) => {
      const parsed = parseConnectionString(url);
      return parsed === undefined
        ? undefined
        : { user: parsed.user ?? "", password: parsed.password ?? "" };
    },
    planInstall: (target, url, installOptions) => planInstall(connect, target, url, installOptions),
    planUninstall: (target, url, uninstallOptions) =>
      planUninstall(connect, target, url, uninstallOptions),
    planPrune: (target, url, deps) => planPrune(connect, target, url, deps),
    render: renderScript,
    run: (target, plan, url, runOptions) => runPlan(connect, target, plan, url, runOptions),
    checkUrl: (target, url, deps) => workerUrlRefusal(url, deps.allowInsecure, subjectOf(target)),
    async open(target, url, openOptions) {
      const store = lazyCursors(openCursors, openOptions.allowInsecure);
      const connector = await createMongoConnector(target, url, {
        clock: openOptions.clock,
        cursors: store.cursors,
        allowInsecure: openOptions.allowInsecure,
        warn,
        connect: worker,
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
    doctor: (target, url, deps) => doctorChecks(worker, target, url, deps),
  };
}

/** The engine over the mongodb driver with no store, for tools and tests; main.ts makes its own. */
export const mongoEngine: DatabaseEngine = createMongoEngine();
