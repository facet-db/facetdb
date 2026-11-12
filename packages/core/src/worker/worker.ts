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
import {
  type AnswerEntry,
  answersCurrentFor,
  decideRecord,
  recordAnswer,
  standingHuman,
  statusOf,
} from "../log/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { type RecordStatus, shouldSkip, transition } from "../records/index.ts";
import { checkStateSize, estimateRequestTokens, estimateTokens } from "../requests/index.ts";
import { type ReservationId, SpendingAlertError, type SpendingGate } from "../spending/index.ts";
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

/**
 * What the retry window decides about a record whose model call failed: `retry` keeps it queued
 * and pending; `error` and `unchecked` take it out of the queue with that status, to be queued
 * again by the policy.
 */
export type OutageVerdict = "retry" | "error" | "unchecked";

/**
 * The worker's side of the outage policy (`@facetdb/model` builds it; core only calls it). It
 * remembers which records are held, and tells the worker when to ask them again.
 */
export type OutagePolicy = {
  /** A model call for `key` failed; what the worker does with the record. */
  failed(key: RecordKey, error: unknown): OutageVerdict;
  /** A model call for `key` succeeded; the held records to queue again if this ended an outage. */
  succeeded(key: RecordKey): readonly RecordKey[];
  /** Held records whose scheduled retry has come; each is returned once, then queued again. */
  due(): readonly RecordKey[];
  /**
   * The worker could not queue these records (the queue refused them): hold them again for the
   * next retry, so a record marked error or unchecked is never left with no retry scheduled.
   */
  hold(keys: readonly RecordKey[]): void;
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
  /** The retry window and `onOutage` policy; without it a failed call just returns the record to the queue. */
  readonly outage?: OutagePolicy;
  /**
   * The project's spending cap. Required: a worker built without one would run uncapped. A test
   * that wants no cap passes an explicit unlimited gate.
   */
  readonly spending: SpendingGate;
};

/**
 * Where in a record's path something failed: the model call, the log and write, one action, the
 * alerts module (a failed alert never changes what happened to the record), or the spending cap
 * (an unreadable cap claims nothing; an uncounted answer is still written and reported). `log` is
 * the pass reading a batch's prior answers from the decision log, which failed: the whole batch
 * went back to the queue (`key` is null).
 */
export type FailureStage = "ask" | "record" | "action" | "alert" | "spending" | "log";

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
  /** The spending gate kept this pass from asking: the project is paused (records stay queued) or its cap could not be read. */
  readonly paused: boolean;
  /** Answered, logged and written. */
  readonly written: readonly RecordKey[];
  /** Nothing to ask: every state field blank (written as skipped). */
  readonly skipped: readonly RecordKey[];
  /**
   * Already answered at this state under this question-set version, every question present (a
   * backfill can queue a record the worker has just answered): no model call; the logged answer's
   * decisions were written again, still guarded by the hash, the actions ran, and the job acked.
   */
  readonly alreadyAnswered: readonly RecordKey[];
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
  /** The model stayed down past the retry window: marked `error` (hold) or `unchecked` (release) and left the queue. */
  readonly held: readonly { readonly key: RecordKey; readonly status: "error" | "unchecked" }[];
  /** Held records queued again, on their 5-minute schedule or because the model came back. */
  readonly requeued: readonly RecordKey[];
  readonly failures: readonly RecordFailure[];
};

