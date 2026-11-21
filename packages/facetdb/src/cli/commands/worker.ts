import { randomUUID } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { resolve } from "node:path";
import {
  type ActionStep,
  type Connector,
  createAlerts,
  createPreviewService,
  createQuestionTestService,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type KeyText,
  type ModelProvider,
  type OpenConnector,
  type PassReport,
  type QuestionSet,
  reviewsOf,
  type SpendingGate,
  type Worker,
} from "@facetdb/core";
import {
  createBackoff,
  createInFlightLimiter,
  createOutagePolicy,
  createResilientProvider,
  DEFAULT_MAX_MS,
  type OutagePolicyHandle,
} from "@facetdb/model";
import {
  type AlertFailure,
  createCheckStore,
  createOutbox,
  createServer,
  type DeliveryReport,
  OpenSurfaceError,
  onlyRecord,
  openStudioBuild,
  requireAccountToServe,
  type StudioBuild,
  type TableFacts,
} from "@facetdb/server";
import {
  type ConfigFiles,
  judgeDraftSource,
  type ProjectConfig,
  type SourceConfig,
  toProjectJson,
} from "../../config/index.ts";
import { projectSpending } from "../backfill-wiring.ts";
import { engineFor, keyWords, openConnector, requireUsableUrl, tableKeyText } from "../engines.ts";
import {
  type CliDeps,
  CliError,
  type CommandContext,
  defineCommand,
  EXIT_USAGE,
  type HttpListener,
  type OpenStore,
  type StoreClient,
} from "../program.ts";
import {
  requireStoreSecret,
  requireUsableStoreUrl,
  STORE_VARIABLE,
  storeSharedFor,
  storeSourceId,
} from "../store-door.ts";
import { createBackfillJobs } from "./backfill-jobs.ts";
import {
  configFileDoor,
  createFleet,
  fileQueue,
  reviewLookups,
  type SourceLoop,
} from "./config-reload.ts";
import { tableFacts } from "./dashboard-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  engineTarget,
  loadProjectConfig,
  type ProjectRef,
  projectRef,
  questionSetOf,
  sourceUrlOf,
  splitTable,
} from "./database.ts";
import { installRuns, installVerdict, unreadCheck } from "./install-check.ts";
import { createMigrateDoor, UNAVAILABLE_MIGRATE_DOOR } from "./migrate-door.ts";
import { createSetupDoor, UNAVAILABLE_SETUP_DOOR } from "./setup-door.ts";

/**
 * `facetdb worker`: one process that answers every source of the config. Per table source it runs
 * the connector its engine opens (the Postgres capture connector) under the worker login; per API
 * source the store's queue. Every worker shares the resilient provider (backoff and the in-flight
 * limit), the project's spending gate and its alerts, and beats the heartbeat `facetdb doctor`
 * reads. Next to the loops it delivers the webhook outbox and serves the HTTP surface (the check
 * API, the studio's endpoints and, once built, the studio itself) on `--port` unless `--no-http`.
 * SIGINT stops it after the pass in hand, so every claim is acked or released before it exits;
 * `--once` answers what is queued and exits. The sources run as a fleet (config-reload.ts): when
 * the studio's Apply has written facetdb.config.ts, the worker reloads it, a changed source
 * restarting after its batch in hand under its new question-set version, and a table source the
 * setup flow installed starting once the worker's own check of its database holds, its connection,
 * engine and key text made then with the checks the start makes.
 */

/**
 * The port of the HTTP surface: the check API and the studio's endpoints share it. It was 7411 for
 * the check API alone.
 */
export const DEFAULT_PORT = 4040;

/** Where the surface listens unless told otherwise: this machine only. */
export const DEFAULT_HOST = "127.0.0.1";

/** How often the outbox looks for webhooks that are due. */
export const OUTBOX_EVERY_MS = 2_000;

/**
 * The pool of the worker's store client and of each table source's client: a connection per lane in
 * flight, plus the claim and the heartbeat. With the old pool of two, six of eight lanes waited for
 * a connection on every statement (seen on Supabase). postgres.js keeps idle connections open, so
 * the worker shares pools to stay inside a pooler's per-user limit (Supabase's session pooler
 * serves about 15 per user and database on its small instances). Worst case per worker process:
 *  - table sources on the store's database (one DATABASE_URL): the store, the outbox and every
 *    such source share one pool, 10, plus one LISTEN connection: 11;
 *  - each table source on another database adds its own pool, 10, plus one LISTEN connection on
 *    that database, and one short-lived connection at start that reads its primary key.
 */
export const WORKER_CONNECTIONS = DEFAULT_WORKER_LIMITS.maxInFlight + 2;

export type WorkerOptions = {
  readonly config: string;
  readonly port: string;
  /**
   * The address the surface listens on. Not an option of `dev`, which always serves this machine
   * only (its store's secret is a constant the source code publishes).
   */
  readonly host: string;
  /** False under `--no-http`. */
  readonly http: boolean;
  readonly once: boolean;
  /** `--allow-insecure`: the store may be reached without TLS, on a network the operator trusts. */
  readonly allowInsecure?: boolean;
  /**
   * `--studio-dir`: the studio build to serve, relative to the project directory. Absent, the
   * install's own build is served when it is built, and the API alone otherwise.
   */
  readonly studioDir?: string;
};

