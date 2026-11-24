import {
  FakeAction,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordDecision, RecordKey } from "../contracts/index.ts";
import { type AnswerEntry, type LogEntry, recordAnswer, standingHuman } from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { Answer } from "../thresholds/index.ts";
import { configureAction } from "../worker/index.ts";
import { followReview } from "./follow.ts";
import { type ReviewEntry, reviewsOf } from "./queue.ts";
import { type CardRef, createReviewService, type OpenedCard } from "./service.ts";

/**
 * A person's decision written while a model answer is logged at the card's state (a backfill
 * merging an added question into the answer, or the worker asking again at an unchanged state) is
 * written together with that answer, never done over a question it leaves open. The interleaving is
 * deterministic: the review service's connection runs the armed step inside its `write`, after the
 * row is written and before the write returns, so the newer answer is in the log but not in the
 * history the write was made from: the window between the card's load and the read after the write.
 * Found in use: a card loaded before the backfill's unsure answer on an added question was written
 * `done` over it, and its card was lost.
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

/** The set the cards were answered under (version 1), and the set after `vehicle` was added. */
const VERSION_1 = setOf([scam, team]);
const VERSION_2 = setOf([scam, team, vehicle]);

// The low-stakes defaults: a noul is yes at or above 0.70 and no at or below 0.30; a choice decides
// at confidence 0.50, which for two options is a top pick of 75%.
const UNSURE_SCAM: Answer = { type: "noul", probability: 0.5 };
const SURE_SCAM: Answer = { type: "noul", probability: 0.95 };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };
const SURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_VEHICLE: Answer = { type: "noul", probability: 0.5 };
const SURE_NO_VEHICLE: Answer = { type: "noul", probability: 0.05 };

const START = Date.parse("2026-11-19T10:00:00Z");

/**
 * The review service's connection: every write is noted in the journal and kept, and the next
 * armed step runs inside the write once the row is written, before the write returns.
 */
class RacingConnector extends FakeConnector {
  readonly writes: RecordDecision[] = [];
  readonly duringWrite: (() => Promise<void>)[] = [];
  readonly #journal: string[];

  constructor(database: FakeDatabase, journal: string[]) {
    super(database);
    this.#journal = journal;
  }

  override async write(
    ...args: Parameters<FakeConnector["write"]>
  ): ReturnType<FakeConnector["write"]> {
    this.#journal.push(`write ${args[0]}`);
    this.writes.push(args[1]);
    const result = await super.write(...args);
    await this.duringWrite.shift()?.();
    return result;
  }
}

/** The log, noting every history read in the journal; an armed step runs once just after a read. */
class JournalLog extends FakeDecisionLog {
  afterNextRead: (() => Promise<void>) | undefined;

  override async history(key: RecordKey): Promise<readonly LogEntry[]> {
    this.journal.push(`history ${key}`);
    const entries = await super.history(key);
    const step = this.afterNextRead;
    this.afterNextRead = undefined;
    await step?.();
    return entries;
  }
}

/** The queue, noting each card added, refreshed or taken out in the journal. */
class JournalQueue extends FakeReviewQueue {
  readonly #journal: string[];

  constructor(journal: string[]) {
    super();
    this.#journal = journal;
  }

  override upsert(entry: ReviewEntry): Promise<void> {
    this.#journal.push(`card ${entry.key} [${entry.openQuestions.join(", ")}]`);
    return super.upsert(entry);
  }

  override remove(source: string, key: RecordKey): Promise<void> {
    this.#journal.push(`card ${key} removed`);
    return super.remove(source, key);
  }
}

type Notify = { readonly to: string };

/**
 * Record `r1` answered under version 1 with `answers`, written and its card queued as the worker
 * leaves it, and a review service whose source has `inForce` as its set.
 */
