import type { QuestionSet, ThresholdOverride } from "../questions/index.ts";
import type { RecordStatus } from "../records/index.ts";
import { type Decision, decide, resolveThresholds } from "../thresholds/index.ts";
import { humanDecision, standingHuman } from "./human.ts";
import type { AnswerEntry, LogEntry } from "./model.ts";

/**
 * Every question's decision for one logged answer under the given threshold overrides, or
 * undefined when the answer lacks a question of the set (only a model call can decide that one).
 * A question a person decided against this answer's state keeps the person's value, whatever the
 * thresholds say. This is the one place an answer becomes decisions, shared by the worker's write
 * and by re-apply, so the two can never disagree.
 */
export function decideRecord(
  questionSet: QuestionSet,
  overrides: Readonly<Record<string, ThresholdOverride>>,
  entry: AnswerEntry,
  history: readonly LogEntry[],
): Readonly<Record<string, Decision>> | undefined {
  const decisions: Record<string, Decision> = {};
  for (const question of questionSet.questions) {
    const answer = entry.answers[question.name];
    if (answer === undefined) {
      return undefined;
    }
    const human = standingHuman(history, question.name, entry.stateHash);
    decisions[question.name] =
      human !== undefined
        ? humanDecision(question, human.value, answer)
        : decide(question, resolveThresholds(question, overrides[question.name]), answer);
  }
  return decisions;
}

/** done when every question has a decision, needs_review when at least one fell between the thresholds. */
export function statusOf(decisions: Readonly<Record<string, Decision>>): RecordStatus {
  return Object.values(decisions).every((decision) => decision.kind === "decided")
    ? "done"
    : "needs_review";
}

/**
 * The questions of the set that `entry` has an answer for, in set order: the set a card is judged
 * on when its answer predates a question added since (the added question has no answer until its
 * backfill). `decideRecord` over this set decides every question the answer carries and never
 * returns undefined; for a complete answer it is the whole set, so nothing changes for it. A
 * question the answer has and the set no longer has is left out, since a removed question is not
 * asked.
 */
export function answeredSet(questionSet: QuestionSet, entry: AnswerEntry): QuestionSet {
  return {
    ...questionSet,
    questions: questionSet.questions.filter(
      (question) => entry.answers[question.name] !== undefined,
    ),
  };
}
