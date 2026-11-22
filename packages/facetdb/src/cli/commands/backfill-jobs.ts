import {
  type AlertSignals,
  type BackfillEstimate,
  type BackfillReport,
  type Clock,
  type Connector,
  type CursorStore,
  compactTokens,
  createBackfill,
  DEFAULT_BACKFILL_PACE,
  type DecisionLog,
  type ModelProvider,
  type OpenConnector,
  type RunRecorder,
  type SourceReviews,
  type SpendingGate,
} from "@facetdb/core";
import type {
  BackfillJobCounts,
  BackfillJobState,
  BackfillJobStatus,
  BackfillJobsDoor,
} from "@facetdb/server";
import type { SourceLoop } from "./config-reload.ts";

/**
 * The studio's backfills, run inside the worker as jobs. At most one job per source:
 *  - `estimate` starts a job that surveys the source from its saved place (the count, the sample,
 *    the cost) and then waits; nothing is asked or queued until `start` carries the token that
 *    estimate gave, so no model budget is spent on an estimate nobody saw;
 *  - a job runs under the question set and version of the loop in force, and records no version of
 *    its own; a named question the loop does not run is refused, to be installed first;
 *  - it asks through the worker's provider (its backoff and in-flight limit), spending gate, clock
 *    and store, so its calls and the loops' share one limit and one cap;
 *  - it reads, claims and writes over a connector of its own, opened under a worker id of its own,
 *    as `facetdb backfill` does: a queue kept in the database tells a job's claim from a loop's by
 *    that id. The records of a whole set, which the loop asks, go to the queue of the loop in
 *    force and not to the job's connector: the polling engine's connector keeps a memory of its
 *    queue, a cache over the stored state hash, so the loop's own connector asks them at once
 *    where the job's would leave them to the loop's next whole-table poll;
 *  - a stop, a reload that restarts or removes the source, and the worker stopping each stop it
 *    after the page in hand, with that page's place saved (core's `BackfillOptions.signal`).
 * Every write goes through core's backfill, which writes a decision only while the state hash still
 * matches and never over a person's decision.
 */

/**
 * How long an estimate nobody starts is kept before its job is dropped: the setup flow's plan token
 * lives as long (`PLAN_TOKEN_TTL_MS`), so the studio's show-then-confirm steps agree. Long enough
 * to read a cost and decide; short enough that a forgotten tab's estimate, whose count drifts as
 * the table changes, is never the one a later click starts.
 */
export const ESTIMATE_KEPT_MS = 10 * 60 * 1000;

/** What a job needs of the loop in force: its source, and the question set and version it runs. */
export type JobLoop = Pick<SourceLoop, "source" | "questionSet" | "version">;