async function setup(inForce: QuestionSet, answers: Record<string, Answer>) {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const journal: string[] = [];
  const connector = new RacingConnector(db, journal);
  // The worker's (or the backfill's) own connection to the same table: its writes race nothing.
  const worker = new FakeConnector(db);
  const log = new JournalLog(journal);
  const queue = new JournalQueue(journal);
  const reviews = reviewsOf(queue, SOURCE);
  const notify = new FakeAction<Notify>();
  const service = createReviewService({
    queue,
    log: new Map([[SOURCE, log]]),
    connectors: new Map([[SOURCE, connector]]),
    actions: new Map([[SOURCE, [configureAction("notify", notify, { to: "#mods" })]]]),
    questionSets: new Map([[SOURCE, { questionSet: inForce, version: 2 }]]),
    clock,
  });

  db.edit("r1", { body: "Cheap van, pay by gift card" });
  const hash = stateHash(["body"], { body: "Cheap van, pay by gift card" });

  /** A model answer for `r1` logged now, at its state unless another hash is named. */
  const answerOf = (given: Record<string, Answer>, version = 2, at = hash): AnswerEntry => ({
    kind: "answer",
    key: "r1",
    version,
    model: "jev-1.14.0",
    stateHash: at,
    answers: given,
    usage: { inputTokens: 100, outputTokens: 8 },
    at: new Date(clock.now()),
  });

  /** The worker's or the backfill's write of a logged answer, the queue following each landed write. */
  const answered = (entry: AnswerEntry, questionSet: QuestionSet) =>
    recordAnswer(entry, questionSet, log, async (key, decision, expected) => {
      const result = await worker.write(key, decision, expected);
      if (result.written) {
        await followReview(reviews, { key, stateHash: entry.stateHash }, decision, entry);
      }
      return result;
    });

  await answered(answerOf(answers, 1), VERSION_1);
  clock.advance(60_000);

  /** Opens `r1`'s card for alice, the journal emptied after it. */
  async function open(): Promise<{ card: OpenedCard; ref: CardRef }> {
    const card = await service.open("alice", {});
    if (card === null) {
      throw new Error("the card was withdrawn");
    }
    journal.length = 0;
    clock.advance(5_000);
    return { card, ref: { source: card.source, key: card.key, stateHash: card.stateHash } };
  }

  return {
    clock,
    db,
    journal,
    connector,
    log,
    queue,
    notify,
    service,
    hash,
    answerOf,
    answered,
    open,
  };
}

