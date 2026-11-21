import { randomUUID } from "node:crypto";
import type { Clock } from "@facetdb/core";
import type { ApiKeyStore, RunsReader, UsersStore } from "@facetdb/postgres";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createApiKeys } from "./auth/api-keys.ts";
import type { AppEnv } from "./auth/middleware.ts";
import { createReviewers } from "./auth/reviewers.ts";
import { createSessions } from "./auth/sessions.ts";
import { type CheckStore, type CheckWorkers, createCheckService } from "./check/service.ts";
import {
  createConfigService,
  type PreviewSource,
  type ProjectConfigDoor,
} from "./config/service.ts";
import {
  createAccessService,
  createAlertsService,
  createDashboardReads,
  createDecisionsService,
  createDoctors,
  createHomeService,
  createSourcesService,
  type DashboardDatabase,
  type DashboardDoor,
  type DecisionsServiceDeps,
} from "./data/index.ts";
import { createRunsService } from "./data/runs.ts";
import { createReviewEndpointService, type ReviewEndpointDeps } from "./review/service.ts";
import type { BackfillJobsDoor } from "./sources/backfill-door.ts";
import type { MigrateDoor, SetupDoor } from "./sources/door.ts";
import { createSetupService } from "./sources/service.ts";
import type { StudioBuild } from "./studio/build.ts";

export type ServerDeps = {
  /**
   * The API keys, the reviewer accounts, the API sources' records and queues, and the run log's
   * read side (the dashboard's run log), from the FacetDB store.
   */
  readonly store: CheckStore & {
    readonly apiKeys: ApiKeyStore;
    readonly runs: RunsReader;
    readonly users: UsersStore;
  };
  /**
   * `FACETDB_SECRET`, which signs the session cookie. The caller read it from the environment and
   * refused to start without it (the store door); this package never reads the environment.
   */
  readonly sessionSecret: string;
  /** The operating system's user name: the reviewer on record for a request on this machine. */
  readonly osUser: () => string;
  /** One line per sign-in, refusal, lockout and account made; names only, never a password. */
  readonly log: (line: string) => void;
  /** The workers that answer each API source's queue. */
  readonly worker: CheckWorkers;
  readonly clock: Clock;
  /**
   * `retry-after` of a 503 when the model is unreachable, in whole seconds. The caller passes the
   * model package's backoff ceiling (`DEFAULT_MAX_MS`, `@facetdb/model`): this package does not
   * depend on the model package, so the number has one owner and no copy here.
   */
  readonly retryAfterSeconds: number;
  /**
   * The project's configuration as only the CLI has it: the loader's JSON export and its judgement
   * of a draft (this package never imports the `facetdb` package).
   */
  readonly config: ProjectConfigDoor;
  /** The preview over a running source of the worker, or undefined when it runs none by that name. */
  readonly preview: (source: string) => PreviewSource | undefined;
  /** The decision log's reader, the project's sources and how their keys are written. */
  readonly decisions: DecisionsServiceDeps;
  /**
   * The store's database, which the Home and Sources pages read: heartbeats, usage, alerts, the
   * decision log, the review queue, the run log and the backfill cursors.
   */
  readonly storeDatabase: DashboardDatabase;
  /** The project's sources with their engines and doctors, and its cap, as only the CLI knows them. */
  readonly dashboard: DashboardDoor;
  /**
   * The Alerts and Settings pages: the host this surface listens on (`--host`), and the alert
   * channel addresses (`alerts.channels`, `slack:#ops`): `alertChannels` the ones the worker runs
   * with (the config as it started; a reload changes them only at the next restart), and
   * `fileAlertChannels` the ones the file names now, read on each request, so the page can say they
   * differ. The addresses alone: no channel setting ever reaches this package.
   */
  readonly host: string;
  readonly alertChannels: () => readonly string[];
  readonly fileAlertChannels: () => readonly string[];
  /**
   * What the review endpoints decide with: the store's queue, and per source, keyed by its store
   * id, the decision log, the connector, the actions and the question set in force; the source
   * names are the config's, those the worker runs now, read on every call. The project is
   * `config.projectId`.
   */
  readonly review: Omit<ReviewEndpointDeps, "projectId">;
  /**
   * The studio's build the surface serves beside the API: opened by the caller on its directory
   * (`openStudioBuild` over the CLI's disk door); absent under a worker that serves the API alone.
   */
  readonly studioApp?: StudioBuild;
  /**
   * The setup flow's door: the engines, `facetdb migrate`'s plan and Apply's write, as only the CLI
   * has them. Absent, the studio says a source cannot be added here.
   */
  readonly setup?: SetupDoor;
  /**
   * The install of an added question from the studio: `facetdb migrate`'s plan and run for one
   * source, behind the setup's operator check, token and redaction. Absent, the studio shows the
   * commands.
   */
  readonly migrate?: MigrateDoor;
  /**
   * The worker's backfill jobs: estimate, start, stop and status per source, run inside the worker
   * as only the CLI can build them. Absent, the studio is told this worker runs none.
   */
  readonly backfill?: BackfillJobsDoor;
};

/**
 * The HTTP surface's composition root: every dependency of the app is wired here and nowhere else.
 * `facetdb worker` serves the returned app (`@hono/node-server`) next to its loop.
 */
export function createServer(deps: ServerDeps): Hono<AppEnv> {
  // One doctor cache for both pages, so Home and Sources open one round of connections a minute.
  const dashboard = {
    door: deps.dashboard,
    reads: createDashboardReads(deps.storeDatabase),
    doctors: createDoctors(deps.clock),
    clock: deps.clock,
  };
  const reviewers = createReviewers({ users: deps.store.users, log: deps.log });
  return createApp({
    keys: createApiKeys(deps.store.apiKeys),
    check: createCheckService({
      store: deps.store,
      worker: deps.worker,
      clock: deps.clock,
      retryAfterSeconds: deps.retryAfterSeconds,
    }),
    config: createConfigService({ config: deps.config, preview: deps.preview, log: deps.log }),
    data: {
      runs: createRunsService({ reader: deps.store.runs }),
      decisions: createDecisionsService(deps.decisions),
      home: createHomeService(dashboard),
      sources: createSourcesService(dashboard),
      alerts: createAlertsService({
        projectId: deps.config.projectId,
        channels: deps.alertChannels,
        fileChannels: deps.fileAlertChannels,
        reads: dashboard.reads,
      }),
      access: createAccessService({ host: deps.host, reviewers }),
    },
    review: createReviewEndpointService({ ...deps.review, projectId: deps.config.projectId }),
    ...(deps.setup === undefined
      ? {}
      : {
          setup: createSetupService({
            door: deps.setup,
            ...(deps.migrate === undefined ? {} : { migrate: deps.migrate }),
            clock: deps.clock,
            log: deps.log,
          }),
        }),
    ...(deps.backfill === undefined ? {} : { backfill: deps.backfill }),
    studio: {
      sessions: createSessions({
        secret: deps.sessionSecret,
        clock: deps.clock,
        users: deps.store.users,
        osUser: deps.osUser,
        log: deps.log,
      }),
      reviewers,
      projectId: deps.config.projectId,
    },
    ...(deps.studioApp === undefined ? {} : { studioApp: deps.studioApp }),
    newRequestId: randomUUID,
  });
}
