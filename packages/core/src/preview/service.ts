import { PRICE_PER_MILLION_INPUT_TOKENS } from "../backfill/index.ts";
import type {
  Clock,
  Connector,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ReadRow,
  RecordKey,
  Usage,
} from "../contracts/index.ts";
import { statusOf } from "../log/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import {
  type RecordStatus,
  type SkipReason,
  type StateValue,
  shouldSkip,
} from "../records/index.ts";
import { checkStateSize, estimateRequestTokens } from "../requests/index.ts";
import {
  nextMonthOf,
  type ReservationId,
  SpendingAlertError,
  type SpendingGate,
} from "../spending/index.ts";
import { type Answer, type Decision, decide, resolveThresholds } from "../thresholds/index.ts";

/**
 * The preview ("a live preview answers the 20 most recent rows"): the newest rows of one source
 * through its connector's `scan`, one model request per row carrying every question of the set,
 * each admitted under the project's spending cap as the worker admits it, and what the set's
 * thresholds make of every answer. It writes nothing anywhere: the connector is only scanned, never
 * written, queued or claimed, and no decision is logged. Both doors call it: `facetdb preview` and
 * `POST /v1/preview`.
 */

/** The preview answers the 20 most recent rows. */
export const PREVIEW_DEFAULT_LIMIT = 20;

/** Requests in flight at once: a preview is a handful of rows, not a worker. */
export const PREVIEW_IN_FLIGHT = 4;

export type PreviewDeps = {
  /** The source's connector; the preview calls its `scan` and nothing else. */
  readonly connector: Pick<Connector, "scan">;
  readonly provider: ModelProvider;
  /** The project's spending gate, the one its workers share. */
  readonly spending: SpendingGate;
  /**
   * Hears what went wrong without changing the preview: an alert the spending cap could not raise,
   * or a count of tokens the spending module holds to write again (it is never dropped).
   */
  readonly log: (line: string) => void;
  /** The source's `maxStateTokens`; absent, core's refusal size. */
  readonly maxStateTokens?: number;
  /** Read only when the cap is reached, for the seconds until the month resets. */
  readonly clock: Clock;
  /** Requests in flight at once; absent, `PREVIEW_IN_FLIGHT`. A test of a thousand rows asks for more. */
  readonly inFlight?: number;
};

/** Why a row was shown but not asked. */
export type PreviewSkipReason =
  /** `filtered-out`: the source's `where` filter leaves it out; `empty-state`: it reads nothing. */
  | SkipReason
  /** Its state is above the size the model is sent. */
  | "too-large"
  /** The spending cap was reached while the preview ran, so this row was not asked. */
  | "spending-cap";

export type PreviewRow =
  | {
      /** A row not asked carries its key and why, never its state: the model was not shown it. */
      readonly key: RecordKey;
      readonly kind: "skipped";
      readonly reason: PreviewSkipReason;
    }
  | {
      readonly key: RecordKey;
      readonly kind: "answered";
      /** What the model was shown. */
      readonly state: Readonly<Record<string, StateValue>>;
      /** The exact version that answered, as the response named it. */
      readonly model: string;
      /** Every answer with all its probabilities, so a threshold can be re-applied without a call. */
      readonly answers: Readonly<Record<string, Answer>>;
      /** What the set's thresholds make of each answer. */
      readonly decisions: Readonly<Record<string, Decision>>;
      /** The status the row would get: done, or needs_review when a question fell between. */
      readonly status: RecordStatus;
      readonly usage: Usage;
    };

/** What the preview cost: the billable input tokens the model counted, and their price. */
export type PreviewCost = {
  readonly inputTokens: number;
  /** At $0.042 per million input tokens. */
  readonly dollars: number;
};

export type PreviewResult =
  | {
      readonly kind: "previewed";
      /** Newest first. */
      readonly rows: readonly PreviewRow[];
      /** Answered rows every question decided. */
      readonly decided: number;
      /** Answered rows at least one question sends to review. */
      readonly review: number;
      readonly cost: PreviewCost;
    }
  | {
      /** The cap was already reached: nothing was read and nothing was asked. */
      readonly kind: "capped";
      readonly message: string;
      readonly fix: string;
      /** Whole seconds until the UTC month resets and the count starts again. */
      readonly retryAfterSeconds: number;
    };

