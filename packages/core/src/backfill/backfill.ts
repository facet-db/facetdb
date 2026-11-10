import type { AlertSignals } from "../alerts/index.ts";
import type {
  Clock,
  Connector,
  DecisionLog,
  ProviderRequest,
  ProviderResponse,
  ReadRow,
  RecordKey,
  ScanCursor,
} from "../contracts/index.ts";
import { type AnswerEntry, recordAnswer } from "../log/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { type StateValue, shouldSkip } from "../records/index.ts";
import {
  buildRequest,
  CHARACTERS_PER_TOKEN,
  checkStateSize,
  estimateRequestTokens,
} from "../requests/index.ts";
import { type ReservationId, SpendingAlertError, type SpendingGate } from "../spending/index.ts";
import { DEFAULT_MAX_IN_FLIGHT } from "../worker/index.ts";

/** Jev charges $0.042 per million input tokens and nothing for output. */
export const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;

/** The timing target: 50 records per second per source. */
export const DEFAULT_BACKFILL_PACE = 50;

/** The estimate is made from this many states, not from the whole table. */
export const ESTIMATE_SAMPLE_SIZE = 100;

type State = Readonly<Record<string, StateValue>>;

/** Where a run stands, saved after every page so a restart resumes instead of starting over. */
export type BackfillProgress = {
  /** Where the next page starts; null at the very start or, with `done`, after the last page. */
  readonly cursor: ScanCursor | null;
  /** True once the last page was settled: the next run of the same kind starts from the top. */
  readonly done: boolean;
};

/**
 * Where backfill progress survives a restart. `run` names the kind of run (the whole set at one
 * question-set version, or one set of added questions), so two kinds never share a cursor.
 */
export type CursorStore = {
  load(run: string): Promise<BackfillProgress | undefined>;
  save(run: string, progress: BackfillProgress): Promise<void>;
};

/**
 * The worker's side of a backfill: one model call for one record, under the worker's own in-flight
 * limit and backoff. It rejects on any failed call; a failed call is an error, never an answer.
 */
export type BackfillWorker = {
  ask(request: ProviderRequest): Promise<ProviderResponse>;
};

export type BackfillDeps = {
  readonly connector: Connector;
  readonly worker: BackfillWorker;
  readonly clock: Clock;
  readonly cursorStore: CursorStore;
  /** Every answer is logged before the row is written, exactly as the worker does it. */
  readonly log: DecisionLog;
  readonly questionSet: QuestionSet;
  /** The question-set version in force; every logged answer carries it. */
  readonly version: number;
  /** The source's own refuse limit for a record's state; 32,000 when absent. */
  readonly maxStateTokens?: number;
  /** Told when a run finishes or stops. */
  readonly alerts?: AlertSignals;
  /**
   * The project's spending cap. Every added-question call is admitted and counted through it, as
   * the worker's are. Required: a backfill built without one would run uncapped.
   */
  readonly spending: SpendingGate;
};

/** The states `estimate` reads, and how many records they stand for. */
export type BackfillSample = {
  /** Every record the run will visit. */
  readonly records: number;
  /** Up to 100 of their states. */
  readonly states: readonly State[];
};

export type BackfillEstimate = {
  readonly records: number;
  /** How many states the average was taken over. */
  readonly sampled: number;
  /** The average input tokens one record costs; a record with nothing to ask costs none. */
  readonly tokensPerRecord: number;
  readonly tokens: number;
  readonly dollars: number;
};

export type BackfillOptions = {
  /** Records started per second. */
  readonly pace?: number;
  /** Ask only these questions and merge the decisions into the records' existing ones. */
  readonly onlyQuestions?: readonly string[];
  /**
   * Shows the cost before anything is asked. Returning false stops the run with no model call and
   * no change to the cursor.
   */
  readonly onEstimate: (estimate: BackfillEstimate) => boolean | Promise<boolean>;
  /** Called after each settled page, with the cursor just saved. */
  readonly onPage?: (page: PageProgress) => void;
  /** Model calls in flight at once; the worker's default of 8 when absent. */
  readonly maxInFlight?: number;
};

