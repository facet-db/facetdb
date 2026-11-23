import {
  type AnswerEntry,
  choiceConfidence,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type HumanEntry,
  type Question,
  type QuestionSet,
  REVIEW_LOCK_MS,
  type ReviewEntry,
  type ReviewQueue,
  reviewsOf,
  type SpendingGate,
} from "@facetdb/core";
import { FakeClock, freshHeldModel } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient, type SqlRow } from "../sql/index.ts";
import { createDecisionLog } from "./decision-log.ts";
import { createReviewQueue, rebuildStoreReviewQueue, rebuiltKey } from "./reviews.ts";
import { migrateStore } from "./schema.ts";
import { newDb, newStore, useStoreWorld } from "./store-world.ts";

/**
 * `facetdb.reviews` as the review queue on PGlite: the rules the in-memory fake keeps
 * (packages/core/src/review/review-queue.test.ts), held against the table, and the one rebuild from
 * a seeded decision log. PGlite is one connection, so two reviewers racing for one card are
 * statements in turn here; the `for update` wait is a real server's to prove.
 */

useStoreWorld();

const PROJECT = "p1";
const SOURCE = "p1:listings";
const START = Date.UTC(2026, 10, 5, 9, 0, 0);

async function world(): Promise<{ client: SqlClient; queue: ReviewQueue }> {
  const client = pgliteClient(await newDb());
  await migrateStore(client);
  return { client, queue: createReviewQueue(client) };
}

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

async function seeded(
  ...entries: ReviewEntry[]
): Promise<{ client: SqlClient; queue: ReviewQueue }> {
  const made = await world();
  for (const entry of entries) {
    await made.queue.upsert(entry);
  }
  return made;
}

/** Every row as the table holds it, oldest first. */
async function rows(client: SqlClient): Promise<readonly SqlRow[]> {
  return client.query(
    `select source_id, record_key, state_hash, open_questions::text as open_questions,
            numbers::text as numbers, round(extract(epoch from since) * 1000)::bigint::text as since_ms,
            locked_by, round(extract(epoch from locked_until) * 1000)::bigint::text as until_ms,
            skipped_by::text as skipped_by
       from facetdb.reviews order by since, source_id, record_key`,
  );
}

const keysOf = async (queue: ReviewQueue, viewer: string, nowMs: number, filter = {}) =>
  (await queue.list(filter, viewer, nowMs)).map((listed) => listed.key);

