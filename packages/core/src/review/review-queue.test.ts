import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ProviderResponse } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { choiceConfidence } from "../thresholds/index.ts";
import { createWorker, DEFAULT_WORKER_LIMITS, type WorkerDeps } from "../worker/index.ts";
import {
  REVIEW_LOCK_MS,
  type ReviewEntry,
  type ReviewQueue,
  reviewEntryOf,
  reviewsOf,
} from "./index.ts";

/**
 * The review queue's rules on the in-memory fake, and the worker's hooks that keep it. The store's
 * table is held to the same rules in packages/postgres/src/store/reviews.test.ts.
 */

const SOURCE = "p1:listings";
const START = Date.UTC(2026, 10, 5, 9, 0, 0);

function card(key: string, overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    source: SOURCE,
    key,
    stateHash: `h-${key}`,
    openQuestions: ["scam"],
    numbers: { scam: 0.5 },
    since: new Date(START),
    ...overrides,
  };
}

async function seeded(...entries: ReviewEntry[]): Promise<FakeReviewQueue> {
  const queue = new FakeReviewQueue();
  for (const entry of entries) {
    await queue.upsert(entry);
  }
  return queue;
}

const keysOf = async (queue: ReviewQueue, viewer: string, nowMs: number, filter = {}) =>
  (await queue.list(filter, viewer, nowMs)).map((listed) => listed.key);

