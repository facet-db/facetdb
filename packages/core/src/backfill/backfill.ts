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
import { type StateValue, shouldSkip, transition } from "../records/index.ts";
import { buildRequest, CHARACTERS_PER_TOKEN, checkStateSize } from "../requests/index.ts";
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
  | "incomplete";

export type BackfillFailure = { readonly key: RecordKey; readonly error: unknown };

export type BackfillReport = {
  /**
   * `completed`: every page settled. `declined`: the estimate was refused, nothing was asked.
   * `stopped`: a page had failures; the cursor stays at the start of that page, so the next run
   * resumes there and asks only what is still unanswered.
   */
  readonly status: "completed" | "declined" | "stopped";
  readonly estimate: BackfillEstimate;
  /** Model calls made whose answers were logged and written. */
  readonly answered: readonly RecordKey[];
  /** Already answered at the same state (and version): not asked again. */
  readonly alreadyAnswered: readonly RecordKey[];
  /** Nothing to ask: every state field blank. */
  readonly skipped: readonly RecordKey[];
  /** The record changed while the model was answering: the answer is logged, the row untouched. */
  readonly discarded: readonly RecordKey[];
  /** State too large to send. */
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
  const { connector, worker, clock, cursorStore, log, questionSet, version } = deps;

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
      records += page.rows.length;
      for (const row of page.rows) {
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

    async function settle(row: ReadRow): Promise<void> {
      try {
        const prior = await log.latestAnswer(row.key);
        if (shouldSkip(questionSet.read, row.state, { filterExcluded: false }).skip) {
          if (only === undefined) {
            await writeBlank(row);
            report.skipped.push(row.key);
          }
          return;
        }
        if (
          only === undefined ? isCurrent(prior, row, asked, version) : hasAll(prior, row, asked)
        ) {
          report.alreadyAnswered.push(row.key);
          return;
        }
        if (only !== undefined) {
          const reason = deferral(prior, row, questionSet, only);
          if (reason !== undefined) {
            report.deferred.push({ key: row.key, reason });
            return;
          }
        }
        const size = checkStateSize(
          recordTokens({ ...questionSet, questions: asked }, row.state),
          deps.maxStateTokens,
        );
        if (size.kind === "refuse") {
          // The model is not called: an oversize state is an error for the record, never an answer.
          if (only === undefined) {
            await connector.write(
              row.key,
              { decisions: {}, status: transition("pending", "model-error") },
              row.hash,
            );
          }
          report.refused.push(row.key);
          return;
        }
        await waitForTurn();
        const response = await worker.ask({
          model: questionSet.model,
          state: row.state,
          questions: asked,
        });
        // Every other question keeps the answer it already has, so its decision is the one it had.
        const kept = only === undefined || prior === undefined ? {} : prior.answers;
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
        (result.written ? report.answered : report.discarded).push(row.key);
      } catch (error) {
        report.failures.push({ key: row.key, error });
      }
    }

    async function writeBlank(row: ReadRow): Promise<void> {
      const result = await connector.write(
        row.key,
        { decisions: {}, status: transition("pending", "skipped") },
        row.hash,
      );
      if (!result.written) {
        report.discarded.push(row.key);
      }
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
        return report;
      }
      await cursorStore.save(runKey, { cursor: page.next, done: page.next === null });
      report.cursor = page.next;
      options.onPage?.({ records: page.rows.length, cursor: page.next });
      cursor = page.next;
    } while (cursor !== null);

    report.status = "completed";
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
    answered: [],
    alreadyAnswered: [],
    skipped: [],
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