describe("facetdb.reviews keeps the queue's rules", () => {
  it("lists a card as it was written, oldest first", async () => {
    const { queue } = await seeded(
      card("b", { since: new Date(START + 2_000) }),
      card("c", { since: new Date(START + 1_000), numbers: { scam: 0.375 } }),
      card("a", { since: new Date(START + 2_000) }),
    );
    expect(await keysOf(queue, "ana", START)).toEqual(["c", "a", "b"]);
    expect((await queue.list({}, "ana", START))[0]).toEqual({
      ...card("c", { since: new Date(START + 1_000), numbers: { scam: 0.375 } }),
      lock: null,
      skipped: false,
    });
  });

  it("refreshes a card at the same hash, keeping its since, lease and skips; a new hash is a new card", async () => {
    const { client, queue } = await seeded(card("a"));
    await queue.lock(SOURCE, "a", "ana", START);
    await queue.skip(SOURCE, "a", "ben");
    await queue.lock(SOURCE, "a", "ana", START);

    await queue.upsert(
      card("a", {
        openQuestions: ["category"],
        numbers: { category: 0.25 },
        since: new Date(START + 5_000),
      }),
    );
    expect(await rows(client)).toEqual([
      {
        source_id: SOURCE,
        record_key: "a",
        state_hash: "h-a",
        open_questions: '["category"]',
        numbers: '{"category": 0.25}',
        since_ms: String(START),
        locked_by: "ana",
        until_ms: String(START + REVIEW_LOCK_MS),
        skipped_by: '["ben"]',
      },
    ]);

    await queue.upsert(card("a", { stateHash: "h-new", since: new Date(START + 9_000) }));
    expect(await rows(client)).toEqual([
      {
        source_id: SOURCE,
        record_key: "a",
        state_hash: "h-new",
        open_questions: '["scam"]',
        numbers: '{"scam": 0.5}',
        since_ms: String(START + 9_000),
        locked_by: null,
        until_ms: null,
        skipped_by: "[]",
      },
    ]);
  });

  it("withdraws a card at its own hash only, and twice is the same as once", async () => {
    const { client, queue } = await seeded(card("a", { stateHash: "h-new" }));
    await queue.withdraw(SOURCE, "a", "h-old");
    expect(await rows(client)).toHaveLength(1);

    await queue.withdraw(SOURCE, "a", "h-new");
    await queue.withdraw(SOURCE, "a", "h-new");
    expect(await rows(client)).toEqual([]);
  });

  it("removes a card whatever its hash, and keeps the other sources' cards of the same key", async () => {
    const { client, queue } = await seeded(card("a"), card("a", { source: "p1:messages" }));
    await queue.remove(SOURCE, "a");
    expect((await rows(client)).map((row) => row["source_id"])).toEqual(["p1:messages"]);
  });

  it("refuses a lock while another reviewer's lease runs, and hides the card from them", async () => {
    const { queue } = await seeded(card("a"), card("b"));

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

  it("lets a lease expire on the worker's clock alone, whatever the server's time @timing", async () => {
    // The fake clock stands years from the server's now(): only the clock passed in counts.
    const clock = new FakeClock(START);
    const { queue } = await seeded(card("a"));
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
    const { queue } = await seeded(card("a"));
    await queue.lock(SOURCE, "a", "ana", clock.now());

    clock.advance(60_000);
    expect(await queue.renew(SOURCE, "a", "ana", clock.now())).toEqual({
      kind: "locked",
      until: new Date(clock.now() + REVIEW_LOCK_MS),
    });
    expect((await queue.renew(SOURCE, "a", "ben", clock.now())).kind).toBe("held");

    clock.advance(REVIEW_LOCK_MS);
    await queue.lock(SOURCE, "a", "ben", clock.now());
    expect(await queue.renew(SOURCE, "a", "ana", clock.now())).toEqual({
      kind: "held",
      by: "ben",
      until: new Date(clock.now() + REVIEW_LOCK_MS),
    });

    await queue.release(SOURCE, "a", "ana");
    expect((await queue.list({}, "ben", clock.now()))[0]?.lock?.by).toBe("ben");
    await queue.release(SOURCE, "a", "ben");
    expect(await queue.renew(SOURCE, "a", "ben", clock.now())).toEqual({ kind: "lost" });
    expect(await queue.renew(SOURCE, "missing", "ben", clock.now())).toEqual({ kind: "gone" });
  });

  it("puts a skipped card behind the rest for that viewer only, and releases their lease", async () => {
    const { client, queue } = await seeded(
      card("a"),
      card("b", { since: new Date(START + 1_000) }),
      card("c", { since: new Date(START + 2_000) }),
    );
    await queue.lock(SOURCE, "a", "ana", START);
    await queue.skip(SOURCE, "a", "ana");
    await queue.skip(SOURCE, "a", "ana");

    expect(await keysOf(queue, "ana", START)).toEqual(["b", "c", "a"]);
    expect(await keysOf(queue, "ben", START)).toEqual(["a", "b", "c"]);
    expect((await rows(client))[0]).toMatchObject({
      record_key: "a",
      locked_by: null,
      until_ms: null,
      skipped_by: '["ana"]',
    });
    expect((await queue.list({}, "ana", START)).map((listed) => listed.skipped)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("filters by source, by an open question and by a probability band", async () => {
    const { queue } = await seeded(
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
    // One record's card alone, for the open of a named record.
    expect(await keysOf(queue, "ana", START, { source: SOURCE, key: "b" })).toEqual(["b"]);
    expect(await keysOf(queue, "ana", START, { source: SOURCE, key: "c" })).toEqual([]);
  });

  it("counts under the same clause as the listing, with the oldest card's since, and no card read", async () => {
    const { queue } = await seeded(
      card("a", { openQuestions: ["scam"], numbers: { scam: 0.62 } }),
      card("b", {
        openQuestions: ["scam", "category"],
        numbers: { scam: 0.41, category: 0.7 },
        since: new Date(START + 1_000),
      }),
      card("c", { source: "p1:messages", since: new Date(START + 2_000) }),
    );
    expect(await queue.count({}, "ana", START)).toEqual({
      count: 3,
      oldestSince: new Date(START),
    });
    expect(await queue.count({ below: 0.6 }, "ana", START)).toEqual({
      count: 2,
      oldestSince: new Date(START + 1_000),
    });
    expect(await queue.count({ question: "category", below: 0.6 }, "ana", START)).toEqual({
      count: 0,
      oldestSince: undefined,
    });
    // A card another reviewer holds is not counted for this viewer, as it is not listed.
    await queue.lock(SOURCE, "a", "maya", START);
    expect((await queue.count({ source: SOURCE }, "ana", START)).count).toBe(1);
    expect((await queue.count({ source: SOURCE }, "maya", START)).count).toBe(2);
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
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

function answer(key: string, scamYes: number, at: number, carProbability = 1): AnswerEntry {
  return {
    kind: "answer",
    key,
    version: 1,
    model: "jev-1.14.0",
    stateHash: `h-${key}`,
    answers: {
      scam: { type: "noul", probability: scamYes },
      category: { type: "choice", top: "car", probabilities: [carProbability, 1 - carProbability] },
    },
    usage: { inputTokens: 100, outputTokens: 8 },
    at: new Date(at),
  };
}

function human(key: string, question: string, value: boolean | string, at: number): HumanEntry {
  return {
    kind: "human",
    key,
    question,
    value,
    reviewer: "ana",
    stateHash: `h-${key}`,
    version: 1,
    at: new Date(at),
  };
}

describe("the one rebuild from the log (records decided before the queue existed)", () => {
  it("lists the records whose latest answer, with the people's decisions on it, leaves a question open", async () => {
    const { client } = await world();
    const log = createDecisionLog(client, SOURCE);
    // a: unsure, then asked again and sure: done. b: unsure, waiting. c: unsure, decided by a person.
    // d: unsure on two questions, one decided by a person: waiting on the other. e: sure at once.
    await log.appendAnswer(answer("a", 0.5, START));
    await log.appendAnswer(answer("a", 0.95, START + 1_000));
    await log.appendAnswer(answer("b", 0.5, START + 2_000));
    await log.appendAnswer(answer("c", 0.5, START + 3_000));
    await log.appendHuman(human("c", "scam", true, START + 4_000));
    await log.appendAnswer(answer("d", 0.5, START + 5_000, 0.6));
    await log.appendHuman(human("d", "scam", false, START + 6_000));
    await log.appendAnswer(answer("e", 0.95, START + 7_000));
    // Another source's log, not in the config: left alone.
    await createDecisionLog(client, "p1:gone").appendAnswer(answer("z", 0.5, START));

    const waiting = await rebuildStoreReviewQueue(
      client,
      PROJECT,
      new Map([[SOURCE, questionSet]]),
    );

    expect(waiting).toBe(2);
    expect(await createReviewQueue(client).list({}, "ana", START)).toEqual([
      {
        ...card("b", { since: new Date(START + 2_000) }),
        lock: null,
        skipped: false,
      },
      {
        ...card("d", {
          openQuestions: ["category"],
          numbers: { category: choiceConfidence([0.6, 0.4]) },
          since: new Date(START + 5_000),
        }),
        lock: null,
        skipped: false,
      },
    ]);
  });

  it("runs once per project and leaves the queue the worker kept since alone", async () => {
    const { client, queue } = await world();
    await createDecisionLog(client, SOURCE).appendAnswer(answer("b", 0.5, START));
    expect(await rebuildStoreReviewQueue(client, PROJECT, new Map([[SOURCE, questionSet]]))).toBe(
      1,
    );
    await queue.lock(SOURCE, "b", "ana", START);
    await queue.remove(SOURCE, "b");
    await queue.upsert(card("x"));

    expect(
      await rebuildStoreReviewQueue(client, PROJECT, new Map([[SOURCE, questionSet]])),
    ).toBeUndefined();
    expect(await keysOf(queue, "ana", START)).toEqual(["x"]);
  });

  it("lists a second project's records on that project's first migrate, on a store another project rebuilt", async () => {
    const { client, queue } = await world();
    const other = "p1:x:listings";
    await createDecisionLog(client, SOURCE).appendAnswer(answer("a", 0.5, START));
    await createDecisionLog(client, other).appendAnswer(answer("b", 0.5, START + 1_000));
    expect(await rebuildStoreReviewQueue(client, PROJECT, new Map([[SOURCE, questionSet]]))).toBe(
      1,
    );

    // Project `p1:x`, whose id begins with p1's: its own marker, its own sources only.
    expect(await rebuildStoreReviewQueue(client, "p1:x", new Map([[other, questionSet]]))).toBe(1);
    expect(
      (await queue.list({}, "ana", START)).map((listed) => [listed.source, listed.key]),
    ).toEqual([
      [SOURCE, "a"],
      [other, "b"],
    ]);
    expect(
      await rebuildStoreReviewQueue(client, "p1:x", new Map([[other, questionSet]])),
    ).toBeUndefined();
  });

  it("is idempotent when a stopped migrate runs it again: a card at the same hash keeps its lease", async () => {
    const { client, queue } = await world();
    await createDecisionLog(client, SOURCE).appendAnswer(answer("b", 0.5, START));
    expect(await rebuildStoreReviewQueue(client, PROJECT, new Map([[SOURCE, questionSet]]))).toBe(
      1,
    );
    await queue.lock(SOURCE, "b", "ana", START);
    // As if the migrate stopped before marking the rebuild done.
    await client.query("delete from facetdb.install where key = $1", [rebuiltKey(PROJECT)]);

    expect(await rebuildStoreReviewQueue(client, PROJECT, new Map([[SOURCE, questionSet]]))).toBe(
      1,
    );
    expect(await queue.list({}, "ana", START)).toEqual([
      {
        ...card("b"),
        lock: { by: "ana", until: new Date(START + REVIEW_LOCK_MS) },
        skipped: false,
      },
    ]);
  });
});

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

describe("an API source's worker keeps the store's queue", () => {
  it("adds the card of a needs_review write and removes it when the record is decided", async () => {
    const { store, clock } = await newStore();
    const probabilities = [0.5, 0.95];
    const connector = store.connector({
      sourceId: SOURCE,
      fields: ["title", "body"],
      workerId: "w",
    });
    const workerAt = (version: number) =>
      createWorker({
        connector,
        provider: {
          ask: () =>
            Promise.resolve({
              model: "jev-1.14.0",
              answers: {
                scam: { type: "noul", probability: probabilities.shift() ?? 0.95 },
                category: { type: "choice", top: "car", probabilities: [1, 0] },
              },
              usage: { inputTokens: 100, outputTokens: 8 },
            }),
        },
        log: store.log(SOURCE),
        reviews: reviewsOf(store.reviews, SOURCE),
        actions: [],
        clock,
        limits: DEFAULT_WORKER_LIMITS,
        questionSet,
        version,
        heldModel: freshHeldModel(version),
        spending: UNLIMITED,
      });
    await connector.upsertRecord("m1", { title: "Phone", body: "pay by gift card" });

    await workerAt(1).runOnce();
    const [listed] = await store.reviews.list({}, "ana", clock.now());
    expect(listed).toMatchObject({
      source: SOURCE,
      key: "m1",
      openQuestions: ["scam"],
      numbers: { scam: 0.5 },
      since: new Date(clock.now()),
    });

    await connector.enqueue(["m1"]);
    await workerAt(2).runOnce();
    expect(await store.reviews.list({}, "ana", clock.now())).toEqual([]);
  });
});