export type PageProgress = {
  readonly records: number;
  /** The saved cursor, or null after the last page. */
  readonly cursor: ScanCursor | null;
};

/** Why a record was left for the worker's normal path instead of being asked by an added-question run. */
export type DeferredReason =
  /** Never answered: the worker will ask it with the whole set. */
  | "unanswered"
  /** Its state changed since it was last answered: the worker will ask it with the whole set. */
  | "stale"
  /** Another question has no stored answer to merge with. */
  | "incomplete"
  /** Already in the queue: a worker holds it or will, and asks it with the whole set. */
  | "queued";

export type BackfillFailure = { readonly key: RecordKey; readonly error: unknown };

export type BackfillReport = {
  /**
   * `completed`: every page settled. `declined`: the estimate was refused, nothing was asked.
   * `stopped`: a page had failures; the cursor stays at the start of that page, so the next run
   * resumes there and asks only what is still unanswered. `paused`: the spending cap was reached, so
   * the run made no further call; the cursor stays at the start of that page, as with `stopped`.
   */
  readonly status: "completed" | "declined" | "stopped" | "paused";
  readonly estimate: BackfillEstimate;
  /** A whole-set run: records put in the worker's queue, which asks, skips or refuses each one. */
  readonly enqueued: readonly RecordKey[];
  /** An added-question run: model calls made whose answers were logged and written. */
  readonly answered: readonly RecordKey[];
  /** Already answered at the same state (and version): not asked again. */
  readonly alreadyAnswered: readonly RecordKey[];
  /** The record changed while the model was answering: the answer is logged, the row untouched. */
  readonly discarded: readonly RecordKey[];
  /** An added-question run: state too large to send (the worker marks the record when it gets it). */
  readonly refused: readonly RecordKey[];
  readonly deferred: readonly { readonly key: RecordKey; readonly reason: DeferredReason }[];
  readonly failures: readonly BackfillFailure[];
  /** The cursor saved last, or null when none was saved or the run finished. */
  readonly cursor: ScanCursor | null;
};

export type Backfill = {
  /**
   * What a run over `sample.records` records would cost: the average estimated input tokens of the
   * sampled states, times the records, at $0.042 per million. `onlyQuestions` prices an added
   * question alone, which is the state plus those questions' words.
   */
  estimate(
    questionSet: QuestionSet,
    sample: BackfillSample,
    onlyQuestions?: readonly string[],
  ): BackfillEstimate;
  run(options: BackfillOptions): Promise<BackfillReport>;
};

/**
 * The paced, resumable, newest-first backfill. It shows its estimate first, then pages through
 * `scan`, starts records at the pace of the injected clock, and saves the cursor after every page.
 * Pure orchestration: every side effect enters through `deps`.
 */
