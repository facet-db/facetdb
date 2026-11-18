import type { RecordKey } from "../contracts/index.ts";
import type { PassReport } from "./worker.ts";

/** The run log keeps 30 days, then the worker prunes it. */
export const RUN_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** The worker prunes the run log once an hour on its clock, not on every pass. */
export const RUN_LOG_PRUNE_EVERY_MS = 60 * 60 * 1_000;

/**
 * Who did the work a run row counts: a worker pass over the queue, or one page of a backfill
 * (the dashboard names the source "a backfill page").
 */
export type RunKind = "pass" | "backfill";

/**
 * One row of the run log: a worker pass that claimed at least one record, or a backfill page that
 * queued or asked at least one.
 */
export type Run = {
  /** The source's id in the store (`<project>:<name>`), the id its log and queue are keyed by. */
  readonly source: string;
  readonly kind: RunKind;
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** Records the pass took from the queue; for a backfill page, the records it queued or asked. */
  readonly claimed: number;
  /** Asked and written with a decision that needs no person. */
  readonly answered: number;
  /** Asked and written with at least one question left to a person. */
  readonly toReview: number;
  /**
   * Records whose turn failed (the model call, the log and write, an action, the spending count) or
   * whose state was too large to send, each once, plus each failure of the pass itself.
   */
  readonly errors: number;
  /** Answers thrown away because the record changed while the model was answering. */
  readonly discarded: number;
  /** Input tokens of the model's answers in this run. */
  readonly tokens: number;
};

/**
 * Where run rows go (the store's `facetdb.runs`). `record` writes one row; `prune` removes every
 * row that ended before `before` and nothing younger.
 */
export type RunLog = {
  record(run: Run): Promise<void>;
  prune(before: Date): Promise<void>;
};

/** A run log and the source whose runs a worker or a backfill writes to it. */
export type RunRecorder = {
  readonly log: RunLog;
  /** The source's id in the store, as `Run.source`. */
  readonly source: string;
};

/**
 * Counts the records with an error: each record once, however many stages of it failed (a held
 * record carries its model failure too), plus each failure of the pass itself (no key).
 */
export function errorCount(
  failures: readonly { readonly key: RecordKey | null }[],
  refused: readonly RecordKey[],
): number {
  const keys = new Set<RecordKey>(refused);
  let passFailures = 0;
  for (const failure of failures) {
    if (failure.key === null) {
      passFailures += 1;
    } else {
      keys.add(failure.key);
    }
  }
  return keys.size + passFailures;
}

/** The run row of a worker pass, from its report and the times it started and ended. */
export function runOfPass(
  source: string,
  report: PassReport,
  startedAtMs: number,
  endedAtMs: number,
): Run {
  return {
    source,
    kind: "pass",
    startedAt: new Date(startedAtMs),
    endedAt: new Date(endedAtMs),
    claimed: report.claimed,
    answered: report.written.length - report.toReview.length,
    toReview: report.toReview.length,
    // A failed alert never changes what happened to the record (FailureStage), so it is no error of it.
    errors: errorCount(
      report.failures.filter((failure) => failure.stage !== "alert"),
      report.refused.map((refusal) => refusal.key),
    ),
    discarded: report.discarded.length,
    tokens: report.tokens,
  };
}
