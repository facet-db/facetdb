import type { RecordStatus, StateValue } from "../records/index.ts";
import type { Decision } from "../thresholds/index.ts";
import type { RecordKey } from "./connector.ts";

/** The record an action runs on: its key, its state fields and its current status. */
export type ActionRecord = {
  readonly key: RecordKey;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly status: RecordStatus;
  /**
   * When the decision the action reports was made: the time of the decision log entry behind it
   * (the answer, or a person's decision on it), never the time the action runs. An action run late
   * or again carries the same time, so a receiver can order what it gets.
   */
  readonly decidedAt: Date;
};

/** The decision for each question name, as the record now holds them. */
export type ActionDecisions = Readonly<Record<string, Decision>>;

/**
 * A number test on a question's probability or confidence: `atLeast` is inclusive. Written as
 * `{ "<question>.probability": { atLeast: 0.9 } }` in a condition.
 */
export type NumberTest = {
  readonly atLeast: number;
};

/**
 * One term of a `when`: a question name equal to a decision value (`not_priority: true`), `status`
 * equal to a record status, or a number test on `<question>.probability` or `<question>.confidence`.
 * Every term must hold (AND).
 */
export type ConditionValue = boolean | string | NumberTest;
export type ActionCondition = Readonly<Record<string, ConditionValue>>;

/**
 * An action's configuration as written in the config file: its own fields, plus an optional `when`
 * and an optional `else` that overrides some fields when the condition does not hold. The pipeline
 * evaluates `when` and passes `run` the config that applies, so `run` never sees a condition.
 */
export type ActionInvocation<C> = C & {
  readonly when?: ActionCondition;
  readonly else?: Partial<C>;
};

/**
 * Runs after a decision. The built-in write of the answer column always runs first; an action
 * receives the record, its decisions and the config that applies.
 */
export type Action<C> = {
  run(record: ActionRecord, decisions: ActionDecisions, config: C): Promise<void>;
};
