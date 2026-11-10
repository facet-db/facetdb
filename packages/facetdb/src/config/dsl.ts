import type {
  ChoiceOption,
  ChoiceQuestion,
  NoulCriteria,
  NoulQuestion,
  OnChange,
  Question,
  ScoreLevel,
  ScoreQuestion,
  Stakes,
  ThresholdOverride,
} from "@facetdb/core";
import type { OnOutage } from "@facetdb/model";

/**
 * The config DSL: `facetdb({...})` with `noul`, `choice` and `score` for the questions. These
 * functions only shape and default; the zod schema in `schema.ts` is what judges a config, so a
 * mistake is reported with its path at the boundary and not thrown from here.
 */

/** A value that survives a round trip through JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * An action as written in the config: the plugin that provides it, its name and its arguments.
 * `slack.notify({ channel })` builds one with `actionCall("@facetdb/slack", "notify", { channel })`,
 * and the JSON export carries exactly these three fields, so a function never has to be serialized.
 */
export type ActionCall = {
  readonly plugin: string;
  readonly action: string;
  readonly config: { readonly [key: string]: JsonValue };
};

export function actionCall(
  plugin: string,
  action: string,
  config: { readonly [key: string]: JsonValue } = {},
): ActionCall {
  return { plugin, action, config };
}

/** What a question needs besides its text; `thresholds` is the per-question way to set them. */
type QuestionOptions = {
  readonly stakes?: Stakes;
  readonly thresholds?: ThresholdOverride;
};

export type NoulOptions = QuestionOptions & { readonly criteria?: NoulCriteria };
export type ChoiceOptions = QuestionOptions & { readonly storeProbabilities?: boolean };
export type ScoreOptions = QuestionOptions;

type Unnamed<Q extends Question> = Omit<Q, "name">;

/** A question before it has a name: the name is the key it sits under in `questions`. */
export type QuestionDraft = (
  | Unnamed<NoulQuestion>
  | Unnamed<ChoiceQuestion>
  | Unnamed<ScoreQuestion>
) & { readonly thresholds?: ThresholdOverride };

export function noul(
  instructions: string,
  options: NoulOptions = {},
): Unnamed<NoulQuestion> & { readonly thresholds?: ThresholdOverride } {
  return {
    type: "noul",
    instructions,
    ...(options.criteria === undefined ? {} : { criteria: options.criteria }),
    stakes: options.stakes ?? "low",
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  };
}

/**
 * `options` maps each option's name to the situation that earns it, in the order written. A list of
 * `{ name, description }` says the same and keeps its order even for names such as "1" that an
 * object would sort first.
 */
export function choice(
  instructions: string,
  options: { readonly [name: string]: string } | readonly ChoiceOption[],
  questionOptions: ChoiceOptions = {},
): Unnamed<ChoiceQuestion> & { readonly thresholds?: ThresholdOverride } {
  return {
    type: "choice",
    instructions,
    options: Array.isArray(options)
      ? options
      : Object.entries(options).map(([name, description]) => ({ name, description })),
    stakes: questionOptions.stakes ?? "low",
    storeProbabilities: questionOptions.storeProbabilities ?? false,
    ...(questionOptions.thresholds === undefined ? {} : { thresholds: questionOptions.thresholds }),
  };
}

/** `levels` run from the lowest to the highest; a level is a name or a name with a description. */
export function score(
  instructions: string,
  levels: readonly (string | ScoreLevel)[],
  options: ScoreOptions = {},
): Unnamed<ScoreQuestion> & { readonly thresholds?: ThresholdOverride } {
  return {
    type: "score",
    instructions,
    levels: levels.map((level) => (typeof level === "string" ? { name: level } : level)),
    stakes: options.stakes ?? "low",
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  };
}

export type StorageMode = "inline" | "side-table";
export type OnCapReached = "pause" | "continue";