export function createBackfill(deps: BackfillDeps): Backfill {
  const { connector, worker, clock, cursorStore, log, questionSet, version, spending } = deps;

  function estimate(
    set: QuestionSet,
    sample: BackfillSample,
    onlyQuestions?: readonly string[],
  ): BackfillEstimate {
    const questions = pickQuestions(set, onlyQuestions);
    const priced: QuestionSet = { ...set, questions };
    let tokens = 0;
    for (const state of sample.states) {
      tokens += recordTokens(priced, state);
    }
    const tokensPerRecord = sample.states.length === 0 ? 0 : tokens / sample.states.length;
    const total = tokensPerRecord * sample.records;
    return {
      records: sample.records,
      sampled: sample.states.length,
      tokensPerRecord,
      tokens: total,
      dollars: (total * PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
    };
  }

  /** Walks the pages that remain, counting records and keeping the first 100 states. No model call. */
  async function survey(from: ScanCursor | null): Promise<BackfillSample> {
    const states: State[] = [];
    let records = 0;
    let cursor = from;
    do {
      const page = await connector.scan(cursor);
      // A record the source's filter excludes is never asked, so it costs nothing.
      const included = page.rows.filter((row) => !row.excluded);
      records += included.length;
      for (const row of included) {
        if (states.length < ESTIMATE_SAMPLE_SIZE) {
          states.push(row.state);
        }
      }
      cursor = page.next;
    } while (cursor !== null);
    return { records, states };
  }

  async function run(options: BackfillOptions): Promise<BackfillReport> {
    const pace = options.pace ?? DEFAULT_BACKFILL_PACE;
    if (!Number.isFinite(pace) || pace <= 0) {
      throw new Error(`a backfill pace is a positive number of records per second, not ${pace}`);
    }
    const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error(`a backfill keeps at least one request in flight, not ${maxInFlight}`);
    }
    const asked = pickQuestions(questionSet, options.onlyQuestions);
    const only = options.onlyQuestions === undefined ? undefined : new Set(options.onlyQuestions);
    const runKey = runKeyOf(version, options.onlyQuestions);
    // The alert names the added questions when the run asks only those, else every question.
    const askedLabel =
      options.onlyQuestions === undefined ? null : options.onlyQuestions.join(", ");

    const saved = await cursorStore.load(runKey);
    const start = saved === undefined || saved.done ? null : saved.cursor;

    const report = newReport(estimate(questionSet, await survey(start), options.onlyQuestions));
    // The cost is shown before a single record is asked; a refusal leaves everything as it was.
    if (!(await options.onEstimate(report.estimate))) {
      report.status = "declined";
      return report;
    }

    const interval = 1000 / pace;
    let nextStartAt = clock.now();
    /** Each record gets its own start time, one interval after the last, however many lanes run. */
    async function waitForTurn(): Promise<void> {
      const slot = Math.max(nextStartAt, clock.now());
      nextStartAt = slot + interval;
      const wait = slot - clock.now();
      if (wait > 0) {
        await clock.sleep(wait);
      }
    }

    /**
     * The whole set: the record goes into the worker's queue at the pace, and the worker asks it,
     * skips it or refuses it exactly as it does any change. The queue holds one entry per record,
     * so a record the worker is already asking is never answered twice.
     */
    async function enqueueWhole(row: ReadRow): Promise<void> {
      const prior = await log.latestAnswer(row.key);
      if (isCurrent(prior, row, asked, version)) {
        report.alreadyAnswered.push(row.key);
        return;
      }
      await waitForTurn();
      await connector.enqueue([row.key]);
      report.enqueued.push(row.key);
    }

    /** Set when the spending cap refuses a request: no record after it is asked, in this run. */
    let paused = false;

    async function settle(row: ReadRow): Promise<void> {
      if (paused) {
        return;
      }
      try {
        if (only === undefined) {
          await enqueueWhole(row);
          return;
        }
        if (shouldSkip(questionSet.read, row.state, { filterExcluded: row.excluded }).skip) {
          return;
        }
        const prior = await log.latestAnswer(row.key);
        if (hasAll(prior, row, asked)) {
          report.alreadyAnswered.push(row.key);
          return;
        }
        const reason = deferral(prior, row, questionSet, only);
        if (reason !== undefined) {
          report.deferred.push({ key: row.key, reason });
          return;
        }
        const size = checkStateSize(
          recordTokens({ ...questionSet, questions: asked }, row.state),
          deps.maxStateTokens,
        );
        if (size.kind === "refuse") {
          report.refused.push(row.key);
          return;
        }
        await waitForTurn();
        // Held like a worker's claim while asking, so the worker never asks the record at once.
        if (!(await connector.claimKey(row.key))) {
          report.deferred.push({ key: row.key, reason: "queued" });
          return;
        }
        // Read again under the claim: the worker may have answered the record since the first read.
        const held = await log.latestAnswer(row.key);
        if (hasAll(held, row, asked)) {
          await connector.ack([row.key]);
          report.alreadyAnswered.push(row.key);
          return;
        }
        const late = deferral(held, row, questionSet, only);
        if (late !== undefined) {
          // The worker asks it whole: back to the queue, never acked away.
          await connector.release([row.key]);
          report.deferred.push({ key: row.key, reason: late });
          return;
        }
        await askAdded(row, held);
      } catch (error) {
        report.failures.push({ key: row.key, error });
      }
    }

    /** Asks the added questions alone for a record this run holds, then acks or releases its job. */
    /**
     * Counts one answer's input tokens. A failed count is reported and the answer is still written, since
     * it was paid for. A failed alert changes nothing: the count is stored, and the alert is raised again
     * at the next check that finds the same level.
     */
    async function countSpend(row: ReadRow, inputTokens: number): Promise<void> {
      try {
        await spending.record(inputTokens);
      } catch (error) {
        if (!(error instanceof SpendingAlertError)) {
          report.failures.push({ key: row.key, error });
        }
      }
    }

    /** Releases a request's reservation; a failure is reported, and never drops the answer. */
    async function releaseSpend(row: ReadRow, reservation: ReservationId): Promise<void> {
      try {
        await spending.settle(reservation);
      } catch (error) {
        report.failures.push({ key: row.key, error });
      }
    }

    /** Asks the added questions alone for a record this run holds, then acks or releases its job. */
    async function askAdded(row: ReadRow, prior: AnswerEntry | undefined): Promise<void> {
      let written = false;
      try {
        const request: ProviderRequest = {
          model: questionSet.model,
          state: row.state,
          questions: asked,
        };
        // Admitted before the call, as the worker admits each of its requests. A refused request
        // is not made, and the run pauses; the record goes back to the queue with its claim.
        const reservation = await spending.admit(estimateRequestTokens(request));
        if (reservation === undefined) {
          paused = true;
          return;
        }
        let response: ProviderResponse;
        try {
          response = await worker.ask(request);
          await countSpend(row, response.usage.inputTokens);
        } finally {
          // Counted (or failed) by now: the reservation gives way to the count, or to nothing.
          await releaseSpend(row, reservation);
        }
        // Every other question keeps the answer it already has, so its decision is the one it had.
        const kept = prior === undefined ? {} : prior.answers;
        const entry: AnswerEntry = {
          kind: "answer",
          key: row.key,
          version,
          model: questionSet.model,
          stateHash: row.hash,
          answers: {
            ...kept,
            ...answersFor(
              response,
              asked.map((q) => q.name),
            ),
          },
          usage: response.usage,
          at: new Date(clock.now()),
        };
        const result = await recordAnswer(entry, questionSet, log, (key, decision, hash) =>
          connector.write(key, decision, hash),
        );
        written = result.written;
        (written ? report.answered : report.discarded).push(row.key);
      } finally {
        await settleClaim(row, written);
      }
    }

    /**
     * Done when written. Otherwise the job goes back to the queue only when the record changed, so
     * the worker asks it whole at its new state; an unchanged record is let go (the unsaved cursor
     * brings it back to the next run) instead of costing a whole-set call during an outage.
     */
    async function settleClaim(row: ReadRow, written: boolean): Promise<void> {
      if (written) {
        await connector.ack([row.key]);
        return;
      }
      const { rows } = await connector.read([row.key]);
      const unchanged = rows[0]?.hash === row.hash;
      await (unchanged ? connector.ack([row.key]) : connector.release([row.key]));
    }

    let cursor = start;
    do {
      const page = await connector.scan(cursor);
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < page.rows.length) {
          const row = page.rows[next++];
          if (row !== undefined) {
            await settle(row);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxInFlight, page.rows.length) }, lane));
      if (report.failures.length > 0) {
        // Not saved: the next run starts this page again and skips what was answered.
        report.status = "stopped";
        await deps.alerts?.backfillFailed({
          failed: report.failures.length,
          question: askedLabel,
        });
        return report;
      }
      if (paused) {
        // Not saved, as with a stopped run. The spending gate has already raised the pause alert.
        report.status = "paused";
        return report;
      }
      await cursorStore.save(runKey, { cursor: page.next, done: page.next === null });
      report.cursor = page.next;
      options.onPage?.({ records: page.rows.length, cursor: page.next });
      cursor = page.next;
    } while (cursor !== null);

    report.status = "completed";
    await deps.alerts?.backfillFinished({
      answered: report.answered.length,
      queued: report.enqueued.length,
      question: askedLabel,
    });
    return report;
  }

  return { estimate, run };
}

