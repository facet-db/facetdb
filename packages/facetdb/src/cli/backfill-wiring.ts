import {
  type Alerts,
  type BackfillDeps,
  type BoundChannel,
  type ChannelFailure,
  type Clock,
  type Connector,
  createAlerts,
  createSpending,
  holdModel,
  type ModelProvider,
  reviewsOf,
  type SpendingCap,
  type SpendingGate,
  spendingGate,
} from "@facetdb/core";
import { createBackoff, createInFlightLimiter, createResilientProvider } from "@facetdb/model";
import { type ProjectRef, type Store, sourceIdOf } from "@facetdb/postgres";
import type { ProjectConfig, SourceConfig } from "../config/index.ts";
import {
  type BackfillStore,
  createPluginBackfillConnector,
  hostedSource,
  type PluginHost,
  type PluginSourceConnector,
} from "../plugin/index.ts";
import { questionSetOf } from "./commands/database.ts";
import { alertScope, createLinks, type Links } from "./links.ts";

/**
 * Wires the backfill engine's dependencies for one source from the pieces the composition root
 * built: the source's connector, the FacetDB store (decision log, cursors, usage, alerts) and the
 * model provider. Pure wiring: it opens nothing itself, so a test passes fakes through the same
 * parameters. The source's name is its id in the store, as `uninstall` uses it.
 */
export type BackfillWiring = {
  readonly config: ProjectConfig;
  readonly source: SourceConfig;
  readonly project: ProjectRef;
  readonly store: Store;
  readonly connector: Connector;
  /** The bare provider: the wiring puts the worker's backoff and in-flight limit around it. */
  readonly provider: ModelProvider;
  readonly clock: Clock;
  /** A number in [0, 1), as `Math.random`, for the backoff's jitter, injected as the worker's is. */
  readonly random: () => number;
  /** The alert channels the config names, bound by the composition root; none without `alerts`. */
  readonly channels: readonly BoundChannel[];
  /** Told of each delivery that failed; the alert is recorded with it either way. */
  readonly report: (failure: ChannelFailure) => void;
};

/** No spending cap in the config: a gate that never refuses (the count is still kept). */
const NO_CAP = { inputTokens: Number.MAX_SAFE_INTEGER, onCapReached: "continue" } as const;

/** What the dry run needs: no store, so nothing of FacetDB's is created in the customer's database. */
export type DryRunWiring = {
  readonly config: ProjectConfig;
  readonly source: SourceConfig;
  readonly project: ProjectRef;
  readonly connector: Connector;
  readonly clock: Clock;
};

function neverDoes(what: string): never {
  throw new Error(`a dry run never ${what}`);
}

/**
 * The engine's dependencies for `facetdb backfill --dry-run`: the estimate reads the source through
 * its connector and prices the questions, nothing more. The store is never opened (opening it
 * builds its schema and inserts rows), so there is no saved place and no log to read: the estimate
 * counts every row of the table. Every write, and every model call, throws.
 */
export function wireBackfillDryRun(wiring: DryRunWiring): BackfillDeps {
  const { config, source, clock } = wiring;
  return {
    project: wiring.project.id,
    source: source.name,
    connector: wiring.connector,
    worker: { ask: () => neverDoes("asks the model") },
    clock,
    cursorStore: {
      load: () => Promise.resolve(undefined),
      save: () => neverDoes("saves a place"),
    },
    log: {
      appendAnswer: () => neverDoes("writes the decision log"),
      appendHuman: () => neverDoes("writes the decision log"),
      latestAnswer: () => Promise.resolve(undefined),
      latestAnswers: () => Promise.resolve(new Map()),
      history: () => Promise.resolve([]),
      latestAnswersSince: () => Promise.resolve([]),
      page: () => Promise.resolve({ entries: [], next: undefined }),
      count: () => Promise.resolve(0),
    },
    reviews: {
      upsert: () => neverDoes("follows the review queue"),
      remove: () => neverDoes("follows the review queue"),
      withdraw: () => neverDoes("follows the review queue"),
    },
    questionSet: questionSetOf(config, source),
    version: 1,
    heldModel: {
      check: () => neverDoes("checks the model's answer"),
      holding: undefined,
      probeAt: undefined,
      probeDue: () => neverDoes("asks the model"),
      mayAsk: () => neverDoes("asks the model"),
    },
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    spending: {
      allowsWork: () => neverDoes("checks the spending cap"),
      admit: () => neverDoes("asks the model"),
      settle: () => neverDoes("asks the model"),
      record: () => neverDoes("counts tokens"),
      finish: () => neverDoes("counts tokens"),
    },
  };
}