/** Everything the loops run on, opened by `worker` from the environment or by `dev` on PGlite. */
export type WorkerParts = {
  readonly config: ProjectConfig;
  readonly project: ProjectRef;
  readonly store: OpenStore;
  /** The store's own database, for the webhook outbox. */
  readonly storeClient: StoreClient;
  /**
   * Opens a table source's connector through its engine, under the worker login; the caller closes
   * it. `worker` checked every source's URL before the store opened; `dev` is in-process. `config`
   * is the project the source is read from: after a reload, the new one.
   */
  readonly openTable: (
    source: SourceConfig,
    options: { readonly workerId: string; readonly maxConnections: number },
    config: ProjectConfig,
  ) => Promise<OpenConnector>;
  /**
   * The config file the studio's Apply writes and the worker reloads: absent in `dev`, whose config
   * is not the file's alone (its sources are the installed ones, its model may be `--model-url`'s).
   */
  readonly configFile?: {
    /** As `--config` names it. */
    readonly path: string;
    /** The loader over that file; `quiet` keeps its wording warnings unprinted. */
    readonly load: (options?: { readonly quiet?: boolean }) => Promise<ProjectConfig>;
    readonly files: ConfigFiles;
  };
  /**
   * How a table source's keys are written in the log lines: its engine's key text for its table, so
   * MongoDB's `n:1` prints `answered 1`, and a collection whose marker records string `_id`s prints
   * `answered 1001` as explain reads it. Read once, after the table opened. Absent, or undefined
   * for a source, keys print as they are.
   */
  readonly keyTextOf?: (source: SourceConfig) => Promise<KeyText | undefined>;
  /**
   * A table source as the dashboard's Home and Sources endpoints show it: its engine's words, its
   * login's reach and its doctor. Nothing connects until the doctor runs. `config` is the project
   * the source is read from, so its doctor checks that question set. For a source the start did not
   * have, `worker` makes its connection, engine and URL check here first, with the checks the start
   * makes, and a refusal is this call's error.
   */
  readonly tableFacts: (source: SourceConfig, config: ProjectConfig) => Promise<TableFacts>;
  /**
   * A source removed from the file, its loop closed: what the start made for its table (its
   * connection, engine and key text) is dropped, so a source added again under the name is made
   * anew. Absent in `dev`, whose sources never change.
   */
  readonly forgetTable?: (source: SourceConfig) => void;
  /** The model, before the backoff and the in-flight limit are put around it. */
  readonly provider: ModelProvider;
  /** `FACETDB_SECRET`: it signs the reviewers' session cookie. `worker` refuses to start without it. */
  readonly sessionSecret: string;
  /** The studio build the surface serves beside the API; absent, the API alone. */
  readonly studio?: StudioBuild;
  /**
   * Called once the surface listens, with the host it was told and the port it got: `facetdb studio`
   * opens the browser there.
   */
  readonly listening?: (host: string, port: number) => Promise<void>;
};

/** What a run hands back under `--json`: what was answered per source, and whether HTTP was served. */
export type WorkerSummary = {
  readonly ok: true;
  readonly http: { readonly host: string; readonly port: number } | null;
  readonly sources: readonly {
    readonly source: string;
    readonly answered: number;
    readonly alreadyAnswered: number;
    readonly failed: number;
  }[];
};

const OPTIONS = [
  { flags: "--config <path>", description: "the config file", defaultValue: "facetdb.config.ts" },
  {
    flags: "--port <port>",
    description: "the port of the HTTP surface (the check API and the studio's endpoints)",
    defaultValue: String(DEFAULT_PORT),
  },
  { flags: "--no-http", description: "serve nothing: a worker-only replica" },
  { flags: "--once", description: "answer what is queued, then exit" },
  {
    flags: "--studio-dir <path>",
    description:
      "the studio build to serve beside the API (a built apps/studio dist/); by default this install's own, when it is built",
  },
] as const;

export function parsePort(text: string): number {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliError(
      "port",
      `--port is a port number from 0 to 65535, not "${text}"`,
      `pass --port ${DEFAULT_PORT}, or any free port`,
      EXIT_USAGE,
    );
  }
  return port;
}

/** A host name: labels of letters, digits and hyphens, joined by dots (RFC 1123). */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * `--host`: an IPv4 or IPv6 address, or a plain host name, and nothing else. The address reaches
 * the browser opener (`facetdb studio`), and on Windows that is `cmd /c start`, which reads `&`,
 * `|`, `^` and `%` as its own syntax; refusing them here is simpler and surer than escaping them
 * there. An IPv6 zone id (`fe80::1%eth0`) is refused for the same `%`.
 */
export function parseHost(text: string): string {
  if (isIPv4(text) || (isIPv6(text) && !text.includes("%")) || HOST_NAME.test(text)) {
    return text;
  }
  throw new CliError(
    "host",
    `--host is an IP address or a host name, not "${text}"`,
    `pass --host ${DEFAULT_HOST} for this machine only, 0.0.0.0 for every interface, an IPv6 address without brackets or a zone id (::1), or a host name of letters, digits, dots and hyphens`,
    EXIT_USAGE,
  );
}

/** What one source's loops answered over the run, its restarts after a reload included. */
type Tally = {
  readonly source: string;
  answered: number;
  /** Queued again at a state already answered under this version: written again, no model call. */
  alreadyAnswered: number;
  failed: number;
};

/**
 * Builds a worker per source, serves HTTP, and runs until stopped (or once). The caller has opened
 * `parts` and closes them afterwards. The start issues no DDL and no grant: `facetdb migrate` gave
 * the worker login its rights on every store table, the heartbeats included.
 */