type MutableReport = {
  -readonly [K in keyof BackfillReport]: BackfillReport[K] extends readonly (infer T)[]
    ? T[]
    : BackfillReport[K];
};

function newReport(estimated: BackfillEstimate): MutableReport {
  return {
    status: "completed",
    estimate: estimated,
    enqueued: [],
    answered: [],
    alreadyAnswered: [],
    discarded: [],
    refused: [],
    deferred: [],
    failures: [],
    cursor: null,
  };
}

/** A run's identity for the cursor store: the whole set at one version, or one group of added questions. */
function runKeyOf(version: number, onlyQuestions: readonly string[] | undefined): string {
  return onlyQuestions === undefined
    ? `all@v${version}`
    : `only@v${version}:${[...onlyQuestions].sort().join(",")}`;
}

/** The questions a run asks; a name the set does not have is a caller's mistake, said plainly. */
function pickQuestions(
  set: QuestionSet,
  names: readonly string[] | undefined,
): QuestionSet["questions"] {
  if (names === undefined) {
    return set.questions;
  }
  if (names.length === 0) {
    throw new Error("a backfill of added questions names at least one question");
  }
  const unknown = names.filter((name) => !set.questions.some((q) => q.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `the question set has no question named ${unknown.map((n) => `"${n}"`).join(", ")}`,
    );
  }
  return set.questions.filter((question) => names.includes(question.name));
}

