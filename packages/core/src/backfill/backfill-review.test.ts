import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type {
  ProviderRequest,
  ProviderResponse,
  RecordDecision,
  RecordKey,
} from "../contracts/index.ts";
import { type AnswerEntry, recordAnswer } from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { followReview, reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { createWorker, DEFAULT_WORKER_LIMITS } from "../worker/index.ts";
import { type BackfillDeps, createBackfill } from "./backfill.ts";

/**
 * A backfill's write of an added question follows the review queue as the loop's write does (3,672
 * records read needs_review while the queue held none of the cards the backfill's writes should
 * have made).
 */

const SOURCE = "proj_market:listings";

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

function setOf(questions: readonly Question[]): QuestionSet {
  return { questions, read: ["body"], model: "jev-1.14.0", thresholds: {} };
}

const SCAM_ONLY = setOf([scam]);
const SCAM_AND_SPAM = setOf([scam, spam]);

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** What the model says of `spam` for each record, by body; a record not named is a sure no. */
function spamAnswerer(probabilities: Readonly<Record<string, number>>) {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    ask(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const body = String(request.state["body"]);
      return Promise.resolve({
        model: request.model,
        answers: Object.fromEntries(
          request.questions.map((question) => [
            question.name,
            { type: "noul", probability: probabilities[body] ?? 0.05 } as const,
          ]),
        ),
        usage: { inputTokens: 100, outputTokens: 5 },
      });
    },
  };
}

/** A table whose records the worker answered under version 1, one question, and queued the cards of. */
async function world(
  rows: Readonly<Record<RecordKey, { body: string; scam: number }>>,
  queue: FakeReviewQueue = new FakeReviewQueue(),
) {
  const clock = new FakeClock();
  const db = new FakeDatabase({ fields: ["body"], clock });
  const connector = new FakeConnector(db);
  await connector.install();
  const log = new FakeDecisionLog();
  const reviews = reviewsOf(queue, SOURCE);
  const hashes = new Map<RecordKey, string>();
  for (const [key, { body, scam: probability }] of Object.entries(rows)) {
    db.edit(key, { body });
    const { rows: read } = await connector.read([key]);
    const row = read[0];
    if (row === undefined) {
      throw new Error(`the row ${key} was not made`);
    }
    hashes.set(key, row.hash);
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 1,
      model: "jev-1.14.0",
      stateHash: row.hash,
      answers: { scam: { type: "noul", probability } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date(clock.now()),
    };
    const writes: RecordDecision[] = [];
    await recordAnswer(entry, SCAM_ONLY, log, (k, decision, hash) => {
      writes.push(decision);
      return connector.write(k, decision, hash);
    });
    const [decision] = writes;
    if (decision === undefined) {
      throw new Error("the seed's answer was not written");
    }
    await followReview(reviews, { key, stateHash: row.hash }, decision, entry);
    clock.advance(1_000);
  }
  // The worker took the edits' jobs and settled them when it answered.
  await connector.ack(await connector.claim(1_000));
  const deps = (worker: {
    ask: (request: ProviderRequest) => Promise<ProviderResponse>;
  }): BackfillDeps => ({
    project: "proj_market",
    source: "listings",
    connector,
    worker,
    clock,
    cursorStore: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
    log,
    questionSet: SCAM_AND_SPAM,
    version: 2,
    heldModel: freshHeldModel(2),
    spending: UNLIMITED,
    reviews,
  });
  return { clock, db, connector, log, queue, hashes, deps };
}

const yes = (): boolean => true;