export async function runWorkers(
  context: CommandContext<WorkerOptions>,
  parts: WorkerParts,
): Promise<WorkerSummary> {
  const { options, deps, print } = context;
  const { config, project, store } = parts;
  const { clock } = deps;
  const port = parsePort(options.port);
  // Before anything starts: a surface open to other machines needs an account to sign in with.
  if (options.http) {
    try {
      await requireAccountToServe(options.host, store.users);
    } catch (error) {
      if (error instanceof OpenSurfaceError) {
        throw new CliError("no-account", error.message, error.fix);
      }
      throw error;
    }
  }
  const workerId = `worker-${randomUUID()}`;
  const provider = createResilientProvider(parts.provider, {
    backoff: createBackoff({ clock, random: deps.random }),
    limiter: createInFlightLimiter({ clock }),
  });
  const alerts = createAlerts({ store: store.alerts, clock, channels: [] });
  for (const note of store.migrationNotes) {
    print(`note: ${note}`);
  }
  await store.ensureProject(project);
  /** The source's id in the store: its log, versions, records and queue are keyed by it. */
  const idOf = (source: SourceConfig) => storeSourceId(project.id, source.name);
  const spending: SpendingGate = projectSpending(config, store, alerts, clock, project.id);

  /**
   * The actions a source runs after a decision: the worker's own and a reviewer's decision in the
   * studio run these same ones. None are wired yet (plugin actions come with plugins).
   */
  function actionsOf(_source: SourceConfig): readonly ActionStep[] {
    return [];
  }

  /**
   * One source's worker, under the question set and version its loop runs. The loop's worker
   * carries the alerts and `outage`, the loop's outage policy; a check call's worker (one record,
   * `forRecord`, no policy) leaves both to the loop, which answers the record if it fails.
   */
  function workerFor(
    source: SourceConfig,
    questionSet: QuestionSet,
    version: number,
    connector: Connector,
    outage: OutagePolicyHandle | undefined,
  ): Worker {
    return createWorker({
      connector,
      provider,
      log: store.log(idOf(source)),
      // The store's review queue follows this source's writes, API sources too.
      reviews: reviewsOf(store.reviews, idOf(source)),
      actions: actionsOf(source),
      clock,
      limits: {
        ...DEFAULT_WORKER_LIMITS,
        ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
      },
      questionSet,
      version,
      ...(outage !== undefined
        ? {
            alerts: alerts.signals({
              project: project.id,
              source: source.name,
              link: "https://docs.facetdb.dev/fix/worker",
            }),
            outage,
            // The loop's passes fill the run log; a check call's one record is not a pass.
            runs: { log: store.runs, source: idOf(source) },
          }
        : {}),
      spending,
    });
  }

  /**
   * Registers a source and records its question set: a new version only when the set's content
   * changed (`store.questionSets.record`), at start and when a reload restarts it.
   */
  async function start(
    source: SourceConfig,
    kind: "api" | "plugin",
    questionSet: QuestionSet,
  ): Promise<number> {
    await store.ensureSource({ projectId: project.id, name: source.name, kind });
    const recorded = await store.questionSets.record(idOf(source), questionSet);
    if (source.actions.length > 0) {
      print(
        `note: ${source.name} lists ${source.actions.length} action(s); plugin actions run once plugins are resolved (a later version), the answer columns are written meanwhile`,
      );
    }
    return recorded.version;
  }

  /** One source's loop: its version recorded, its connector opened, its worker built. */
  async function openLoop(source: SourceConfig, from: ProjectConfig): Promise<SourceLoop> {
    const questionSet = questionSetOf(from, source);
    // The loop's own policy, kept on the loop so a restart hands its held records on.
    const outage = createOutagePolicy({ onOutage: source.onOutage, clock });
    if (source.api) {
      const version = await start(source, "api", questionSet);
      const connector = store.connector({ sourceId: idOf(source), fields: source.read, workerId });
      return {
        source,
        questionSet,
        version,
        worker: workerFor(source, questionSet, version, connector, outage),
        connector,
        keyText: undefined,
        outage,
        close: () => Promise.resolve(),
      };
    }
    // Its facts for the dashboard, made once per loop (its doctor's cache with them) from the
    // source and project the loop is opened with, so Home checks the question set in force; before
    // the connector opens, since nothing connects for them and a refusal leaves nothing to close.
    const table = await parts.tableFacts(source, from);
    const connector = await parts.openTable(
      source,
      { workerId, maxConnections: WORKER_CONNECTIONS },
      from,
    );
    // Its log and versions are kept in the store under the source's name, registered as a
    // plugin-kind source, as backfill does (the store has no third kind).
    try {
      const version = await start(source, "plugin", questionSet);
      return {
        source,
        questionSet,
        version,
        worker: workerFor(source, questionSet, version, connector, outage),
        connector,
        keyText: await parts.keyTextOf?.(source),
        table,
        outage,
        close: () => connector.close(),
      };
    } catch (error) {
      await connector.close();
      throw error;
    }
  }

  /** What each source answered over the run, by name, across its restarts. */
  const tallies = new Map<string, Tally>();
  const tallyOf = (name: string): Tally => {
    const known = tallies.get(name);
    if (known !== undefined) {
      return known;
    }
    const made = { source: name, answered: 0, alreadyAnswered: 0, failed: 0 };
    tallies.set(name, made);
    return made;
  };
  const tally = (loop: SourceLoop) => (report: PassReport) => {
    const entry = tallyOf(loop.source.name);
    entry.answered += report.written.length + report.skipped.length;
    entry.alreadyAnswered += report.alreadyAnswered.length;
    entry.failed += report.failures.length;
    // Keys as the user writes them, the form `explain` reads back.
    const shown = (keys: readonly string[]) =>
      keys.map((key) => keyWords(loop.keyText, key)).join(", ");
    if (report.written.length > 0) {
      print(`${entry.source}: answered ${shown(report.written)}`);
    }
    if (report.alreadyAnswered.length > 0) {
      print(
        `${entry.source}: already answered ${shown(report.alreadyAnswered)} at this state, so the model was not asked again`,
      );
    }
    for (const failure of report.failures) {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      print(
        failure.stage === "log"
          ? `${entry.source}: the decision log could not be read: ${message}`
          : `${entry.source}: ${failure.key === null ? "the pass" : keyWords(loop.keyText, failure.key)} failed at ${failure.stage}: ${message}`,
      );
    }
  };

  // The installs the studio ran to their end, until the reload after each reads them.
  const studioInstalls = installRuns();
  // The sources as one fleet: every loop under its own stop, so a reload after Apply restarts the
  // changed ones and leaves the others running.
  const fleet = createFleet({
    open: openLoop,
    // The engine's doctor for the new source and set, under the worker login over the source's own
    // connection string, never the page's word; read by `installVerdict`. An install this worker
    // just ran to its end for this very source stands in for the rights check an engine's doctor
    // lacks (PostgreSQL's); the columns are still the doctor's to find. For a source the start did
    // not have, the facts are made here first.
    installed: async (source, from) => {
      const table = await parts.tableFacts(source, from);
      const checks = await table.doctor();
      // A database that did not answer tells nothing: the read failed, in the doctor's words, and
      // the finished install run is kept for the next reading.
      const unread = unreadCheck(checks);
      if (unread !== undefined) {
        throw new Error(unread);
      }
      return installVerdict(table.database, checks, studioInstalls.took(source, from));
    },
    removed: (source) => parts.forgetTable?.(source),
    load: () => {
      if (parts.configFile === undefined) {
        return Promise.reject(new Error("this worker has no config file to reload"));
      }
      return parts.configFile.load();
    },
    beat: (source) =>
      alerts
        .signals({ project: project.id, source, link: "https://docs.facetdb.dev/fix/worker" })
        .beat(),
    clock,
    print,
    onPass: tally,
    failure: (source, error) => installMissing(source, options.config, error),
  });
  // The studio's backfills: jobs inside this worker under the loop in force, asking through the
  // loops' provider and spending gate, over a connector of their own on the source's pool and under
  // a worker id of their own, as facetdb backfill's is: never this worker's, by which a queue in
  // the database would take a job's claims for the loop's. A whole set's records go to the loop's
  // own queue. None under --once, which exits once the queue is answered.
  const jobs = options.once
    ? undefined
    : createBackfillJobs({
        projectId: project.id,
        loop: (name) => fleet.loop(name),
        open: (loop, backfillId) =>
          parts.openTable(
            loop.source,
            { workerId: backfillId, maxConnections: WORKER_CONNECTIONS },
            // The loop's own question set: the file's model may have moved on since it opened.
            { ...fleet.config(), model: loop.questionSet.model },
          ),
        newWorkerId: () => `backfill-${randomUUID()}`,
        queue: (name) => (fleet.loop(name) === undefined ? undefined : fleet.connector(name)),
        provider,
        spending,
        clock,
        cursors: store.cursors,
        log: (name) => store.log(storeSourceId(project.id, name)),
        runs: (name) => ({ log: store.runs, source: storeSourceId(project.id, name) }),
        alerts: (name) =>
          alerts.signals({
            project: project.id,
            source: name,
            link: "https://docs.facetdb.dev/fix/backfill",
          }),
        expireAfter: deps.abortAfter,
        newToken: randomUUID,
        print,
      });
  // Apply writes the file only for a worker that runs until stopped and reads the file as it is.
  const configFile = options.once ? undefined : parts.configFile;
  // Apply and the setup flow write the one file, one write at a time.
  const writes = fileQueue();
  let listener: HttpListener | undefined;
  try {
    await fleet.open(config);
    for (const loop of fleet.loops()) {
      tallyOf(loop.source.name);
    }
    const apiSources = fleet
      .loops()
      .filter((loop) => loop.source.api)
      .map((loop) => ({ name: loop.source.name, fields: loop.source.read }));

    const outbox = createOutbox({
      client: parts.storeClient,
      clock,
      fetch: deps.webhookFetch,
      abortAfter: deps.abortAfter,
      secretFor: async (projectId, endpoint) => {
        const secret = await store.credentials.get(projectId, `webhook:${endpoint}`);
        if (secret === undefined) {
          throw new Error(`no signing secret is stored for the webhook ${new URL(endpoint).host}`);
        }
        return secret;
      },
      onGiveUp: (event) => {
        // Alert channels arrive later; the event goes to the worker's log.
        print(
          `webhook to ${event.host} given up after ${event.attempts} attempts in 24 hours (delivery ${event.deliveryId})`,
        );
        return Promise.resolve();
      },
    });

    if (options.http) {
      const app = createServer({
        store: {
          ...createCheckStore(
            store,
            apiSources.map((api) => ({ ...api, projectId: project.id })),
            workerId,
          ),
          apiKeys: store.apiKeys,
          runs: store.runs,
          users: store.users,
        },
        sessionSecret: parts.sessionSecret,
        osUser: deps.osUser,
        // Sign-ins, refusals and accounts made: names and counts, never a password.
        log: (line) => print(line),
        worker: {
          forRecord: (projectId, name, key) => {
            const loop = fleet.loop(name);
            if (loop === undefined || !loop.source.api || projectId !== project.id) {
              throw new Error(`the project ${projectId} has no API source named ${name}`);
            }
            const connector = store.connector({
              sourceId: idOf(loop.source),
              fields: loop.source.read,
              workerId,
            });
            return workerFor(
              loop.source,
              loop.questionSet,
              loop.version,
              onlyRecord(connector, key),
              undefined,
            );
          },
        },
        clock,
        // The dashboard's Home and Sources: the store's figures through the worker's own store
        // client, and each source as only this package knows it. Read on every request, so a
        // reload's versions show.
        storeDatabase: parts.storeClient,
        dashboard: {
          projectId: project.id,
          cap:
            config.spendingCap === undefined
              ? undefined
              : { inputTokens: config.spendingCap, onCapReached: config.onCapReached },
          get sources() {
            return fleet.loops().map((loop) => ({
              name: loop.source.name,
              read: loop.source.read,
              questions: loop.questionSet.questions.length,
              version: loop.version,
              table: loop.table,
            }));
          },
        },
        // The Alerts and Settings pages: where this surface listens, the channel addresses the
        // worker runs with (the config as it started; a reload keeps them until a restart), and the
        // ones the file names now, so the page can say they differ.
        host: options.host,
        alertChannels: () => config.alerts?.channels ?? [],
        fileAlertChannels: () => fleet.config().alerts?.channels ?? [],
        // The review endpoints: the store's queue, the sources the fleet runs now, and per source
        // the log, the connector, the actions and the question set and version of the loop in
        // force, all read on every call (config-reload.ts, `reviewLookups`).
        review: {
          queue: store.reviews,
          sources: () => fleet.loops().map((loop) => loop.source.name),
          ...reviewLookups(fleet, {
            idOf: (name) => storeSourceId(project.id, name),
            log: (name) => store.log(storeSourceId(project.id, name)),
            actionsOf,
          }),
          clock,
        },
        // The built studio, served after the API; without it the API alone.
        ...(parts.studio === undefined ? {} : { studioApp: parts.studio }),
        ...(jobs === undefined ? {} : { backfill: jobs }),
        // The model's backoff ceiling: by then the next attempt has been made.
        retryAfterSeconds: Math.ceil(DEFAULT_MAX_MS / 1000),
        // The studio's door to the configuration: the loader's export and judgement of the file as
        // last loaded, which only this package has, and Apply's write and reload.
        config: {
          projectId: project.id,
          json: () => toProjectJson(fleet.config()),
          validate: (draft) => judgeDraftSource(fleet.config(), draft, deps.env),
          // The sources whose loop does not run the file as last loaded.
          pending: () => fleet.pending(),
          // The Questions page's version history: what the store keeps of each source, and the
          // version its loop answers under now.
          history: {
            sources: () =>
              fleet.config().sources.map((source) => ({
                name: source.name,
                inForce: fleet.loop(source.name)?.version ?? null,
              })),
            read: (name, limit) =>
              store.questionSets.history(storeSourceId(project.id, name), limit),
          },
          ...(configFile === undefined
            ? {}
            : {
                file: configFileDoor({
                  path: configFile.path,
                  files: configFile.files,
                  load: () => configFile.load({ quiet: true }),
                  env: deps.env,
                  reload: () => fleet.reload(),
                  serial: writes,
                }),
              }),
        },
        // The studio's setup flow: a new source added with the admin connection string the operator
        // pastes on this machine, through migrate's plan and Apply's write; only a worker that
        // writes its config file offers it. The reload after its install starts the source once the
        // worker's own check holds, the run it finished counted as the rights check where the
        // engine's doctor has none.
        setup:
          configFile === undefined
            ? UNAVAILABLE_SETUP_DOOR
            : createSetupDoor({
                cli: deps,
                project,
                allowInsecureStore: options.allowInsecure === true,
                path: configFile.path,
                files: configFile.files,
                load: () => configFile.load({ quiet: true }),
                ran: (source, from) => {
                  studioInstalls.ran(source, from);
                },
                reload: () => fleet.reload(),
                serial: writes,
                provider,
                spending,
                print,
              }),
        // An added question's install from the studio: migrate's plan and run for one running
        // source, in the writes' queue, then the fleet's reload.
        migrate:
          configFile === undefined
            ? UNAVAILABLE_MIGRATE_DOOR
            : createMigrateDoor({
                cli: deps,
                project,
                allowInsecureStore: options.allowInsecure === true,
                path: configFile.path,
                load: () => configFile.load({ quiet: true }),
                running: (name) => fleet.loop(name),
                ran: (source, from) => {
                  studioInstalls.ran(source, from);
                },
                reload: () => fleet.reload(),
                serial: writes,
              }),
        // A preview reads a running source through the connector its loop holds, asks through the
        // workers' provider (backoff and the in-flight limit) and admits under their spending gate.
        preview: (name) => {
          const loop = fleet.loop(name);
          if (loop === undefined) {
            return undefined;
          }
          const { source } = loop;
          const maxStateTokens =
            source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens };
          return {
            read: source.read,
            where: source.where,
            keyText: loop.keyText,
            preview: createPreviewService({
              connector: loop.connector,
              provider,
              spending,
              log: (line) => print(`${name}: preview: ${line}`),
              clock,
              ...maxStateTokens,
            }).preview,
            // The test's "now" is what this worker runs; its reviewed records and the answers they
            // were given are in the source's log.
            current: loop.questionSet,
            testQuestionSet: createQuestionTestService({
              connector: loop.connector,
              decisions: store.log(idOf(source)),
              provider,
              spending,
              note: (line) => print(`${name}: test: ${line}`),
              clock,
              ...maxStateTokens,
            }).testQuestionSet,
          };
        },
        // The Decisions page and the why page read the store's log: the same history `facetdb
        // explain` words, by the project-scoped source id.
        decisions: {
          projectId: project.id,
          get sources() {
            return fleet.loops().map((loop) => loop.source.name);
          },
          keyText: (name) => fleet.loop(name)?.keyText,
          store: {
            search: (search) => store.searchDecisions(search),
            history: (sourceId, key) => store.log(sourceId).history(key),
            questionSets: (sourceId, versions) => store.questionSets.versions(sourceId, versions),
          },
        },
      });
      listener = await deps.serve((request, peer) => app.fetch(request, peer), port, options.host);
      const address = `http://${hostInUrl(options.host)}:${listener.port}`;
      print(
        parts.studio === undefined
          ? `Serving the check API and the studio's endpoints on ${address}.`
          : `Serving the studio, its endpoints and the check API on ${address}.`,
      );
      await parts.listening?.(options.host, listener.port);
    }

    if (options.once) {
      for (const loop of fleet.loops()) {
        const onPass = tally(loop);
        // Pass after pass until the queue is empty, or a pass settles nothing (a record that keeps
        // failing goes back to the queue; it is not asked again in the same run).
        for (;;) {
          let report: PassReport;
          try {
            report = await loop.worker.runOnce();
          } catch (error) {
            throw installMissing(loop.source.name, options.config, error);
          }
          onPass(report);
          const settled =
            report.written.length +
            report.skipped.length +
            report.alreadyAnswered.length +
            report.gone.length +
            report.held.length +
            report.refused.length +
            report.discarded.length;
          if (report.claimed === 0 || settled === 0 || report.paused) {
            break;
          }
        }
      }
      printAlertFailures(await outbox.deliverDue(clock.now()), print);
    } else {
      // One loop failing (its database gone, say) stops the others too, so every claim is settled
      // before the connectors close; the first failure is what the run reports (the fleet's run
      // throws it once every loop has stopped).
      const stopped = deps.stopSignal();
      const stopAll = new AbortController();
      const signal = AbortSignal.any([stopped, stopAll.signal]);
      const names = fleet.loops().map((loop) => loop.source.name);
      print(
        names.length === 0
          ? "Worker running with no source to answer (none is installed). Press Ctrl+C to stop."
          : `Worker running for ${names.join(", ")}. Press Ctrl+C to stop.`,
      );
      const loops = await Promise.allSettled([
        fleet.run(signal).catch((error: unknown) => {
          stopAll.abort();
          throw error;
        }),
        deliverUntil(signal, () => outbox.deliverDue(clock.now()), clock, print),
        // A backfill job stops after its page in hand when the worker does.
        ...(jobs === undefined ? [] : [jobs.until(signal)]),
      ]);
      const failed = loops.find((loop) => loop.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
      print("Stopped: every claim was settled.");
    }
    for (const entry of tallies.values()) {
      print(
        `${entry.source}: answered ${entry.answered}, already answered ${entry.alreadyAnswered}, failed ${entry.failed}`,
      );
    }
  } finally {
    await listener?.close();
    // Before the connectors and the store close: every job's page in hand settled and saved.
    await jobs?.close();
    await fleet.close();
  }
  return {
    ok: true,
    http: listener === undefined ? null : { host: options.host, port: listener.port },
    sources: [...tallies.values()].map(({ source, answered, alreadyAnswered, failed }) => ({
      source,
      answered,
      alreadyAnswered,
      failed,
    })),
  };
}