/** Input tokens one record costs: what the request holds, at 4 characters a token, rounded up. */
function recordTokens(set: QuestionSet, state: State): number {
  if (shouldSkip(set.read, state, { filterExcluded: false }).skip) {
    return 0;
  }
  const characters = Array.from(JSON.stringify(buildRequest(set, state))).length;
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

/** Already answered whole: same state, same version, every question present. */
function isCurrent(
  prior: AnswerEntry | undefined,
  row: ReadRow,
  asked: QuestionSet["questions"],
  version: number,
): boolean {
  return prior !== undefined && prior.version === version && hasAll(prior, row, asked);
}

function hasAll(
  prior: AnswerEntry | undefined,
  row: ReadRow,
  asked: QuestionSet["questions"],
): boolean {
  return (
    prior !== undefined &&
    prior.stateHash === row.hash &&
    asked.every((question) => prior.answers[question.name] !== undefined)
  );
}

/** Why an added-question run cannot merge into this record, or undefined when it can. */
function deferral(
  prior: AnswerEntry | undefined,
  row: ReadRow,
  set: QuestionSet,
  only: ReadonlySet<string>,
): DeferredReason | undefined {
  if (prior === undefined) {
    return "unanswered";
  }
  if (prior.stateHash !== row.hash) {
    return "stale";
  }
  const others = set.questions.filter((question) => !only.has(question.name));
  return others.every((question) => prior.answers[question.name] !== undefined)
    ? undefined
    : "incomplete";
}

/** The answer to each asked question; a response that lacks one is a failed call, not a partial answer. */
function answersFor(
  response: ProviderResponse,
  names: readonly string[],
): ProviderResponse["answers"] {
  const answers: Record<string, ProviderResponse["answers"][string]> = {};
  for (const name of names) {
    const answer = response.answers[name];
    if (answer === undefined) {
      throw new Error(`the model's response has no answer for "${name}"`);
    }
    answers[name] = answer;
  }
  return answers;
}
