import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  FakeRunLog,
  freshHeldModel,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type BackfillProgress, type CursorStore, createBackfill } from "../backfill/index.ts";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { errorCount, RUN_LOG_PRUNE_EVERY_MS, RUN_LOG_RETENTION_MS, type Run } from "./run-log.ts";
import { createWorker, DEFAULT_WORKER_LIMITS, type WorkerDeps } from "./worker.ts";

/**
 * The run log on the fake connector, the fake clock and the fake run log: one row per pass that
 * claimed a record, one per backfill page that queued or asked one, and the hourly prune that keeps
 * every row younger than 30 days.
 */

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};

const spam: Question = {
  type: "noul",
  name: "spam",
  instructions: "Is this listing spam?",
  stakes: "low",
};

const SCAM_ONLY: QuestionSet = {
  questions: [scam],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const SCAM_AND_SPAM: QuestionSet = { ...SCAM_ONLY, questions: [scam, spam] };

// 0.95 is decided, 0.5 is left to a person.
const SURE = 0.95;
const UNSURE = 0.5;
const TOKENS_PER_ANSWER = 120;

const SOURCE = "listings-app:listings";
const START = Date.UTC(2026, 10, 5, 14, 0, 0);

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** Answers every question with the probability `body` names ("sure" or "unsure"); each call takes a second. */
class ScriptedProvider implements ModelProvider {
  readonly #clock: FakeClock;
  readonly #during: (request: ProviderRequest) => void;

  constructor(clock: FakeClock, during: (request: ProviderRequest) => void = () => undefined) {
    this.#clock = clock;
    this.#during = during;
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.#clock.advance(1_000);
    this.#during(request);
    const body = request.state["body"];
    if (body === "down") {
      return Promise.reject(new Error("the model is down"));
    }
    const probability = typeof body === "string" && body.startsWith("unsure") ? UNSURE : SURE;
    return Promise.resolve({
      model: request.model,
      answers: Object.fromEntries(
        request.questions.map((question) => [
          question.name,
          { type: "noul" as const, probability },
        ]),
      ),
      usage: { inputTokens: TOKENS_PER_ANSWER, outputTokens: 4 },
    });
  }
}

function world(during?: (request: ProviderRequest) => void) {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  const connector = new FakeConnector(db);
  const runs = new FakeRunLog();
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const deps: WorkerDeps = {
    connector,
    provider: new ScriptedProvider(clock, during),
    log,
    reviews: reviewsOf(queue, "listings"),
    actions: [],
    clock,
    limits: { ...DEFAULT_WORKER_LIMITS, maxInFlight: 1 },
    questionSet: SCAM_ONLY,
    version: 1,
    heldModel: freshHeldModel(),
    spending: UNLIMITED,
    runs: { log: runs, source: SOURCE },
  };
  return { clock, db, connector, runs, log, queue, deps };
}

describe("the worker's run log", () => {
  it("writes no row for an idle pass", async () => {
    const t = world();
    await t.connector.install();
    const worker = createWorker(t.deps);

    const report = await worker.runOnce();

    expect(report.claimed).toBe(0);
    expect(t.runs.runs).toEqual([]);
  });

  it("writes one row per pass that claimed a record: its source, times and counts", async () => {
    let edited = false;
    const t = world((request) => {
      // The record changes while the model answers it: the answer is discarded.
      if (request.state["body"] === "changes" && !edited) {
        edited = true;
        t.db.edit("c", { body: "changed meanwhile" });
      }
    });
    await t.connector.install();
    t.db.edit("a", { body: "sure: a phone" });
    t.db.edit("b", { body: "unsure: a ticket" });
    t.db.edit("c", { body: "changes" });
    t.db.edit("d", { body: "down" });
    t.db.edit("e", { body: "" });
    const worker = createWorker(t.deps);

    const report = await worker.runOnce();

    expect(report.written).toEqual(["a", "b"]);
    expect(report.toReview).toEqual(["b"]);
    expect(report.discarded).toEqual(["c"]);
    expect(report.skipped).toEqual(["e"]);
    // The row's "to review" is the review queue's new card (the queue follows every landed write).
    expect(t.queue.rows.map((card) => card.key)).toEqual(["b"]);
    expect(t.runs.runs).toEqual([
      {
        source: SOURCE,
        kind: "pass",
        startedAt: new Date(START),
        // Four model calls of a second each on the fake clock.
        endedAt: new Date(START + 4_000),
        claimed: 5,
        answered: 1,
        toReview: 1,
        errors: 1,
        discarded: 1,
        // The three answers the model gave, the discarded one included: it was paid for.
        tokens: 3 * TOKENS_PER_ANSWER,
      } satisfies Run,
    ]);
  });

  it("reports a run log that cannot be written as a failure of the pass, after the records settled", async () => {
    const t = world();
    await t.connector.install();
    t.runs.failWith = new Error("the store is down");
    t.db.edit("a", { body: "sure: a phone" });
    const worker = createWorker(t.deps);

    const report = await worker.runOnce();

    expect(report.written).toEqual(["a"]);
    expect(t.db.jobs.has("a")).toBe(false);
    expect(report.failures.map((failure) => [failure.key, failure.stage])).toEqual([
      [null, "runs"],
      [null, "runs"],
    ]);
  });

  it("writes nothing and prunes nothing for a worker built without a run log", async () => {
    const t = world();
    await t.connector.install();
    const { runs: _runs, ...bare } = t.deps;
    t.db.edit("a", { body: "sure: a phone" });

    const report = await createWorker(bare).runOnce();

    expect(report.written).toEqual(["a"]);
    expect(report.failures).toEqual([]);
    expect(t.runs.runs).toEqual([]);
    expect(t.runs.prunes).toEqual([]);
  });

  it("prunes once an hour on the injected clock, cutting at 30 days @timing", async () => {
    const t = world();
    await t.connector.install();
    const worker = createWorker(t.deps);

    await worker.runOnce();
    t.clock.advance(RUN_LOG_PRUNE_EVERY_MS - 1);
    await worker.runOnce();
    expect(t.runs.prunes).toEqual([new Date(START - RUN_LOG_RETENTION_MS)]);

    t.clock.advance(1);
    await worker.runOnce();
    await worker.runOnce();
    expect(t.runs.prunes).toEqual([
      new Date(START - RUN_LOG_RETENTION_MS),
      new Date(START + RUN_LOG_PRUNE_EVERY_MS - RUN_LOG_RETENTION_MS),
    ]);
  });

  it("never prunes a row younger than 30 days on the injected clock @timing", async () => {
    const t = world();
    await t.connector.install();
    const worker = createWorker(t.deps);
    t.db.edit("old", { body: "sure: first" });
    await worker.runOnce();
    const [old] = t.runs.runs;
    expect(old?.endedAt).toEqual(new Date(START + 1_000));

    // Hourly passes up to 30 days after the old row ended, to the millisecond: it stays.
    t.clock.advance(RUN_LOG_RETENTION_MS - 1_000 - RUN_LOG_PRUNE_EVERY_MS);
    await worker.runOnce();
    t.clock.advance(RUN_LOG_PRUNE_EVERY_MS);
    t.db.edit("young", { body: "sure: second" });
    await worker.runOnce();
    expect(t.clock.now()).toBe(START + RUN_LOG_RETENTION_MS + 1_000);
    expect(t.runs.prunes.at(-1)).toEqual(new Date(START + 1_000));
    expect(t.runs.runs.map((run) => run.claimed)).toEqual([1, 1]);

    // An hour later the old row is past 30 days and goes; the young one stays.
    t.clock.advance(RUN_LOG_PRUNE_EVERY_MS);
    await worker.runOnce();
    expect(t.runs.runs).toHaveLength(1);
    expect(t.runs.runs[0]?.startedAt).toEqual(new Date(START + RUN_LOG_RETENTION_MS));
  });

  it("counts a record once however many of its stages failed, and each failure of the pass", () => {
    expect(errorCount([{ key: "a" }, { key: "a" }, { key: null }, { key: "b" }], ["c", "b"])).toBe(
      4,
    );
  });
});

class MemoryCursors implements CursorStore {
  readonly #stored = new Map<string, BackfillProgress>();

  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#stored.get(run));
  }

  save(run: string, progress: BackfillProgress): Promise<void> {
    this.#stored.set(run, progress);
    return Promise.resolve();
  }
}