export type SourceInput = {
  readonly name: string;
  /** The connection string, read from the environment: `process.env.DATABASE_URL`. */
  readonly database?: string | undefined;
  /** An API source: your code sends the records to `/v1/check`. */
  readonly api?: boolean;
  readonly table?: string;
  readonly where?: string;
  readonly read: readonly string[];
  readonly storage?: StorageMode;
  readonly onChange?: OnChange;
  readonly onOutage?: OnOutage;
  readonly maxStateTokens?: number;
  readonly questions: { readonly [name: string]: QuestionDraft };
  /** Thresholds by question name; they override the ones given in a question's own options. */
  readonly thresholds?: { readonly [question: string]: ThresholdOverride };
  readonly actions?: readonly ActionCall[];
  /** Overrides the project's model for this source. */
  readonly model?: string;
};

export type ProjectInput = {
  readonly model: string;
  readonly modelUrl?: string;
  readonly alerts?: { readonly channels: readonly string[] };
  readonly spendingCap?: number;
  readonly onCapReached?: OnCapReached;
  readonly sources: readonly SourceInput[];
};

/** A source with every default filled and its questions named: what the rest of FacetDB reads. */
export type SourceConfig = {
  readonly name: string;
  readonly api: boolean;
  /** The connection string as read when the config loaded; never written to the JSON export. */
  readonly database?: string;
  /** The environment variable the connection string came from; the JSON export carries this. */
  readonly databaseEnv?: string;
  readonly table?: string;
  readonly where?: string;
  readonly read: readonly string[];
  readonly storage: StorageMode;
  readonly onChange: OnChange;
  readonly onOutage: OnOutage;
  readonly maxStateTokens?: number;
  readonly questions: readonly Question[];
  readonly thresholds: { readonly [question: string]: ThresholdOverride };
  readonly actions: readonly ActionCall[];
  readonly model?: string;
};

export type ProjectConfig = {
  readonly model: string;
  readonly modelUrl?: string;
  readonly alerts?: { readonly channels: readonly string[] };
  readonly spendingCap?: number;
  readonly onCapReached: OnCapReached;
  readonly sources: readonly SourceConfig[];
};

/** Drops the keys whose value is undefined, so an optional setting is absent rather than empty. */
function withDefined<Result>(entries: object): Result {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as Result;
}

function mergeThresholds(
  fromQuestions: { [question: string]: ThresholdOverride },
  fromSource: { readonly [question: string]: ThresholdOverride } | undefined,
): { [question: string]: ThresholdOverride } {
  const merged = { ...fromQuestions };
  for (const [name, override] of Object.entries(fromSource ?? {})) {
    merged[name] = override;
  }
  return merged;
}

function nameQuestions(drafts: SourceInput["questions"]): {
  questions: Question[];
  thresholds: { [question: string]: ThresholdOverride };
} {
  const questions: Question[] = [];
  const thresholds: { [question: string]: ThresholdOverride } = {};
  for (const [name, draft] of Object.entries(drafts)) {
    const { thresholds: own, ...rest } = draft;
    questions.push({ ...rest, name } as Question);
    if (own !== undefined) {
      thresholds[name] = own;
    }
  }
  return { questions, thresholds };
}

function sourceConfig(input: SourceInput): SourceConfig {
  const { questions, thresholds } = nameQuestions(input.questions);
  return withDefined<SourceConfig>({
    name: input.name,
    api: input.api === true,
    database: input.database,
    table: input.table,
    where: input.where,
    read: input.read,
    storage: input.storage ?? "inline",
    onChange: input.onChange ?? "reset",
    onOutage: input.onOutage ?? "hold",
    maxStateTokens: input.maxStateTokens,
    questions,
    thresholds: mergeThresholds(thresholds, input.thresholds),
    actions: input.actions ?? [],
    model: input.model,
  });
}

/**
 * Shapes a project: fills the defaults (`inline`, `reset`, `hold`, `pause`) and names the
 * questions. It does not judge the result; the loader does, with the schema.
 */
export function facetdb(project: ProjectInput): ProjectConfig {
  return withDefined<ProjectConfig>({
    model: project.model,
    modelUrl: project.modelUrl,
    alerts: project.alerts,
    spendingCap: project.spendingCap,
    onCapReached: project.onCapReached ?? "pause",
    sources: project.sources.map(sourceConfig),
  });
}
