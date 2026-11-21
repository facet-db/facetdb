import {
  type Alerts,
  type BackfillDeps,
  type Clock,
  type Connector,
  createAlerts,
  createSpending,
  type ModelProvider,
  reviewsOf,
  type SpendingCap,
  type SpendingGate,
  spendingGate,
} from "@facetdb/core";
import { type ProjectRef, type Store, sourceIdOf } from "@facetdb/postgres";
import type { ProjectConfig, SourceConfig } from "../config/index.ts";
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
  readonly provider: ModelProvider;
  readonly clock: Clock;
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

export async function wireBackfill(wiring: BackfillWiring): Promise<BackfillDeps> {
  const { config, source, project, store, clock } = wiring;
  const questionSet = questionSetOf(config, source);
  await store.ensureProject(project);
  // A table source keeps its answers in the customer's database; the store holds its log and
  // versions under `sourceIdOf(project, name)`, registered as a plugin-kind source (the store has
  // no third kind).
  await store.ensureSource({ projectId: project.id, name: source.name, kind: "plugin" });
  const sourceId = sourceIdOf(project.id, source.name);
  const version = await store.questionSets.record(sourceId, questionSet);
  const alerts = createAlerts({ store: store.alerts, clock, channels: [] });
  return {
    // The run's key in the store's cursors carries both: two sources at one question-set version
    // never resume from each other's place.
    project: project.id,
    source: source.name,
    connector: wiring.connector,
    worker: wiring.provider,
    clock,
    cursorStore: store.cursors,
    log: store.log(sourceId),
    questionSet,
    version: version.version,
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