describe("a backfill's run log", () => {
  function backfillWorld(questionSet: QuestionSet) {
    const clock = new FakeClock(START);
    const db = new FakeDatabase({ fields: ["body"], clock, pageSize: 2 });
    const connector = new FakeConnector(db);
    const runs = new FakeRunLog();
    const log = new FakeDecisionLog();
    const provider = new ScriptedProvider(clock);
    const backfill = createBackfill({
      project: "listings-app",
      source: "listings",
      connector,
      worker: provider,
      clock,
      cursorStore: new MemoryCursors(),
      log,
      reviews: reviewsOf(new FakeReviewQueue(), "listings"),
      questionSet,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
      runs: { log: runs, source: SOURCE },
    });
    return { clock, db, connector, runs, log, backfill };
  }

  it("writes a row per page of the whole set, named as a backfill, counting what it queued", async () => {
    const t = backfillWorld(SCAM_ONLY);
    for (const key of ["a", "b", "c"]) {
      t.db.edit(key, { body: `sure: ${key}` });
    }
    await t.connector.install();

    const report = await t.backfill.run({ onEstimate: () => true });

    expect(report.status).toBe("completed");
    expect(t.runs.runs.map((run) => [run.source, run.kind, run.claimed, run.answered])).toEqual([
      [SOURCE, "backfill", 2, 0],
      [SOURCE, "backfill", 1, 0],
    ]);
  });

  it("writes a row per page of added questions with its answers, reviews and tokens", async () => {
    const t = backfillWorld(SCAM_AND_SPAM);
    await t.connector.install();
    for (const key of ["a", "b", "c"]) {
      t.db.edit(key, { body: key === "b" ? "unsure: b" : `sure: ${key}` });
    }
    // Every record already answered the first question, so the run asks the added one alone.
    const worker = createWorker({
      connector: t.connector,
      provider: new ScriptedProvider(t.clock),
      log: t.log,
      reviews: reviewsOf(new FakeReviewQueue(), "listings"),
      actions: [],
      clock: t.clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: SCAM_ONLY,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
    });
    await worker.runOnce();
    const startedAt = t.clock.now();

    const report = await t.backfill.run({ onlyQuestions: ["spam"], onEstimate: () => true });

    expect(report.status).toBe("completed");
    expect(report.answered).toHaveLength(3);
    const [first, second] = t.runs.runs;
    expect(t.runs.runs).toHaveLength(2);
    // Newest first: c and b on the first page, a on the second; b is left to a person.
    // The page's two calls run side by side, a second each on the fake clock, behind the pace.
    expect(first?.endedAt.getTime()).toBeGreaterThanOrEqual(startedAt + 2_000);
    expect(first).toEqual({
      source: SOURCE,
      kind: "backfill",
      startedAt: new Date(startedAt),
      endedAt: expect.any(Date),
      claimed: 2,
      answered: 1,
      toReview: 1,
      errors: 0,
      discarded: 0,
      tokens: 2 * TOKENS_PER_ANSWER,
    } satisfies Run);
    expect(second).toMatchObject({
      claimed: 1,
      answered: 1,
      toReview: 0,
      tokens: TOKENS_PER_ANSWER,
    });
  });

  it("writes no row for a page that queued and asked nothing", async () => {
    const t = backfillWorld(SCAM_ONLY);
    await t.connector.install();
    t.db.edit("a", { body: "sure: a" });
    const worker = createWorker({ ...world().deps, connector: t.connector, log: t.log });
    await worker.runOnce();

    await t.backfill.run({ onEstimate: () => true });

    expect(t.runs.runs).toEqual([]);
  });
});
