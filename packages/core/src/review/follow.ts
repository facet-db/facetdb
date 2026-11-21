import type { RecordDecision, RecordKey } from "../contracts/index.ts";
import type { AnswerEntry } from "../log/index.ts";
import { reviewEntryOf, type SourceReviews } from "./queue.ts";

/**
 * The review queue follows every write of a decision that landed, and this is the one function that
 * does it, for the worker's write, the backfill's write of an added question and the review
 * service's own, so the three cannot drift. A record left needs_review has its card added or
 * refreshed with its open questions and the model's figures from `answer`, the logged answer the
 * decisions were made from, waiting since that answer; any other status takes the card out,
 * whatever its hash (a record written done must not leave one behind, still decidable).
 */
export async function followReview(
  reviews: SourceReviews,
  record: { readonly key: RecordKey; readonly stateHash: string },
  decision: RecordDecision,
  answer: AnswerEntry,
): Promise<void> {
  if (decision.status !== "needs_review") {
    await reviews.remove(record.key);
    return;
  }
  await reviews.upsert(
    reviewEntryOf({
      key: record.key,
      stateHash: record.stateHash,
      decisions: decision.decisions,
      answers: answer.answers,
      since: answer.at,
    }),
  );
}
