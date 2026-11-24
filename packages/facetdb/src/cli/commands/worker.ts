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
  createWorkerWatch,
  DEFAULT_WORKER_LIMITS,
  type HeldModel,
  holdModel,
  type KeyText,
  knownZone,
  type ModelProvider,
  type OpenConnector,
  type PassReport,
  processZone,
  type QuestionSet,
  reviewsOf,
  type SpendingGate,
  type SummaryReport,
  type Worker,
  type WorkerWatchStep,
  withoutProbe,
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
  type CredentialAlertFailure,
  createCheckStore,
  createOutbox,
  createServer,
  credentialRefusedAlert,
  credentialRefusedKey,
  credentialSubject,
  DeliveryPassFailed,
  type DeliveryReport,
  gaveUpAlert,
  gaveUpHow,
  gaveUpSubject,
  hideSecrets,
  OpenSurfaceError,
  onlyRecord,
  openStudioBuild,
  operatorKnownByAddress,
  outboxQueue,
  queueAction,
  requireAccountToServe,
  type SecretPart,
  type StudioBuild,
  secretParts,
  type TableFacts,
} from "@facetdb/server";
import {
  type ConfigFiles,
  judgeDraftSource,
  type ProjectConfig,
  pluginProviderOf,
  type SourceConfig,
  toProjectJson,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  type ActionSource,
  actionSteps,
  bindChannels,
  channelsOf,
  checkPluginProvider,
  checkSourceActions,
  createActionRunner,
  createDigestRunner,
  createPluginSourceConnector,
  createSettingsInForce,
  deliveryFailureLine,
  draftPlugins,
  type HostedSource,
  hostedSource,
  livePluginHost,
  type PluginHost,
  PluginHostError,
  PluginProviderError,
  printableKey,
  summaryFailureLine,
  summaryUnmarkedLine,
  type WebhookOutbox,
  webhookAllowsPrivate,
  webhookRefusal,
  webhookSecret,
  withOutbox,
} from "../../plugin/index.ts";
import {
  capOf,
  type ProjectSpendingSettings,
  pluginBackfillConnector,
  spendingUnder,
} from "../backfill-wiring.ts";
import { engineFor, keyWords, openConnector, requireUsableUrl, tableKeyText } from "../engines.ts";
import { alertScope, createLinks, hostInUrl, servedStudioUrl } from "../links.ts";
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
import { createAlertRaisers, type WatchedSource } from "./alert-raisers.ts";
import { createBackfillJobs } from "./backfill-jobs.ts";
import { bindWords } from "./bind-words.ts";
import {
  configFileDoor,
  createFleet,
  failureWords,
  fileQueue,
  reviewLookups,
  type SourceLoop,
} from "./config-reload.ts";
import { tableFacts } from "./dashboard-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  engineTarget,
  loadWorkerConfig,
  type ProjectRef,
  projectRef,
  questionSetOf,
  sourceUrlOf,
  splitTable,
} from "./database.ts";
import { createHooksDoor, hooklessNotes } from "./hooks-door.ts";
import { installRuns, readInstall } from "./install-check.ts";
import { createMigrateDoor, UNAVAILABLE_MIGRATE_DOOR } from "./migrate-door.ts";
import { presetKeyOf } from "./model-provider.ts";
import { createPluginsDoor, registryAddress } from "./plugins-door.ts";
import {
  createSetupDoor,
  type DoorDatabases,
  registeredDatabases,
  UNAVAILABLE_SETUP_DOOR,
} from "./setup-door.ts";

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

/** What failed, in the words of the line a worker prints when its heartbeat or its look at the others does. */
const WATCH_FAILURES: Readonly<Record<WorkerWatchStep, string>> = {
  clean: "the rows of workers that stopped before this one could not be cleared",
  save: "this worker's row could not be saved",
  remove: "this worker's row could not be removed",
  check: "the other workers' rows could not be read",
  alert: "the alert for a worker that stopped could not be raised",
};

function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** The fewest connections a worker runs on: one lane, the LISTEN connection and one for the rest. */
const LEAST_CONNECTIONS = 3;

/** `--connections` as a count: a whole number from 3 up; the lanes shrink to fit under it. */
export function parseConnections(text: string): number {
  const count = Number(text);
  if (!Number.isInteger(count) || count < LEAST_CONNECTIONS || count > 1_000) {
    throw new CliError(
      "connections",
      `--connections is a whole number of connections from ${LEAST_CONNECTIONS} to 1000, not "${text}"`,
      `pass --connections ${WORKER_CONNECTIONS} (the default), or 6 under a Supabase session pooler`,
      EXIT_USAGE,
    );
  }
  return count;
}

/** The connections this run holds per database: the flag, else FACETDB_CONNECTIONS, else the default. */
export function connectionsOf(
  options: Pick<WorkerOptions, "connections">,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const given = options.connections ?? env["FACETDB_CONNECTIONS"];
  return given === undefined || given === "" ? WORKER_CONNECTIONS : parseConnections(given);
}

/**
 * The loop's limits under a connection budget: the lanes in flight never exceed what the pool can
 * hold beside the LISTEN connection and one more, so a smaller budget slows a loop rather than
 * starving it of a connection mid-batch.
 */
