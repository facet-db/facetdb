import { randomUUID } from "node:crypto";
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
  requireAccountToServe,
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
import { configFileDoor, createFleet, reviewLookups, type SourceLoop } from "./config-reload.ts";
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

/**
 * `facetdb worker`: one process that answers every source of the config. Per table source it runs
 * the connector its engine opens (the Postgres capture connector) under the worker login; per API
 * source the store's queue. Every worker shares the resilient provider (backoff and the in-flight
 * limit), the project's spending gate and its alerts, and beats the heartbeat `facetdb doctor`
 * reads. Next to the loops it delivers the webhook outbox and serves the HTTP surface (the check
 * API) on `--port` unless `--no-http`. SIGINT stops it after the pass in hand, so every claim is
 * acked or released before it exits; `--once` answers what is queued and exits. The sources run as
 * a fleet (config-reload.ts): when the studio's Apply has written facetdb.config.ts, the worker
 * reloads it, a changed source restarting after its batch in hand under its new question-set
 * version.
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
   * login's reach and its doctor. Nothing connects until the doctor runs.
   */
  readonly tableFacts: (source: SourceConfig) => TableFacts;
  /** The model, before the backoff and the in-flight limit are put around it. */
  readonly provider: ModelProvider;
  /** `FACETDB_SECRET`: it signs the reviewers' session cookie. `worker` refuses to start without it. */
  readonly sessionSecret: string;
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

  /** A table source's facts for the dashboard, made once per source (its doctor's cache with them). */
  const facts = new Map<string, TableFacts>();
  const factsOf = (source: SourceConfig): TableFacts => {
    const known = facts.get(source.name) ?? parts.tableFacts(source);
    facts.set(source.name, known);
    return known;
  };

  // The sources as one fleet: every loop under its own stop, so a reload after Apply restarts the
  // changed ones and leaves the others running.
  const fleet = createFleet({
    open: openLoop,
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
  });
  // Apply writes the file only for a worker that runs until stopped and reads the file as it is.
  const configFile = options.once ? undefined : parts.configFile;
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
              table: loop.source.api ? undefined : factsOf(loop.source),
            }));
          },
        },
        // The review endpoints: the store's queue, and per source the log, the connector, the
        // actions and the question set and version of the loop in force, read on every call
        // (config-reload.ts, `reviewLookups`).
        review: {
          queue: store.reviews,
          sources: config.sources.map((source) => source.name),
          ...reviewLookups(fleet, {
            idOf: (name) => storeSourceId(project.id, name),
            log: (name) => store.log(storeSourceId(project.id, name)),
            actionsOf,
          }),
          clock,
        },
        // The model's backoff ceiling: by then the next attempt has been made.
        retryAfterSeconds: Math.ceil(DEFAULT_MAX_MS / 1000),
        // The studio's door to the configuration: the loader's export and judgement of the file as
        // last loaded, which only this package has, and Apply's write and reload.
        config: {
          projectId: project.id,
          json: () => toProjectJson(fleet.config()),
          validate: (draft) => judgeDraftSource(fleet.config(), draft, deps.env),
          ...(configFile === undefined
            ? {}
            : {
                file: configFileDoor({
                  path: configFile.path,
                  files: configFile.files,
                  load: () => configFile.load({ quiet: true }),
                  env: deps.env,
                  reload: () => fleet.reload(),
                }),
              }),
        },
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
      const shown = options.host.includes(":") ? `[${options.host}]` : options.host;
      print(
        `Serving the check API and the studio's endpoints on http://${shown}:${listener.port}.`,
      );
    }

    if (options.once) {
      for (const loop of fleet.loops()) {
        const onPass = tally(loop);
        // Pass after pass until the queue is empty, or a pass settles nothing (a record that keeps
        // failing goes back to the queue; it is not asked again in the same run).
        for (;;) {
          const report = await loop.worker.runOnce();
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

/** Without a model the worker would only fail: it refuses to start, and says what to set. */
function requireModel(
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

export const workerCommand = defineCommand<WorkerOptions>("worker", {
  description:
    "Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API; run it next to the database, in the same region, because every record costs a few round trips to it",
  options: [
    ...OPTIONS,
    {
      flags: "--host <address>",
      description:
        "the address the HTTP surface listens on: this machine only by default; any other address needs a reviewer account first (facetdb users add <name>)",
      defaultValue: DEFAULT_HOST,
    },
    ALLOW_INSECURE_OPTION,
  ],
  run: async (context) => {
    const { options, deps, print } = context;
    const config = await loadProjectConfig(deps, options.config);
    requireModel(config, deps.env);
    parsePort(options.port);
    if (options.dryRun) {
      print(
        `Would answer ${config.sources.map((source) => source.name).join(", ")}${options.http ? ` and serve the check API and the studio's endpoints on ${options.host}, port ${options.port}` : ""}. Dry run: nothing was started.`,
      );
      return { ok: true, dryRun: true };
    }
    const storeUrl = deps.env[STORE_VARIABLE] ?? "";
    const allowInsecure = options.allowInsecure === true;
    const project = projectRef(deps.projectDir);
    // Before the store opens or anything connects: no worker password in the clear to another
    // machine, by the store door's rule for the store and each source's engine for its own URL.
    if (storeUrl !== "") {
      requireUsableStoreUrl(storeUrl, allowInsecure, deps.env["PGHOST"]);
    }
    const tables = new Map<
      string,
      {
        /** Under the source's question set in `from`: a reload opens it anew with the new one. */
        readonly open: (
          source: SourceConfig,
          from: ProjectConfig,
          workerId: string,
          maxConnections: number,
        ) => Promise<OpenConnector>;
        readonly keyText: () => Promise<KeyText | undefined>;
        readonly facts: TableFacts;
      }
    >();
    for (const source of config.sources) {
      if (source.table === undefined) {
        continue;
      }
      const url = sourceUrlOf(
        source,
        "the worker login's connection string (postgres://facetdb_worker:…@host/db)",
      );
      const engine = await engineFor(deps.engines, url, source.connector);
      const target = engineTarget(config, { source, ...splitTable(source.table) }, project);
      requireUsableUrl(engine, target, url, allowInsecure);
      const storeShared = storeSharedFor(deps.env, source);
      tables.set(source.name, {
        // The type its database records for its keys, read once the table opened.
        keyText: () => tableKeyText(engine, target, url, allowInsecure),
        facts: tableFacts({
          engine,
          target,
          url,
          source,
          deps: { clock: deps.clock, allowInsecure, storeShared },
        }),
        // The connection is the one checked above: a reload restarts a source only when its
        // table, database and install are unchanged (config-reload.ts), so only the question set moves.
        open: (opened, from, workerId, maxConnections) =>
          openConnector(
            engine,
            engineTarget(from, { source: opened, ...splitTable(source.table ?? "") }, project),
            url,
            { clock: deps.clock, allowInsecure, storeShared, workerId, maxConnections },
          ),
      });
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
          openTable: (source, open, from) => {
            const table = tables.get(source.name);
            if (table === undefined) {
              throw new Error(`the source ${source.name} reads no table`);
            }
            return table.open(source, from, open.workerId, open.maxConnections);
          },
          // Apply writes the file this worker loaded, and the worker reloads it.
          configFile: {
            path: options.config,
            load: (load) => deps.loadConfig(options.config, load),
            files: deps.configFiles,
          },
          keyTextOf: async (source) => tables.get(source.name)?.keyText(),
          tableFacts: (source) => {
            const table = tables.get(source.name);
            if (table === undefined) {
              throw new Error(`the source ${source.name} reads no table`);
            }
            return table.facts;
          },
          provider: deps.provider(config),
          sessionSecret,
        });
      } finally {
        await store.close();
      }
    } finally {
      await storeClient.close();
    }
  },
});

export const WORKER_OPTIONS = OPTIONS;
