import { randomUUID } from "node:crypto";
import {
  type Connector,
  createAlerts,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type ModelProvider,
  type PassReport,
  type ReviewQueue,
  type SpendingGate,
  type Worker,
} from "@facetdb/core";
import {
  createBackoff,
  createInFlightLimiter,
  createOutagePolicy,
  createResilientProvider,
  DEFAULT_MAX_MS,
} from "@facetdb/model";
import {
  type ProjectRef,
  type SqlClient,
  type SqlConnect,
  type Store,
  WORKER_ROLE,
} from "@facetdb/postgres";
import { createCheckStore, createOutbox, createServer, onlyRecord } from "@facetdb/server";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import { projectSpending } from "../backfill-wiring.ts";
import {
  CliError,
  type CommandContext,
  defineCommand,
  EXIT_USAGE,
  type HttpListener,
} from "../program.ts";
import { openTableConnector, workerUrlOf } from "../table-connector.ts";
import { loadProjectConfig, projectRef, questionSetOf } from "./database.ts";

/**
 * `facetdb worker`: one process that answers every source of the config. Per table source it runs
 * the Postgres capture connector under the worker login; per API source the store's queue. Every
 * worker shares the resilient provider (backoff and the in-flight limit), the project's spending
 * gate and its alerts, and beats the heartbeat `facetdb doctor` reads. Next to the loops it
 * delivers the webhook outbox and serves the HTTP surface (the check API) on `--port` unless
 * `--no-http`. SIGINT stops it after the pass in hand, so every claim is acked or released before
 * it exits; `--once` answers what is queued and exits.
 */

export const DEFAULT_PORT = 7411;

/** How often the outbox looks for webhooks that are due. */
export const OUTBOX_EVERY_MS = 2_000;

export type WorkerOptions = {
  readonly config: string;
  readonly port: string;
  /** False under `--no-http`. */
  readonly http: boolean;
  readonly once: boolean;
};

/** Everything the loops run on, opened by `worker` from the environment or by `dev` on PGlite. */
export type WorkerParts = {
  readonly config: ProjectConfig;
  readonly project: ProjectRef;
  readonly store: Store;
  /** The store's own database, for the webhook outbox. */
  readonly storeClient: SqlClient;
  /** Opens a table source's database; `databaseOf` names the URL it is given. */
  readonly connect: SqlConnect;
  readonly databaseOf: (source: SourceConfig) => string;
  /** The model, before the backoff and the in-flight limit are put around it. */
  readonly provider: ModelProvider;
};

/** What a run hands back under `--json`: what was answered per source, and whether HTTP was served. */
export type WorkerSummary = {
  readonly ok: true;
  readonly http: { readonly port: number } | null;
  readonly sources: readonly {
    readonly source: string;
    readonly answered: number;
    readonly failed: number;
  }[];
};

