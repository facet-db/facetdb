import type { Answer } from "../thresholds/index.ts";

/**
 * The decision log's entries: one entry per model call holding every answer of the record, and
 * one entry per human decision at question level. Both carry the question-set version in force,
 * which stands for the wording, criteria, state fields and model version of that moment.
 */

/** Tokens one call consumed, as the provider counted them (the same two numbers the provider returns). */
export type LoggedUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * One model call for one record. `answers` keeps the complete answer of every question, with every
 * probability: re-applying a threshold reads these, never the single number the row keeps.
 */
export type AnswerEntry = {
  readonly kind: "answer";
  readonly key: string;
  /** The question-set version the call ran under. */
  readonly version: number;
  /** The exact model version that answered, as the response named it (`jev-1.14.0`). */
  readonly model: string;
  /** The hash of the state the model was shown; a decision is written only while it still matches. */
  readonly stateHash: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: LoggedUsage;
  readonly at: Date;
};

/** A value a person chose: yes or no for a noul, an option or level name otherwise. */
export type HumanValue = boolean | string;

/**
 * One question of one record decided by a person. `stateHash` is the state the reviewer saw; the
 * decision stands only while the record still has that state.
 */
export type HumanEntry = {
  readonly kind: "human";
  readonly key: string;
  readonly question: string;
  readonly value: HumanValue;
  readonly reviewer: string;
  readonly note?: string;
  readonly stateHash: string;
  /** The question-set version in force when the person decided. */
  readonly version: number;
  readonly at: Date;
};

export type LogEntry = AnswerEntry | HumanEntry;