/**
 * The store a plugin source's dry run hands its adapter: never opened, and never reached, since the
 * adapter's `scan` stores nothing and a dry run queues nothing. Every call throws.
 */
const DRY_RUN_STORE: BackfillStore = {
  capabilities: {
    inlineColumns: false,
    pushWakeup: false,
    transactions: true,
    sideTable: false,
    multipleWorkers: true,
  },
  install: () => neverDoes("installs anything"),
  uninstall: () => neverDoes("uninstalls anything"),
  watch: () => neverDoes("watches a source"),
  read: () => neverDoes("reads the store"),
  write: () => neverDoes("writes a decision"),
  current: () => neverDoes("reads the store"),
  scan: () => neverDoes("pages through the store"),
  enqueue: () => neverDoes("queues a record"),
  claim: () => neverDoes("claims a record"),
  claimKey: () => neverDoes("claims a record"),
  ack: () => neverDoes("settles a claim"),
  release: () => neverDoes("settles a claim"),
  upsertRecord: () => neverDoes("stores a record"),
  insertRecord: () => neverDoes("stores a record"),
};

/** What a plugin source's backfill reads its records through. */
export type PluginBackfillWiring = {
  readonly config: ProjectConfig;
  readonly source: SourceConfig;
  readonly project: ProjectRef;
  /** The plugins loaded for the config: the source's own plugin among them. */
  readonly host: PluginHost;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** The backfill's own worker id in the store's queue: never a worker loop's. */
  readonly workerId: string;
  /** The store; undefined for a dry run, which opens none. */
  readonly store: Pick<Store, "connector" | "cursors"> | undefined;
  /** Where a row the plugin returned that the store does not take is said. */
  readonly note: (line: string) => void;
};

/**
 * A plugin source's connector for a backfill, `facetdb backfill`'s and the worker's job's alike: an
 * adapter of its own over the store's records and queue of the source, under the backfill's own
 * worker id, whose `scan` pages through the plugin's `scan` and whose `enqueue` takes each record
 * in by what the store holds of it as it queues it (`createPluginBackfillConnector`). The plugin's
 * `watch` never runs in it, and the worker's loop never pages or queues through it. For a dry run
 * it stands over a store that refuses every call, which its estimate never makes. Throws the host's
 * refusal when the source's plugin, its settings or a variable they read are not as they must be.
 */
export function pluginBackfillConnector(wiring: PluginBackfillWiring): PluginSourceConnector {
  const { config, source, host, clock, store } = wiring;
  const hosted = hostedSource(host, config, source, wiring.env);
  const sourceId = sourceIdOf(wiring.project.id, source.name);
  return createPluginBackfillConnector({
    store:
      store === undefined
        ? DRY_RUN_STORE
        : store.connector({ sourceId, fields: source.read, workerId: wiring.workerId }),
    name: source.name,
    hosted,
    context: (signal) => host.contextFor(hosted.packageName, signal),
    fields: source.read,
    clock,
    // The plugin's one saved cursor, which its scan may read: a dry run has no store, so none.
    cursors:
      store === undefined
        ? { load: () => Promise.resolve(undefined), save: () => neverDoes("saves a cursor") }
        : store.cursors,
    cursorRun: `plugin-source:${sourceId}`,
    note: wiring.note,
  });
}

