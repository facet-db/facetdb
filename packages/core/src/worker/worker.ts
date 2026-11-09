import type { AlertSignals } from "../alerts/index.ts";
import type {
  ActionDecisions,
  ActionRecord,
  Clock,
  Connector,
  DecisionLog,
  ModelProvider,
  ProviderResponse,
  ReadRow,
  RecordDecision,
  RecordKey,
} from "../contracts/index.ts";
import { type AnswerEntry, decideRecord, recordAnswer, statusOf } from "../log/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { type RecordStatus, shouldSkip, transition } from "../records/index.ts";
import { checkStateSize, estimateTokens } from "../requests/index.ts";
import type { ActionStep } from "./action-pipeline.ts";

// The batch, the in-flight cap and the poll.
export const DEFAULT_CLAIM_BATCH = 20;
export const DEFAULT_MAX_IN_FLIGHT = 8;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type WorkerLimits = {
  /** Jobs taken from the queue at once. */
  readonly claimBatch: number;
  /** Requests to the model in flight at once. */
  readonly maxInFlight: number;
  /** How long to wait for a wake-up before looking at the queue anyway. */
  readonly pollIntervalMs: number;
  /** The source's own refuse limit for a record's state; 32,000 when absent. */
  readonly maxStateTokens?: number;
};

