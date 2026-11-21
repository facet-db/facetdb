import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordDecision, RecordKey } from "../contracts/index.ts";
import { type AnswerEntry, recordAnswer, standingHuman } from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { Answer } from "../thresholds/index.ts";
import { followReview } from "./follow.ts";
import { reviewsOf } from "./queue.ts";
import { type CardRef, createReviewService, type OpenedCard } from "./service.ts";

/**
 * A card whose answer was logged before a question was added is judged on the questions that answer
 * has, not withdrawn as "asked again". Seen in a real run: `is_vehicle` was added, the source
 * switched to version 2, and every card of the queue (567) was withdrawn one by one on open while
 * 3,672 records still read needs_review.
 */

const SOURCE = "proj_market:listings";

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};
const team: Question = {
  type: "choice",
  name: "team",
  instructions: "Which team owns this?",
  options: [
    { name: "billing", description: "Money questions" },
    { name: "tech", description: "Technical questions" },
  ],
  stakes: "low",
  storeProbabilities: false,
};
const vehicle: Question = {
  type: "noul",
  name: "vehicle",
  instructions: "Is this listing a vehicle?",
  stakes: "low",
};

function setOf(questions: readonly Question[]): QuestionSet {
  return { questions, read: ["body"], model: "jev-1.14.0", thresholds: {} };
}

/** The set the cards were answered under (version 1), and the sets in force after it changed. */
const VERSION_1 = setOf([scam, team]);
const VERSION_2_ADDED = setOf([scam, team, vehicle]);
const VERSION_2_REMOVED = setOf([scam]);

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.5 };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };
const SURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_VEHICLE: Answer = { type: "noul", probability: 0.5 };

const START = Date.parse("2026-11-12T10:00:00Z");

/**
 * Records answered under version 1 with their cards queued as the worker leaves them, and a review
 * service whose source has switched to the set in force.
 */
function setup(inForce: QuestionSet, version = 2) {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const connector = new FakeConnector(db);
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const service = createReviewService({
    queue,
    log: new Map([[SOURCE, log]]),
    connectors: new Map([[SOURCE, connector]]),
    actions: new Map([[SOURCE, []]]),
    questionSets: new Map([[SOURCE, { questionSet: inForce, version }]]),
    clock,
  });

  /** As the worker left the record under version 1: answered, logged, written, its card queued. */
  async function seed(key: RecordKey, answers: Record<string, Answer>): Promise<string> {
    db.edit(key, { body: `listing ${key}` });
    const hash = stateHash(["body"], { body: `listing ${key}` });
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 1,
      model: "jev-1.14.0",
      stateHash: hash,
      answers,
      usage: { inputTokens: 100, outputTokens: 8 },
      at: new Date(clock.now()),
    };
    const writes: RecordDecision[] = [];
    await recordAnswer(entry, VERSION_1, log, (k, decision, expected) => {
      writes.push(decision);
      return connector.write(k, decision, expected);
    });
    const [written] = writes;
    if (written === undefined) {
      throw new Error("the seed's answer was not written");
    }
    await followReview(reviewsOf(queue, SOURCE), { key, stateHash: hash }, written, entry);
    clock.advance(1_000);
    return hash;
  }

  return { clock, db, connector, log, queue, service, seed };
}

function refOf(card: OpenedCard): CardRef {
  return { source: card.source, key: card.key, stateHash: card.stateHash };
}