/**
 * The outbox's own loop: deliver what is due, wait, again, until the signal aborts. A give-up
 * alert that could not be raised is printed, every one: once real alert channels exist, this line
 * is the only trace of an alert that never went out.
 */
export async function deliverUntil(
  signal: AbortSignal,
  deliver: () => Promise<Pick<DeliveryReport, "alertFailures">>,
  clock: { sleep(ms: number): Promise<void> },
  print: (text: string) => void,
): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
  while (!signal.aborted) {
    try {
      printAlertFailures(await deliver(), print);
    } catch (error) {
      print(`webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Promise.race([clock.sleep(OUTBOX_EVERY_MS), aborted]);
  }
}

/** Every give-up alert of a delivery pass that could not be raised, one line each, none dropped. */
function printAlertFailures(
  report: Pick<DeliveryReport, "alertFailures">,
  print: (text: string) => void,
): void {
  for (const failure of report.alertFailures) {
    print(alertFailureLine(failure));
  }
}

/** One alert that did not go out, in plain words: which webhook, why, and what happens next. */
function alertFailureLine({ event, error, final }: AlertFailure): string {
  const reason = error instanceof Error ? error.message : String(error);
  const attempts = `${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`;
  return `webhook to ${event.host} (delivery ${event.deliveryId}) was given up after ${attempts} in 24 hours, and its alert could not be raised: ${reason}. ${
    final
      ? "That was the alert's last try: the webhook is closed, and this line is its only alert."
      : "FacetDB tries the alert once more on the webhook's next attempt; the webhook itself is not sent again."
  }`;
}

/**
 * The database's own codes for a table or a column that is not there: Postgres's SQLSTATE 42P01
 * and 42703, MySQL's and MariaDB's. A loop meets one when the source's install never ran, when a
 * column of the customer's own table was dropped or renamed under it, when `where` names a column
 * that does not exist, or when a separate store was never migrated: the words say only what is
 * true of all of them.
 */
const MISSING_OBJECT = new Set(["42P01", "42703", "ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"]);

/**
 * A loop's failure as the run reports it: one on a missing table or column names the source and how
 * to find out which, the database's words kept; anything else is left as it is. The worker starts
 * as it always did: nothing is checked before the first claim.
 */
export function installMissing(source: string, configPath: string, error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code !== "string" || !MISSING_OBJECT.has(code)) {
    return error;
  }
  const said = error instanceof Error ? error.message : String(error);
  return new CliError(
    "missing-object",
    `the source "${source}" stopped: a table or a column it uses is not there (${said})`,
    `run facetdb migrate --source ${source} --dry-run on this machine to see what the install is missing, then facetdb migrate --source ${source}; or, if a column of your own table was renamed or dropped, change read or where for "${source}" in ${configPath}`,
  );
}

/** Without a model the worker would only fail: it refuses to start, and says what to set. */
export function requireModel(
  config: ProjectConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const key = env["TYPESAFE_API_KEY"];
  if (config.modelUrl === undefined && (key === undefined || key === "")) {
    throw new CliError(
      "model-key",
      "TYPESAFE_API_KEY is not set, so the worker has no model to ask",
      "set TYPESAFE_API_KEY to your TypeSafe API key (or set modelUrl in facetdb.config.ts for a compatible server), then run facetdb worker again; facetdb dev answers offline without one",
    );
  }
}

/** A host as an address writes it: an IPv6 one in brackets. */
export function hostInUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** A studio build to serve, and the directory it was found in (for the words). */
export type ServedStudio = { readonly dir: string; readonly build: StudioBuild };

/**
 * The build in `dir` (relative to the project directory), or undefined when it holds none. The
 * surface reads it through the install's door from then on.
 */
async function openBuild(deps: CliDeps, dir: string): Promise<ServedStudio | undefined> {
  const absolute = resolve(deps.projectDir, dir);
  const build = await openStudioBuild(deps.studio.files(absolute));
  return build === undefined ? undefined : { dir: absolute, build };
}

/**
 * No build where one was asked for: say how to make it (the server never starts Vite). `dir` is
 * undefined in an install with no studio package, `named` when `--studio-dir` gave it.
 */
export function notBuilt(dir: string | undefined, named: boolean): CliError {
  if (dir === undefined) {
    return new CliError(
      "studio-not-built",
      "this install of facetdb holds no studio to serve",
      "run pnpm build in the FacetDB repository, then pass --studio-dir with the apps/studio/dist directory it made",
    );
  }
  return new CliError(
    "studio-not-built",
    `${dir} holds no studio build (an index.html and a routes.json from vite build)`,
    named
      ? "run pnpm build in the FacetDB repository and pass --studio-dir the apps/studio/dist directory it made, or leave --studio-dir out to serve this install's own"
      : `run pnpm build in the FacetDB repository (it builds the studio into ${dir}), then run this command again`,
  );
}

/**
 * The studio `facetdb studio` serves: the build `--studio-dir` names, else the install's own;
 * refused when there is none, since serving it is the command's whole point.
 */
export async function requiredStudio(
  deps: CliDeps,
  studioDir: string | undefined,
): Promise<ServedStudio> {
  const dir = studioDir ?? deps.studio.defaultDir;
  if (dir === undefined) {
    throw notBuilt(undefined, false);
  }
  const served = await openBuild(deps, dir);
  if (served === undefined) {
    throw notBuilt(resolve(deps.projectDir, dir), studioDir !== undefined);
  }
  return served;
}

/**
 * The studio `facetdb worker` and `facetdb dev` serve beside the API: the build `--studio-dir`
 * names, refused when it holds none (it was asked for); else the install's own when it is built,
 * and the API alone otherwise, said once. Under `--no-http` nothing is served, and a `--studio-dir`
 * given anyway is said to be unused, on stderr so `--json` keeps it.
 */
export async function workerStudio(
  deps: CliDeps,
  options: { readonly http: boolean; readonly studioDir?: string | undefined },
  print: (text: string) => void,
): Promise<ServedStudio | undefined> {
  const { studioDir } = options;
  if (!options.http) {
    if (studioDir !== undefined) {
      deps.io.stderr(
        `note: --studio-dir ${studioDir} is unused under --no-http, which serves nothing\n`,
      );
    }
    return undefined;
  }
  if (studioDir !== undefined) {
    return requiredStudio(deps, studioDir);
  }
  const dir = deps.studio.defaultDir;
  const served = dir === undefined ? undefined : await openBuild(deps, dir);
  if (served === undefined) {
    print(
      "note: the studio is not built, so only the API is served; run pnpm build in the FacetDB repository to serve it here too",
    );
  }
  return served;
}

/**
 * The worker as a process: the store and every table source opened from the environment, then
 * `runWorkers` until stopped. `facetdb worker` runs it, and `facetdb studio` runs it with the
 * studio and the browser opened.
 */
export async function runWorkerProcess(
  context: CommandContext<WorkerOptions>,
  config: ProjectConfig,
  surface: Pick<WorkerParts, "listening"> & { readonly studio: ServedStudio | undefined },
): Promise<WorkerSummary> {
  const { options, deps } = context;
  const storeUrl = deps.env[STORE_VARIABLE] ?? "";
  const allowInsecure = options.allowInsecure === true;
  const project = projectRef(deps.projectDir);
  // Before the store opens or anything connects: no worker password in the clear to another
  // machine, by the store door's rule for the store and each source's engine for its own URL.
  if (storeUrl !== "") {
    requireUsableStoreUrl(storeUrl, allowInsecure, deps.env["PGHOST"]);
  }
  /**
   * What the start makes of a table source, once: its connection string from its variable, its
   * engine by the string's scheme, the string's check (no password in the clear to another machine)
   * and whether it shares the store's pool. A reload makes the same for a source the start did not
   * have, with the same checks, and drops it when the source goes; a source whose connection,
   * engine choice or table differ from the entry's is made anew.
   */
  type TableEntry = {
    /** The fields the entry was made from. */
    readonly madeOf: string;
    /** Under the source's question set in `from`: a reload opens it anew with the new one. */
    readonly open: (
      source: SourceConfig,
      from: ProjectConfig,
      workerId: string,
      maxConnections: number,
    ) => Promise<OpenConnector>;
    readonly keyText: () => Promise<KeyText | undefined>;
    /** Its facts and doctor for the source and question set of `from`. */
    readonly facts: (opened: SourceConfig, from: ProjectConfig) => TableFacts;
  };
  const madeOf = (source: SourceConfig): string =>
    JSON.stringify([source.database, source.databaseEnv, source.connector, source.table]);
  const tables = new Map<string, TableEntry>();
  async function tableOf(source: SourceConfig): Promise<TableEntry> {
    const known = tables.get(source.name);
    if (known !== undefined && known.madeOf === madeOf(source)) {
      return known;
    }
    const table = source.table;
    if (table === undefined) {
      throw new Error(`the source ${source.name} reads no table`);
    }
    const url = sourceUrlOf(
      source,
      "the worker login's connection string (postgres://facetdb_worker:…@host/db)",
    );
    const engine = await engineFor(deps.engines, url, source.connector);
    // The target of the string's check: its question set does not bear on it.
    const target = engineTarget(config, { source, ...splitTable(table) }, project);
    requireUsableUrl(engine, target, url, allowInsecure);
    const storeShared = storeSharedFor(deps.env, source);
    const made: TableEntry = {
      madeOf: madeOf(source),
      // The type its database records for its keys, read once the table opened.
      keyText: () => tableKeyText(engine, target, url, allowInsecure),
      facts: (opened, from) =>
        tableFacts({
          engine,
          target: engineTarget(from, { source: opened, ...splitTable(table) }, project),
          url,
          source: opened,
          deps: { clock: deps.clock, allowInsecure, storeShared },
        }),
      // The connection is the one checked above: a reload restarts a source only when its
      // table, database and install are unchanged (config-reload.ts), so only the question set moves.
      open: (opened, from, workerId, maxConnections) =>
        openConnector(
          engine,
          engineTarget(from, { source: opened, ...splitTable(table) }, project),
          url,
          { clock: deps.clock, allowInsecure, storeShared, workerId, maxConnections },
        ),
    };
    tables.set(source.name, made);
    return made;
  }
  // Every table source of the start, checked before the store opens or anything connects.
  for (const source of config.sources) {
    if (source.table !== undefined) {
      await tableOf(source);
    }
  }
  // One pool for the store, the outbox, and every table source on the store's own database (the
  // usual single DATABASE_URL): see WORKER_CONNECTIONS for the count. The composition root's
  // connect lends it to the engine's connector of such a source (cli/pools.ts); the store's
  // borrower closes nothing. The session cookie is signed under the store's secret: refused here,
  // in the store door's words, before the store opens or the surface could start.
  const sessionSecret = requireStoreSecret(deps.env);
  const storeClient = deps.connect(storeUrl, { max: WORKER_CONNECTIONS });
  const borrowed = (): StoreClient => ({ ...storeClient, close: () => Promise.resolve() });
  try {
    const store = await deps.store({
      allowInsecure,
      connect: borrowed,
      // A reviewer account whose stored hash cannot be read cannot sign in: say so where the
      // operator looks (the hash itself is never in the line).
      warn: (message) => deps.io.stderr(`warning: ${message}\n`),
    });
    try {
      return await runWorkers(context, {
        config,
        project,
        store,
        storeClient,
        openTable: async (source, open, from) =>
          (await tableOf(source)).open(source, from, open.workerId, open.maxConnections),
        // Apply writes the file this worker loaded, and the worker reloads it.
        configFile: {
          path: options.config,
          load: (load) => deps.loadConfig(options.config, load),
          files: deps.configFiles,
        },
        keyTextOf: async (source) => (await tableOf(source)).keyText(),
        tableFacts: async (source, from) => (await tableOf(source)).facts(source, from),
        forgetTable: (source) => {
          tables.delete(source.name);
        },
        provider: deps.provider(config),
        sessionSecret,
        ...(surface.studio === undefined ? {} : { studio: surface.studio.build }),
        ...(surface.listening === undefined ? {} : { listening: surface.listening }),
      });
    } finally {
      await store.close();
    }
  } finally {
    await storeClient.close();
  }
}

/** `--host`, as the worker and the studio take it (this machine by default). */
export const HOST_OPTION = {
  flags: "--host <address>",
  description:
    "the address the HTTP surface listens on: this machine only by default; any other address needs a reviewer account first (facetdb users add <name>)",
  defaultValue: DEFAULT_HOST,
} as const;

export const workerCommand = defineCommand<WorkerOptions>("worker", {
  description:
    "Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API and the studio; run it next to the database, in the same region, because every record costs a few round trips to it",
  options: [...OPTIONS, HOST_OPTION, ALLOW_INSECURE_OPTION],
  run: async (context) => {
    const { options, deps, print } = context;
    const config = await loadProjectConfig(deps, options.config);
    requireModel(config, deps.env);
    parsePort(options.port);
    parseHost(options.host);
    const studio = await workerStudio(deps, options, print);
    if (options.dryRun) {
      const served =
        studio === undefined
          ? "the check API and the studio's endpoints"
          : `the studio from ${studio.dir}, its endpoints and the check API`;
      print(
        `Would answer ${config.sources.map((source) => source.name).join(", ")}${options.http ? ` and serve ${served} on ${options.host}, port ${options.port}` : ""}. Dry run: nothing was started.`,
      );
      return { ok: true, dryRun: true };
    }
    return runWorkerProcess(context, config, { studio });
  },
});

export const WORKER_OPTIONS = OPTIONS;
