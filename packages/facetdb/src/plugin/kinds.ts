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

export type SourceSpec<Config> = {
  /** Yields batches of changed keys, at least once each; duplicates are fine. */
  watch(ctx: PluginContext<Config>): AsyncIterable<readonly RecordKey[]>;
  /** The state of each key; a key that no longer exists is left out. */
  read(ctx: PluginContext<Config>, keys: readonly RecordKey[]): Promise<readonly SourceRow[]>;
  /** Pages through every record from a cursor that survives a restart; `null` starts at the beginning. */
  scan(ctx: PluginContext<Config>, cursor: ScanCursor | null): AsyncIterable<SourcePage>;
};

export type SourceDefinition<Config = never> = SourceSpec<Config> & { readonly kind: "source" };

export function source<Config = unknown>(spec: SourceSpec<Config>): SourceDefinition<Config> {
  return { ...spec, kind: "source" };
}

export type ActionSpec<Config, Settings extends ZodType> = {
  /** The settings of one use of the action in a config file or the dashboard. */
  config: Settings;
  run(
    ctx: PluginContext<Config>,
    record: ActionRecord,
    decisions: ActionDecisions,
    settings: Infer<Settings>,
  ): Promise<void>;
};

export type ActionDefinition<Config = never, Settings extends ZodType = ZodType> = ActionSpec<
  Config,
  Settings
> & { readonly kind: "action" };

export function action<Config = unknown, Settings extends ZodType = ZodType>(
  spec: ActionSpec<Config, Settings>,
): ActionDefinition<Config, Settings> {
  return { ...spec, kind: "action" };
}

export type ChannelSpec<Config, Settings extends ZodType> = {
  config: Settings;
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
