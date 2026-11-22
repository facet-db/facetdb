import type {
  ActionCondition,
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

/** What `webhook` takes: where to send, and when (`when` and `else` as every action has them). */
export type WebhookOptions = {
  /**
   * Where each decision is sent: https, or http for a receiver on this machine; written here as
   * the address itself, which is no secret (the signing secret is `plugins.webhook.secret`).
   */
  readonly url: string;
  /** Send only when this holds: a decision value, the status, or `{ atLeast }` on a number. */
  readonly when?: ActionCondition;
  /** Where to send instead when `when` does not hold; without it nothing is sent then. */
  readonly else?: { readonly url: string };
};

/**
 * `webhook({ url })` in a source's `actions` is the way to get each decision pushed to your code:
 * the built-in `@facetdb/webhook`, shipped inside facetdb, with nothing to add. Every decision of
 * the source, the worker's and a person's alike, is sent as a signed POST (`facetdb-signature`,
 * HMAC-SHA256 over `<t>.<body>`), retried with backoff for 24 hours; the signing secret is a
 * variable the config names, `plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET") } }`, and
 * your receiver checks it with `verifyWebhook`. Deliveries may arrive out of order, and a retry, or
 * rarely the same decision queued twice, may repeat one: key them by `delivery` and keep, per `id`,
 * the one with the latest `decidedAt`; between two with the same `decidedAt` (a threshold change
 * re-decided the record from the same answer), the one with the larger `delivery` as a whole
 * number, the outbox's sequence number taken when queued.
 */
export function webhook(options: WebhookOptions): ActionCall {
  const { url, when, else: otherwise } = options;
  return actionCall("@facetdb/webhook", "send", {
    url,
    ...(when === undefined ? {} : { when }),
    ...(otherwise === undefined ? {} : { else: { url: otherwise.url } }),
  });
}

/**
 * A plugin source as written in the config: the plugin that provides it, the source's name in that
 * plugin, and the settings of this one use. `github.issues({ repo })` builds one with
 * `sourceCall("@facetdb/github", "issues", { repo })`; like an action, the JSON export carries
 * exactly these three fields. A setting may name a variable, `env("NAME")`, at any depth, and a
 * secret always does: the value is read where the worker runs, never written here.
 */
export type SourceCall = {
  readonly plugin: string;
  readonly source: string;
  readonly settings: { readonly [key: string]: JsonValue };
};

export function sourceCall(
  plugin: string,
  source: string,
  settings: { readonly [key: string]: JsonValue } = {},
): SourceCall {
  return { plugin, source, settings };
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

/**
 * Whether a setting is `env("NAME")`: an object whose one key is `env`, holding text. The same
 * shape in the file and in the JSON (`{ "env": "NAME" }`), so one test reads both.
 */
export function isEnvReference(value: unknown): value is EnvVariable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { env?: unknown }).env === "string"
  );
}

/**
 * One plugin's settings as the file writes them: the fields its manifest's schema takes, any of
 * them `env("NAME")` at any depth, and every secret always that. The value of a variable is never
 * here: the plugin host reads it where the worker runs, so this object, its JSON export and the
 * dashboard carry the name alone, as a source's `database` does.
 */
export type PluginSettings = { readonly [key: string]: JsonValue };

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
  /**
   * A plugin source: `github.issues({ repo })`, or `sourceCall(...)`. Its records, queue, log and
   * review cards are kept in the FacetDB store; it has no table, database or where filter.
   */
  readonly source?: SourceCall;
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

/**
 * Which system alerts a channel is sent: `critical` alone, `warnings` (critical alerts and
 * warnings) or `everything`, the default.
 */
export type AlertSends = "critical" | "warnings" | "everything";

/**
 * A channel's quiet hours: `from` and `to` as `HH:MM` on a 24-hour clock, in `zone` (an IANA time
 * zone, `Europe/Berlin`; absent, the worker's own). Carried here; holding messages in them is not
 * built yet.
 */
export type QuietHours = {
  readonly from: string;
  readonly to: string;
  readonly zone?: string;
};

/**
 * One alert channel: an address `"<kind>:<where>"` (`"slack:#ops"`), or the address under `to` with
 * what it sends and its quiet hours. The kind is a plugin's short name; `where` is handed to that
 * plugin's channel as its one setting. The file's form is kept by the export.
 */
export type AlertChannel =
  | string
  | {
      readonly to: string;
      readonly sends?: AlertSends;
      readonly quiet?: QuietHours;
    };

/** `alerts` in a config file: the channels every system alert goes to. */
export type AlertsConfig = { readonly channels: readonly AlertChannel[] };

/** The address of a channel as the file writes it either way: `slack:#ops`. */
export function channelAddressOf(channel: AlertChannel): string {
  return typeof channel === "string" ? channel : channel.to;
}

/** What a channel sends: its own `sends`, or everything. */
export function channelSendsOf(channel: AlertChannel): AlertSends {
  return typeof channel === "string" ? "everything" : (channel.sends ?? "everything");
}

