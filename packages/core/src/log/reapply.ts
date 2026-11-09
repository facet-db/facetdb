import type { DecisionLog, RecordKey } from "../contracts/index.ts";
import type { QuestionSet, ThresholdOverride } from "../questions/index.ts";
import type { Decision } from "../thresholds/index.ts";
import type { DecisionWriter } from "./human.ts";
import { decideRecord, statusOf } from "./record-decisions.ts";

/** What one re-apply did, so the caller can say it in plain words ("12 records changed, 0 model calls"). */
export type ReapplyReport = {
  /** Records with a logged answer that were looked at. */
  readonly examined: number;
  /** Records whose decision changed and whose new decision was written. */
  readonly written: readonly RecordKey[];
  /** Records whose decisions came out the same, so nothing was written. */
  readonly unchanged: number;
  /** Records whose change was refused because the row's state moved on; they are asked again anyway. */
  readonly stale: readonly RecordKey[];
  /** Records whose latest answer lacks a question of the set: only a model call can decide those. */
  readonly unanswered: readonly RecordKey[];
};

function sameDecision(a: Decision | undefined, b: Decision): boolean {
  if (a === undefined) {
    return false;
  }
  if (a.kind === "needs_review" || b.kind === "needs_review") {
    return a.kind === b.kind;
  }
  return a.value === b.value;
}

/**
 * Applies new thresholds to what the model already said. `questionSet.thresholds` are the
 * overrides in force until now and `thresholds` the new ones; each record is decided again from
 * its latest logged answer under both, and written only where the two differ: decided to review,
 * review to decided, or another value. The model is never called, and the row's single
 * probability is never read: the log holds every probability. A question a person decided
 * against the record's current state keeps that decision, whatever the thresholds say. The write
 * lands only while the record's state hash still equals the answer's.
 */
export async function reapplyThresholds(
  questionSet: QuestionSet,
  thresholds: Readonly<Record<string, ThresholdOverride>>,
  log: DecisionLog,
  write: DecisionWriter,
): Promise<ReapplyReport> {
  const answers = await log.latestAnswersSince();
  const written: RecordKey[] = [];
  const stale: RecordKey[] = [];
  const unanswered: RecordKey[] = [];
  let unchanged = 0;
  for (const entry of answers) {
    const history = await log.history(entry.key);
    const before = decideRecord(questionSet, questionSet.thresholds, entry, history);
    const after = decideRecord(questionSet, thresholds, entry, history);
    if (before === undefined || after === undefined) {
      unanswered.push(entry.key);
    } else if (
      Object.entries(after).every(([name, decision]) => sameDecision(before[name], decision))
    ) {
      unchanged += 1;
    } else {
      const result = await write(
        entry.key,
        { decisions: after, status: statusOf(after) },
        entry.stateHash,
      );
      (result.written ? written : stale).push(entry.key);
    }
  }
  return { examined: answers.length, written, unchanged, stale, unanswered };
}