describe("a card answered under the question set before the one in force", () => {
  it("opens every one of 500 cards after a question was added; none is withdrawn", async () => {
    const t = setup(VERSION_2_ADDED);
    for (let n = 1; n <= 500; n += 1) {
      await t.seed(`r${n}`, { scam: UNSURE_SCAM, team: SURE_TEAM });
    }
    expect(t.queue.rows).toHaveLength(500);

    const opened = new Set<RecordKey>();
    for (let n = 1; n <= 500; n += 1) {
      const card = await t.service.open("alice", {});
      if (card === null) {
        throw new Error(`the queue ran dry after ${opened.size} of 500 cards`);
      }
      opened.add(card.key);
      // The next open reaches the next card: this one goes behind the rest for alice.
      await t.service.skip("alice", refOf(card));
    }

    expect(opened.size).toBe(500);
    expect(t.queue.rows).toHaveLength(500);
  });

  it("opens on the questions the answer has; the added question is on no side of the card", async () => {
    const t = setup(VERSION_2_ADDED);
    const hash = await t.seed("r1", { scam: UNSURE_SCAM, team: SURE_TEAM });

    const card = await t.service.open("alice", {});

    expect(card).toEqual({
      source: SOURCE,
      key: "r1",
      stateHash: hash,
      state: { body: "listing r1" },
      open: [{ question: scam, answer: UNSURE_SCAM, figure: 0.5 }],
      decided: [{ question: team, value: "billing" }],
      since: new Date(START),
      lockedUntil: new Date(t.clock.now() + 10 * 60_000),
    });
    expect(t.queue.rows).toHaveLength(1);
  });

  it("logs and writes a decision on it as it does today, under the version in force", async () => {
    const t = setup(VERSION_2_ADDED);
    const hash = await t.seed("r1", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const card = await t.service.open("alice", {});
    if (card === null) {
      throw new Error("the card was withdrawn");
    }

    const result = await t.service.decide("alice", refOf(card), "scam", false, "fine");

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["team"] });
    const history = await t.log.history("r1");
    expect(history.at(-1)).toMatchObject({
      kind: "human",
      question: "scam",
      value: false,
      reviewer: "alice",
      note: "fine",
      stateHash: hash,
      version: 2,
    });
    const row = t.db.decisionOf("r1");
    expect(row?.reviewed).toBe(true);
    expect(row?.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
    expect(row?.decisions["vehicle"]).toBeUndefined();
    // The card follows the write: still the viewer's, open on what is left.
    const [queued] = t.queue.rows;
    expect(queued?.openQuestions).toEqual(["team"]);
    expect(queued?.lock?.by).toBe("alice");

    const second = await t.service.decide("alice", refOf(card), "team", "tech");
    expect(second).toMatchObject({ kind: "decided", status: "done", open: [] });
    expect(t.queue.rows).toEqual([]);
  });

  it("refuses a decision on the added question: the model has not answered it", async () => {
    const t = setup(VERSION_2_ADDED);
    await t.seed("r1", { scam: UNSURE_SCAM, team: SURE_TEAM });
    const card = await t.service.open("alice", {});
    if (card === null) {
      throw new Error("the card was withdrawn");
    }

    const result = await t.service.decide("alice", refOf(card), "vehicle", true);

    expect(result).toEqual({
      kind: "refused",
      reason: '"vehicle" has no answer from the model on this card yet',
    });
    expect(await t.log.history("r1")).toHaveLength(1);
  });

  it("keeps the person's word when the backfill answers the added question at the same state", async () => {
    const t = setup(VERSION_2_ADDED);
    const hash = await t.seed("r1", { scam: UNSURE_SCAM, team: SURE_TEAM });
    const card = await t.service.open("alice", {});
    if (card === null) {
      throw new Error("the card was withdrawn");
    }
    await t.service.decide("alice", refOf(card), "scam", true);

    // The added question's backfill merges its answer into the record's latest one.
    const writes: RecordDecision[] = [];
    await recordAnswer(
      {
        kind: "answer",
        key: "r1",
        version: 2,
        model: "jev-1.14.0",
        stateHash: hash,
        answers: { scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE },
        usage: { inputTokens: 100, outputTokens: 8 },
        at: new Date(t.clock.now()),
      },
      VERSION_2_ADDED,
      t.log,
      (key, decision, expected) => {
        writes.push(decision);
        return t.connector.write(key, decision, expected);
      },
    );

    expect(standingHuman(await t.log.history("r1"), "scam", hash)?.value).toBe(true);
    expect(writes[0]?.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
    expect(writes[0]?.status).toBe("needs_review");
  });

  it("drops a question the set no longer has from the card; a card left with none is withdrawn", async () => {
    const t = setup(VERSION_2_REMOVED);
    // r1's only open question is the removed one: nothing is left to decide on it.
    await t.seed("r1", { scam: { type: "noul", probability: 0.95 }, team: UNSURE_TEAM });
    await t.seed("r2", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const card = await t.service.open("alice", {});

    expect(card?.key).toBe("r2");
    expect(card?.open.map((open) => open.question.name)).toEqual(["scam"]);
    expect(card?.decided).toEqual([]);
    // r1 was met first: no open question of the set in force, so its card left the queue.
    expect(t.queue.rows.map((row) => row.key)).toEqual(["r2"]);
  });

  it("still withdraws a card whose record has no answer at the card's state", async () => {
    const t = setup(VERSION_2_ADDED);
    const hash = await t.seed("r1", { scam: UNSURE_SCAM, team: SURE_TEAM });
    // A card the log cannot explain (a purged and reinstalled source, a rebuild's card).
    t.db.edit("r2", { body: "listing r2" });
    const orphan = stateHash(["body"], { body: "listing r2" });
    await t.queue.upsert({
      source: SOURCE,
      key: "r2",
      stateHash: orphan,
      openQuestions: ["scam"],
      numbers: { scam: 0.5 },
      since: new Date(START - 1_000),
    });

    const card = await t.service.open("alice", {});

    // The orphan is older: it is met first and withdrawn; the answered card behind it opens.
    expect(card).toMatchObject({ key: "r1", stateHash: hash });
    expect(t.queue.rows.map((row) => row.key)).toEqual(["r1"]);

    const result = await t.service.decide(
      "alice",
      { source: SOURCE, key: "r2", stateHash: orphan },
      "scam",
      true,
    );
    expect(result).toMatchObject({ kind: "stale" });
  });
});
