import type { Question } from "../questions/index.ts";
import type { StateValue } from "../records/index.ts";
import type { Answer } from "../thresholds/index.ts";

/**
 * One model call for one record: the record's state and every question of the set, in one
 * request. `model` is an exact version such as `jev-1.14.0`; an alias is never accepted.
 */
export type ProviderRequest = {
  readonly model: string;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly questions: readonly Question[];
};

/** Tokens the call consumed, as the provider counted them. */
export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/** One answer per question name, each in its question's own option or level order. */
export type ProviderResponse = {
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: Usage;
};

/**
 * Which model answers the questions. `ask` rejects on any failed call: a failed call is an error,
 * never an answer, so the caller retries or holds the record.
 */
export type ModelProvider = {
  ask(request: ProviderRequest): Promise<ProviderResponse>;
};