/**
 * The model failed one row: the call was refused, or its response lacks a question. A failed call
 * is an error, never an answer, so the whole preview fails; the rows already answered are counted.
 */
export class PreviewModelError extends Error {
  readonly key: RecordKey;
  /** The question the response lacked; undefined when the call itself failed. */
  readonly question: string | undefined;

  constructor(
    key: RecordKey,
    failure: { readonly cause: unknown } | { readonly question: string },
  ) {
    super(
      "question" in failure
        ? `the model's response has no answer for "${failure.question}"`
        : failure.cause instanceof Error
          ? failure.cause.message
          : String(failure.cause),
      "cause" in failure ? { cause: failure.cause } : undefined,
    );
    this.name = "PreviewModelError";
    this.key = key;
    this.question = "question" in failure ? failure.question : undefined;
  }
}

export type PreviewService = {
  /** The newest `limit` rows answered under `questionSet`; writes nothing. */
  preview(questionSet: QuestionSet, limit: number): Promise<PreviewResult>;
  /**
   * The same service over rows the caller already read (`facetdb test` asks the draft about the
   * newest rows and about older reviewed ones): the cap check, the skips, the admission per request
   * and the cost are the preview's, only the scan is the caller's.
   */
  previewRows(questionSet: QuestionSet, rows: readonly ReadRow[]): Promise<PreviewResult>;
};

/** The cap's words: what happened and what to do. */
export const PREVIEW_CAPPED = {
  message:
    "This month's usage reached the project's spending cap, so the preview asked the model nothing.",
  fix: "Raise spendingCap in facetdb.config.ts (Settings can change it) and restart facetdb worker, or wait for the month to reset; records stay pending meanwhile and nothing is lost.",
} as const;

/** Reads pages of `scan`, newest first, until `limit` rows or the last page. */
export async function newestRows(
  connector: Pick<Connector, "scan">,
  limit: number,
): Promise<readonly ReadRow[]> {
  let page = await connector.scan(null);
  const rows: ReadRow[] = [...page.rows];
  while (rows.length < limit && page.next !== null) {
    page = await connector.scan(page.next);
    rows.push(...page.rows);
  }
  return rows.slice(0, limit);
}

/**
 * What the preview does with one row before it spends anything: leaves it out and says why, or asks
 * it, with the request and its estimated tokens (what the spending gate reserves). `facetdb test`
 * prices its run with the same call, so its estimate counts exactly the rows the run will ask.
 */
export function askFor(
  questionSet: QuestionSet,
  row: ReadRow,
  maxStateTokens: number | undefined,
):
  | { readonly kind: "skip"; readonly reason: Exclude<PreviewSkipReason, "spending-cap"> }
  | { readonly kind: "ask"; readonly request: ProviderRequest; readonly requestTokens: number } {
  const skip = shouldSkip(questionSet.read, row.state, { filterExcluded: row.excluded });
  if (skip.skip) {
    return { kind: "skip", reason: skip.reason };
  }
  const request: ProviderRequest = {
    model: questionSet.model,
    state: row.state,
    questions: questionSet.questions,
  };
  const requestTokens = estimateRequestTokens(request);
  if (checkStateSize(requestTokens, maxStateTokens).kind === "refuse") {
    return { kind: "skip", reason: "too-large" };
  }
  return { kind: "ask", request, requestTokens };
}

