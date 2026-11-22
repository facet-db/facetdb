import type { BackfillEstimate } from "@facetdb/core";

/**
 * The CLI's door for the studio's backfills: the worker runs at most one backfill job per source,
 * under the question set and version of the loop in force, through the worker's own provider,
 * spending gate and store. Only the `facetdb` package can build one (the fleet, the engines, the
 * store), so it is handed to the server as plain operations; the routes (backfill-routes.ts) map
 * their outcomes.
 */

/**
 * Where a source's job stands:
 *  - `idle`: no job since the worker started;
 *  - `estimating`: reading the source to count and price it (the whole table, from the saved place);
 *  - `waiting`: the estimate is shown, and nothing is asked until a start carries its token;
 *  - `running`: started, paced, newest first (a plugin source in the plugin's order);
 *  - `stopping`: told to stop; it settles the page in hand and saves its place first;
 *  - `stopped`: by a stop, a reload that restarted or removed the source, the worker stopping, or an
 *    estimate nobody started in time (`why` says which); the place of the last finished page is saved;
 *  - `finished`: every page done;
 *  - `failed`: a page had failures, or the run could not go on (`why`); the page is not saved, so
 *    the next job takes it again;
 *  - `paused`: the spending cap refused a request; the page in hand is not saved, nothing is lost.
 */
export type BackfillJobState =
  | "idle"
  | "estimating"
  | "waiting"
  | "running"
  | "stopping"
  | "stopped"
  | "finished"
  | "failed"
  | "paused";

/** What a job has done so far: pages settled, and the records of them by what became of each. */
export type BackfillJobCounts = {
  /** Records on the pages settled so far. */
  readonly records: number;
  /** The whole set: put in the worker's queue, which asks them. */
  readonly queued: number;
  /** Added questions: asked by the job, logged and written. */
  readonly answered: number;
  readonly alreadyAnswered: number;
  /** Added questions: left to the worker's normal path (unanswered, changed, incomplete, queued). */
  readonly deferred: number;
};

export type BackfillJobStatus = {
  readonly source: string;
  readonly state: BackfillJobState;
  /** The added questions the job asks alone; null for the whole question set (or when idle). */
  readonly questions: readonly string[] | null;
  /** The question-set version the job runs under: the loop's in force when it was estimated. */
  readonly version: number | null;
  /** Records the survey has counted so far: it walks the whole source before the estimate exists. */
  readonly surveyed: number | null;
  readonly estimate: BackfillEstimate | null;
  /** Records started per second. */
  readonly pace: number | null;
  /** What `start` takes; only while `waiting`. */
  readonly token: string | null;
  /** When an estimate nobody started is dropped, ISO 8601; only while `waiting`. */
  readonly expiresAt: string | null;
  readonly counts: BackfillJobCounts | null;
  /** When the job was asked for, and when it ended; ISO 8601. */
  readonly since: string | null;
  readonly endedAt: string | null;
  /** Why it stopped, failed or paused, in words; null otherwise. */
  readonly why: string | null;
  /** The whole state in one or two sentences, for the page. */
  readonly words: string;
};

/** The worker runs no source by that name. */
export type BackfillUnknownSource = { readonly kind: "unknown_source" };

export type BackfillEstimateOutcome =
  | { readonly kind: "estimating"; readonly status: BackfillJobStatus }
  | BackfillUnknownSource
  /** An API source: its records arrive one by one, there is no table to page through. */
  | { readonly kind: "not_a_table" }
  /** A job of the source lives (estimating, waiting, running or stopping). */
  | { readonly kind: "busy"; readonly status: BackfillJobStatus }
  /** Named questions the loop in force does not run: installed first, then backfilled. */
  | { readonly kind: "not_installed"; readonly questions: readonly string[] };

export type BackfillStartOutcome =
  | { readonly kind: "started"; readonly status: BackfillJobStatus }
  | BackfillUnknownSource
  /** No estimate waits to be started. */
  | { readonly kind: "no_estimate"; readonly status: BackfillJobStatus }
  /** The token is not the waiting estimate's. */
  | { readonly kind: "wrong_token"; readonly status: BackfillJobStatus }
  /** The estimate was not started in time and was dropped. */
  | { readonly kind: "expired"; readonly status: BackfillJobStatus }
  /** The source restarted on another question-set version since the estimate (or was removed). */
  | { readonly kind: "restarted"; readonly status: BackfillJobStatus };

export type BackfillStopOutcome =
  | { readonly kind: "stopping"; readonly status: BackfillJobStatus }
  | BackfillUnknownSource
  | { readonly kind: "nothing_to_stop"; readonly status: BackfillJobStatus };

export type BackfillStatusOutcome =
  | { readonly kind: "status"; readonly status: BackfillJobStatus }
  | BackfillUnknownSource;

export type BackfillJobsDoor = {
  /** False where the worker runs no jobs (`--once`); the routes refuse before any call. */
  readonly available: boolean;
  /** Starts a job that surveys the source and waits; `questions` asks those alone. */
  estimate(
    source: string,
    questions: readonly string[] | undefined,
  ): Promise<BackfillEstimateOutcome>;
  /** Lets the waiting job run, when `token` is the one its estimate gave. */
  start(source: string, token: string): Promise<BackfillStartOutcome>;
  /** Stops the job after the page in hand (at once, when nothing was asked yet). */
  stop(source: string): Promise<BackfillStopOutcome>;
  status(source: string): Promise<BackfillStatusOutcome>;
};

/** A surface with no jobs to offer (a test's app, a worker under `--once`): every route refuses. */
export const NO_BACKFILL_JOBS: BackfillJobsDoor = {
  available: false,
  estimate: () => Promise.reject(new Error("this worker runs no backfill")),
  start: () => Promise.reject(new Error("this worker runs no backfill")),
  stop: () => Promise.reject(new Error("this worker runs no backfill")),
  status: () => Promise.reject(new Error("this worker runs no backfill")),
};
