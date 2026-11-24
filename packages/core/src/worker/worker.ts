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
  type DecisionWriter,
  type LogEntry,
  recordAnswer,
  standingHuman,
  writeAnswer,
} from "../log/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { type RecordStatus, shouldSkip, transition } from "../records/index.ts";
import { checkStateSize, estimateRequestTokens, estimateTokens } from "../requests/index.ts";
import { followReview, type SourceReviews } from "../review/index.ts";
import { type ReservationId, SpendingAlertError, type SpendingGate } from "../spending/index.ts";
import { ActionNotQueued, type ActionStep } from "./action-pipeline.ts";
import type { HeldModel, ModelChangedError } from "./held-model.ts";
import {
  RUN_LOG_PRUNE_EVERY_MS,
  RUN_LOG_RETENTION_MS,
  type RunRecorder,
  runOfPass,
} from "./run-log.ts";

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
 * What the retry window decides about a record whose model call failed: `retry` keeps it queued and
 * pending; `error` and `unchecked` take it out of the queue with that status, to be queued again by
 * the policy.
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
  /** The review queue of this worker's source: it follows every write that lands. */
  readonly reviews: SourceReviews;
  /** The configured actions, in order. The write of the answer columns is not one: it always runs first. */
  readonly actions: readonly ActionStep[];
  readonly clock: Clock;
  readonly limits: WorkerLimits;
  readonly questionSet: QuestionSet;
  /** The question-set version in force; every logged answer carries it. */
  readonly version: number;
  /**
   * The model `version` is held to, the loop's own, shared with its check calls. Required, as the
   * spending gate is: a worker built without one would write an answer from any model.
   */
  readonly heldModel: HeldModel;
  /** Where the heartbeat and the outcome of every model call go; optional so a bare worker still runs. */
  readonly alerts?: AlertSignals;
  /** The retry window and `onOutage` policy; without it a failed call just returns the record to the queue. */
  readonly outage?: OutagePolicy;
  /**
   * The project's spending cap. Required: a worker built without one would run uncapped. A test
   * that wants no cap passes an explicit unlimited gate.
   */
  readonly spending: SpendingGate;
  /**
   * The run log: a row after every pass that claimed a record, and the hourly prune of rows older
   * than 30 days. Optional so a check call's one-record worker writes no row of its own.
   */
  readonly runs?: RunRecorder;
};

/**
 * Where in a record's path something failed: the model call, the log and write, one action, the
 * alerts module (a failed alert never changes what happened to the record), or the spending cap
 * (an unreadable cap claims nothing; an uncounted answer is still written and reported). `log` is
 * the pass reading a batch's prior answers from the decision log, which failed: the whole batch
 * went back to the queue (`key` is null). `runs` is the run log's row or prune, which failed after
 * the pass settled its records (`key` is null).
 */
