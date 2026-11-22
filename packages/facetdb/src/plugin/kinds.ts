import type {
  ActionDecisions,
  ActionRecord,
  ChannelMessage,
  ProviderRequest,
  ProviderResponse,
  Question,
  RecordKey,
  ScanCursor,
  StateValue,
  ThresholdOverride,
} from "@facetdb/core";
import type { ZodType } from "zod";
import type { QuestionDraft } from "../config/index.ts";
import type { Infer } from "./zod.ts";

/**
 * What every plugin function receives first: the plugin's validated config and its secrets, read
 * from the environment by the host (never from the config file). A plugin never writes a decision
 * itself; the worker, the thresholds, the review screen and the log are core's.
 */
export type PluginContext<Config> = {
  readonly config: Config;
  readonly secrets: Readonly<Record<string, string>>;
  /** Aborted when the host stops the plugin; a `watch` that waits must return when it fires. */
  readonly signal: AbortSignal;
};

/** A record of a source plugin: its key as text and the state fields the questions read. */
export type SourceRow = {
  readonly key: RecordKey;
  readonly state: Readonly<Record<string, StateValue>>;
};

/** One page of a resumable scan; `next` is the cursor to continue from, or null after the last page. */
export type SourcePage = {
  readonly rows: readonly SourceRow[];
  readonly next: ScanCursor | null;
};

/**
 * An action of the same plugin configured on a source, as the file writes it: its name and its
 * settings, `when` and `else` included, each variable as `{ env: "NAME" }` and never its value. A
 * GitHub issues source reads the labels its own label actions add and remove here, so it can leave
 * them out of the state it returns.
 */
export type SourceAction = {
  readonly action: string;
  readonly config: { readonly [key: string]: unknown };
};

/**
 * What a source plugin's functions receive: the plugin's context, the source as the config names
 * it, the worker's own clock and the source's one saved cursor.
 */
export type SourceContext<
  Config,
  Settings = Readonly<Record<string, unknown>>,
> = PluginContext<Config> & {
  readonly source: {
    /** The source's name in the config: `issues`. */
    readonly name: string;
    /** This source's settings, as its `config` schema parsed them, each variable read; `{}` without a schema. */
    readonly settings: Settings;
    /** The actions of this same plugin configured on the source, in the file's order. */
    readonly actions: readonly SourceAction[];
  };
  /**
   * The worker's clock, never the machine's: `sleep` ends when its signal aborts, and when the
   * source stops whatever signal it is given, so a waiting `watch` leaves no timer behind.
   */
  readonly clock: {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
  };
  /**
   * One saved string per source, in the FacetDB store, where `watch` resumes after a restart (a
   * `since` time, an event id). `load` is null until the first `save`. A save waits until every key
   * `watch` yielded before it has been taken in, so save a cursor after yielding the keys it covers:
   * a crash between the two then repeats work and never skips it.
   */
  readonly cursor: {
    load(): Promise<string | null>;
    save(cursor: string): Promise<void>;
  };
};

/**
 * An inbound HTTP event a source is told of: the standard `Request`, its body unread, so a plugin
 * can check a signature over the exact bytes.
 */
export type SourceRequest = Request;

/** What `receive` answers: the HTTP status to reply with, and the keys the event says changed. */
export type SourceReceipt = {
  readonly status: number;
  readonly keys: readonly RecordKey[];
};

/**
 * A source's functions. `Own` is the type of its settings as its context carries them, its schema's
 * output by default; `definePlugin` takes any source as `never` there, so a source whose functions
 * read typed settings fits beside one whose plugin config they also read.
 */
export type SourceSpec<Config, Settings extends ZodType = ZodType, Own = Infer<Settings>> = {
  /**
   * The settings of one use of the source in a config file or the dashboard: `github.issues({
   * repo })`. Optional; without it the source takes no settings of its own.
   */
  config?: Settings;
  /** Yields batches of changed keys, at least once each; duplicates are fine. */
  watch(ctx: SourceContext<Config, Own>): AsyncIterable<readonly RecordKey[]>;
  /** The state of each key; a key that no longer exists is left out. */
  read(ctx: SourceContext<Config, Own>, keys: readonly RecordKey[]): Promise<readonly SourceRow[]>;
  /** Pages through every record from a cursor that survives a restart; `null` starts at the beginning. */
  scan(ctx: SourceContext<Config, Own>, cursor: ScanCursor | null): AsyncIterable<SourcePage>;
  /**
   * Optional: reads an inbound HTTP event (a webhook) and answers its status and the keys it names;
   * the worker takes those keys in as it takes the keys `watch` yields. A plugin checks the event's
   * signature here and answers 401 with no keys when it does not hold.
   */
  receive?(ctx: SourceContext<Config, Own>, request: SourceRequest): Promise<SourceReceipt>;
};

export type SourceDefinition<
  Config = never,
  Settings extends ZodType = ZodType,
  Own = Infer<Settings>,
> = SourceSpec<Config, Settings, Own> & { readonly kind: "source" };

