import type { RecordKey } from "../contracts/index.ts";
import { type Answer, choiceConfidence, type Decision } from "../thresholds/index.ts";

// "A card opened by a reviewer is locked for 10 minutes, renewed while it stays open, so nobody
// else sees it meanwhile."
export const REVIEW_LOCK_MS = 10 * 60_000;

// An open card renews its lease every 60 seconds (the screen's and the terminal's cadence; the
// queue extends a lease only when asked).
export const REVIEW_RENEW_EVERY_MS = 60_000;

/**
 * One card of the review queue: a record that needs a person. The state hash is the version of the
 * record the card shows, so a withdrawal at an older hash leaves a newer card alone.
 */
export type ReviewEntry = {
  /** The source's id in the store (`<project>:<name>`). */
  readonly source: string;
  readonly key: RecordKey;
  readonly stateHash: string;
  /** The questions still undecided, in question-set order. */
  readonly openQuestions: readonly string[];
  /**
   * The model's figure for each open question: a noul's yes probability, a choice's or a score's
   * confidence, in [0, 1]. What the probability band filter reads.
   */
  readonly numbers: Readonly<Record<string, number>>;
  /** When the record began waiting: the time of the answer that sent it to review. */
  readonly since: Date;
};

/** One source's card, as the worker of that source writes it. */
export type SourceReviewEntry = Omit<ReviewEntry, "source">;

/** A reviewer's lease on a card. */
export type ReviewLock = { readonly by: string; readonly until: Date };

/** A card as a viewer lists it: its lease, and whether this viewer skipped it. */
export type ReviewCard = ReviewEntry & {
  /** The viewer's lease, or an expired one, or null when nobody took the card; never another reviewer's live one. */
  readonly lock: ReviewLock | null;
  /** This viewer skipped the card: it is listed after every card they did not skip. */
  readonly skipped: boolean;
};

/** What `list` narrows the queue to (the screen's filters; `facetdb review --source --question --below --limit`). */
/** What `ReviewQueue.count` answers: the cards the viewer may open, and when the oldest arrived. */
export type QueueCount = {
  readonly count: number;
  /** The oldest card's `since`; undefined when none waits. */
  readonly oldestSince: Date | undefined;
};

export type ReviewFilter = {
  readonly source?: string;
  /** Only cards on which this question is still open. */
  readonly question?: string;
  /**
   * Only cards with an open question whose figure is strictly below this (with `question`, that
   * question's figure).
   */
  readonly below?: number;
  /** One record's card alone (with `source`): the open of a named record reads no other card. */
  readonly key?: RecordKey;
  readonly limit?: number;
};

/**
 * What a lock or a renewal did: the viewer holds the card until `until`; another reviewer's lease
 * has not expired; (a renewal only) the viewer's lease is gone, released or replaced by a newer
 * card; or the card left the queue.
 */
export type LockResult =
  | { readonly kind: "locked"; readonly until: Date }
  | { readonly kind: "held"; readonly by: string; readonly until: Date }
  | { readonly kind: "lost" }
  | { readonly kind: "gone" };

/**
 * The review queue: one row per record that needs review, across the project's sources, kept by the
 * worker's writes and read by the review screen and the terminal. Every lease is compared with the
 * `nowMs` the caller's clock gives, never a server's time, so a lease expires on the clock alone.
 */
