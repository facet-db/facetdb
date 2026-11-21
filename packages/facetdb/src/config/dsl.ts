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

/**
 * How a source's database is watched when its scheme's own way does not fit: `"polling"` scans for
 * changed rows and compares a state hash, for a host that forbids triggers. Absent, the connection
 * string's scheme picks the engine.
 */
export type ConnectorChoice = "polling";

/**
 * How a SQL Server source notices a changed record ("trigger and `facetdb_jobs` table, or Change
 * Tracking"): `"trigger"`, the default, or `"change-tracking"` for a shop that forbids triggers on
 * its tables, where the database keeps a version per row change and the worker reads it every
 * second. SQL Server only.
 */
export type CaptureMode = "trigger" | "change-tracking";

/**
 * The name of the environment variable a source reads its connection string from: what
 * `env("DATABASE_URL")` builds. It holds the name only, never the value, so the file, its JSON export
 * (`database: { env: "DATABASE_URL" }`) and the dashboard all carry the same thing, and the loader
 * reads the string where the worker runs. Reading `process.env` here would freeze the value in the
 * module cache and put a secret in a value the rest of FacetDB passes around.
 */
export type EnvVariable = { readonly env: string };

export function env(name: string): EnvVariable {
  return Object.freeze({ env: name });
}

export type SourceInput = {
  readonly name: string;
  /**
   * Where the connection string comes from: `env("DATABASE_URL")` names the variable, and the loader
   * reads it. A string (`process.env.DATABASE_URL`) still loads; the loader then finds the variable by
   * its value, which is a guess where two variables hold the same string.
   */
  readonly database?: string | EnvVariable | undefined;
  /** Overrides the engine the scheme picks: `"polling"` for a host that forbids triggers. */
  readonly connector?: ConnectorChoice;
  /** SQL Server only: `"change-tracking"` watches the table without a trigger; `"trigger"` by default. */
  readonly capture?: CaptureMode;
  /**
   * A polled table only (CockroachDB, Oracle, `connector: "polling"`): the column the application
   * sets on every insert and every update, which FacetDB polls by every 10 seconds; or `false` to
   * read the whole table every hour, on purpose and without a warning. Left out, FacetDB looks for
   * an `updated_at`, `modified_at` or the like.
   */
  readonly lastChanged?: string | false;
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
  /**
   * The loader's mark that the file named the variable itself (`env("X")`) rather than the loader
   * guessing it from the string's value: Apply then trusts `databaseEnv` as the file's own. Set by the
   * loader alone; never in the JSON export, never in the file (the schema refuses the key).
   */
  readonly databaseEnvNamed?: true;
  /** The engine chosen over the scheme's: `"polling"`; absent, the scheme picks it. */
  readonly connector?: ConnectorChoice;
  /** How a SQL Server source notices changes, when the config says; absent, the trigger. */
  readonly capture?: CaptureMode;
  /** The column a polled table is read by, or `false` for the hourly scan; absent, found by name. */
  readonly lastChanged?: string | false;
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
  // `env("X")` names the variable and the loader reads it; a string is the value already read.
  const database = input.database;
  const named = typeof database === "object" ? database : undefined;
  return withDefined<SourceConfig>({
    name: input.name,
    api: input.api === true,
    database: named === undefined ? database : undefined,
    databaseEnv: named?.env,
    connector: input.connector,
    capture: input.capture,
    lastChanged: input.lastChanged,
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