export function source<Config = unknown, Settings extends ZodType = ZodType>(
  spec: SourceSpec<Config, Settings>,
): SourceDefinition<Config, Settings> {
  return { ...spec, kind: "source" };
}

/**
 * Thrown by a source plugin when the service it reads refuses its credential (a revoked token, a
 * rotated password, a permission taken away). The worker stops that source alone, says so in its
 * own words naming the plugin and the variables its settings read, and tries it again after a wait,
 * so a credential restored where it is granted is picked up without a restart. Matched by its
 * `name`, so one thrown by a plugin built against another copy of `facetdb/plugin` counts too. Its
 * message is the plugin's and is never printed: it could quote what the plugin was handed.
 */
export class SourceAccessLost extends Error {
  constructor(message = "the service refused the source's credential", options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceAccessLost";
  }
}

/**
 * What an action receives first: the plugin's context, and the source whose record it runs on: its
 * name, and its settings when the source comes from this same plugin (a GitHub label action on a
 * GitHub issues source reads the repository there), null otherwise.
 */
export type ActionContext<Config> = PluginContext<Config> & {
  readonly source: {
    readonly name: string;
    readonly settings: Readonly<Record<string, unknown>> | null;
  };
};

export type ActionSpec<Config, Settings extends ZodType> = {
  /** The settings of one use of the action in a config file or the dashboard. */
  config: Settings;
  run(
    ctx: ActionContext<Config>,
    record: ActionRecord,
    decisions: ActionDecisions,
    settings: Infer<Settings>,
  ): Promise<void>;
};

export type ActionDefinition<Config = never, Settings extends ZodType = ZodType> = ActionSpec<
  Config,
  Settings
> & { readonly kind: "action" };

/**
 * The action FacetDB gives every plugin that provides an alert channel: `slack.notify({ channel,
 * when })` sends a record notification through the plugin's channel. It is FacetDB's own, never
 * declared, so no plugin may name an action of its own so.
 */
export const NOTIFY_ACTION = "notify";

export function action<Config = unknown, Settings extends ZodType = ZodType>(
  spec: ActionSpec<Config, Settings>,
): ActionDefinition<Config, Settings> {
  return { ...spec, kind: "action" };
}

export type ChannelSpec<Config, Settings extends ZodType> = {
  config: Settings;
  /**
   * Why this use of the channel can never deliver with the plugin's settings, in words that name
   * the fix and never a secret; undefined when it can. Optional: the host calls it when it binds an
   * address, so an address the plugin cannot reach is refused when the config loads, not at its
   * first alert. `settings` has already passed `config`.
   */
  check?(ctx: PluginContext<Config>, settings: Infer<Settings>): string | undefined;
  deliver(
    ctx: PluginContext<Config>,
    message: ChannelMessage,
    settings: Infer<Settings>,
  ): Promise<void>;
};

export type ChannelDefinition<Config = never, Settings extends ZodType = ZodType> = ChannelSpec<
  Config,
  Settings
> & { readonly kind: "channel" };

export function channel<Config = unknown, Settings extends ZodType = ZodType>(
  spec: ChannelSpec<Config, Settings>,
): ChannelDefinition<Config, Settings> {
  return { ...spec, kind: "channel" };
}

export type ProviderSpec<Config, Settings extends ZodType> = {
  config: Settings;
  /** Rejects on any failed call: a failed call is an error, never an answer. */
  ask(
    ctx: PluginContext<Config>,
    request: ProviderRequest,
    settings: Infer<Settings>,
  ): Promise<ProviderResponse>;
};

export type ProviderDefinition<Config = never, Settings extends ZodType = ZodType> = ProviderSpec<
  Config,
  Settings
> & { readonly kind: "provider" };

export function provider<Config = unknown, Settings extends ZodType = ZodType>(
  spec: ProviderSpec<Config, Settings>,
): ProviderDefinition<Config, Settings> {
  return { ...spec, kind: "provider" };
}

export type PackSpec = {
  readonly description?: string;
  /** Questions by name, written with `noul`, `choice` and `score` like in a config file. */
  readonly questions: { readonly [name: string]: QuestionDraft };
};

/** A question pack with its questions named and their own thresholds split out, as a config reads them. */
export type PackDefinition = {
  readonly kind: "pack";
  readonly description?: string;
  readonly questions: readonly Question[];
  readonly thresholds: { readonly [question: string]: ThresholdOverride };
};

export function pack(spec: PackSpec): PackDefinition {
  const questions: Question[] = [];
  const thresholds: { [question: string]: ThresholdOverride } = {};
  for (const [name, draft] of Object.entries(spec.questions)) {
    const { thresholds: own, ...rest } = draft;
    questions.push({ ...rest, name } as Question);
    if (own !== undefined) {
      thresholds[name] = own;
    }
  }
  return {
    kind: "pack",
    ...(spec.description === undefined ? {} : { description: spec.description }),
    questions,
    thresholds,
  };
}