export type ReviewQueue = {
  /**
   * Adds the card, or refreshes it. At the same state hash it is the same card: its open questions
   * and numbers are replaced, its `since`, lease and skips kept. At another hash it is a new card:
   * the old one's lease and skips go with the old one.
   */
  upsert(entry: ReviewEntry): Promise<void>;
  /** Takes the record's card out of the queue, whatever its hash (the record left review). */
  remove(source: string, key: RecordKey): Promise<void>;
  /**
   * Takes the card out only while it is still the one at `stateHash`; a card at a newer hash stays.
   * Safe to call twice.
   */
  withdraw(source: string, key: RecordKey, stateHash: string): Promise<void>;
  /**
   * The cards the viewer may open, oldest first: a card another reviewer holds under a live lease is
   * left out, and the cards this viewer skipped come after the rest.
   */
  list(filter: ReviewFilter, viewer: string, nowMs: number): Promise<readonly ReviewCard[]>;
  /**
   * How many cards `list` would give the viewer under the filter, and the oldest's `since`, in one
   * statement that carries no card: the studio's count beside Review and the top bar's figures ask
   * this every few seconds and on every decision, and read the queue's rows only for the page shown
   * (two full listings of 1,660 cards a click, the Review page's own slowness).
   */
  count(filter: Omit<ReviewFilter, "limit">, viewer: string, nowMs: number): Promise<QueueCount>;
  /**
   * Takes the card for `REVIEW_LOCK_MS` from `nowMs`; refused (`held`) while another reviewer's
   * lease has not expired. The viewer's own lease is extended.
   */
  lock(source: string, key: RecordKey, viewer: string, nowMs: number): Promise<LockResult>;
  /** Extends the viewer's own lease to `REVIEW_LOCK_MS` from `nowMs`; `lost` when it is no longer theirs. */
  renew(source: string, key: RecordKey, viewer: string, nowMs: number): Promise<LockResult>;
  /** Lets go of the viewer's lease; another reviewer's is left alone. */
  release(source: string, key: RecordKey, viewer: string): Promise<void>;
  /**
   * The card goes behind the rest for this viewer only, and their lease is released; other
   * reviewers keep seeing it in its place.
   */
  skip(source: string, key: RecordKey, viewer: string): Promise<void>;
};

/**
 * The worker's side of the queue, for the one source it answers: after every write that lands, a
 * needs_review record's card is added or refreshed and any other status removes it; a record whose
 * state changed while it waited has its card withdrawn at the old hash.
 */
export type SourceReviews = {
  upsert(entry: SourceReviewEntry): Promise<void>;
  remove(key: RecordKey): Promise<void>;
  /** The card at `stateHash` leaves the queue; it must be safe to call twice, since a retry may repeat it. */
  withdraw(key: RecordKey, stateHash: string): Promise<void>;
};

/** The queue as one source's worker sees it. */
export function reviewsOf(queue: ReviewQueue, source: string): SourceReviews {
  return {
    upsert: (entry) => queue.upsert({ source, ...entry }),
    remove: (key) => queue.remove(source, key),
    withdraw: (key, stateHash) => queue.withdraw(source, key, stateHash),
  };
}

/**
 * The model's figure for an answer, the one the decision rule compares: a noul's yes probability, a
 * choice's confidence, a score's confidence.
 */
export function answerFigure(answer: Answer): number {
  switch (answer.type) {
    case "noul":
      return answer.probability;
    case "choice":
      return choiceConfidence(answer.probabilities);
    case "score":
      return answer.confidence;
  }
}

/**
 * The card of a record decided needs_review: the questions left to a person, in the decisions'
 * order, each with the model's figure from `answers`, the answer the decisions were made from.
 */
export function reviewEntryOf(input: {
  readonly key: RecordKey;
  readonly stateHash: string;
  readonly decisions: Readonly<Record<string, Decision>>;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly since: Date;
}): SourceReviewEntry {
  const openQuestions: string[] = [];
  const numbers: Record<string, number> = {};
  for (const [name, decision] of Object.entries(input.decisions)) {
    if (decision.kind !== "needs_review") {
      continue;
    }
    const answer = input.answers[name];
    if (answer === undefined) {
      throw new Error(`the question "${name}" is left for review, but the answer has none for it`);
    }
    openQuestions.push(name);
    numbers[name] = answerFigure(answer);
  }
  return {
    key: input.key,
    stateHash: input.stateHash,
    openQuestions,
    numbers,
    since: input.since,
  };
}