describe("backfill of an added question follows the review queue", () => {
  it("adds the added question to a card the model is unsure of, with its number", async () => {
    const w = await world({ k1: { body: "unsure-scam", scam: 0.5 } });
    const [before] = w.queue.rows;
    expect(before?.openQuestions).toEqual(["scam"]);
    const model = spamAnswerer({ "unsure-scam": 0.5 });

    const report = await createBackfill(w.deps(model)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect(report).toMatchObject({ answered: ["k1"], failures: [], deferred: [] });
    expect(w.db.decisionOf("k1")?.status).toBe("needs_review");
    const [card] = w.queue.rows;
    expect(card?.openQuestions).toEqual(["scam", "spam"]);
    expect(card?.numbers).toEqual({ scam: 0.5, spam: 0.5 });
    // The same card: waiting since the first answer, at the record's state.
    expect(card?.since).toEqual(before?.since);
    expect(card?.stateHash).toBe(w.hashes.get("k1"));
  });

  it("makes a card for a record the added question's answer alone sends to review", async () => {
    const w = await world({ k1: { body: "sure-scam", scam: 0.95 } });
    expect(w.queue.rows).toEqual([]);
    const model = spamAnswerer({ "sure-scam": 0.5 });

    await createBackfill(w.deps(model)).run({ onlyQuestions: ["spam"], onEstimate: yes });

    expect(w.db.decisionOf("k1")?.status).toBe("needs_review");
    const [card] = w.queue.rows;
    expect(card?.key).toBe("k1");
    expect(card?.openQuestions).toEqual(["spam"]);
    expect(card?.numbers).toEqual({ spam: 0.5 });
  });

  it("removes the card of a record the added answer leaves with every question decided", async () => {
    const w = await world({ k1: { body: "decided-by-a-person", scam: 0.5 } });
    // A person decided the unsure scam question at the record's state; the added question had no
    // answer yet, so the card (and the record) still waited.
    await w.log.appendHuman({
      kind: "human",
      key: "k1",
      question: "scam",
      value: false,
      reviewer: "alice",
      stateHash: w.hashes.get("k1") ?? "",
      version: 1,
      at: new Date(w.clock.now()),
    });
    expect(w.queue.rows).toHaveLength(1);
    const model = spamAnswerer({ "decided-by-a-person": 0.9 });

    await createBackfill(w.deps(model)).run({ onlyQuestions: ["spam"], onEstimate: yes });

    expect(w.db.decisionOf("k1")?.status).toBe("done");
    expect(w.queue.rows).toEqual([]);
  });

  it("follows each record of a run on its own: cards kept, added and absent together", async () => {
    const w = await world({
      k1: { body: "a", scam: 0.5 },
      k2: { body: "b", scam: 0.95 },
      k3: { body: "c", scam: 0.05 },
    });
    // k1 waits on scam; k2 and k3 are done and have no card.
    expect(w.queue.rows.map((card) => card.key)).toEqual(["k1"]);
    const model = spamAnswerer({ a: 0.9, b: 0.5, c: 0.9 });

    await createBackfill(w.deps(model)).run({ onlyQuestions: ["spam"], onEstimate: yes });

    const cards = w.queue.rows.map((card) => [card.key, card.openQuestions]);
    // k1 stays on scam (spam is decided), k2 is new on spam, k3 is done with no card.
    expect(cards).toEqual([
      ["k1", ["scam"]],
      ["k2", ["spam"]],
    ]);
  });

  it("leaves the queue as it was for a record that changed while the model answered", async () => {
    const w = await world({ k1: { body: "a", scam: 0.5 } });
    const model = spamAnswerer({ a: 0.5 });
    const asking = {
      ask: (request: ProviderRequest) => {
        // The application edits the record while the model answers it: the write will not land.
        w.db.edit("k1", { body: "a, edited" });
        return model.ask(request);
      },
    };

    const report = await createBackfill(w.deps(asking)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect(report.discarded).toEqual(["k1"]);
    // No write landed, so nothing follows it: the card stands at the state it was made for (the
    // edit's own change capture has queued the record, and the worker withdraws the card).
    const [card] = w.queue.rows;
    expect(card?.openQuestions).toEqual(["scam"]);
    expect(card?.stateHash).toBe(w.hashes.get("k1"));
  });

  it("releases the claim, not acks it, when the queue refuses the follow; a worker pass then follows without asking the model", async () => {
    const queue = new FlakyQueue();
    const w = await world({ k1: { body: "sure-scam", scam: 0.95 } }, queue);
    queue.failNextUpsert = true;
    const model = spamAnswerer({ "sure-scam": 0.5 });

    const report = await createBackfill(w.deps(model)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    // The answer is logged and the row written needs_review, but the card is missing and the
    // failure is the run's to report.
    expect(report.failures.map((failure) => failure.key)).toEqual(["k1"]);
    expect(w.db.decisionOf("k1")?.status).toBe("needs_review");
    expect(w.queue.rows).toEqual([]);
    // Released: the job is back in the queue, unclaimed, not acked away.
    expect(w.db.jobs.get("k1")).toEqual({ claimedBy: null });

    // A later backfill finds the answer current and follows nothing: only the worker can.
    const worker = spamAnswerer({});
    const loop = createWorker({
      connector: w.connector,
      provider: worker,
      log: w.log,
      reviews: reviewsOf(queue, SOURCE),
      actions: [],
      clock: w.clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: SCAM_AND_SPAM,
      version: 2,
      heldModel: freshHeldModel(2),
      spending: UNLIMITED,
    });
    const asked = model.requests.length;

    const pass = await loop.runOnce();

    expect(pass.alreadyAnswered).toEqual(["k1"]);
    expect(model.requests.length).toBe(asked);
    expect(worker.requests).toEqual([]);
    const [card] = w.queue.rows;
    expect(card?.key).toBe("k1");
    expect(card?.openQuestions).toEqual(["spam"]);
    expect(card?.numbers).toEqual({ spam: 0.5 });
    expect(w.db.jobs.size).toBe(0);
  });
});

/** A queue that refuses one upsert, as a store that dropped the connection would. */
class FlakyQueue extends FakeReviewQueue {
  failNextUpsert = false;

  override upsert(entry: Parameters<FakeReviewQueue["upsert"]>[0]): Promise<void> {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      return Promise.reject(new Error("the review queue is unreachable"));
    }
    return super.upsert(entry);
  }
}