export type BackfillJobsDeps = {
  /** The project's id: part of every run's key in the cursor store. */
  readonly projectId: string;
  /**
   * The loop in force for a source, or undefined when the worker runs none (`Fleet.loop`). A job
   * compares it with the loop it started under: a reload that restarts the source makes a new one.
   */
  readonly loop: (name: string) => JobLoop | undefined;
  /**
   * Opens a connector of the job's own on the source's table, under the loop's question set and
   * under `workerId`, which is the job's alone (`newWorkerId`); for a plugin source, an adapter of
   * the job's own over the store's queue of the source, paging through the plugin's scan. Never a
   * loop's: SQLite acks and releases a claim by the worker id and nothing else, and lets go of the
   * table's lock by it on close, so a job under the loop's id would settle the loop's claim of a
   * record that changed meanwhile (asked twice, or its queue entry gone) and drop the loop's lock.
   */
  readonly open: (loop: JobLoop, workerId: string) => Promise<OpenConnector>;
  /** Makes a job's worker id; random in the process, a counter in a test. */
  readonly newWorkerId: () => string;
  /**
   * Where the loop in force of a source takes the records it is to ask (its own connector's
   * `enqueue`, through `Fleet.connector`), or undefined when the worker runs no such source, and
   * for a plugin source, whose records the job's own connector takes into the store as it queues
   * them, into the store's one queue of the source that the loop claims from. A whole set's records
   * are handed there: the polling engine's connector keeps a memory of its queue, a cache over the
   * stored state hash its `enqueue` marks (the old hash written in capitals, so an edit made
   * meanwhile still reads as a change), so records queued through the job's connector would wait
   * for a poll that reads the whole table (the loop's next start, or its hourly scan without a
   * last-changed column) to be found, where the loop's own connector asks them at once.
   */
  readonly queue: (name: string) => Pick<Connector, "enqueue"> | undefined;
  /** The workers' provider: backoff and the in-flight limit around the model, shared with the loops. */
  readonly provider: ModelProvider;
  /** The project's spending gate, the loops' own: every admission is counted together. */
  readonly spending: SpendingGate;
  /** The lanes a job keeps in flight: the worker's own limit under `--connections`; the engine's default when absent. */
  readonly maxInFlight?: number;
  readonly clock: Clock;
  readonly cursors: CursorStore;
  /** The source's decision log, by the source's name. */
  readonly log: (name: string) => DecisionLog;
  /** The run log's rows of a source's backfill pages. */
  readonly runs: (name: string) => RunRecorder;
  /** A source's review queue, which an added question's write follows as the loop's own does. */
  readonly reviews: (name: string) => SourceReviews;
  /** The backfill finished or failed alerts of a source. */
  readonly alerts: (name: string) => AlertSignals;
  /**
   * A signal that aborts `ms` from now: drops an estimate nobody started. The platform's timeout in
   * the process; a test aborts its own. `start` also checks the clock, so a late start never runs.
   */
  readonly expireAfter: (ms: number) => AbortSignal;
  /** Makes an estimate's token; random in the process, a counter in a test. */
  readonly newToken: () => string;
  /** The worker's log. */
  readonly print: (line: string) => void;
};

export type BackfillJobs = BackfillJobsDoor & {
  /** Resolves once `signal` aborts and every job has stopped after its page in hand. */
  until(signal: AbortSignal): Promise<void>;
  /** Stops every job after its page in hand and waits for each; the worker calls it before closing. */
  close(): Promise<void>;
};

/** Why a job stopped. The first cause told is the one kept. */
type StopCause =
  | { readonly kind: "requested" }
  | { readonly kind: "expired" }
  | { readonly kind: "restarted"; readonly version: number }
  | { readonly kind: "removed" }
  | { readonly kind: "worker" };

type Counts = { -readonly [K in keyof BackfillJobCounts]: BackfillJobCounts[K] };

type Job = {
  readonly source: string;
  readonly loop: JobLoop;
  readonly questions: readonly string[] | null;
  readonly since: number;
  /** Aborted by every stop: core's run stops after the page in hand. */
  readonly halt: AbortController;
  state: BackfillJobState;
  surveyed: number;
  estimate: BackfillEstimate | null;
  token: string | null;
  estimatedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  counts: Counts;
  cause: StopCause | undefined;
  why: string | null;
  /** Ends the estimate's wait (true lets the job run); set only while it waits. */
  answer: ((go: boolean) => void) | undefined;
};

