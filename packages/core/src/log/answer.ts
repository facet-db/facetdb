import type { DecisionLog, WriteResult } from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import type { DecisionWriter } from "./human.ts";
import type { AnswerEntry, LogEntry } from "./model.ts";
import { decideRecord, statusOf } from "./record-decisions.ts";

/**
 * Logs one model call and then writes the decisions it leads to: the entry is appended first, so a
 * crash between the two steps leaves an answer nobody lost and a row that is merely behind, which
 * re-apply can catch up, and never a decision the log cannot explain. A person's decision on the
 * same state stands over the new answer. The write lands only while the record's state hash still
 * equals the one the model was shown.
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
): Promise<WriteResult> {
  await log.appendAnswer(entry);
  const history = before === undefined ? await log.history(entry.key) : [...before, entry];
  const decisions = decideRecord(questionSet, questionSet.thresholds, entry, history);
  if (decisions === undefined) {
    throw new Error(`the model's answer for "${entry.key}" lacks a question of the set`);
  }
  return write(entry.key, { decisions, status: statusOf(decisions) }, entry.stateHash);
}