/** A person decided a question: the reviewer's write already landed, now the actions run again. */
export type HumanDecisionNotice = {
  readonly key: RecordKey;
  /** The state hash the reviewer saw. */
  readonly stateHash: string;
  readonly status: RecordStatus;
  readonly decisions: ActionDecisions;
  /** The `at` of the person's logged decision: the time the actions report, not when they run. */
  readonly decidedAt: Date;
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
    outage,
    spending,
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
    decidedAt: Date,
  ): Promise<RecordFailure[]> {
    const record: ActionRecord = { key: row.key, state: row.state, status, decidedAt };
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
   * question to a person. `prior` is that latest answer, read with the rest of the batch's.
   */
  async function withdrawStaleReview(
    row: ReadRow,
    prior: AnswerEntry | undefined,
  ): Promise<boolean> {
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

  /**
   * Checked before every claim. A paused project claims nothing; a cap that cannot be read fails
   * closed, so no money is spent on an unknown cap. A failed alert is reported, but the gate still
   * decides with the status it was settled at, so an alert outage neither stops a project that may
   * answer nor lets a request past the cap.
   */
  async function spendingAllows(report: MutablePass): Promise<boolean> {
    try {
      return await spending.allowsWork((error) => {
        report.failures.push({ key: null, stage: "alert", error });
      });
    } catch (error) {
      report.failures.push({ key: null, stage: "spending", error });
      return false;
    }
  }

  /**
   * Checked before every request to the model. The gate counts every request admitted for the
   * project and not yet counted, from any worker bound to the same spending, and if the request
   * may go it reserves this one's estimate. A request that is admitted and crosses the cap still
   * finishes.
   */
  async function admit(
    report: MutablePass,
    requestTokens: number,
  ): Promise<ReservationId | undefined> {
    try {
      return await spending.admit(requestTokens, (error) => {
        report.failures.push({ key: null, stage: "alert", error });
      });
    } catch (error) {
      report.failures.push({ key: null, stage: "spending", error });
      return undefined;
    }
  }

  /** Releases the reservation of a request that produced no answer. A failure is reported. */
  async function release(
    report: MutablePass,
    key: RecordKey,
    reservation: ReservationId,
  ): Promise<void> {
    try {
      await spending.settle(reservation);
    } catch (error) {
      report.failures.push({ key, stage: "spending", error });
    }
  }

  /**
   * Counts one answer's input tokens and releases its reservation, in one store call. A failure is
   * reported; the answer is still written, since it was paid for.
   */
  async function countSpend(
    report: MutablePass,
    key: RecordKey,
    reservation: ReservationId,
    inputTokens: number,
  ): Promise<void> {
    try {
      await spending.finish(reservation, inputTokens);
    } catch (error) {
      // The count is stored before the alert is raised, so an alert failure leaves nothing uncounted.
      const stage = error instanceof SpendingAlertError ? "alert" : "spending";
      report.failures.push({ key, stage, error });
    }
  }

  /** Queues held records again; a failure is handed back, and the policy will not offer them twice. */
  async function requeue(report: MutablePass, keys: readonly RecordKey[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await connector.enqueue(keys);
      report.requeued.push(...keys);
    } catch (error) {
      // The policy has already let these keys go; it takes them back for the next retry.
      outage?.hold(keys);
      report.failures.push({ key: null, stage: "record", error });
    }
  }

  /**
   * The model call failed and the outage policy says the retry window is spent: the record gets its
   * status through `write`, still guarded by the hash it was read with, and leaves the queue.
   */
  async function hold(
    row: ReadRow,
    verdict: "error" | "unchecked",
    report: MutablePass,
  ): Promise<Settled> {
    const event = verdict === "error" ? "model-error" : "released-unchecked";
    const result = await connector.write(
      row.key,
      { decisions: {}, status: transition("pending", event) },
      row.hash,
    );
    if (!result.written) {
      report.discarded.push(row.key);
      return "release";
    }
    report.held.push({ key: row.key, status: verdict });
    return "ack";
  }

  /**
   * A record answered at its current state under this version is not asked twice. A backfill can
   * queue one the worker has just answered, a lost ack hands a whole answered batch out again, and
   * a write that failed (or a crash) after the answer was logged leaves the row behind. The worker
   * cannot tell these apart, so it does what covers all of them: the logged answer's decisions
   * (with the people's decisions on this state laid over them), written again and followed by the
   * actions. Undefined when the record must be asked: no answer, another state, another version, or
   * a question the answer lacks. `decidedAt` is the latest logged entry behind the decisions: the
   * answer, or a person's decision on its state made after it.
   */
  async function currentDecision(
    row: ReadRow,
    prior: AnswerEntry | undefined,
  ): Promise<{ readonly decision: RecordDecision; readonly decidedAt: Date } | undefined> {
    if (
      prior === undefined ||
      !answersCurrentFor(prior, {
        stateHash: row.hash,
        questions: questionSet.questions,
        version,
      })
    ) {
      return undefined;
    }
    const history = await log.history(row.key);
    const decisions = decideRecord(questionSet, questionSet.thresholds, prior, history);
    if (decisions === undefined) {
      return undefined;
    }
    // The later of the answer and the people's decisions that stand on it, by the rule
    // `decideRecord` applies: a retired decision, or one on a question no longer asked, moves nothing.
    let decidedAt = prior.at;
    for (const question of questionSet.questions) {
      const human = standingHuman(history, question.name, prior.stateHash);
      if (human !== undefined && human.at > decidedAt) {
        decidedAt = human.at;
      }
    }
    return { decision: { decisions, status: statusOf(decisions) }, decidedAt };
  }

  async function processRecord(
    row: ReadRow,
    prior: AnswerEntry | undefined,
    report: MutablePass,
  ): Promise<Settled> {
    let stage: FailureStage = "record";
    try {
      if (await withdrawStaleReview(row, prior)) {
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

      const current = await currentDecision(row, prior);
      if (current !== undefined) {
        const { decision, decidedAt } = current;
        const result = await connector.write(row.key, decision, row.hash);
        if (!result.written) {
          // The state changed since: the record is asked again with it, and nothing runs now.
          report.discarded.push(row.key);
          return "release";
        }
        report.alreadyAnswered.push(row.key);
        // The actions follow every write that lands. After a lost ack they run again, at least
        // once, as they did when the record was asked again, and report the logged decision's time,
        // not this run's.
        report.failures.push(
          ...(await runActions(row, decision.status, decision.decisions, decidedAt)),
        );
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

      // Checked per request, not once per pass, so a batch cannot carry a project past its cap. A
      // record that may not be asked goes back to the queue, still pending. An admitted request
      // reserves its estimated cost until its answer is counted, so the lanes of a pass cannot all
      // pass.
      const requestTokens = estimateRequestTokens({
        model: questionSet.model,
        state: row.state,
        questions: questionSet.questions,
      });
      const reservation = await admit(report, requestTokens);
      if (reservation === undefined) {
        report.paused = true;
        return "release";
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
        // No answer, so nothing to count: the reservation gives way to nothing.
        await release(report, row.key, reservation);
        await tell(report, row.key, (signals) => signals.modelCall(false));
        const verdict = outage?.failed(row.key, error) ?? "retry";
        if (verdict === "retry") {
          throw error;
        }
        // The failure stays in the report; the record is held instead of retried at once.
        report.failures.push({ key: row.key, stage, error });
        stage = "record";
        return await hold(row, verdict, report);
      }
      // Paid for: the reservation gives way to the count, in one store call.
      await countSpend(report, row.key, reservation, response.usage.inputTokens);
      await tell(report, row.key, (signals) => signals.modelCall(true));
      await requeue(report, outage?.succeeded(row.key) ?? []);

      stage = "record";
      const entry: AnswerEntry = {
        kind: "answer",
        key: row.key,
        version,
        model: response.model,
        stateHash: row.hash,
        answers: response.answers,
        usage: response.usage,
        at: new Date(clock.now()),
      };
      // The only door to the database: `recordAnswer` logs, decides and writes with this hash. A record
      // with no logged answer has no person's decision either (a person decides on a logged answer,
      // applyHumanDecision), so its log before this entry is known to be empty and is not read again.
      const writes: RecordDecision[] = [];
      const result = await recordAnswer(
        entry,
        questionSet,
        log,
        async (key, decision, hash) => {
          writes.push(decision);
          return connector.write(key, decision, hash);
        },
        prior === undefined ? [] : undefined,
      );
      const [written] = writes;
      if (!result.written || written === undefined) {
        // The record changed while in flight: the answer is discarded and the record queued again.
        report.discarded.push(row.key);
        return "release";
      }
      report.written.push(row.key);

      // The write above is the default action; the rest follow it.
      report.failures.push(...(await runActions(row, written.status, written.decisions, entry.at)));
      return "ack";
    } catch (error) {
      report.failures.push({ key: row.key, stage, error });
      return "release";
    }
  }

  async function runOnce(): Promise<PassReport> {
    const report = newPass(0);
    // A held record is asked again every 5 minutes while the model is down.
    await requeue(report, outage?.due() ?? []);
    // A paused project keeps its records queued: nothing is claimed, so nothing is lost.
    const allowed = await spendingAllows(report);
    report.paused = !allowed;
    const claimed = allowed ? await connector.claim(limits.claimBatch) : [];
    // The queue holds one entry per record, but a connector may repeat a key in a batch.
    const keys = [...new Set(claimed)];
    report.claimed = keys.length;
    // The worker is alive whether or not the queue had anything for it, or was allowed to take it.
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
    // The batch's latest answers in one call, not one per record: a far database charges every round
    // trip, and a record needs its prior to withdraw a stale review, to skip itself, and to know its
    // log is empty. A lookup that fails is a failed pass, as it was when each record looked itself
    // up: the batch goes back to the queue whole and `run` waits a poll before the next pass.
    let priors: ReadonlyMap<RecordKey, AnswerEntry>;
    try {
      priors = rows.length === 0 ? new Map() : await log.latestAnswers(rows.map((row) => row.key));
    } catch (error) {
      await connector.release(keys);
      report.failures.push({ key: null, stage: "log", error });
      return report;
    }
    report.gone.push(...missing);
    const toAck: RecordKey[] = [...missing];
    const toRelease: RecordKey[] = [];

    await forEachLimited(rows, limits.maxInFlight, async (row) => {
      const settled = await processRecord(row, priors.get(row.key), report);
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
    return {
      ran: true,
      failures: await runActions(row, notice.status, notice.decisions, notice.decidedAt),
    };
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
    paused: false,
    written: [],
    skipped: [],
    alreadyAnswered: [],
    discarded: [],
    gone: [],
    withdrawn: [],
    refused: [],
    warned: [],
    held: [],
    requeued: [],
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
