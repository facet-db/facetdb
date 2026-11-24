import type { DecisionLog, RecordDecision, WriteResult } from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { type DecisionWriter, humanCount, standingHuman } from "./human.ts";
import type { AnswerEntry, LogEntry } from "./model.ts";
import { decideRecord, statusOf } from "./record-decisions.ts";

/** What the last write of an answer carried, and the history it was decided from. */
export type WrittenAnswer = WriteResult & {
  /** The last write's decision: the row's, when `written`. */
  readonly decision: RecordDecision;
  /** The record's log the last write was decided from: every person's entry in it is in the row. */
  readonly history: readonly LogEntry[];
};

/**
 * Logs one model call and then writes the decisions it leads to: the entry is appended first, so a
 * crash between the two steps leaves an answer nobody lost and a row that is merely behind, which
 * re-apply can catch up, and never a decision the log cannot explain. A person's decision on the
 * same state stands over the new answer, including one logged while this write was on its way
 * (`writeAnswer`). The write lands only while the record's state hash still equals the one the
 * model was shown.
 *
 * `before` is the record's log before this entry, when the caller already knows it, so the log is
 * not read again after the append; without it the history is read.
 */
export async function recordAnswer(
  entry: AnswerEntry,
  questionSet: QuestionSet,
  log: DecisionLog,
  write: DecisionWriter,
  before?: readonly LogEntry[],
): Promise<WrittenAnswer> {
  await log.appendAnswer(entry);
  const history = before === undefined ? await log.history(entry.key) : [...before, entry];
  return writeAnswer(entry, questionSet, log, write, history);
}

/**
 * Writes the decisions a logged answer leads to over `history` (the record's log as the caller read
 * it, `entry` in it), so that no person's decision logged before the last write is lost from the
 * row. The review path closes the same window against other reviewers (`applyHumanDecision`); this
 * is its pattern on the worker's side. After every write that lands, the log is read again: a
 * person's entry appended since the history the write was decided from (a decision, or a
 * withdrawal) means the row may be short of it, so the record is decided again from the new history
 * and written again under the same hash, until a read after a landed write shows no new person's
 * entry. A person's entry appended after that read is carried by that person's own write, which
 * lands after this one. With no person's entry in the window, this is one write and one read after
 * it.
 *
 * `write` is where the caller follows a landed write (the review queue), so that follow-through
 * also comes before the read: a person who closes the record after it has the last word on the
 * card too. A write that does not land ends the loop: the record changed, and its new state is
 * asked again.
 */
export async function writeAnswer(
  entry: AnswerEntry,
  questionSet: QuestionSet,
  log: DecisionLog,
  write: DecisionWriter,
  history: readonly LogEntry[],
): Promise<WrittenAnswer> {
  let decidedFrom = history;
  for (;;) {
    const decision = answerDecision(entry, questionSet, decidedFrom);
    const result = await write(entry.key, decision, entry.stateHash);
    if (!result.written) {
      return { ...result, decision, history: decidedFrom };
    }
    const after = await log.history(entry.key);
    // The log is append-only: a count that grew is a person's entry logged since.
    if (humanCount(after) === humanCount(decidedFrom)) {
      return { ...result, decision, history: decidedFrom };
    }
    decidedFrom = after;
  }
}

/**
 * The row's decision for `entry` over `history`: every question decided by the thresholds, a
 * standing person's value laid over its question, and `reviewed` set when a person's value is in
 * it, so a row that carries a person's decision says a person decided even when the person's own
 * write never landed. `restoreFromLog` compares a row with it before writing.
 */
export function answerDecision(
  entry: AnswerEntry,
  questionSet: QuestionSet,
  history: readonly LogEntry[],
): RecordDecision {
  const decisions = decideRecord(questionSet, questionSet.thresholds, entry, history);
  if (decisions === undefined) {
    throw new Error(`the model's answer for "${entry.key}" lacks a question of the set`);
  }
  const byPerson = questionSet.questions.some(
    (question) => standingHuman(history, question.name, entry.stateHash) !== undefined,
  );
  const status = statusOf(decisions);
  return byPerson ? { decisions, status, reviewed: true } : { decisions, status };
}
