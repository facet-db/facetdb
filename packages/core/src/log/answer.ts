import type { DecisionLog, WriteResult } from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import type { DecisionWriter } from "./human.ts";
import type { AnswerEntry } from "./model.ts";
import { decideRecord, statusOf } from "./record-decisions.ts";

/**
 * Logs one model call and then writes the decisions it leads to: the entry is appended first, so
 * a crash between the two steps leaves an answer nobody lost and a row that is merely behind,
 * which re-apply can catch up, and never a decision the log cannot explain. A person's decision
 * on the same state stands over the new answer. The write lands only while the record's state
 * hash still equals the one the model was shown.
 */
export async function recordAnswer(
  entry: AnswerEntry,
  questionSet: QuestionSet,
  log: DecisionLog,
  write: DecisionWriter,
): Promise<WriteResult> {
  await log.appendAnswer(entry);
  const decisions = decideRecord(
    questionSet,
    questionSet.thresholds,
    entry,
    await log.history(entry.key),
  );
  if (decisions === undefined) {
    throw new Error(`the model's answer for "${entry.key}" lacks a question of the set`);
  }
  return write(entry.key, { decisions, status: statusOf(decisions) }, entry.stateHash);
}
