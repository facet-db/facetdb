import type { AnswerEntry } from "./model.ts";

/** What a logged answer is compared with: the row's state, the questions asked, optionally the version. */
export type CurrentTarget = {
  /** The hash of the row's state now. */
  readonly stateHash: string;
  /** The questions the record must have an answer for. */
  readonly questions: readonly { readonly name: string }[];
  /**
   * The question-set version in force. Left out, the answer's version does not matter: an
   * added-question run merges into an answer from any version.
   */
  readonly version?: number;
};

/**
 * Whether a record's latest logged answer is current: it was given for this very state, under this
 * version, and holds an answer for every question asked. The one rule the worker (to rewrite a
 * record from its log instead of asking again) and the backfill (to leave an answered record out of
 * the queue) share, so the two can never disagree. A human decision is not an answer: a history of
 * people's decisions alone has no `AnswerEntry`, so the caller passes undefined and the record is
 * not current.
 */
export function answersCurrentFor(prior: AnswerEntry | undefined, target: CurrentTarget): boolean {
  return (
    prior !== undefined &&
    prior.stateHash === target.stateHash &&
    (target.version === undefined || prior.version === target.version) &&
    target.questions.every((question) => prior.answers[question.name] !== undefined)
  );
}