export type FailureStage = "ask" | "record" | "action" | "alert" | "spending" | "log" | "runs";

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
  /**
   * When the pass began, in ms on the worker's clock (the run log's start too): every write of the
   * pass came after it (a write is proof the source reads well only from a pass begun after its
   * Connector lost access alert was raised).
   */
  readonly startedAt: number;
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
  /** Deleted before the worker reached them: left the queue and the review queue, history stays in the log. */
  readonly gone: readonly RecordKey[];
  /**
   * Records whose state changed since their latest logged answer: the review card at that answer's
   * hash, if there was one, was withdrawn.
   */
  readonly withdrawn: readonly RecordKey[];
  /** State too large to send: the model was not called and the record is marked error. */
  readonly refused: readonly { readonly key: RecordKey; readonly estimate: number }[];
  /** State above the warning size but sent. */
  readonly warned: readonly { readonly key: RecordKey; readonly estimate: number }[];
  /** The model stayed down past the retry window: marked `error` (hold) or `unchecked` (release) and left the queue. */
  readonly held: readonly { readonly key: RecordKey; readonly status: "error" | "unchecked" }[];
  /**
   * Claimed while the source is held by a changed model, so not asked: back in the queue as they
   * were, with no model call and nothing written, until the held model answers again.
   */
  readonly waiting: readonly RecordKey[];
  /**
   * When the pass ended with the source held by a changed model, the time (ms, on the worker's
   * clock) its next probe may be asked; null when it is not held. A check call answers by it.
   */
  readonly heldUntil: number | null;
  /** Held records queued again, on their 5-minute schedule or because the model came back. */
  readonly requeued: readonly RecordKey[];
  readonly failures: readonly RecordFailure[];
  /** Of `written`, the records written with at least one question left to a person. */
  readonly toReview: readonly RecordKey[];
  /** Input tokens of the model's answers in this pass, as their usage reported them. */
  readonly tokens: number;
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
    heldModel,
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
    const record: ActionRecord = {
      key: row.key,
      state: row.state,
      status,
      stateHash: row.hash,
      decidedAt,
    };
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
   * How a record whose write landed ends its claim once its steps ran: acked, unless a step could
   * not hand its action on (`ActionNotQueued`). Then the job is released, and the next pass, a poll
   * interval later (`run` waits after a pass with failures), writes the logged decision again with
   * no model call and runs every step again.
   */
  function afterActions(failures: readonly RecordFailure[]): Settled {
    return failures.some((failure) => failure.error instanceof ActionNotQueued) ? "release" : "ack";
  }

  /**
   * A record changed while waiting for review has its pending review withdrawn. Whenever the state
   * moved from its latest logged answer's (`prior`, read with the rest of the batch's), the card at
   * that answer's hash is withdrawn, whatever the thresholds in force now say of that answer: the
   * withdrawal is one delete by key and hash, a no-op when there is no card, and a card the worker
   * did not make (a rebuild's, a reviewer's undo) or made under other thresholds is withdrawn all
   * the same.
   */
  async function withdrawStaleReview(
    row: ReadRow,
    prior: AnswerEntry | undefined,
  ): Promise<boolean> {
    if (prior === undefined || prior.stateHash === row.hash) {
      return false;
    }
    await reviews.withdraw(row.key, prior.stateHash);
    return true;
  }

  /**
   * The review queue follows every write that lands, before the actions run (a failure here
   * releases the record, and the next pass writes it again and follows again), through the one
   * `followReview` the backfill and the review service share.
   */
  function follow(row: ReadRow, decision: RecordDecision, answer: AnswerEntry): Promise<void> {
    return followReview(reviews, { key: row.key, stateHash: row.hash }, decision, answer);
  }

  /**
   * The writer `writeAnswer` is handed: the connector's write, and the review queue following each
   * write that lands at once, so the queue has followed the last landed write before the log is
   * read again. A person who decides after that read follows the queue after it too.
   */
  function writeAndFollow(row: ReadRow, answer: AnswerEntry): DecisionWriter {
    return async (key, decision, expectedHash) => {
      const result = await connector.write(key, decision, expectedHash);
      if (result.written) {
        await follow(row, decision, answer);
      }
      return result;
    };
  }

  /**
   * When the decisions written from `answer` over `history` were made: the later of the answer and
   * the people's decisions that stand on it, by the rule `decideRecord` applies (a retired decision,
   * or one on a question no longer asked, moves nothing). The actions report this time.
   */
  function decidedAtOf(answer: AnswerEntry, history: readonly LogEntry[]): Date {
    let decidedAt = answer.at;
    for (const question of questionSet.questions) {
      const human = standingHuman(history, question.name, answer.stateHash);
      if (human !== undefined && human.at > decidedAt) {
        decidedAt = human.at;
      }
    }
    return decidedAt;
  }

  /**
   * A write that lands with a status other than needs_review, or a record deleted from its source,
   * takes the record's card out, whatever the worker knows of its past: one delete by key. A card
   * may outlive the log the worker reads (a purged and reinstalled source, a rebuild's card), and
   * a record written done at an unchanged hash must not leave one behind, still decidable.
   */
  async function leaveReview(key: RecordKey): Promise<void> {
    await reviews.remove(key);
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
   * The response named another model than the one this version is held to, which now holds the
   * source (`heldModel`). No answer entry is made and nothing is written; the failure stays in the
   * report, the alert is raised, and the record goes back to the queue, where it waits with the
   * source's others: the queue keeps them through a reload or a restart, whatever loop claims them
   * next.
   */
  async function modelChanged(
    row: ReadRow,
    change: ModelChangedError,
    report: MutablePass,
  ): Promise<Settled> {
    report.failures.push({ key: row.key, stage: "ask", error: change });
    await tell(report, row.key, (signals) => signals.modelChecked(change));
    return "release";
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
    await leaveReview(row.key);
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
   * a question the answer lacks (`answersCurrentFor` checks every question of the set, so
   * `writeAnswer` can decide each one). Otherwise the answer and the record's history, read once
   * here, before the write, as it always was.
   */
  async function currentAnswer(
    row: ReadRow,
    prior: AnswerEntry | undefined,
  ): Promise<{ readonly answer: AnswerEntry; readonly history: readonly LogEntry[] } | undefined> {
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
    return { answer: prior, history: await log.history(row.key) };
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
        await leaveReview(row.key);
        report.skipped.push(row.key);
        return "ack";
      }

      const current = await currentAnswer(row, prior);
      if (current !== undefined) {
        const { answer } = current;
        // A person's decision logged between the history read above and the write is written too,
        // by a second write after the read that follows the first (`writeAnswer`).
        const landed = await writeAnswer(
          answer,
          questionSet,
          log,
          writeAndFollow(row, answer),
          current.history,
        );
        if (!landed.written) {
          // The state changed since: the record is asked again with it, and nothing runs now.
          report.discarded.push(row.key);
          return "release";
        }
        const { decision } = landed;
        // The actions follow every write that lands, with the decision that landed last. After a
        // lost ack they run again, at least once, as they did when the record was asked again, and
        // report the logged decision's time, not this run's.
        const failures = await runActions(
          row,
          decision.status,
          decision.decisions,
          decidedAtOf(answer, landed.history),
        );
        report.failures.push(...failures);
        const settled = afterActions(failures);
        // Counted as settled only once its actions are handed on: a pass that only released it
        // again settles nothing, so `--once` stops instead of spinning while the store refuses.
        if (settled === "ack") {
          report.alreadyAnswered.push(row.key);
        }
        return settled;
      }

      // The source is held by a changed model (an answer of this pass, of a check call or of a
      // backfill job of the loop named another) and its probe is not due: the record waits in the
      // queue, unasked. Every record that needs no model call has been settled above.
      if (heldModel.holding !== undefined && !heldModel.probeDue()) {
        report.waiting.push(row.key);
        return "release";
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
        await leaveReview(row.key);
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
      // A held source's probe is spent here, as its request goes: of the lanes that came this far
      // together, one asks and the others wait, and a probe whose record needed no call spent
      // nothing, so the next record that needs one asks.
      if (!heldModel.mayAsk()) {
        await release(report, row.key, reservation);
        report.waiting.push(row.key);
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
      report.tokens += response.usage.inputTokens;
      stage = "record";
      // An answer from another model than the one this version is held to is never logged or
      // written. It is no failure to reach the model, so Model failing hears nothing.
      const changed = await heldModel.check(response.model);
      if (changed !== undefined) {
        return await modelChanged(row, changed, report);
      }
      await tell(report, row.key, (signals) => signals.modelCall(true));
      await tell(report, row.key, (signals) => signals.modelChecked(null));
      await requeue(report, outage?.succeeded(row.key) ?? []);

      const entry: AnswerEntry = {
        kind: "answer",
        key: row.key,
        version,
        model: response.model,
        stateHash: row.hash,
        answers: response.answers,
        // What the call asked, beside what it cost: every question of the set.
        usage: {
          ...response.usage,
          asked: questionSet.questions.map((question) => question.name),
        },
        at: new Date(clock.now()),
      };
      // The only door to the database: `recordAnswer` logs, decides and writes with this hash, then
      // reads the log once more and writes again if a person decided meanwhile. A record with no
      // logged answer has no person's decision either (a person decides on a logged answer,
      // applyHumanDecision), so its log before this entry is known to be empty and is not read
      // before the write; the read after it still catches a person's entry logged since.
      const landed = await recordAnswer(
        entry,
        questionSet,
        log,
        writeAndFollow(row, entry),
        prior === undefined ? [] : undefined,
      );
      if (!landed.written) {
        // The answer is discarded and the record queued again.
        report.discarded.push(row.key);
        return "release";
      }
      const { decision: written } = landed;
      report.written.push(row.key);
      if (written.status === "needs_review") {
        report.toReview.push(row.key);
      }

      // The write above is the default action; the rest follow it, with the decision that landed
      // last. The answer is logged and written either way; a step whose action was not handed on
      // releases the job, and the next pass hands it on from the log without asking the model.
      const failures = await runActions(
        row,
        written.status,
        written.decisions,
        decidedAtOf(entry, landed.history),
      );
      report.failures.push(...failures);
      return afterActions(failures);
    } catch (error) {
      report.failures.push({ key: row.key, stage, error });
      return "release";
    }
  }

  /** When this worker last pruned the run log; undefined until its first pass. */
  let prunedAtMs: number | undefined;

  /**
   * A pass that claimed at least one record leaves a row in the run log, and once an hour the
   * worker prunes the rows older than 30 days. Both come after the records are settled, so a run
   * log that cannot be written is a failure of the pass, never of a record.
   */
  async function logRun(
    recorder: RunRecorder,
    report: MutablePass,
    startedAtMs: number,
  ): Promise<void> {
    const endedAtMs = clock.now();
    if (report.claimed > 0) {
      try {
        await recorder.log.record(runOfPass(recorder.source, report, startedAtMs, endedAtMs));
      } catch (error) {
        report.failures.push({ key: null, stage: "runs", error });
      }
    }
    if (prunedAtMs !== undefined && endedAtMs - prunedAtMs < RUN_LOG_PRUNE_EVERY_MS) {
      return;
    }
    // Taken before the delete: a prune that fails is tried again in an hour, not on every pass.
    prunedAtMs = endedAtMs;
    try {
      await recorder.log.prune(new Date(endedAtMs - RUN_LOG_RETENTION_MS));
    } catch (error) {
      report.failures.push({ key: null, stage: "runs", error });
    }
  }

  async function runOnce(): Promise<PassReport> {
    const startedAtMs = clock.now();
    const report = await takeBatch(startedAtMs);
    report.heldUntil = heldModel.probeAt ?? null;
    if (deps.runs !== undefined) {
      await logRun(deps.runs, report, startedAtMs);
    }
    return report;
  }

  async function takeBatch(startedAtMs: number): Promise<MutablePass> {
    const report = newPass(startedAtMs);
    // A held record is asked again every 5 minutes while the model is down.
    await requeue(report, outage?.due() ?? []);
    // A paused project keeps its records queued: nothing is claimed, so nothing is lost.
    const allowed = await spendingAllows(report);
    report.paused = !allowed;
    // A source held by a changed model claims nothing until its probe is due, every 5 minutes; then
    // one record that needs a model call is asked and the rest wait in the queue, as a swapped
    // server bills every retry, until the probe's answer names the held model.
    const limit =
      allowed && (heldModel.holding === undefined || heldModel.probeDue()) ? limits.claimBatch : 0;
    const claimed = limit > 0 ? await connector.claim(limit) : [];
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
    const toAck: RecordKey[] = [];
    const toRelease: RecordKey[] = [];
    // A deleted record leaves the queue, its card with it (its history stays in the log). A card
    // that could not be removed keeps the job, so the next pass finds the record gone again and
    // removes it then.
    for (const key of missing) {
      try {
        await leaveReview(key);
        report.gone.push(key);
        toAck.push(key);
      } catch (error) {
        report.failures.push({ key, stage: "record", error });
        toRelease.push(key);
      }
    }

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

function newPass(startedAt: number): MutablePass {
  return {
    startedAt,
    claimed: 0,
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
    waiting: [],
    heldUntil: null,
    requeued: [],
    failures: [],
    toReview: [],
    tokens: 0,
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
