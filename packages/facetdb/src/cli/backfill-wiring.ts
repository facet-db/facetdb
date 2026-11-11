import {
  type Alerts,
  type BackfillDeps,
  type Clock,
  type Connector,
  createAlerts,
  createSpending,
  type ModelProvider,
  type SpendingGate,
  spendingGate,
} from "@facetdb/core";
import type { ProjectRef, Store } from "@facetdb/postgres";
import type { ProjectConfig, SourceConfig } from "../config/index.ts";
import { questionSetOf } from "./commands/database.ts";

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
      history: () => Promise.resolve([]),
      latestAnswersSince: () => Promise.resolve([]),
    },
    questionSet: questionSetOf(config, source),
    version: 1,
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    spending: {
      allowsWork: () => neverDoes("checks the spending cap"),
      admit: () => neverDoes("asks the model"),
      settle: () => neverDoes("asks the model"),
      record: () => neverDoes("counts tokens"),
    },
  };
}

export async function wireBackfill(wiring: BackfillWiring): Promise<BackfillDeps> {
  const { config, source, project, store, clock } = wiring;
  const questionSet = questionSetOf(config, source);
  await store.ensureProject(project);
  // A table source keeps its answers in the customer's database; the store holds its log and
  // versions under the source's name, registered as a plugin-kind source (the store has no third kind).
  await store.ensureSource({
    id: source.name,
    projectId: project.id,
    name: source.name,
    kind: "plugin",
  });
  const version = await store.questionSets.record(source.name, questionSet);
  const alerts = createAlerts({ store: store.alerts, clock, channels: [] });
  return {
    connector: wiring.connector,
    worker: wiring.provider,
    clock,
    cursorStore: store.cursors,
    log: store.log(source.name),
    questionSet,
    version: version.version,
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    alerts: alerts.signals({
      project: project.id,
      source: source.name,
      link: "https://docs.facetdb.dev/fix/backfill",
    }),
    spending: projectSpending(config, store, alerts, clock, project.id),
  };
}

/**
 * The project's spending gate: the config's cap, or none (the count is still kept). Every worker
 * and backfill of the project shares one, so admissions are counted together.
 */
export function projectSpending(
  config: ProjectConfig,
  store: Pick<Store, "usage">,
  alerts: Alerts,
  clock: Clock,
  projectId: string,
): SpendingGate {
  const spending = createSpending({
    usageStore: store.usage,
    clock,
    alerts,
    capLink: () => "https://docs.facetdb.dev/fix/spending-cap",
  });
  const cap =
    config.spendingCap === undefined
      ? NO_CAP
      : { inputTokens: config.spendingCap, onCapReached: config.onCapReached };
  return spendingGate(spending, projectId, () => Promise.resolve(cap));
}