/** Runs `work` over `items`, `width` at a time, keeping their order; throws once a chunk settled. */
async function inChunks<Item, Result>(
  items: readonly Item[],
  width: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let start = 0; start < items.length; start += width) {
    // Every request of the chunk settles its reservation before the first failure is thrown.
    const settled = await Promise.allSettled(items.slice(start, start + width).map(work));
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
  }
  return results;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPreviewService(deps: PreviewDeps): PreviewService {
  const { connector, provider, spending, log } = deps;

  const alertFailed = (error: SpendingAlertError) => {
    log(`the spending cap could not raise its alert: ${error.message}`);
  };

  /** Counts an answered request; a failure here loses no answer and no token (spending holds it). */
  async function finish(reservation: ReservationId, inputTokens: number): Promise<void> {
    try {
      await spending.finish(reservation, inputTokens);
    } catch (error) {
      if (error instanceof SpendingAlertError) {
        alertFailed(error);
        return;
      }
      log(`the preview's tokens are held to be counted again: ${messageOf(error)}`);
    }
  }

  async function previewRow(questionSet: QuestionSet, row: ReadRow): Promise<PreviewRow> {
    const { key, state } = row;
    const plan = askFor(questionSet, row, deps.maxStateTokens);
    if (plan.kind === "skip") {
      return { key, kind: "skipped", reason: plan.reason };
    }
    const { request, requestTokens } = plan;
    // Admitted per request, as the worker admits, so a preview cannot carry a project past its cap;
    // the reservation holds the estimate until the answer is counted.
    const reservation = await spending.admit(requestTokens, alertFailed);
    if (reservation === undefined) {
      return { key, kind: "skipped", reason: "spending-cap" };
    }
    let response: ProviderResponse;
    try {
      response = await provider.ask(request);
    } catch (cause) {
      // No answer, so nothing to count: the reservation gives its headroom back. A release the store
      // refuses is logged and left to the reservation's lease, as the worker does, so the model's
      // failure is what the caller hears.
      try {
        await spending.settle(reservation);
      } catch (error) {
        log(`the reservation is left to its lease: ${messageOf(error)}`);
      }
      throw new PreviewModelError(key, { cause });
    }
    // Paid for, whatever follows: the reservation gives way to the count.
    await finish(reservation, response.usage.inputTokens);
    const decisions: Record<string, Decision> = {};
    for (const question of questionSet.questions) {
      const answer = response.answers[question.name];
      if (answer === undefined) {
        throw new PreviewModelError(key, { question: question.name });
      }
      decisions[question.name] = decide(
        question,
        resolveThresholds(question, questionSet.thresholds[question.name]),
        answer,
      );
    }
    return {
      key,
      kind: "answered",
      state,
      model: response.model,
      answers: response.answers,
      decisions,
      status: statusOf(decisions),
      usage: response.usage,
    };
  }

  /** The cap's words when the project is paused, else undefined: nothing is read or asked then. */
  async function pausedResult(): Promise<PreviewResult | undefined> {
    if (await spending.allowsWork(alertFailed)) {
      return undefined;
    }
    const now = deps.clock.now();
    return {
      kind: "capped",
      ...PREVIEW_CAPPED,
      retryAfterSeconds: Math.ceil((nextMonthOf(now) - now) / 1000),
    };
  }

  async function preview(questionSet: QuestionSet, limit: number): Promise<PreviewResult> {
    // A paused project reads nothing and asks nothing: the cap's words instead.
    const paused = await pausedResult();
    if (paused !== undefined) {
      return paused;
    }
    return answered(questionSet, await newestRows(connector, limit));
  }

  async function previewRows(
    questionSet: QuestionSet,
    rows: readonly ReadRow[],
  ): Promise<PreviewResult> {
    return (await pausedResult()) ?? answered(questionSet, rows);
  }

  async function answered(
    questionSet: QuestionSet,
    rows: readonly ReadRow[],
  ): Promise<PreviewResult> {
    const previewed = await inChunks(rows, deps.inFlight ?? PREVIEW_IN_FLIGHT, (row) =>
      previewRow(questionSet, row),
    );
    let inputTokens = 0;
    let decided = 0;
    let review = 0;
    for (const row of previewed) {
      if (row.kind !== "answered") {
        continue;
      }
      inputTokens += row.usage.inputTokens;
      if (row.status === "done") {
        decided += 1;
      } else {
        review += 1;
      }
    }
    return {
      kind: "previewed",
      rows: previewed,
      decided,
      review,
      // Dollars from the integer count, once, at the end.
      cost: { inputTokens, dollars: (inputTokens * PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000 },
    };
  }

  return { preview, previewRows };
}