describe("the review queue's rules (the fake)", () => {
  it("lists the cards oldest first", async () => {
    const queue = await seeded(
      card("b", { since: new Date(START + 2_000) }),
      card("c", { since: new Date(START + 1_000) }),
      card("a", { since: new Date(START + 2_000) }),
    );
    expect(await keysOf(queue, "ana", START)).toEqual(["c", "a", "b"]);
  });

  it("refreshes a card at the same hash, keeping its since, lease and skips; a new hash is a new card", async () => {
    const queue = await seeded(card("a"));
    await queue.lock(SOURCE, "a", "ana", START);
    await queue.skip(SOURCE, "a", "ben");
    await queue.lock(SOURCE, "a", "ana", START);

    await queue.upsert(
      card("a", {
        openQuestions: ["category"],
        numbers: { category: 0.2 },
        since: new Date(START + 5_000),
      }),
    );
    expect(queue.rows).toEqual([
      {
        ...card("a", { openQuestions: ["category"], numbers: { category: 0.2 } }),
        lock: { by: "ana", until: new Date(START + REVIEW_LOCK_MS) },
        skippedBy: ["ben"],
      },
    ]);

    await queue.upsert(card("a", { stateHash: "h-new", since: new Date(START + 9_000) }));
    expect(queue.rows).toEqual([
      {
        ...card("a", { stateHash: "h-new", since: new Date(START + 9_000) }),
        lock: null,
        skippedBy: [],
      },
    ]);
  });

  it("withdraws a card at its own hash only, and twice is the same as once", async () => {
    const queue = await seeded(card("a", { stateHash: "h-new" }));
    await queue.withdraw(SOURCE, "a", "h-old");
    expect(queue.rows.map((row) => row.stateHash)).toEqual(["h-new"]);

    await queue.withdraw(SOURCE, "a", "h-new");
    await queue.withdraw(SOURCE, "a", "h-new");
    expect(queue.rows).toEqual([]);
  });

  it("removes a card whatever its hash, and keeps the other sources' cards of the same key", async () => {
    const queue = await seeded(card("a"), card("a", { source: "p1:messages" }));
    await queue.remove(SOURCE, "a");
    expect(queue.rows.map((row) => row.source)).toEqual(["p1:messages"]);
  });

  it("refuses a lock while another reviewer's lease runs, and hides the card from them", async () => {
    const queue = await seeded(card("a"), card("b"));

    expect(await queue.lock(SOURCE, "a", "ana", START)).toEqual({
      kind: "locked",
      until: new Date(START + REVIEW_LOCK_MS),
    });
    expect(await queue.lock(SOURCE, "a", "ben", START + 1_000)).toEqual({
      kind: "held",
      by: "ana",
      until: new Date(START + REVIEW_LOCK_MS),
    });
    // Two viewers never list the same locked card.
    expect(await keysOf(queue, "ana", START + 1_000)).toEqual(["a", "b"]);
    expect(await keysOf(queue, "ben", START + 1_000)).toEqual(["b"]);
    expect(await queue.lock(SOURCE, "missing", "ana", START)).toEqual({ kind: "gone" });
  });

  it("lets a lease expire on the clock alone, never on a timer @timing", async () => {
    const clock = new FakeClock(START);
    const queue = await seeded(card("a"));
    await queue.lock(SOURCE, "a", "ana", clock.now());

    clock.advance(REVIEW_LOCK_MS - 1);
    expect((await queue.lock(SOURCE, "a", "ben", clock.now())).kind).toBe("held");
    expect(await keysOf(queue, "ben", clock.now())).toEqual([]);

    clock.advance(1);
    expect(await keysOf(queue, "ben", clock.now())).toEqual(["a"]);
    expect(await queue.lock(SOURCE, "a", "ben", clock.now())).toEqual({
      kind: "locked",
      until: new Date(clock.now() + REVIEW_LOCK_MS),
    });
    expect(await keysOf(queue, "ana", clock.now())).toEqual([]);
  });

  it("renews only the viewer's own lease @timing", async () => {
    const clock = new FakeClock(START);
    const queue = await seeded(card("a"));
    await queue.lock(SOURCE, "a", "ana", clock.now());

    clock.advance(60_000);
    expect(await queue.renew(SOURCE, "a", "ana", clock.now())).toEqual({
      kind: "locked",
      until: new Date(clock.now() + REVIEW_LOCK_MS),
    });
    expect((await queue.renew(SOURCE, "a", "ben", clock.now())).kind).toBe("held");

    // Ana's lease ends unrenewed and Ben takes the card: Ana's renewal is refused with his name.
    clock.advance(REVIEW_LOCK_MS);
    await queue.lock(SOURCE, "a", "ben", clock.now());
    expect(await queue.renew(SOURCE, "a", "ana", clock.now())).toEqual({
      kind: "held",
      by: "ben",
      until: new Date(clock.now() + REVIEW_LOCK_MS),
    });

    await queue.release(SOURCE, "a", "ana");
    expect(queue.rows[0]?.lock?.by).toBe("ben");
    await queue.release(SOURCE, "a", "ben");
    expect(await queue.renew(SOURCE, "a", "ben", clock.now())).toEqual({ kind: "lost" });
    expect(await queue.renew(SOURCE, "missing", "ben", clock.now())).toEqual({ kind: "gone" });
  });

  it("puts a skipped card behind the rest for that viewer only, and releases their lease", async () => {
    const queue = await seeded(
      card("a"),
      card("b", { since: new Date(START + 1_000) }),
      card("c", { since: new Date(START + 2_000) }),
    );
    await queue.lock(SOURCE, "a", "ana", START);
    await queue.skip(SOURCE, "a", "ana");
    await queue.skip(SOURCE, "a", "ana");

    expect(await keysOf(queue, "ana", START)).toEqual(["b", "c", "a"]);
    expect(await keysOf(queue, "ben", START)).toEqual(["a", "b", "c"]);
    expect(queue.rows[0]).toMatchObject({ key: "a", lock: null, skippedBy: ["ana"] });
    expect((await queue.list({}, "ana", START)).map((listed) => listed.skipped)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("filters by source, by an open question and by a probability band", async () => {
    const queue = await seeded(
      card("a", { openQuestions: ["scam"], numbers: { scam: 0.62 } }),
      card("b", {
        openQuestions: ["scam", "category"],
        numbers: { scam: 0.41, category: 0.7 },
        since: new Date(START + 1_000),
      }),
      card("c", { source: "p1:messages", since: new Date(START + 2_000) }),
    );
    expect(await keysOf(queue, "ana", START, { source: SOURCE })).toEqual(["a", "b"]);
    expect(await keysOf(queue, "ana", START, { question: "category" })).toEqual(["b"]);
    expect(await keysOf(queue, "ana", START, { below: 0.6 })).toEqual(["b", "c"]);
    expect(await keysOf(queue, "ana", START, { question: "category", below: 0.6 })).toEqual([]);
    expect(await keysOf(queue, "ana", START, { limit: 2 })).toEqual(["a", "b"]);
  });
});

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};

const category: Question = {
  type: "choice",
  name: "category",
  instructions: "Which category is this listing?",
  options: [
    { name: "car", description: "A car" },
    { name: "flat", description: "A flat" },
  ],
  stakes: "low",
  storeProbabilities: false,
};

const questionSet: QuestionSet = {
  questions: [scam, category],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

// The low-stakes defaults: a noul between 0.30 and 0.70 and a choice below its confidence threshold
// are left to a person; 0.95 and a certain choice are decided.
const UNSURE: ProviderResponse = {
  model: "jev-1.14.0",
  answers: {
    scam: { type: "noul", probability: 0.5 },
    category: { type: "choice", top: "car", probabilities: [0.6, 0.4] },
  },
  usage: { inputTokens: 100, outputTokens: 8 },
};
const SCAM_UNSURE: ProviderResponse = {
  ...UNSURE,
  answers: { ...UNSURE.answers, category: { type: "choice", top: "car", probabilities: [1, 0] } },
};
const SURE: ProviderResponse = {
  ...UNSURE,
  answers: {
    scam: { type: "noul", probability: 0.95 },
    category: { type: "choice", top: "car", probabilities: [1, 0] },
  },
};

/** Answers from a list, one per call; the last one again once the list runs out. */
function scripted(responses: ProviderResponse[]): ModelProvider {
  return {
    ask: () => {
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return next === undefined
        ? Promise.reject(new Error("no answer scripted"))
        : Promise.resolve(next);
    },
  };
}

async function workerRig(responses: ProviderResponse[]) {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"] });
  const connector = new FakeConnector(db);
  await connector.install();
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const provider = scripted(responses);
  const depsAt = (version: number): WorkerDeps => ({
    connector,
    provider,
    log,
    reviews: reviewsOf(queue, SOURCE),
    actions: [],
    clock,
    limits: DEFAULT_WORKER_LIMITS,
    questionSet,
    version,
    spending: UNLIMITED,
  });
  const workerAt = (version: number) => createWorker(depsAt(version));
  return { clock, db, connector, queue, worker: workerAt(1), workerAt, deps: depsAt(1) };
}

const hashOf = (body: string) => stateHash(["body"], { body });

describe("the worker keeps the queue", () => {
  it("adds a card with the open questions and the model's figures when a write leaves the record needs_review", async () => {
    const rig = await workerRig([UNSURE]);
    rig.db.edit("a", { body: "Cheap phone" });

    const report = await rig.worker.runOnce();

    expect(report.written).toEqual(["a"]);
    expect(rig.queue.rows).toEqual([
      {
        source: SOURCE,
        key: "a",
        stateHash: hashOf("Cheap phone"),
        openQuestions: ["scam", "category"],
        numbers: { scam: 0.5, category: choiceConfidence([0.6, 0.4]) },
        since: new Date(START),
        lock: null,
        skippedBy: [],
      },
    ]);
  });

  it("writes no card for a record decided whole", async () => {
    const rig = await workerRig([SURE]);
    rig.db.edit("a", { body: "A red car" });
    await rig.worker.runOnce();
    expect(rig.queue.rows).toEqual([]);
  });

  it("removes the card when a later write of the same state is done", async () => {
    const rig = await workerRig([UNSURE, SURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    expect(rig.queue.rows).toHaveLength(1);

    // Asked again at the same state under a new question-set version: no withdrawal, a done write.
    await rig.connector.enqueue(["a"]);
    const report = await rig.workerAt(2).runOnce();

    expect(report.withdrawn).toEqual([]);
    expect(report.written).toEqual(["a"]);
    expect(rig.db.decisionOf("a")?.status).toBe("done");
    expect(rig.queue.rows).toEqual([]);
  });

  it("refreshes the card's open questions when a rewrite at the same state leaves fewer, keeping its place and lease", async () => {
    const rig = await workerRig([UNSURE, SCAM_UNSURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    await rig.queue.lock(SOURCE, "a", "ana", rig.clock.now());

    rig.clock.advance(5_000);
    await rig.connector.enqueue(["a"]);
    await rig.workerAt(2).runOnce();

    expect(rig.queue.rows).toEqual([
      expect.objectContaining({
        openQuestions: ["scam"],
        numbers: { scam: 0.5 },
        since: new Date(START),
        lock: { by: "ana", until: new Date(START + REVIEW_LOCK_MS) },
      }),
    ]);
  });

  it("withdraws the card at the old hash when the record changes, and the new state's needs_review write comes back as a new card", async () => {
    const rig = await workerRig([UNSURE, UNSURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    await rig.queue.lock(SOURCE, "a", "ana", rig.clock.now());
    await rig.queue.skip(SOURCE, "a", "ben");

    rig.clock.advance(30_000);
    rig.db.edit("a", { body: "Cheap phone, pay by gift card" });
    const report = await rig.worker.runOnce();

    expect(report.withdrawn).toEqual(["a"]);
    expect(rig.queue.rows).toEqual([
      {
        source: SOURCE,
        key: "a",
        stateHash: hashOf("Cheap phone, pay by gift card"),
        openQuestions: ["scam", "category"],
        numbers: { scam: 0.5, category: choiceConfidence([0.6, 0.4]) },
        since: new Date(START + 30_000),
        lock: null,
        skippedBy: [],
      },
    ]);
  });

  it("takes the card out when the changed record is decided, and a withdrawal at the old hash leaves a newer card alone", async () => {
    const rig = await workerRig([UNSURE, SURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    rig.db.edit("a", { body: "A red car" });
    await rig.worker.runOnce();
    expect(rig.queue.rows).toEqual([]);

    const sourceReviews = reviewsOf(rig.queue, SOURCE);
    await sourceReviews.upsert(
      reviewEntryOf({
        key: "b",
        stateHash: hashOf("new"),
        decisions: { scam: { kind: "needs_review" } },
        answers: UNSURE.answers,
        since: new Date(START),
      }),
    );
    await sourceReviews.withdraw("b", hashOf("old"));
    expect(rig.queue.rows.map((row) => row.stateHash)).toEqual([hashOf("new")]);
  });

  it("takes the card out when the changed record is skipped for a blank state", async () => {
    const rig = await workerRig([UNSURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    rig.db.edit("a", { body: "" });

    const report = await rig.worker.runOnce();

    expect(report.skipped).toEqual(["a"]);
    expect(rig.queue.rows).toEqual([]);
  });

  it("takes out a card the worker never made when the record is written done at its hash (a purged and reinstalled source)", async () => {
    const rig = await workerRig([SURE]);
    // A card left from before the log was purged: the worker's log knows nothing of the record.
    await rig.queue.upsert(card("a", { stateHash: hashOf("A red car") }));
    rig.db.edit("a", { body: "A red car" });

    const report = await rig.worker.runOnce();

    expect(report.written).toEqual(["a"]);
    expect(report.withdrawn).toEqual([]);
    expect(rig.queue.rows).toEqual([]);
  });

  it("takes the card out when the record is deleted from its source, and keeps the job when that fails", async () => {
    const rig = await workerRig([UNSURE]);
    rig.db.edit("a", { body: "Cheap phone" });
    await rig.worker.runOnce();
    expect(rig.queue.rows).toHaveLength(1);
    rig.db.edit("a", { body: "Cheap phone, then deleted" });
    rig.db.rows.delete("a");

    // The queue is down for one call: the record stays queued and is reported, never acked as gone.
    const failing = createWorker({
      ...rig.deps,
      reviews: { ...reviewsOf(rig.queue, SOURCE), remove: () => Promise.reject(new Error("down")) },
    });
    const failed = await failing.runOnce();
    expect(failed.gone).toEqual([]);
    expect(failed.failures.map((failure) => failure.key)).toEqual(["a"]);
    expect(rig.db.jobs.size).toBe(1);

    const report = await rig.worker.runOnce();

    expect(report.gone).toEqual(["a"]);
    expect(rig.queue.rows).toEqual([]);
    expect(rig.db.jobs.size).toBe(0);
  });
});