const LIVING: ReadonlySet<BackfillJobState> = new Set([
  "estimating",
  "waiting",
  "running",
  "stopping",
]);

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(dollars: number): string {
  return dollars > 0 && dollars < 0.01 ? "less than $0.01" : `about $${dollars.toFixed(2)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const noCounts = (): Counts => ({
  records: 0,
  queued: 0,
  answered: 0,
  alreadyAnswered: 0,
  deferred: 0,
});

/**
 * The job's own connector as core's backfill gets it: the records each survey page read are told to
 * `seen`, and records to be asked by the loop go to `queue()`, the loop in force's, looked up at each
 * call (after a reload, the loop that will ask them). A source taken out of the file has no loop:
 * what is left of the page in hand then goes to the job's own connector, the table's queue where the
 * database keeps one.
 */
function jobConnector(
  connector: Connector,
  seen: (records: number) => void,
  queue: () => Pick<Connector, "enqueue"> | undefined,
): Connector {
  return {
    get capabilities() {
      return connector.capabilities;
    },
    install: () => connector.install(),
    uninstall: () => connector.uninstall(),
    watch: () => connector.watch(),
    read: (keys) => connector.read(keys),
    write: (key, decision, hash) => connector.write(key, decision, hash),
    current: (keys) => connector.current(keys),
    scan: async (cursor) => {
      const page = await connector.scan(cursor);
      // As the survey counts: a record the source's filter excludes is never asked.
      seen(page.rows.filter((row) => !row.excluded).length);
      return page;
    },
    enqueue: (keys) => (queue() ?? connector).enqueue(keys),
    claim: (limit) => connector.claim(limit),
    claimKey: (key) => connector.claimKey(key),
    ack: (keys) => connector.ack(keys),
    release: (keys) => connector.release(keys),
  };
}

export function createBackfillJobs(deps: BackfillJobsDeps): BackfillJobs {
  const { clock, print } = deps;
  const jobs = new Map<string, Job>();
  /** Every job's run until it has ended and closed its connector. */
  const running = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const asked = (job: Job) =>
    job.questions === null ? "" : ` of ${job.questions.map((name) => `"${name}"`).join(", ")}`;

  /** Stops a job after the page in hand; a waiting estimate is declined at once. */
  function halt(job: Job, cause: StopCause): void {
    job.cause ??= cause;
    if (job.state === "estimating" || job.state === "waiting" || job.state === "running") {
      job.state = "stopping";
    }
    job.halt.abort();
    job.answer?.(false);
  }

  /**
   * What the clock and the fleet say of a living job, looked at on every call and after every page:
   * an estimate kept past its time is dropped, and a source whose loop a reload replaced (a new
   * version) or removed stops the job, after the page in hand when it runs. Answers the state the
   * job is left in.
   */
  function look(job: Job): BackfillJobState {
    if (
      job.state === "waiting" &&
      job.estimatedAt !== null &&
      clock.now() - job.estimatedAt >= ESTIMATE_KEPT_MS
    ) {
      halt(job, { kind: "expired" });
    }
    if (job.state === "estimating" || job.state === "waiting" || job.state === "running") {
      const now = deps.loop(job.source);
      if (now !== job.loop) {
        halt(
          job,
          now === undefined ? { kind: "removed" } : { kind: "restarted", version: now.version },
        );
      }
    }
    return job.state;
  }

  /** Why a stopped job stopped, in words. */
  function stoppedWhy(job: Job, cause: StopCause): string {
    const begun = job.startedAt !== null;
    const where = begun
      ? "after the page in hand; the pages done stay done, and the next backfill resumes after the last one"
      : "before it started; nothing was asked";
    switch (cause.kind) {
      case "requested":
        return `Stopped on request ${where}.`;
      case "expired":
        return `The estimate was not started within ${ESTIMATE_KEPT_MS / 60_000} minutes, so it was dropped; nothing was asked.`;
      case "restarted": {
        // A run's place is kept per question-set version (core's `backfillRun`): under the same
        // version the next job resumes after the last page, under a new one no page is done yet.
        const from = job.loop.version;
        if (cause.version === from) {
          return `${job.source} restarted after a reload, so the backfill stopped ${where}. Estimate again: it runs with the source as it is now.`;
        }
        return begun
          ? `${job.source} restarted under version ${cause.version} after a reload, so the backfill under version ${from} stopped after the page in hand. A backfill under version ${cause.version} is a new one: estimate again, and it starts from the newest record.`
          : `${job.source} restarted under version ${cause.version} after a reload, so the backfill under version ${from} stopped before it started; nothing was asked. Estimate again under version ${cause.version}.`;
      }
      case "removed":
        return `${job.source} is no longer in facetdb.config.ts, so the backfill stopped ${where}.`;
      case "worker":
        return `The worker stopped, so the backfill stopped ${where}. Estimate again once the worker runs.`;
    }
  }

  function words(job: Job): string {
    const { counts, estimate } = job;
    switch (job.state) {
      case "idle":
        return "No backfill is running. Estimate one to see its cost first.";
      case "estimating":
        return `Counting the records of ${job.source} to price the backfill${asked(job)}: ${grouped.format(job.surveyed)} read so far, newest first. Nothing is asked until it is started.`;
      case "waiting":
        return estimate === null
          ? "Waiting to be started."
          : `Estimated${asked(job)}: ${grouped.format(estimate.records)} records, about ${compactTokens(estimate.tokens)} input tokens, ${money(estimate.dollars)}. Nothing is asked until it is started; an estimate not started within ${ESTIMATE_KEPT_MS / 60_000} minutes is dropped.`;
      case "running":
        return `Running${asked(job)} under version ${job.loop.version}, newest first, at most ${DEFAULT_BACKFILL_PACE} records a second: ${grouped.format(counts.records)}${estimate === null ? "" : ` of ${grouped.format(estimate.records)}`} records done.`;
      case "stopping":
        return "Stopping after the page in hand: that page is settled and its place saved first.";
      case "finished":
        return job.questions === null
          ? `Finished: ${grouped.format(counts.queued)} records queued for the worker, ${grouped.format(counts.alreadyAnswered)} already answered.`
          : `Finished: ${grouped.format(counts.answered)} records answered, ${grouped.format(counts.alreadyAnswered)} already had these answers, ${grouped.format(counts.deferred)} left for the worker.`;
      case "stopped":
      case "failed":
      case "paused":
        return job.why ?? "Ended.";
    }
  }

  function statusOf(job: Job): BackfillJobStatus {
    const waiting = job.state === "waiting";
    return {
      source: job.source,
      state: job.state,
      questions: job.questions,
      version: job.loop.version,
      surveyed: job.surveyed,
      estimate: job.estimate,
      pace: DEFAULT_BACKFILL_PACE,
      token: waiting ? job.token : null,
      expiresAt:
        waiting && job.estimatedAt !== null ? iso(job.estimatedAt + ESTIMATE_KEPT_MS) : null,
      counts: { ...job.counts },
      since: iso(job.since),
      endedAt: iso(job.endedAt),
      why: job.why,
      words: words(job),
    };
  }

  function idle(source: string): BackfillJobStatus {
    return {
      source,
      state: "idle",
      questions: null,
      version: null,
      surveyed: null,
      estimate: null,
      pace: null,
      token: null,
      expiresAt: null,
      counts: null,
      since: null,
      endedAt: null,
      why: null,
      words: "No backfill is running. Estimate one to see its cost first.",
    };
  }

  /** The estimate is shown; the run waits here until a start, a stop or the estimate's time. */
  function waitForStart(job: Job, estimate: BackfillEstimate): Promise<boolean> {
    job.estimate = estimate;
    if (job.state !== "estimating") {
      return Promise.resolve(false);
    }
    job.state = "waiting";
    job.token = deps.newToken();
    job.estimatedAt = clock.now();
    // The loop may have been replaced while the survey read the table.
    if (look(job) !== "waiting") {
      return Promise.resolve(false);
    }
    const expiry = deps.expireAfter(ESTIMATE_KEPT_MS);
    return new Promise<boolean>((resolve) => {
      job.answer = (go) => {
        job.answer = undefined;
        resolve(go);
      };
      const drop = () => {
        if (job.state === "waiting") {
          halt(job, { kind: "expired" });
        }
      };
      if (expiry.aborted) {
        drop();
      } else {
        expiry.addEventListener("abort", drop, { once: true });
      }
    });
  }

  /** The job's end, from core's report: told once its connector is closed. */
  function ended(job: Job, report: BackfillReport): void {
    job.counts = {
      records: job.counts.records,
      queued: report.enqueued.length,
      answered: report.answered.length,
      alreadyAnswered: report.alreadyAnswered.length,
      deferred: report.deferred.length,
    };
    switch (report.status) {
      case "completed":
        job.state = "finished";
        break;
      case "declined":
      case "aborted":
        job.state = "stopped";
        job.why = stoppedWhy(job, job.cause ?? { kind: "requested" });
        break;
      case "stopped": {
        const [first] = report.failures;
        job.state = "failed";
        job.why = `${grouped.format(report.failures.length)} record${report.failures.length === 1 ? "" : "s"} failed on a page${first === undefined ? "" : ` (the first: ${messageOf(first.error)})`}, so the backfill stopped there; the earlier pages are saved. Run facetdb doctor to check the model key and the connection, then estimate again: it resumes at that page and skips what was answered.`;
        break;
      }
      case "paused":
        job.state = "paused";
        job.why =
          "The project's spending cap was reached, so the backfill paused before its next request; the page it was on is not saved, and nothing is lost. Raise spendingCap in facetdb.config.ts (Settings can change it) and restart facetdb worker, or wait for next month, then estimate again: it resumes after the last finished page.";
        break;
    }
    job.token = null;
    job.endedAt = clock.now();
    print(`${job.source}: backfill${asked(job)} ${job.state}. ${words(job)}`);
  }

  function failed(job: Job, error: unknown): void {
    job.state = "failed";
    job.token = null;
    job.endedAt = clock.now();
    job.why = `The backfill could not go on: ${messageOf(error)}. Run facetdb doctor to check the connection, then estimate again: it resumes after the last finished page.`;
    print(`${job.source}: backfill${asked(job)} failed: ${messageOf(error)}`);
  }

  async function run(job: Job): Promise<void> {
    let connector: OpenConnector | undefined;
    let outcome: { readonly report: BackfillReport } | { readonly error: unknown };
    try {
      if (job.halt.signal.aborted) {
        // Stopped before it opened anything (the worker was stopping): nothing to read.
        job.state = "stopped";
        job.endedAt = clock.now();
        job.why = stoppedWhy(job, job.cause ?? { kind: "worker" });
        return;
      }
      connector = await deps.open(job.loop, deps.newWorkerId());
      const { loop } = job;
      const backfill = createBackfill({
        project: deps.projectId,
        source: job.source,
        connector: jobConnector(
          connector,
          (records) => {
            if (job.state === "estimating") {
              job.surveyed += records;
            }
          },
          () => deps.queue(job.source),
        ),
        worker: deps.provider,
        clock,
        cursorStore: deps.cursors,
        log: deps.log(job.source),
        questionSet: loop.questionSet,
        version: loop.version,
        ...(loop.source.maxStateTokens === undefined
          ? {}
          : { maxStateTokens: loop.source.maxStateTokens }),
        alerts: deps.alerts(job.source),
        spending: deps.spending,
        runs: deps.runs(job.source),
        reviews: deps.reviews(job.source),
      });
      const report = await backfill.run({
        pace: DEFAULT_BACKFILL_PACE,
        // Inside the worker's connection budget (without it the job took the engine's default of 8
        // lanes on a pool of 6, and the review endpoints queued behind them).
        ...(deps.maxInFlight === undefined ? {} : { maxInFlight: deps.maxInFlight }),
        ...(job.questions === null ? {} : { onlyQuestions: job.questions }),
        signal: job.halt.signal,
        onEstimate: (estimate) => waitForStart(job, estimate),
        onPage: (page) => {
          job.counts = {
            records: job.counts.records + page.records,
            queued: page.queued,
            answered: page.answered,
            alreadyAnswered: page.alreadyAnswered,
            deferred: page.deferred,
          };
          // A reload that replaced the loop stops the job here, after this page.
          look(job);
        },
      });
      outcome = { report };
    } catch (error) {
      outcome = { error };
    }
    try {
      await connector?.close();
    } catch (error) {
      print(`${job.source}: closing the backfill's connection failed: ${messageOf(error)}`);
    }
    if ("report" in outcome) {
      ended(job, outcome.report);
    } else {
      failed(job, outcome.error);
    }
  }

  function launch(job: Job): void {
    const done: Promise<void> = run(job)
      .catch((error: unknown) => {
        // `run` settles the job before it says so in the worker's log, so what reaches here is that
        // log failing: the job has its end already. Were it ever still living, it must not stay so,
        // or its source would refuse every later job; and a rejection nobody takes ends the worker.
        if (LIVING.has(job.state)) {
          job.state = "failed";
          job.token = null;
          job.endedAt = clock.now();
          job.why = `The backfill ended in a way the worker could not report: ${messageOf(error)}. Estimate again: it resumes after the last finished page.`;
        }
      })
      .finally(() => {
        running.delete(done);
      });
    running.add(done);
  }

  /** The job of a source, looked at afresh. */
  function current(name: string): Job | undefined {
    const job = jobs.get(name);
    if (job !== undefined) {
      look(job);
    }
    return job;
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      for (const job of jobs.values()) {
        if (LIVING.has(job.state)) {
          halt(job, { kind: "worker" });
        }
      }
      while (running.size > 0) {
        await Promise.all([...running]);
      }
    })();
    return closing;
  }

  return {
    available: true,

    estimate(name, questions) {
      const loop = deps.loop(name);
      if (loop === undefined) {
        return Promise.resolve({ kind: "unknown_source" });
      }
      const existing = current(name);
      if (existing !== undefined && LIVING.has(existing.state)) {
        return Promise.resolve({ kind: "busy", status: statusOf(existing) });
      }
      // An API source's records arrive one by one: nothing to page through. A plugin source pages
      // through its plugin's scan.
      if (loop.source.table === undefined && loop.source.source === undefined) {
        return Promise.resolve({ kind: "not_a_table" });
      }
      const named = questions === undefined ? null : [...new Set(questions)];
      if (named !== null) {
        // The job asks under the loop's set: a question the file names but the loop does not run
        // yet (not installed, or not reloaded) is installed first.
        const missing = named.filter(
          (question) => !loop.questionSet.questions.some((known) => known.name === question),
        );
        if (missing.length > 0) {
          return Promise.resolve({ kind: "not_installed", questions: missing });
        }
      }
      const job: Job = {
        source: name,
        loop,
        questions: named,
        since: clock.now(),
        halt: new AbortController(),
        state: "estimating",
        surveyed: 0,
        estimate: null,
        token: null,
        estimatedAt: null,
        startedAt: null,
        endedAt: null,
        counts: noCounts(),
        cause: undefined,
        why: null,
        answer: undefined,
      };
      jobs.set(name, job);
      if (closing !== undefined) {
        halt(job, { kind: "worker" });
      }
      launch(job);
      return Promise.resolve({ kind: "estimating", status: statusOf(job) });
    },

    start(name, token) {
      const job = current(name);
      if (job === undefined) {
        return Promise.resolve(
          deps.loop(name) === undefined
            ? { kind: "unknown_source" }
            : { kind: "no_estimate", status: idle(name) },
        );
      }
      const status = statusOf(job);
      const shown = job.estimate !== null && job.startedAt === null;
      if (job.state !== "waiting") {
        if (shown && job.cause?.kind === "expired") {
          return Promise.resolve({ kind: "expired", status });
        }
        if (shown && (job.cause?.kind === "restarted" || job.cause?.kind === "removed")) {
          return Promise.resolve({ kind: "restarted", status });
        }
        return Promise.resolve({ kind: "no_estimate", status });
      }
      if (token !== job.token) {
        return Promise.resolve({ kind: "wrong_token", status });
      }
      job.state = "running";
      job.startedAt = clock.now();
      job.answer?.(true);
      print(`${name}: backfill${asked(job)} started under version ${job.loop.version}.`);
      return Promise.resolve({ kind: "started", status: statusOf(job) });
    },

    stop(name) {
      const job = current(name);
      if (job === undefined) {
        return Promise.resolve(
          deps.loop(name) === undefined
            ? { kind: "unknown_source" }
            : { kind: "nothing_to_stop", status: idle(name) },
        );
      }
      if (job.state === "stopping") {
        return Promise.resolve({ kind: "stopping", status: statusOf(job) });
      }
      if (!LIVING.has(job.state)) {
        return Promise.resolve({ kind: "nothing_to_stop", status: statusOf(job) });
      }
      halt(job, { kind: "requested" });
      return Promise.resolve({ kind: "stopping", status: statusOf(job) });
    },

    status(name) {
      const job = current(name);
      if (job === undefined) {
        return Promise.resolve(
          deps.loop(name) === undefined
            ? { kind: "unknown_source" }
            : { kind: "status", status: idle(name) },
        );
      }
      return Promise.resolve({ kind: "status", status: statusOf(job) });
    },

    async until(signal) {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      await close();
    },

    close,
  };
}