export async function wireBackfill(wiring: BackfillWiring): Promise<BackfillDeps> {
  const { config, source, project, store, clock } = wiring;
  const questionSet = questionSetOf(config, source);
  await store.ensureProject(project);
  // A table source keeps its answers in the customer's database; the store holds its log and
  // versions under `sourceIdOf(project, name)`, registered as a plugin-kind source (the store has
  // no third kind). A plugin source is registered as the worker registers it, since the store keeps
  // a source's first kind: a backfill run before the worker's first start must not make it a
  // table's.
  await store.ensureSource({
    projectId: project.id,
    name: source.name,
    kind: source.source === undefined ? "plugin" : "plugin-source",
  });
  const sourceId = sourceIdOf(project.id, source.name);
  const version = await store.questionSets.record(sourceId, questionSet);
  const alerts = createAlerts({
    store: store.alerts,
    clock,
    channels: wiring.channels,
    report: wiring.report,
  });
  return {
    // The run's key in the store's cursors carries both: two sources at one question-set version
    // never resume from each other's place.
    project: project.id,
    source: source.name,
    connector: wiring.connector,
    // An added question's requests go out as the worker's do: 429 and 529 backed off, at most 8 in
    // flight and fewer after a 429. The worker's own backfill job is not wired here: it asks
    // through the worker's wrapped provider.
    worker: createResilientProvider(wiring.provider, {
      backoff: createBackoff({ clock, random: wiring.random }),
      limiter: createInFlightLimiter({ clock }),
    }),
    clock,
    cursorStore: store.cursors,
    log: store.log(sourceId),
    questionSet,
    version: version.version,
    // An added question's answers are held to the version's model, as the worker's are. Its hold is
    // read as the run opens, so a source the store holds asks nothing.
    heldModel: await holdModel(store.questionSets, sourceId, version.version, clock),
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    alerts: alerts.signals(alertScope(project.id, source.name, noServedStudio(config).backfill)),
    spending: projectSpending(config, store, alerts, clock, project.id),
    // Each page that queued or asked a record leaves a row, named as a backfill page.
    runs: { log: store.runs, source: sourceId },
    // An added question's write follows the review queue as the loop's does.
    reviews: reviewsOf(store.reviews, sourceId),
  };
}

/** The project's spending settings, as the config carries them. */
export type ProjectSpendingSettings = Pick<ProjectConfig, "spendingCap" | "onCapReached">;

/** The cap the gate enforces for these settings: the config's, or none (the count is still kept). */
export function capOf(settings: ProjectSpendingSettings): SpendingCap {
  return settings.spendingCap === undefined
    ? NO_CAP
    : { inputTokens: settings.spendingCap, onCapReached: settings.onCapReached };
}

/**
 * The project's spending gate under the cap `readCap` answers, read on every check: the worker
 * hands it the settings in force, which each reload of facetdb.config.ts replaces, so a cap saved
 * from Settings is enforced at once. Every worker and backfill of the project shares one, so
 * admissions are counted together.
 */
export function spendingUnder(
  readCap: () => SpendingCap,
  store: Pick<Store, "usage">,
  alerts: Alerts,
  clock: Clock,
  projectId: string,
  capLink: () => string,
): SpendingGate {
  const spending = createSpending({
    usageStore: store.usage,
    clock,
    alerts,
    capLink,
  });
  return spendingGate(spending, projectId, () => Promise.resolve(readCap()));
}

/** The gate under the config's own cap, for a command that runs the file as loaded (backfill, preview). */
export function projectSpending(
  config: ProjectConfig,
  store: Pick<Store, "usage">,
  alerts: Alerts,
  clock: Clock,
  projectId: string,
): SpendingGate {
  const cap = capOf(config);
  return spendingUnder(
    () => cap,
    store,
    alerts,
    clock,
    projectId,
    noServedStudio(config).spendingCap,
  );
}

/**
 * The links of a command that serves no studio (`facetdb backfill`, `facetdb test`): the config's
 * `studioUrl` when it names one, else each alert's docs fix page.
 */
function noServedStudio(config: Pick<ProjectConfig, "studioUrl">): Links {
  return createLinks({ configured: config.studioUrl, served: () => undefined });
}