describe("a person's decision while a newer answer is logged at the card's state", () => {
  it("a decision on the last open question while a backfill's merge adds an unsure question ends needs_review, the person's value kept, the card still in the queue", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { card, ref } = await t.open();
    expect(card.open.map((open) => open.question.name)).toEqual(["scam"]);
    // The backfill of the added question merges its answer into the record's latest one.
    const merged = t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE });
    t.connector.duringWrite.push(() => t.log.appendAnswer(merged));

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toEqual({
      kind: "decided",
      status: "needs_review",
      open: ["vehicle"],
      failures: [],
    });
    const row = t.db.decisionOf("r1");
    expect(row).toMatchObject({
      decisions: {
        scam: { kind: "decided", value: false, probabilityOrConfidence: 0.5 },
        team: { kind: "decided", value: "billing" },
        vehicle: { kind: "needs_review" },
      },
      status: "needs_review",
      reviewed: true,
    });
    expect(t.queue.rows).toHaveLength(1);
    expect(t.queue.rows[0]).toMatchObject({
      key: "r1",
      stateHash: t.hash,
      openQuestions: ["vehicle"],
      since: merged.at,
    });
    // The first write was judged on the card's answer; the second on the merged one.
    expect(t.connector.writes.map((write) => write.status)).toEqual(["done", "needs_review"]);
    // The actions run once, with what landed last.
    expect(t.notify.calls).toHaveLength(1);
    expect(t.notify.calls[0]?.record.status).toBe("needs_review");
    expect(t.notify.calls[0]?.decisions["vehicle"]).toEqual({ kind: "needs_review" });
    expect(t.notify.calls[0]?.decisions["scam"]).toMatchObject({ value: false });
  });

  it("a newer answer that decides the other questions ends done", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { card, ref } = await t.open();
    expect(card.open.map((open) => open.question.name)).toEqual(["scam", "team"]);
    // The worker asks again at the unchanged state, and now the thresholds decide team.
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM })),
    );

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toEqual({ kind: "decided", status: "done", open: [], failures: [] });
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: {
        scam: { kind: "decided", value: false, probabilityOrConfidence: 0.5 },
        team: { kind: "decided", value: "billing" },
      },
      status: "done",
      reviewed: true,
    });
    expect(t.queue.rows).toEqual([]);
    expect(t.connector.writes.map((write) => write.status)).toEqual(["needs_review", "done"]);
    expect(t.notify.calls.map((call) => call.record.status)).toEqual(["done"]);
  });

  it("a newer answer that answers the person's question differently leaves the person's value in the row", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    // The merge carries a sure yes on scam, and leaves the added question open.
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(t.answerOf({ scam: SURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE })),
    );

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["vehicle"] });
    // The person's value, with the newer answer's number: the value says what the person decided,
    // the number what the model now thinks.
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toEqual({
      kind: "decided",
      value: false,
      probabilityOrConfidence: 0.95,
    });
    for (const write of t.connector.writes) {
      expect(write.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
    }
    expect(standingHuman(await t.log.history("r1"), "scam", t.hash)?.value).toBe(false);
  });

  it("a newer answer that decides the question the person left open as well: done, every question decided", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(
        t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: SURE_NO_VEHICLE }),
      ),
    );

    const result = await t.service.decide("alice", ref, "scam", true);

    expect(result).toMatchObject({ kind: "decided", status: "done", open: [] });
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: {
        scam: { kind: "decided", value: true },
        team: { kind: "decided", value: "billing" },
        vehicle: { kind: "decided", value: false },
      },
      status: "done",
      reviewed: true,
    });
    expect(t.queue.rows).toEqual([]);
  });

  it("the backfill's whole write racing the decision: the row and the card end on both, whichever write lands last", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    // The backfill logs, writes (the person's entry is in its history: it carries it) and follows
    // the queue, all between the decision's write and the read after it.
    t.connector.duringWrite.push(async () => {
      await t.answered(
        t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE }),
        VERSION_2,
      );
    });

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["vehicle"] });
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: {
        scam: { kind: "decided", value: false },
        vehicle: { kind: "needs_review" },
      },
      status: "needs_review",
      reviewed: true,
    });
    expect(t.queue.rows.map((row) => row.openQuestions)).toEqual([["vehicle"]]);
  });

  it("a backfill that writes after the decision's read after its write keeps its card: the queue follows each write before that read", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    // Armed by the decision's write, so it runs after the read that follows that write, which sees
    // no newer answer: the backfill's log, write and card come after it.
    t.connector.duringWrite.push(() => {
      t.log.afterNextRead = async () => {
        await t.answered(
          t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE }),
          VERSION_2,
        );
      };
      return Promise.resolve();
    });

    const result = await t.service.decide("alice", ref, "scam", false);

    // The decision's own write was the last the review path made, and it was done: the service
    // reports what it wrote. The row and the card are the backfill's, which carried the person.
    expect(result).toMatchObject({ kind: "decided", status: "done" });
    expect(t.connector.writes).toHaveLength(1);
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: { scam: { kind: "decided", value: false }, vehicle: { kind: "needs_review" } },
      status: "needs_review",
      reviewed: true,
    });
    expect(t.queue.rows.map((row) => row.openQuestions)).toEqual([["vehicle"]]);
  });

  it("an answer logged at another state is not newer at this one: one write, as today", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    // The worker was shown another state (the record was edited and edited back): its answer is not
    // this card's, and the person's decision stands at the card's state alone.
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(t.answerOf({ scam: SURE_SCAM, team: SURE_TEAM }, 2, "another-state")),
    );

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "done" });
    expect(t.connector.writes).toHaveLength(1);
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toEqual({
      kind: "decided",
      value: false,
      probabilityOrConfidence: 0.5,
    });
  });

  it("a newer answer with none of the set's questions judges nothing: never done over it, one write", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open();
    // Logged under a set this service does not run (one that asks vehicle alone).
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(t.answerOf({ vehicle: SURE_NO_VEHICLE })),
    );

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["team"] });
    expect(t.connector.writes).toHaveLength(1);
    expect(t.db.decisionOf("r1")?.status).toBe("needs_review");
    expect(t.queue.rows.map((row) => row.openQuestions)).toEqual([["team"]]);
  });

  it("a newer answer with none of the set's questions does not stop the look for people: a second person's decision in the same window ends in the row", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open();
    // In the same window: an answer this service cannot judge, and bob deciding team, his own
    // write still to come (or never).
    t.connector.duringWrite.push(async () => {
      await t.log.appendAnswer(t.answerOf({ vehicle: SURE_NO_VEHICLE }));
      await t.log.appendHuman({
        kind: "human",
        key: "r1",
        question: "team",
        value: "tech",
        reviewer: "bob",
        stateHash: t.hash,
        version: 2,
        at: new Date(t.clock.now()),
      });
    });

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toEqual({ kind: "decided", status: "done", open: [], failures: [] });
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: {
        scam: { kind: "decided", value: false },
        team: { kind: "decided", value: "tech" },
      },
      status: "done",
      reviewed: true,
    });
    expect(t.connector.writes.map((write) => write.status)).toEqual(["needs_review", "done"]);
    expect(t.queue.rows).toEqual([]);
  });

  it("an undo while a backfill's merge is logged reopens the card on the merged answer's open questions", async () => {
    const t = await setup(VERSION_2, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();
    expect(await t.service.decide("alice", ref, "scam", true)).toMatchObject({ status: "done" });
    t.connector.writes.length = 0;
    t.connector.duringWrite.push(() =>
      t.log.appendAnswer(
        t.answerOf({ scam: UNSURE_SCAM, team: SURE_TEAM, vehicle: UNSURE_VEHICLE }),
      ),
    );

    const result = await t.service.undo("alice");

    expect(result).toMatchObject({ kind: "undone", status: "needs_review" });
    if (result.kind !== "undone") {
      throw new Error("the undo did not land");
    }
    expect(result.card?.open.map((open) => open.question.name)).toEqual(["scam", "vehicle"]);
    expect(result.card?.decided.map((decided) => decided.question.name)).toEqual(["team"]);
    expect(t.db.decisionOf("r1")).toMatchObject({
      decisions: { scam: { kind: "needs_review" }, vehicle: { kind: "needs_review" } },
      status: "needs_review",
      reviewed: true,
    });
    expect(t.queue.rows.map((row) => row.openQuestions)).toEqual([["scam", "vehicle"]]);
  });
});

describe("with no newer entry, a decision makes the same writes and reads as before", () => {
  it("one history read to load, the append, one write, the card followed, one read after it", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open();

    const result = await t.service.decide("alice", ref, "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["team"] });
    // The queue follows the write before the read after it (the worker's order); the count of reads
    // and writes is the one in an earlier version.
    expect(t.journal).toEqual([
      "history r1",
      "append human r1",
      "write r1",
      "card r1 [team]",
      "history r1",
    ]);
  });

  it("a decision that closes the record: the card taken out before the read after the write", async () => {
    const t = await setup(VERSION_1, { scam: UNSURE_SCAM, team: SURE_TEAM });
    const { ref } = await t.open();

    await t.service.decide("alice", ref, "scam", false);

    expect(t.journal).toEqual([
      "history r1",
      "append human r1",
      "write r1",
      "card r1 removed",
      "history r1",
    ]);
    expect(t.queue.rows).toEqual([]);
  });
});