const OPTIONS = [
  { flags: "--config <path>", description: "the config file", defaultValue: "facetdb.config.ts" },
  {
    flags: "--port <port>",
    description: "the port of the HTTP surface (the check API)",
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

/**
 * Pending reviews belong to the review screen, which does not exist yet: there is no card to
 * withdraw, and the decision log the screen will read already carries the newer answer.
 */
const NO_REVIEW_CARDS: ReviewQueue = { withdraw: () => Promise.resolve() };

/** One source's loop, with what it holds open. */
type Running = {
  readonly source: string;
  readonly worker: Worker;
  close(): Promise<void>;
  answered: number;
  failed: number;
};

/** The worker login may read the heartbeat, so `facetdb doctor` run as it can check the worker. */
async function grantHeartbeats(client: SqlClient, print: (text: string) => void): Promise<void> {
  try {
    const role = await client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [
      WORKER_ROLE,
    ]);
    if (role.length > 0) {
      await client.query(`grant select on facetdb.heartbeats to ${WORKER_ROLE}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(
      `note: could not let ${WORKER_ROLE} read facetdb.heartbeats (${message}); facetdb doctor run as that login will say so`,
    );
  }
}

/**
 * Builds a worker per source, serves HTTP, and runs until stopped (or once). The caller has opened
 * `parts` and closes them afterwards.
 */
export async function runWorkers(
  context: CommandContext<WorkerOptions>,
  parts: WorkerParts,
): Promise<WorkerSummary> {
  const { options, deps, print } = context;
  const { config, project, store } = parts;
  const { clock } = deps;
  const port = parsePort(options.port);
  const workerId = `worker-${randomUUID()}`;
  const provider = createResilientProvider(parts.provider, {
    backoff: createBackoff({ clock, random: deps.random }),
    limiter: createInFlightLimiter({ clock }),
  });
  const alerts = createAlerts({ store: store.alerts, clock, channels: [] });
  await store.ensureProject(project);
  await grantHeartbeats(parts.storeClient, print);
  const spending: SpendingGate = projectSpending(config, store, alerts, clock, project.id);

  /** The question-set version each source runs under, recorded once at start. */
  const versions = new Map<string, number>();

  /**
   * One source's worker. The loop's worker carries the alerts and the outage policy; a check call's
   * worker (one record, `forRecord`) leaves both to the loop, which answers the record if it fails.
   */
  function workerFor(source: SourceConfig, connector: Connector, loop: boolean): Worker {
    const version = versions.get(source.name);
    if (version === undefined) {
      throw new Error(`the source ${source.name} was not started by this worker`);
    }
    return createWorker({
      connector,
      provider,
      log: store.log(source.name),
      reviews: NO_REVIEW_CARDS,
      actions: [],
      clock,
      limits: {
        ...DEFAULT_WORKER_LIMITS,
        ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
      },
      questionSet: questionSetOf(config, source),
      version,
      ...(loop
        ? {
            alerts: alerts.signals({
              project: project.id,
              source: source.name,
              link: "https://docs.facetdb.dev/fix/worker",
            }),
            outage: createOutagePolicy({ onOutage: source.onOutage, clock }),
          }
        : {}),
      spending,
    });
  }

  async function start(source: SourceConfig, kind: "api" | "plugin"): Promise<void> {
    await store.ensureSource({ id: source.name, projectId: project.id, name: source.name, kind });
    const recorded = await store.questionSets.record(source.name, questionSetOf(config, source));
    versions.set(source.name, recorded.version);
    if (source.actions.length > 0) {
      print(
        `note: ${source.name} lists ${source.actions.length} action(s); plugin actions run once plugins are resolved (a later version), the answer columns are written meanwhile`,
      );
    }
  }

  const running: Running[] = [];
  const apiSources: {
    readonly name: string;
    readonly sourceId: string;
    readonly fields: readonly string[];
  }[] = [];
  let listener: HttpListener | undefined;
  try {
    for (const source of config.sources) {
      if (source.api) {
        await start(source, "api");
        const connector = store.connector({ sourceId: source.name, fields: source.read, workerId });
        const worker = workerFor(source, connector, true);
        apiSources.push({ name: source.name, sourceId: source.name, fields: source.read });
        running.push({
          source: source.name,
          worker,
          close: () => Promise.resolve(),
          answered: 0,
          failed: 0,
        });
        continue;
      }
      const connector = await openTableConnector({
        source,
        url: parts.databaseOf(source),
        connect: parts.connect,
        questionSet: questionSetOf(config, source),
        clock,
        workerId,
      });
      // Its log and versions are kept in the store under the source's name, registered as a
      // plugin-kind source, as backfill does (the store has no third kind).
      try {
        await start(source, "plugin");
      } catch (error) {
        await connector.close();
        throw error;
      }
      running.push({
        source: source.name,
        worker: workerFor(source, connector, true),
        close: () => connector.close(),
        answered: 0,
        failed: 0,
      });
    }

    const outbox = createOutbox({
      client: parts.storeClient,
      clock,
      fetch: deps.webhookFetch,
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
        },
        worker: {
          forRecord: (projectId, name, key) => {
            const source = config.sources.find(
              (candidate) => candidate.name === name && candidate.api,
            );
            if (source === undefined || projectId !== project.id) {
              throw new Error(`the project ${projectId} has no API source named ${name}`);
            }
            const connector = store.connector({
              sourceId: source.name,
              fields: source.read,
              workerId,
            });
            return workerFor(source, onlyRecord(connector, key), false);
          },
        },
        clock,
        // The model's backoff ceiling: by then the next attempt has been made.
        retryAfterSeconds: Math.ceil(DEFAULT_MAX_MS / 1000),
      });
      listener = await deps.serve((request) => app.fetch(request), port);
      print(`Serving the check API on port ${listener.port}.`);
    }

    const tally = (entry: Running) => (report: PassReport) => {
      entry.answered += report.written.length + report.skipped.length;
      entry.failed += report.failures.length;
      if (report.written.length > 0) {
        print(`${entry.source}: answered ${report.written.join(", ")}`);
      }
      for (const failure of report.failures) {
        const message =
          failure.error instanceof Error ? failure.error.message : String(failure.error);
        print(
          `${entry.source}: ${failure.key ?? "the pass"} failed at ${failure.stage}: ${message}`,
        );
      }
    };

    if (options.once) {
      for (const entry of running) {
        const onPass = tally(entry);
        // Pass after pass until the queue is empty, or a pass settles nothing (a record that keeps
        // failing goes back to the queue; it is not asked again in the same run).
        for (;;) {
          const report = await entry.worker.runOnce();
          onPass(report);
          const settled =
            report.written.length +
            report.skipped.length +
            report.gone.length +
            report.held.length +
            report.refused.length +
            report.discarded.length;
          if (report.claimed === 0 || settled === 0 || report.paused) {
            break;
          }
        }
      }
      await outbox.deliverDue(clock.now());
    } else {
      // One loop failing (its database gone, say) stops the others too, so every claim is settled
      // before the connectors close; the first failure is what the run reports.
      const stopped = deps.stopSignal();
      const stopAll = new AbortController();
      const signal = AbortSignal.any([stopped, stopAll.signal]);
      const untilStopped = (loop: Promise<void>) =>
        loop.catch((error: unknown) => {
          stopAll.abort();
          throw error;
        });
      print(
        running.length === 0
          ? "Worker running with no source to answer (none is installed). Press Ctrl+C to stop."
          : `Worker running for ${running.map((entry) => entry.source).join(", ")}. Press Ctrl+C to stop.`,
      );
      const loops = await Promise.allSettled([
        ...running.map((entry) => untilStopped(entry.worker.run(signal, tally(entry)))),
        deliverUntil(signal, () => outbox.deliverDue(clock.now()), clock, print),
      ]);
      const failed = loops.find((loop) => loop.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
      print("Stopped: every claim was settled.");
    }
  } finally {
    await listener?.close();
    for (const entry of running) {
      await entry.close();
    }
  }
  return {
    ok: true,
    http: listener === undefined ? null : { port: listener.port },
    sources: running.map(({ source, answered, failed }) => ({ source, answered, failed })),
  };
}

/** The outbox's own loop: deliver what is due, wait, again, until the signal aborts. */
async function deliverUntil(
  signal: AbortSignal,
  deliver: () => Promise<unknown>,
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
      await deliver();
    } catch (error) {
      print(`webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Promise.race([clock.sleep(OUTBOX_EVERY_MS), aborted]);
  }
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
    "Runs the worker until stopped: answers every source, beats the heartbeat, delivers webhooks and serves the check API",
  options: OPTIONS,
  run: async (context) => {
    const { options, deps, print } = context;
    const config = await loadProjectConfig(deps, options.config);
    requireModel(config, deps.env);
    parsePort(options.port);
    if (options.dryRun) {
      print(
        `Would answer ${config.sources.map((source) => source.name).join(", ")}${options.http ? ` and serve the check API on port ${options.port}` : ""}. Dry run: nothing was started.`,
      );
      return { ok: true, dryRun: true };
    }
    const storeUrl = deps.env["DATABASE_URL"] ?? "";
    const store = await deps.store();
    const storeClient = deps.connect(storeUrl);
    try {
      return await runWorkers(context, {
        config,
        project: projectRef(deps.projectDir),
        store,
        storeClient,
        connect: deps.connect,
        databaseOf: workerUrlOf,
        provider: deps.provider(config),
      });
    } finally {
      await storeClient.close();
      await store.close();
    }
  },
});

export const WORKER_OPTIONS = OPTIONS;