/** The project's own settings, whichever way its sources are written. */
type ProjectSettings = {
  readonly model: string;
  readonly modelUrl?: string;
  /**
   * Which provider answers: a built-in preset (`openrouter`, `vercel-ai-gateway`,
   * `cloudflare-ai-gateway`, `ollama`, `strands-decider`, `solar-decide`), each reading its own key
   * variable, or `<plugin>/<entry>` for a provider an installed plugin supplies. `modelUrl` beside
   * a preset replaces its address. Absent: TypeSafe direct, or the server at `modelUrl`.
   */
  readonly provider?: string;
  /**
   * The address people open the studio at (`https://facetdb.example.com`): the base of every link
   * an alert or a notification carries. No username or password, no path, query or fragment: the studio
   * is served at the root of its address. Absent, the
   * address the worker serves the studio on; with no studio an alert keeps its docs fix page.
   */
  readonly studioUrl?: string;
  readonly alerts?: AlertsConfig;
  readonly spendingCap?: number;
  readonly onCapReached?: OnCapReached;
  /**
   * Each plugin's settings, under its short name (`github`) or its package name (`@facetdb/github`,
   * `facetdb-plugin-github`), as the plugin loader finds it: `{ github: { repo: "acme/web", token:
   * env("GITHUB_TOKEN") } }`.
   */
  readonly plugins?: { readonly [name: string]: PluginSettings };
};

/** The fields of the one-source form that belong to its source (the GitHub example). */
type OneSourceFields = Pick<
  SourceInput,
  "read" | "questions" | "thresholds" | "actions" | "onChange" | "onOutage" | "maxStateTokens"
>;

/** A project as the file writes it, with a list of `sources`. */
export type ProjectInput = ProjectSettings & { readonly sources: readonly SourceInput[] };

/**
 * The one-source form for a plugin source, `facetdb({ source: github.issues({ ... }), read,
 * questions, ... })`: one `sources` entry, named after the plugin's source (`issues`) unless `name`
 * says otherwise.
 */
export type OneSourceInput = ProjectSettings &
  OneSourceFields & {
    readonly source: SourceCall;
    /** The source's name in the config; the plugin's source's name (`issues`) when left out. */
    readonly name?: string;
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
  /** A plugin source's plugin, its source and settings as written; absent otherwise. */
  readonly source?: SourceCall;
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
  /** A built-in preset's name, or `<plugin>/<entry>`; absent when the file names none. */
  readonly provider?: string;
  /** The studio's address as the file writes it; absent when the file names none. */
  readonly studioUrl?: string;
  readonly alerts?: AlertsConfig;
  readonly spendingCap?: number;
  readonly onCapReached: OnCapReached;
  /** Each plugin's settings as written, `env("NAME")` kept as `{ env: "NAME" }`; absent when the file has none. */
  readonly plugins?: { readonly [name: string]: PluginSettings };
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
    source: input.source,
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
 * The sources a project writes: its `sources`, or the one-source form's single source, named after
 * the plugin's source with any dash read as an underscore (a source's name is lowercase letters,
 * digits and underscores). A file that writes both keeps both, the one-source entry first, and the
 * schema judges them as it judges any two sources.
 */
function sourcesOf(project: ProjectInput | OneSourceInput): readonly SourceInput[] {
  // Read as written: a JavaScript file may give either form, so neither key is taken on trust.
  const call = (project as Partial<OneSourceInput>).source;
  if (call === undefined) {
    return (project as ProjectInput).sources;
  }
  const form = project as OneSourceInput;
  // What only a table or the check API has, which a JavaScript file may still write beside
  // `source`: carried onto the source, so the schema refuses each where it is written.
  const stray = project as Partial<
    Pick<
      SourceInput,
      "table" | "where" | "api" | "storage" | "database" | "connector" | "capture" | "lastChanged"
    >
  >;
  const one: SourceInput = {
    name: form.name ?? call.source.replaceAll("-", "_"),
    source: call,
    ...(stray.table === undefined ? {} : { table: stray.table }),
    ...(stray.where === undefined ? {} : { where: stray.where }),
    ...(stray.api === undefined ? {} : { api: stray.api }),
    ...(stray.storage === undefined ? {} : { storage: stray.storage }),
    ...(stray.database === undefined ? {} : { database: stray.database }),
    ...(stray.connector === undefined ? {} : { connector: stray.connector }),
    ...(stray.capture === undefined ? {} : { capture: stray.capture }),
    ...(stray.lastChanged === undefined ? {} : { lastChanged: stray.lastChanged }),
    read: form.read,
    questions: form.questions,
    ...(form.thresholds === undefined ? {} : { thresholds: form.thresholds }),
    ...(form.actions === undefined ? {} : { actions: form.actions }),
    ...(form.onChange === undefined ? {} : { onChange: form.onChange }),
    ...(form.onOutage === undefined ? {} : { onOutage: form.onOutage }),
    ...(form.maxStateTokens === undefined ? {} : { maxStateTokens: form.maxStateTokens }),
  };
  // Both written is not a form TypeScript allows; a JavaScript file may still write it.
  const others = (project as Partial<ProjectInput>).sources ?? [];
  return [one, ...others];
}

/**
 * Shapes a project: fills the defaults (`inline`, `reset`, `hold`, `pause`) and names the
 * questions. It does not judge the result; the loader does, with the schema. The one-source form
 * is written first so that `Parameters<typeof facetdb>` stays the list form.
 */
export function facetdb(project: OneSourceInput): ProjectConfig;
export function facetdb(project: ProjectInput): ProjectConfig;
export function facetdb(project: ProjectInput | OneSourceInput): ProjectConfig {
  return withDefined<ProjectConfig>({
    model: project.model,
    modelUrl: project.modelUrl,
    provider: project.provider,
    studioUrl: project.studioUrl,
    alerts: project.alerts,
    spendingCap: project.spendingCap,
    onCapReached: project.onCapReached ?? "pause",
    plugins: project.plugins,
    sources: sourcesOf(project).map(sourceConfig),
  });
}