export function limitsFor(connections: number): typeof DEFAULT_WORKER_LIMITS {
  return {
    ...DEFAULT_WORKER_LIMITS,
    maxInFlight: Math.min(DEFAULT_WORKER_LIMITS.maxInFlight, connections - 2),
  };
}

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
  /**
   * `--connections <n>` (or FACETDB_CONNECTIONS): the connections this worker may hold open on each
   * database, the store's pool and every connector's; the loop's lanes fit inside it. Set it under
   * a pooler that counts every session of the worker login (a Supabase session pooler allows 15 per
   * login and database): a real run hit its limit with one studio and its backfill beside a process
   * just closed, and the pass's failure stopped the studio.
   */
  readonly connections?: string;
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
   * The config file the studio's Apply writes and the worker reloads; `dev` gives it too, reading
   * every source's string as its embedded database. Dropped under `--once`.
   */
  readonly configFile?: {
    /** As `--config` names it. */
    readonly path: string;
    /** The loader over that file; `quiet` keeps its wording warnings unprinted. */
    readonly load: (options?: { readonly quiet?: boolean }) => Promise<ProjectConfig>;
    readonly files: ConfigFiles;
  };
  /**
   * The databases the studio's setup and migrate doors reach: the registered engines by scheme
   * under `worker`, dev's one embedded database under `dev`.
   */
  readonly databases: DoorDatabases;
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
   * anew. Absent in `dev`, which keeps nothing per source.
   */
  readonly forgetTable?: (source: SourceConfig) => void;
  /** The model, before the backoff and the in-flight limit are put around it. */
  readonly provider: ModelProvider;
  /** `FACETDB_SECRET`: it signs the reviewers' session cookie. `worker` refuses to start without it. */
  readonly sessionSecret: string;
  /** The studio build the surface serves beside the API; absent, the API alone. */
  readonly studio?: StudioBuild;
  /**
   * The plugins the config names, as the host loaded them at the start: the Plugins page's
   * installed plugins and packs, and every source's actions. A reload never imports a plugin again;
   * it settles the ones loaded here again under a changed `plugins` entry and puts them in force,
   * and refuses a plugin the start did not load.
   */
  readonly plugins: PluginHost;
  /**
   * Called once the surface listens, with the host it was told and the port it got: `facetdb studio`
   * opens the browser there.
   */
  readonly listening?: (host: string, port: number) => Promise<void>;
  /**
   * `dev`: this machine's user stays the operator whatever the config's `studioUrl` says, since dev
   * serves 127.0.0.1 alone under a secret its source code may publish. Absent, a `studioUrl` on
   * another host means nobody is the operator by address and every visitor signs in.
   */
  readonly operatorByAddress?: true;
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
  // The budget per database: the store's pool (opened by the process's caller with the same
  // figure), every connector's and the backfill's, the lanes fitting inside it.
  const connections = connectionsOf(options, deps.env);
  const port = parsePort(options.port);
  // The studioUrl that decides who is the operator by address; dev keeps its OS user.
  const accessUrl = parts.operatorByAddress === true ? undefined : config.studioUrl;
  // Before anything starts: a surface open to other machines needs an account to sign in with.
  if (options.http) {
    try {
      await requireAccountToServe({ host: options.host, studioUrl: accessUrl }, store.users);
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
  // The built-in webhook's deliveries, a decision's and an alert's, are queued in the store's
  // outbox for this project; the outbox's loop below signs and sends them.
  const webhooks: WebhookOutbox = {
    projectId: project.id,
    outbox: outboxQueue(parts.storeClient, clock),
  };
  /**
   * The plugins as everything that runs one reads them, each call the host in force: the start's,
   * then each reload's that put a plugin's changed settings in force.
   */
  const plugins = livePluginHost(parts.plugins);
  /** The channels of `from` bound to the plugins of `host`, delivering through this process. */
  const bindFor = (from: ProjectConfig, host: PluginHost) =>
    bindChannels({
      config: from,
      host: withOutbox(host, webhooks),
      env: deps.env,
      clock,
      stop: deps.stopSignal,
    });
  // Every alert of this process goes to the channels the config names, bound to their plugins when
  // the config loaded (`loadWorkerConfig` refused any it could not bind). A channel that fails is a
  // printed line and a line of the alert's history, never a stopped pass. A reload binds them again
  // and hands them over (`settings` below), or keeps these and says why.
  const alerts = createAlerts({
    store: store.alerts,
    clock,
    channels: bindFor(config, parts.plugins),
    report: (failure) => print(deliveryFailureLine(failure)),
  });
  /**
   * The channels and plugin settings in force, which a reload replaces with the file's when they
   * bind and settle, restarting the sources of a plugin whose settings changed.
   */
  const settings = createSettingsInForce({
    config,
    host: plugins,
    env: deps.env,
    coreVersion: VERSION,
    projectDir: deps.projectDir,
    bind: bindFor,
    rebind: (bound) => alerts.rebind(bound),
    machineZone: processZone,
  });
  for (const note of store.migrationNotes) {
    print(`note: ${note}`);
  }
  await store.ensureProject(project);
  /** The source's id in the store: its log, versions, records and queue are keyed by it. */
  const idOf = (source: SourceConfig) => storeSourceId(project.id, source.name);
  /**
   * The project's spending settings in force: the file's at start, then each reload's (the fleet's
   * `project` hook), so a cap saved from Settings is enforced at the gate's next check and Home
   * shows it, with no restart. The model URL still takes a restart: the reload's notes say so.
   */
  let projectInForce: ProjectSpendingSettings = config;
  /**
   * The address this process serves the studio on, set once the surface listens and only when a
   * studio build is served; every link an alert carries is built by `links`.
   */
  let servedStudio: string | undefined;
  const links = createLinks({ configured: config.studioUrl, served: () => servedStudio });
  const spending: SpendingGate = spendingUnder(
    () => capOf(projectInForce),
    store,
    alerts,
    clock,
    project.id,
    links.spendingCap,
  );

  /**
   * The actions a source runs after a decision: the worker's own and a reviewer's decision in the
   * studio run these same ones. Each queues its row in the store's outbox, and the outbox's loop
   * below runs the plugin. The row is queued after the decision's write, never in its transaction:
   * the write is the connector's, on the source's own database, and the outbox is the store's. The
   * job is acked only once every step queued its row: a crash in between, or a row the store did
   * not take (core's `ActionNotQueued`), leaves the job queued, and the next pass, a poll later,
   * writes the logged decision again with no model call and queues the rows again. A built-in
   * webhook's row names its decision, so that second queueing adds no second delivery.
   */
  function actionsOf(source: SourceConfig): readonly ActionStep[] {
    return actionSteps(
      source,
      (row) =>
        queueAction(parts.storeClient, clock, {
          projectId: project.id,
          sourceId: idOf(source),
          ...row,
        }),
      { ...webhooks, sourceId: idOf(source) },
    );
  }

  /**
   * One source's worker, under the question set and version its loop runs. The loop's worker
   * carries the alerts and `outage`, the loop's outage policy; a check call's worker (one record,
   * `forRecord`, no policy) leaves both to the loop, which answers the record if it fails. Both
   * check the model through the loop's `heldModel`.
   */
  function workerFor(
    source: SourceConfig,
    questionSet: QuestionSet,
    version: number,
    heldModel: HeldModel,
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
        ...limitsFor(connections),
        ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
      },
      questionSet,
      version,
      heldModel,
      ...(outage !== undefined
        ? {
            alerts: alerts.signals(alertScope(project.id, source.name, links.model)),
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
   * changed (`store.questionSets.record`), at start and when a reload restarts it. The set in force
   * is written apart, by `inForce`, once the whole loop has opened. The loop's hold is read here,
   * before its first claim: a source another worker holds opens held.
   */
  async function start(
    source: SourceConfig,
    kind: "api" | "plugin" | "plugin-source",
    questionSet: QuestionSet,
  ): Promise<{ readonly version: number; readonly heldModel: HeldModel }> {
    await store.ensureSource({ projectId: project.id, name: source.name, kind });
    const { version } = await store.questionSets.record(idOf(source), questionSet);
    const heldModel = await holdModel(store.questionSets, idOf(source), version, clock);
    return { version, heldModel };
  }

  /**
   * The whole set as the opened loop runs it (`run`, store migration 8): the version's row keeps
   * only what its content hash sees, and `facetdb review` judges cards by what the worker runs, so
   * a threshold or where filter changed with a restart must reach the store. Written as the open's
   * last step: an open that fails before it leaves the row on the set the old loop still runs, and
   * after it the fleet only puts the loop in place (`openAnew` and the swap fail on nothing; a
   * worker stopping meanwhile runs no loop at all, and its next start writes the row again). A
   * reload that keeps a loop reopens nothing, and its row rightly stays what it was.
   */
  async function inForce(loop: SourceLoop): Promise<SourceLoop> {
    const before = await store.questionSets.run(idOf(loop.source), loop.version, loop.questionSet);
    // A version higher than the one the source ran raises Question set changed, off the open's
    // path; of two workers opening it at once, one is told of the old version.
    raisers.started(loop.source, loop.questionSet, loop.version, before);
    return loop;
  }

  /** One source's loop: its version recorded, its connector opened, its worker built. */
  async function openLoop(source: SourceConfig, from: ProjectConfig): Promise<SourceLoop> {
    // Its actions against the plugins this worker loaded, before anything opens: a reload whose
    // `actions` changed restarts the loop with the new steps, or keeps the old loop and says why.
    checkSourceActions(from, source, plugins, deps.env);
    const questionSet = questionSetOf(from, source);
    // The loop's own policy, kept on the loop so a restart hands its held records on.
    const outage = createOutagePolicy({ onOutage: source.onOutage, clock });
    if (source.api) {
      const { version, heldModel } = await start(source, "api", questionSet);
      const connector = store.connector({ sourceId: idOf(source), fields: source.read, workerId });
      return inForce({
        source,
        questionSet,
        version,
        heldModel,
        worker: workerFor(source, questionSet, version, heldModel, connector, outage),
        connector,
        keyText: undefined,
        outage,
        close: () => Promise.resolve(),
      });
    }
    if (source.source !== undefined) {
      return openPluginSource(source, from, questionSet, outage);
    }
    // Its facts for the dashboard, made once per loop (its doctor's cache with them) from the
    // source and project the loop is opened with, so Home checks the question set in force; before
    // the connector opens, since nothing connects for them and a refusal leaves nothing to close.
    const table = await parts.tableFacts(source, from);
    const connector = await parts.openTable(
      source,
      { workerId, maxConnections: connections },
      from,
    );
    // Its log and versions are kept in the store under the source's name, registered as a
    // plugin-kind source, as backfill does (the store has no third kind).
    try {
      const { version, heldModel } = await start(source, "plugin", questionSet);
      return await inForce({
        source,
        questionSet,
        version,
        heldModel,
        worker: workerFor(source, questionSet, version, heldModel, connector, outage),
        connector,
        keyText: await parts.keyTextOf?.(source),
        table,
        outage,
        close: () => connector.close(),
      });
    } catch (error) {
      await connector.close();
      throw error;
    }
  }

  /**
   * The plugin source of `source`, checked against the plugins this worker loaded, or why it cannot
   * run here, as the CLI's own refusal: a plugin the worker did not load, a source it lacks, a
   * variable unset or settings its schema refuses. No wait mends one, so a loop it stops is not
   * tried again until Check again or a restart.
   */
  function pluginSourceOf(source: SourceConfig, from: ProjectConfig): HostedSource {
    try {
      return hostedSource(plugins, from, source, deps.env);
    } catch (error) {
      if (error instanceof PluginHostError) {
        throw new CliError(error.code, error.message, error.fix);
      }
      throw error;
    }
  }

  /**
   * A plugin source's loop: registered in the store as a `plugin-source`, its records, queue, log
   * and review cards the store's, through the adapter over the store's connector. The plugin's
   * `watch` runs from the loop's first wait until its close, which stops it; under `--once` the
   * loop never waits, so it answers what is queued and the pump never starts.
   */
  async function openPluginSource(
    source: SourceConfig,
    from: ProjectConfig,
    questionSet: QuestionSet,
    outage: OutagePolicyHandle,
  ): Promise<SourceLoop> {
    const hosted = pluginSourceOf(source, from);
    // The loop reads its plugin with the settings in force when it opened, to its close: a reload
    // that changes them restarts it, and the batch in hand finishes on these.
    const opened = plugins.current();
    const { version, heldModel } = await start(source, "plugin-source", questionSet);
    const connector = createPluginSourceConnector({
      store: store.connector({ sourceId: idOf(source), fields: source.read, workerId }),
      name: source.name,
      hosted,
      context: (signal) => opened.contextFor(hosted.packageName, signal),
      fields: source.read,
      clock,
      cursors: store.cursors,
      cursorRun: `plugin-source:${idOf(source)}`,
      note: (line) => print(`${source.name}: ${line}`),
    });
    // A read through the plugin that answered resolves its lost access at the next look.
    connector.onWorking(() => raisers.proven(source.name));
    try {
      return await inForce({
        source,
        questionSet,
        version,
        heldModel,
        worker: workerFor(source, questionSet, version, heldModel, connector, outage),
        connector,
        keyText: undefined,
        outage,
        plugin: {
          packageName: hosted.packageName,
          entry: hosted.entry,
          settings: hosted.settings,
          variables: hosted.variables,
        },
        // Its store answers a pass whatever its plugin does: only a read through the plugin that
        // answered starts its backoff over after a failure.
        proven: (heard) => connector.onWorking(heard),
        // A webhook delivery the HTTP surface hands this source (hooks-door.ts).
        receive: (request, caller) => connector.receive(request, caller),
        close: () => connector.close(),
      });
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
    // Keys as the user writes them, the form `explain` reads back; a plugin's key is the plugin's
    // text, printed with no control or format character and cut short.
    const keyOf = (key: string) =>
      loop.plugin === undefined ? keyWords(loop.keyText, key) : printableKey(key);
    const shown = (keys: readonly string[]) => keys.map(keyOf).join(", ");
    if (report.written.length > 0) {
      print(`${entry.source}: answered ${shown(report.written)}`);
    }
    if (report.alreadyAnswered.length > 0) {
      print(
        `${entry.source}: already answered ${shown(report.alreadyAnswered)} at this state, so the model was not asked again`,
      );
    }
    if (report.waiting.length > 0) {
      // The source is held by a changed model; the failure line above says which.
      print(
        `${entry.source}: ${report.waiting.length} more waiting unasked while the model is changed; one record is asked every 5 minutes`,
      );
    }
    for (const failure of report.failures) {
      // A driver's words can quote a connection string.
      const message = hideSecrets(
        failure.error instanceof Error ? failure.error.message : String(failure.error),
        secretsInForce(),
      );
      print(
        failure.stage === "log"
          ? `${entry.source}: the decision log could not be read: ${message}`
          : `${entry.source}: ${failure.key === null ? "the pass" : keyOf(failure.key)} failed at ${failure.stage}: ${message}`,
      );
    }
  };

  /**
   * The parts of every connection string a driver's words may name (the store's, each source's of
   * the file in force, so one a reload added is hidden too): hidden from every printed line and
   * every alert that carries words a database gave.
   */
  const secretsInForce = (): readonly SecretPart[] =>
    [deps.env[STORE_VARIABLE], ...fleet.config().sources.map((source) => source.database)]
      .filter((url): url is string => url !== undefined && url !== "")
      .flatMap((url) => secretParts(url));
  // Connector lost access, read every 5 minutes from each running table source's doctor and raised
  // at a loop's refused login or credential, and Question set changed at an open.
  const raisers = createAlertRaisers({
    alerts,
    active: (key) => store.alerts.getActive(key),
    clock,
    project: project.id,
    links: { access: links.access, stopped: links.stopped, questionSet: links.questionSet },
    sources: () =>
      fleet.loops().flatMap((loop): WatchedSource[] => {
        const { table } = loop;
        if (loop.plugin !== undefined) {
          return [{ kind: "plugin", name: loop.source.name }];
        }
        return table === undefined
          ? []
          : [{ kind: "table", name: loop.source.name, doctor: () => table.doctor() }];
      }),
    // Home's door's stopped sources, each raised again at the look.
    stoppedSources: () =>
      fleet.stopped().map((entry) => ({
        source: entry.source,
        why: entry.why,
        retryAt: entry.retryAt === null ? null : Date.parse(entry.retryAt),
      })),
    hide: (text) => hideSecrets(text, secretsInForce()),
    print,
    configPath: options.config,
  });
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
      // In `readInstall`'s order: a database that did not answer is a read that failed, one that
      // refused the string is the CLI's own refusal, and only a reading that looked at the install
      // takes the finished install run.
      return readInstall(table.database, await table.doctor(), () =>
        studioInstalls.took(source, from),
      );
    },
    removed: (source) => parts.forgetTable?.(source),
    // Why a plugin source cannot run in this worker (its plugin not loaded at the start, a variable
    // unset, settings refused), or undefined when it can; `pending()` says it.
    pluginRefusal: (source, from) => {
      try {
        pluginSourceOf(source, from);
        return undefined;
      } catch (error) {
        if (error instanceof CliError) {
          return { message: error.message, fix: error.fix };
        }
        throw error;
      }
    },
    project: (next, applied) => {
      projectInForce = next;
      raisers.loaded(next, applied);
    },
    // A reload's channels and plugin settings, put in force or kept with the reason.
    settings: (next) => settings.reload(next),
    load: () => {
      if (parts.configFile === undefined) {
        return Promise.reject(new Error("this worker has no config file to reload"));
      }
      return parts.configFile.load();
    },
    beat: (source) => alerts.signals(alertScope(project.id, source, links.worker)).beat(),
    clock,
    print,
    onPass: (loop) => {
      const seen = tally(loop);
      return (report) => {
        seen(report);
        // A record's refused right raises Connector lost access; a pass begun after the alert that
        // wrote with none is what lets the 5-minute look resolve it.
        raisers.passed(loop.source, report);
      };
    },
    failure: (source, error) => installMissing(source, options.config, error),
    stoppedAlone: (source, error, stop) => raisers.stopped(source, error, stop),
  });
  // This worker's own heartbeat row, and a look at the others' every 30 seconds beside the passes;
  // a failure of either is a line here and nothing more.
  const watch = createWorkerWatch({
    store: store.alerts,
    alerts,
    clock,
    project: project.id,
    worker: workerId,
    // Read when the alert is raised: Home with a studio, the docs page with none.
    link: links.worker,
    report: (error, step) => {
      // A driver's words often name the connection string (the store's, a source's) that failed;
      // the sources are the file's in force now, so one a reload added is hidden too.
      print(
        `worker heartbeat: ${WATCH_FAILURES[step]}: ${hideSecrets(errorWords(error), secretsInForce())}`,
      );
    },
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
          loop.source.source === undefined
            ? parts.openTable(
                loop.source,
                { workerId: backfillId, maxConnections: connections },
                // The loop's own question set: the file's model may have moved on since it opened.
                { ...fleet.config(), model: loop.questionSet.model },
              )
            : // A plugin source's job pages through its plugin's scan, over the store's
              // queue of the source under the job's own id; the loop's watch is never touched.
              Promise.resolve(
                pluginBackfillConnector({
                  config: fleet.config(),
                  source: loop.source,
                  project,
                  host: plugins,
                  env: deps.env,
                  clock,
                  workerId: backfillId,
                  store,
                  note: (line) => print(`${loop.source.name}: ${line}`),
                }),
              ),
        newWorkerId: () => `backfill-${randomUUID()}`,
        // A plugin source's records are taken into the store by the job's own connector as it
        // queues them, into the store's one queue of the source the loop claims from.
        queue: (name) =>
          fleet.loop(name) === undefined || fleet.loop(name)?.source.source !== undefined
            ? undefined
            : fleet.connector(name),
        provider,
        spending,
        maxInFlight: limitsFor(connections).maxInFlight,
        clock,
        cursors: store.cursors,
        log: (name) => store.log(storeSourceId(project.id, name)),
        runs: (name) => ({ log: store.runs, source: storeSourceId(project.id, name) }),
        reviews: (name) => reviewsOf(store.reviews, storeSourceId(project.id, name)),
        alerts: (name) => alerts.signals(alertScope(project.id, name, links.backfill)),
        expireAfter: deps.abortAfter,
        newToken: randomUUID,
        print,
      });
  // Apply writes the file only for a worker that runs until stopped and reads the file as it is.
  const configFile = options.once ? undefined : parts.configFile;
  // Apply and the setup flow write the one file, one write at a time.
  const writes = fileQueue();
  let listener: HttpListener | undefined;
  /** Under --once, the first source that failed: the command exits with it at the end. */
  let onceFailure: { readonly error: unknown } | undefined;
  /** Under --once, the heartbeat's timers: they run while it answers and end with the run. */
  const onceBeats = new AbortController();
  let onceBeating: Promise<void> | undefined;
  try {
    await fleet.open(config);
    for (const loop of fleet.loops()) {
      tallyOf(loop.source.name);
    }
    const apiSources = fleet
      .loops()
      .filter((loop) => loop.source.api)
      .map((loop) => ({ name: loop.source.name, fields: loop.source.read }));

    /** The source a queued action row names, as this worker runs it now. */
    const actionSource = (sourceId: string): ActionSource => {
      const named = fleet.config().sources.find((source) => idOf(source) === sourceId);
      if (named === undefined) {
        return { kind: "gone" };
      }
      const loop = fleet.loop(named.name);
      if (loop === undefined) {
        return { kind: "stopped", name: named.name };
      }
      return {
        kind: "running",
        name: named.name,
        connector: fleet.connector(named.name),
        log: store.log(sourceId),
        questionSet: loop.questionSet,
        // A plugin source's settings, for an action of the same plugin.
        ...(loop.plugin === undefined ? {} : { plugin: loop.plugin }),
      };
    };
    // A notification goes through its plugin's channel, bounded and stopped as an alert is, and
    // links its record's page or, for a digest, the Decisions list.
    const actionRunning = {
      host: plugins,
      env: deps.env,
      notify: { clock, stop: deps.stopSignal, recordLink: links.record, listLink: links.list },
    };
    const outbox = createOutbox({
      client: parts.storeClient,
      clock,
      fetch: deps.webhookFetch,
      abortAfter: deps.abortAfter,
      // Every webhook is signed with the built-in webhook's secret, read when the worker started
      // from the variable the config names; never another project's row with it. A refusal is the
      // outbox's fixed "the signing secret could not be read": its text goes nowhere.
      secretFor: (projectId) => {
        const secret = projectId === project.id ? webhookSecret(plugins) : undefined;
        return secret === undefined
          ? Promise.reject(new Error("this worker holds no signing secret for that webhook"))
          : Promise.resolve(secret);
      },
      // A webhook the built-in queued is sent only to an endpoint the config in force still names;
      // one queued under an older config, or by a review from a stale copy, is closed.
      refuseWebhook: (row) => webhookRefusal(fleet.config(), plugins, row),
      // Every webhook row, a plugin's or one queued by an older version with none, is sent to a
      // private address only when the config in force writes its address with allowPrivate: true;
      // the fetch (`createPinnedFetch` at the composition root) judges it.
      allowPrivate: (row) =>
        row.projectId === project.id && webhookAllowsPrivate(fleet.config(), plugins, row.endpoint),
      // An action or a webhook given up on is the `action_gave_up` alert, recorded and sent as the
      // worker's other alerts are; one that cannot be raised is the outbox's to retry.
      onGiveUp: async (event, _signal, lastError) => {
        await alerts.raise(gaveUpAlert(event, lastError, links.gaveUp));
      },
      // An action whose service refused its plugin's credential (a 401) keeps its 24 hours of
      // retries and raises Action credential refused, one per plugin of a source; that plugin's
      // next delivered try on the source resolves it: once per key in flight, and with no store
      // read while this worker knows the key clear (core's `resolveOpen`).
      onCredentialRefused: async (event, _signal, lastError) => {
        await alerts.raise(credentialRefusedAlert(event, lastError, links.credential));
      },
      onActionDelivered: (event) => alerts.resolveOpen(credentialRefusedKey(event)),
      // A plugin's action row runs here, through the plugins this worker loaded, on the record read
      // through its source's loop in force; only this project's rows are taken.
      actionProject: project.id,
      runAction: createActionRunner({ ...actionRunning, source: actionSource }),
      // A notification past the first 10 of its minute, or held by its channel's quiet hours (the
      // alert channel of the same address), goes out in one digest with the others.
      runDigest: createDigestRunner({ ...actionRunning, source: actionSource }),
      // The quiet hours of the channels in force, which a reload's rebind replaces.
      quietPeriod: (batchKey, at) => settings.quietPeriod(batchKey, at),
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
        operatorByAddress: operatorKnownByAddress(accessUrl),
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
              // It sees the loop's hold, and the loop's probe stays the loop's.
              withoutProbe(loop.heldModel),
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
          // The cap the gate enforces now: the one in force, which a reload replaces.
          get cap() {
            return projectInForce.spendingCap === undefined ? undefined : capOf(projectInForce);
          },
          get sources() {
            return fleet.loops().map((loop) => ({
              name: loop.source.name,
              read: loop.source.read,
              questions: loop.questionSet.questions.length,
              version: loop.version,
              table: loop.table,
              ...(loop.plugin === undefined
                ? {}
                : {
                    plugin: { packageName: loop.plugin.packageName, source: loop.plugin.entry },
                  }),
            }));
          },
          // A source whose loop failed is no loop: Home names it with why and its next try.
          get stopped() {
            return fleet.stopped();
          },
        },
        // The Alerts and Settings pages: where this surface listens, the channel addresses the
        // worker runs with (the start's, then each reload's that bound them, every one in force is
        // bound), and the ones the file names now, so the page can say they differ when a reload
        // could not bind them.
        host: options.host,
        alertChannels: () => settings.channels().map((channel) => ({ ...channel, bound: true })),
        fileAlertChannels: () => channelsOf(fleet.config()),
        // The zone quiet hours with none are bound in, judged as the channel host judges the same
        // reader (`quietWindowFor`): the page names it, or asks for a zone without one.
        machineZone: () => knownZone(processZone()),
        // The test button sends through the channels this worker runs; none under --once.
        ...(options.once
          ? {}
          : {
              alertTest: {
                available: true,
                send: (address: string) =>
                  alerts.test(address, { project: project.id, link: links.alerts() }),
              },
            }),
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
        // The Plugins page: the hosted plugins, the registry's gallery, the packs.
        plugins: createPluginsDoor({
          host: plugins,
          config: () => fleet.config(),
          env: deps.env,
          coreVersion: VERSION,
          registry: registryAddress(deps.env),
          fetch: deps.fetch,
          abortAfter: deps.abortAfter,
          workspace: deps.workspace,
          clock,
        }),
        // A plugin source's webhook, handed to the loop in force of the source it names.
        hooks: createHooksDoor({ fleet, plugins, clock, print }),
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
                  // A draft's channels and plugin settings are judged against the plugins in force,
                  // as the reload after its write puts them in force.
                  plugins: draftPlugins({
                    host: () => plugins.current(),
                    env: deps.env,
                    coreVersion: VERSION,
                    projectDir: deps.projectDir,
                  }),
                  // An Apply's reviewer is who a question set its write changes is by, handed to
                  // that reload's own load and no other.
                  reload: (applied) => fleet.reload(applied),
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
                databases: parts.databases,
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
                databases: parts.databases,
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
          // The record now, through the connector of the loop in force, as explain reads it; a
          // source the file no longer runs has none to read it through, and the log alone speaks.
          current: async (name, key) =>
            fleet.loop(name) === undefined
              ? undefined
              : (await fleet.connector(name).current([key])).get(key),
          store: {
            search: (search) => store.searchDecisions(search),
            history: (sourceId, key) => store.log(sourceId).history(key),
            questionSets: (sourceId, versions) => store.questionSets.versions(sourceId, versions),
          },
        },
      });
      listener = await deps.serve((request, peer) => app.fetch(request, peer), port, options.host);
      const address = `http://${hostInUrl(options.host)}:${listener.port}`;
      // Only a served studio is a place to link to; the API alone has no page for an alert's link.
      // A bind to every interface has no address a reader can open, so those alerts keep the docs.
      if (parts.studio !== undefined) {
        servedStudio = servedStudioUrl(options.host, listener.port);
      }
      print(
        parts.studio === undefined
          ? `Serving the check API and the studio's endpoints on ${address}.`
          : `Serving the studio, its endpoints and the check API on ${address}.`,
      );
      for (const line of bindWords(options.host, accessUrl)) {
        print(line);
      }
      await parts.listening?.(options.host, listener.port);
    } else if (!options.once) {
      // No route under --no-http; a source whose plugin takes webhooks relies on its poll.
      for (const line of hooklessNotes(config, plugins)) {
        print(line);
      }
    }

    // The first beat, once the sources are open and the surface is up; under --once too, which
    // beats every 15 seconds for as long as it answers, so a second worker never takes a run that
    // is still going for a death (its row goes when it has finished, below).
    await watch.start();
    if (options.once) {
      onceBeating = watch.run(onceBeats.signal);
      for (const loop of fleet.loops()) {
        const onPass = tally(loop);
        // Pass after pass until the queue is empty, or a pass settles nothing (a record that keeps
        // failing goes back to the queue; it is not asked again in the same run).
        for (;;) {
          let report: PassReport;
          try {
            report = await loop.worker.runOnce();
          } catch (error) {
            // A source that fails stops alone; the others finish their pass, and the command exits
            // with the first failure. Nothing is tried again under --once. Each failing source says
            // its own error, scrubbed of its connection string.
            const worded = installMissing(loop.source.name, options.config, error);
            onceFailure ??= { error: worded };
            print(`${loop.source.name} stopped: ${failureWords(loop.source, worded)}.`);
            print(
              `${loop.source.name} stopped; the other sources finish their pass, then the worker exits with its error.`,
            );
            break;
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
      await deliverPass(() => outbox.deliverDue(clock.now()), print);
    } else {
      // A loop that fails stops alone and is tried again; the fleet's run rejects only for a
      // failure of the fleet itself, which stops the rest.
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
        // Beside the outbox, each channel whose quiet hours ended is sent its summary.
        deliverUntil(
          signal,
          () => outbox.deliverDue(clock.now()),
          clock,
          print,
          () => alerts.summarize({ project: project.id, link: links.alerts() }),
        ),
        // This worker's row every 15 seconds, a look at the others' every 30; on the clock, beside
        // the passes and never inside one, ended by the signal like the loops.
        watch.run(signal),
        // Each running table source's doctor every 5 minutes, the same way.
        raisers.run(signal),
        // A backfill job stops after its page in hand when the worker does.
        ...(jobs === undefined ? [] : [jobs.until(signal)]),
      ]);
      const failed = loops.find((loop) => loop.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
      print("Stopped: every claim was settled.");
    }
    // The row goes only here: on a clean stop, and at the end of a --once run that finished (a
    // source that failed under it is still a finished run). A worker that dies with an error never
    // gets here and leaves its row, for the others to find and raise.
    onceBeats.abort();
    await onceBeating;
    await watch.stop();
    for (const entry of tallies.values()) {
      print(
        `${entry.source}: answered ${entry.answered}, already answered ${entry.alreadyAnswered}, failed ${entry.failed}`,
      );
    }
    if (onceFailure !== undefined) {
      throw onceFailure.error;
    }
  } finally {
    // A --once run that threw leaves no timer behind; its row stays (see above).
    onceBeats.abort();
    await onceBeating;
    // A raise or a resolve still on its way off a loop's path, before the store closes.
    await raisers.settled();
    // A resolved message still on its way, before the store closes; a stop has already cut its
    // delivery off, so this waits no longer than the channel's bound.
    await alerts.drain();
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
 * What the loop prints when a pass of the outbox fails (in fixed text): a driver's message can name
 * the store's connection string, so it is not printed.
 */
export const OUTBOX_PASS_FAILED =
  "webhook delivery failed: the outbox in the store could not be worked through (the database's own words are not printed, as they can name its connection string); FacetDB tries again in 2 seconds, and nothing queued is lost";

/** What the loop prints when the quiet-hours summaries could not read or write the store. */
export const SUMMARY_PASS_FAILED =
  "quiet hours: the summaries of the alerts they held could not be read or written in the store (the database's own words are not printed, as they can name its connection string); FacetDB tries again in 2 seconds";

/** Prints what one tick of the quiet-hours summaries came to: a line for each part. */
function printSummaries(report: SummaryReport, print: (text: string) => void): void {
  for (const failure of report.failures) {
    print(summaryFailureLine(failure));
  }
  for (const channel of report.unmarked) {
    print(summaryUnmarkedLine(channel));
  }
  if (report.storeFailed) {
    print(SUMMARY_PASS_FAILED);
  }
}

/**
 * The outbox's own loop: deliver what is due, wait, again, until the signal aborts. A give-up alert
 * that could not be raised is printed, every one: once real alert channels exist, this line is the
 * only trace of an alert that never went out. Each pass also starts the quiet-hours summaries that
 * are due (`summarize`) when none is on its way, off the outbox's path (a channel that hangs to its
 * bound holds no webhook), prints what each came to, and waits for the one on its way before it
 * returns (the stop has cut its deliveries off by then).
 */
export async function deliverUntil(
  signal: AbortSignal,
  deliver: () => Promise<OutboxPassReport>,
  clock: { sleep(ms: number): Promise<void> },
  print: (text: string) => void,
  summarize: () => Promise<SummaryReport> = () =>
    Promise.resolve({ failures: [], unmarked: [], storeFailed: false }),
): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
  let summarizing: Promise<void> | undefined;
  while (!signal.aborted) {
    try {
      await deliverPass(deliver, print);
    } catch {
      print(OUTBOX_PASS_FAILED);
    }
    summarizing ??= Promise.resolve()
      .then(summarize)
      .then(
        (report) => printSummaries(report, print),
        () => print(SUMMARY_PASS_FAILED),
      )
      .finally(() => {
        summarizing = undefined;
      });
    await Promise.race([clock.sleep(OUTBOX_EVERY_MS), aborted]);
  }
  await summarizing;
}

/**
 * One delivery pass, every give-up alert it could not raise printed; also those of a pass that
 * failed after its other rows ran (`DeliveryPassFailed` carries its report), which then rejects
 * with the store's own error, as a pass did before.
 */
async function deliverPass(
  deliver: () => Promise<OutboxPassReport>,
  print: (text: string) => void,
): Promise<void> {
  try {
    printAlertFailures(await deliver(), print);
  } catch (error) {
    if (error instanceof DeliveryPassFailed) {
      printAlertFailures(error.report, print);
      throw error.cause;
    }
    throw error;
  }
}

/**
 * What the outbox's loop reads of a pass: the give-up alerts it could not raise, and the credential
 * alerts it could not raise or resolve, which a caller that runs no action may leave out.
 */
type OutboxPassReport = Pick<DeliveryReport, "alertFailures"> &
  Partial<Pick<DeliveryReport, "credentialAlertFailures">>;

/** Every alert of a delivery pass that could not be raised or resolved, one line each, none dropped. */
function printAlertFailures(report: OutboxPassReport, print: (text: string) => void): void {
  for (const failure of report.alertFailures) {
    print(alertFailureLine(failure));
  }
  for (const failure of report.credentialAlertFailures ?? []) {
    print(credentialAlertFailureLine(failure));
  }
}

/**
 * A credential alert that did not go out or was not resolved, in fixed words: whose credential and
 * what happens next. Its error is not printed: a store driver's words can name the store's address,
 * and a channel's never reach here (they are recorded with the alert).
 */
function credentialAlertFailureLine(failure: CredentialAlertFailure): string {
  const whose = credentialSubject(failure.event);
  return failure.phase === "raise"
    ? `Action credential refused for ${whose} (delivery ${failure.event.deliveryId}) could not be raised. The action stays on its backoff, and its next refused try raises the alert again.`
    : `Action credential refused for ${whose} could not be resolved after a delivered try. The plugin's next delivered try on that source resolves it.`;
}

/** One alert that did not go out, in plain words: which webhook, why, and what happens next. */
function alertFailureLine({ event, error, final }: AlertFailure): string {
  const reason = error instanceof Error ? error.message : String(error);
  const row = "host" in event ? "webhook" : "action";
  return `${gaveUpSubject(event)} (delivery ${event.deliveryId}) was given up ${gaveUpHow(event)}, and its alert could not be raised: ${reason}. ${
    final
      ? `That was the alert's last try: the ${row} is closed, and this line is its only alert.`
      : `FacetDB tries the alert once more on the ${row}'s next attempt; the ${row} itself is not ${"host" in event ? "sent" : "run"} again.`
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
 * A database with no connection left for the worker login: Postgres's own too_many_connections
 * (53300) and Supabase's session pooler, which answers EMAXCONNSESSION ("max clients reached in
 * session mode") once the login's sessions, every process's together, reach its pool size.
 */
const TOO_MANY_CONNECTIONS = new Set(["53300", "EMAXCONNSESSION"]);

/**
 * A loop's failure as the run reports it: one on a missing table or column names the source and how
 * to find out which, the database's words kept; anything else is left as it is. The worker starts
 * as it always did: nothing is checked before the first claim.
 */
export function installMissing(source: string, configPath: string, error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && TOO_MANY_CONNECTIONS.has(code)) {
    // Seen in a real run: a Supabase session pooler's 15 sessions per login, held by one studio
    // with its backfill beside a process just closed, stopped the studio with the driver's words
    // and "run facetdb doctor" as the fix.
    const said = error instanceof Error ? error.message : String(error);
    return new CliError(
      "too-many-connections",
      `the source "${source}" stopped: its database allows no more connections for the worker login (${said})`,
      `a pooler counts every session of the worker login, and a process just closed keeps its sessions a minute: close any other facetdb worker, studio or doctor on this login, wait a minute, then start again with --connections 6 (or FACETDB_CONNECTIONS=6), which fits a Supabase session pooler's 15 beside one more process`,
    );
  }
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

/**
 * Without a model the worker would only fail: it refuses to start, and says what to set. A built-in
 * provider's key is its own variable's; a plugin's provider must be one its plugin supplies.
 */
export function requireModel(
  config: ProjectConfig,
  env: Readonly<Record<string, string | undefined>>,
  plugins?: PluginHost,
): void {
  const chosen = presetKeyOf(config);
  if (chosen !== undefined) {
    const value = env[chosen.variable];
    if (chosen.required && (value === undefined || value === "")) {
      throw new CliError(
        "model-key",
        `${chosen.variable} is not set, so the worker has no key for the ${chosen.provider} provider`,
        `set ${chosen.variable} to your ${chosen.provider} key, then run facetdb worker again; facetdb dev answers offline without one`,
      );
    }
    return;
  }
  const ref = config.provider === undefined ? undefined : pluginProviderOf(config.provider);
  if (config.provider !== undefined && ref !== undefined) {
    if (plugins !== undefined) {
      try {
        checkPluginProvider({ provider: config.provider, ref, host: plugins });
      } catch (error) {
        if (error instanceof PluginProviderError) {
          throw new CliError("model-provider", error.message, error.fix);
        }
        throw error;
      }
    }
    return;
  }
  const key = env["TYPESAFE_API_KEY"];
  if (config.modelUrl === undefined && (key === undefined || key === "")) {
    throw new CliError(
      "model-key",
      "TYPESAFE_API_KEY is not set, so the worker has no model to ask",
      "set TYPESAFE_API_KEY to your TypeSafe API key (or set modelUrl in facetdb.config.ts for a compatible server), then run facetdb worker again; facetdb dev answers offline without one",
    );
  }
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
  surface: Pick<WorkerParts, "listening"> & {
    readonly studio: ServedStudio | undefined;
    /** The plugins the config names, as `loadWorkerConfig` hosted them (the Plugins page's door). */
    readonly plugins: PluginHost;
  },
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
  const storeClient = deps.connect(storeUrl, { max: connectionsOf(options, deps.env) });
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
      // A plugin's provider is built over the plugin host the start hosted.
      const model = deps.provider(config, surface.plugins);
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
        databases: registeredDatabases(deps),
        keyTextOf: async (source) => (await tableOf(source)).keyText(),
        tableFacts: async (source, from) => (await tableOf(source)).facts(source, from),
        forgetTable: (source) => {
          tables.delete(source.name);
        },
        provider: model,
        sessionSecret,
        plugins: surface.plugins,
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

/** `--connections`, as the worker and the studio take it. */
export const CONNECTIONS_OPTION = {
  flags: "--connections <n>",
  description:
    "the connections this worker may hold open on each database, the store's pool and every connector's (default 10, or FACETDB_CONNECTIONS); a Supabase session pooler allows 15 per login, so 6 leaves room for a second process and facetdb doctor",
} as const;

export const workerCommand = defineCommand<WorkerOptions>("worker", {
  description:
    "Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API and the studio; run it next to the database, in the same region, because every record costs a few round trips to it. Each worker also watches the others of its project and raises Worker not running once for one that stops beating for 2 minutes, so a lone worker's death shows on Home only: an alert for it needs a second worker (or FacetDB Cloud)",
  options: [...OPTIONS, CONNECTIONS_OPTION, HOST_OPTION, ALLOW_INSECURE_OPTION],
  run: async (context) => {
    const { options, deps, print } = context;
    // Every plugin the config names is loaded and its settings checked here, a dry run included.
    const { config, plugins } = await loadWorkerConfig(deps, options.config);
    requireModel(config, deps.env, plugins);
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
    return runWorkerProcess(context, config, { studio, plugins });
  },
});

export const WORKER_OPTIONS = OPTIONS;