export const DEFAULT_WORKER_LIMITS: WorkerLimits = {
  claimBatch: DEFAULT_CLAIM_BATCH,
  maxInFlight: DEFAULT_MAX_IN_FLIGHT,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

/**
 * The review screen's side of a withdrawal, for a record that changed while waiting for review.
 * `withdraw` marks the pending review of the record at `stateHash` as superseded; it must be safe
 * to call twice, because a retry may repeat it.
 */
export type ReviewQueue = {
  withdraw(key: RecordKey, stateHash: string): Promise<void>;
};

export type WorkerDeps = {
  readonly connector: Connector;
  readonly provider: ModelProvider;
  readonly log: DecisionLog;
  readonly reviews: ReviewQueue;
  /** The configured actions, in order. The write of the answer columns is not one: it always runs first. */
  readonly actions: readonly ActionStep[];
  readonly clock: Clock;
  readonly limits: WorkerLimits;
  readonly questionSet: QuestionSet;
  /** The question-set version in force; every logged answer carries it. */
  readonly version: number;
  /**
   * Where the heartbeat and the outcome of every model call go; optional so a bare worker still
   * runs.
   */
  readonly alerts?: AlertSignals;
};

/**
 * Where in a record's path something failed: the model call, the log and write, one action, or the
 * alerts module (a failed alert never changes what happened to the record).
 */
export type FailureStage = "ask" | "record" | "action" | "alert";

export type RecordFailure = {
  readonly key: RecordKey | null;
  readonly stage: FailureStage;
  /** Which action, when the stage is `action`. */
  readonly action?: string;
  readonly error: unknown;
};

/**
 * What one pass over the queue did. `failures` is the worker handing every error back to its caller
 * (the retry and outage policy belongs to the caller): a record whose model call failed was not
 * decided and has been returned to the queue.
 */
export type PassReport = {
  /** Distinct keys the pass took from the queue. */
  readonly claimed: number;
  /** Answered, logged and written. */
  readonly written: readonly RecordKey[];
  /** Nothing to ask: every state field blank (written as skipped). */
  readonly skipped: readonly RecordKey[];
  /** The record changed while the model was answering: the answer was discarded and the record queued again. */
  readonly discarded: readonly RecordKey[];
  /** Deleted before the worker reached them: left the queue, history stays in the log. */
  readonly gone: readonly RecordKey[];
  /** Pending reviews withdrawn because the record's state changed. */
  readonly withdrawn: readonly RecordKey[];
  /** State too large to send: the model was not called and the record is marked error. */
  readonly refused: readonly { readonly key: RecordKey; readonly estimate: number }[];
  /** State above the warning size but sent. */
  readonly warned: readonly { readonly key: RecordKey; readonly estimate: number }[];
  readonly failures: readonly RecordFailure[];
};

/** A person decided a question: the reviewer's write already landed, now the actions run again. */
export type HumanDecisionNotice = {
  readonly key: RecordKey;
  /** The state hash the reviewer saw. */
  readonly stateHash: string;
  readonly status: RecordStatus;
  readonly decisions: ActionDecisions;
};

export type HumanDecisionOutcome = {
  /** False when the record is gone or changed since: its actions belong to the next answer. */
  readonly ran: boolean;
  readonly failures: readonly RecordFailure[];
};

export type Worker = {
  /** Takes one batch from the queue and settles it. */
  runOnce(): Promise<PassReport>;
  /** Runs passes until `signal` aborts; `onPass` sees each report, including its failures. */
  run(signal: AbortSignal, onPass?: (report: PassReport) => void): Promise<void>;
  /** Runs the configured actions again after a person's decision. */
  onHumanDecision(notice: HumanDecisionNotice): Promise<HumanDecisionOutcome>;
};

type Settled = "ack" | "release";

type Wake = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

/**
 * The worker loop: claim, read, ask, decide, log, write if the hash still matches, run the
 * actions, ack. Pure orchestration; every side effect enters through `deps`.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const {
    connector,
    provider,
    log,
    reviews,
    actions,
    clock,
    limits,
    questionSet,
    version,
    alerts,
  } = deps;

  /** An alert that cannot be sent or stored is handed back as a failure; the record is unaffected. */
  async function tell(
    report: MutablePass,
    key: RecordKey | null,
    send: (signals: AlertSignals) => Promise<void>,
  ): Promise<void> {
    if (alerts === undefined) {
      return;
    }
    try {
      await send(alerts);
    } catch (error) {
      report.failures.push({ key, stage: "alert", error });
    }
  }

  async function runActions(
    row: ReadRow,
    status: RecordStatus,
    decisions: ActionDecisions,
  ): Promise<RecordFailure[]> {
    const record: ActionRecord = { key: row.key, state: row.state, status };
    const failures: RecordFailure[] = [];
    // Step 7: one action failing does not keep the others from running.
    for (const step of actions) {
      try {
        await step.run(record, decisions);
      } catch (error) {
        failures.push({ key: row.key, stage: "action", action: step.name, error });
      }
    }
    return failures;
  }

  /**
   * A record changed while waiting for review has its pending review withdrawn. The record counts
   * as waiting when its latest logged answer, with the people's decisions on it, still leaves a
   * question to a person.
   */
  async function withdrawStaleReview(row: ReadRow): Promise<boolean> {
    const prior = await log.latestAnswer(row.key);
    if (prior === undefined || prior.stateHash === row.hash) {
      return false;
    }
    const decisions = decideRecord(
      questionSet,
      questionSet.thresholds,
      prior,
      await log.history(row.key),
    );
    if (decisions !== undefined && statusOf(decisions) === "done") {
      return false;
    }
    await reviews.withdraw(row.key, prior.stateHash);
    return true;
  }

  async function processRecord(row: ReadRow, report: MutablePass): Promise<Settled> {
    let stage: FailureStage = "record";
    try {
      if (await withdrawStaleReview(row)) {
        report.withdrawn.push(row.key);
      }

      if (shouldSkip(questionSet.read, row.state, { filterExcluded: row.excluded }).skip) {
        const result = await connector.write(
          row.key,
          { decisions: {}, status: transition("pending", "skipped") },
          row.hash,
        );
        if (!result.written) {
          report.discarded.push(row.key);
          return "release";
        }
        report.skipped.push(row.key);
        return "ack";
      }

      const estimate = estimateTokens(row.state);
      const size = checkStateSize(estimate, limits.maxStateTokens);
      if (size.kind === "refuse") {
        // The model is not called: an oversize state is an error for the record, never an answer.
        const result = await connector.write(
          row.key,
          { decisions: {}, status: transition("pending", "model-error") },
          row.hash,
        );
        if (!result.written) {
          report.discarded.push(row.key);
          return "release";
        }
        report.refused.push({ key: row.key, estimate });
        return "ack";
      }
      if (size.kind === "warn") {
        report.warned.push({ key: row.key, estimate });
      }

      stage = "ask";
      let response: ProviderResponse;
      try {
        response = await provider.ask({
          model: questionSet.model,
          state: row.state,
          questions: questionSet.questions,
        });
      } catch (error) {
        await tell(report, row.key, (signals) => signals.modelCall(false));
        throw error;
      }
      await tell(report, row.key, (signals) => signals.modelCall(true));

      stage = "record";
      const entry: AnswerEntry = {
        kind: "answer",
        key: row.key,
        version,
        model: questionSet.model,
        stateHash: row.hash,
        answers: response.answers,
        usage: response.usage,
        at: new Date(clock.now()),
      };
      // The only door to the database: `recordAnswer` logs, decides and writes with this hash.
      const writes: RecordDecision[] = [];
      const result = await recordAnswer(entry, questionSet, log, async (key, decision, hash) => {
        writes.push(decision);
        return connector.write(key, decision, hash);
      });
      const [written] = writes;
      if (!result.written || written === undefined) {
        // The record changed while in flight: the answer is discarded and the record queued again.
        report.discarded.push(row.key);
        return "release";
      }
      report.written.push(row.key);

      // The write above is the default action; the rest follow it.
      report.failures.push(...(await runActions(row, written.status, written.decisions)));
      return "ack";
    } catch (error) {
      report.failures.push({ key: row.key, stage, error });
      return "release";
    }
  }

  async function runOnce(): Promise<PassReport> {
    const claimed = await connector.claim(limits.claimBatch);
    // The queue holds one entry per record, but a connector may repeat a key in a batch.
    const keys = [...new Set(claimed)];
    const report = newPass(keys.length);
    // The worker is alive whether or not the queue had anything for it.
    await tell(report, null, (signals) => signals.beat());
    if (keys.length === 0) {
      return report;
    }

    let rows: readonly ReadRow[];
    let missing: readonly RecordKey[];
    try {
      ({ rows, missing } = await connector.read(keys));
    } catch (error) {
      await connector.release(keys);
      throw error;
    }
    report.gone.push(...missing);
    const toAck: RecordKey[] = [...missing];
    const toRelease: RecordKey[] = [];

    await forEachLimited(rows, limits.maxInFlight, async (row) => {
      const settled = await processRecord(row, report);
      (settled === "ack" ? toAck : toRelease).push(row.key);
    });

    if (toAck.length > 0) {
      await connector.ack(toAck);
    }
    if (toRelease.length > 0) {
      await connector.release(toRelease);
    }
    return report;
  }

  async function run(signal: AbortSignal, onPass?: (report: PassReport) => void): Promise<void> {
    const iterator = connector.watch()[Symbol.asyncIterator]();
    const nextWake = (): Promise<Wake> =>
      iterator.next().then(
        (): Wake => ({ failed: false }),
        (error: unknown): Wake => ({ failed: true, error }),
      );
    let wake = nextWake();
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      while (!signal.aborted) {
        const report = await runOnce();
        onPass?.(report);
        if (report.claimed > 0 && report.failures.length === 0) {
          continue;
        }
        // Wake on the notification, or on the poll if one was lost.
        // After a failed pass the wait also keeps a down model from being asked in a tight loop.
        const woken = await Promise.race([
          wake,
          clock.sleep(limits.pollIntervalMs).then((): "poll" => "poll"),
          aborted,
        ]);
        if (woken === "aborted") {
          break;
        }
        if (woken !== "poll") {
          if (woken.failed) {
            throw woken.error;
          }
          wake = nextWake();
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      // A generator parked on its next change finishes only when that change comes, so do not wait.
      iterator.return?.().catch(() => undefined);
    }
  }

  async function onHumanDecision(notice: HumanDecisionNotice): Promise<HumanDecisionOutcome> {
    const { rows } = await connector.read([notice.key]);
    const [row] = rows;
    if (row === undefined || row.hash !== notice.stateHash) {
      return { ran: false, failures: [] };
    }
    return { ran: true, failures: await runActions(row, notice.status, notice.decisions) };
  }

  return { runOnce, run, onHumanDecision };
}

type MutablePass = {
  -readonly [K in keyof PassReport]: PassReport[K] extends readonly (infer T)[]
    ? T[]
    : PassReport[K];
};

function newPass(claimed: number): MutablePass {
  return {
    claimed,
    written: [],
    skipped: [],
    discarded: [],
    gone: [],
    withdrawn: [],
    refused: [],
    warned: [],
    failures: [],
  };
}

/** Runs `task` over every item with at most `limit` running at once, in the order given. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) {
        await task(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
