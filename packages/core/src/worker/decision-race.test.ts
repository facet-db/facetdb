import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createBackfill } from "../backfill/index.ts";
import type {
  ActionDecisions,
  ActionRecord,
  ProviderRequest,
  ProviderResponse,
  RecordDecision,
  RecordKey,
} from "../contracts/index.ts";
import {
  type AnswerEntry,
  applyHumanDecision,
  type HumanEntry,
  type LogEntry,
  recordAnswer,
} from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { followReview, reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import type { ActionStep } from "./action-pipeline.ts";
import { createWorker, DEFAULT_WORKER_LIMITS } from "./worker.ts";

/**
 * A person's decision logged while the worker (or a backfill's added-question merge) writes the
 * same record at the same state stays in the row, and the record never returns to review for it.
 * The interleaving is deterministic: the racing connector's `write` runs the person's step before
 * it writes, so the person's entry is in the log but not in the history the write was decided from,
 * exactly the window between the worker's read and its write.
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

// The low-stakes noul defaults: yes at or above 0.70, no at or below 0.30.
const UNSURE = 0.5;
const SURE_NO = 0.05;

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** A model that answers every asked question with the probability set for it. */
function model(probabilities: Readonly<Record<string, number>>) {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    ask(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      return Promise.resolve({
        model: request.model,
        answers: Object.fromEntries(
          request.questions.map((question) => [
            question.name,
            { type: "noul", probability: probabilities[question.name] ?? UNSURE } as const,
          ]),
        ),
        usage: { inputTokens: 100, outputTokens: 5 },
      });
    },
  };
}

/**
 * The worker's connection: every write is noted in the journal shared with the log, and the next
 * armed step (a person deciding) runs inside the write, before the row is written.
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
    await this.duringWrite.shift()?.();
    return super.write(...args);
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

/** An action step that notes what each run saw. */
function journalStep(runs: { record: ActionRecord; decisions: ActionDecisions }[]): ActionStep {
  return {
    name: "journal",
    run: (record, decisions) => {
      runs.push({ record, decisions });
      return Promise.resolve();
    },
  };
}

/**
 * One record `k1`, answered by the worker under version 1 of `seeded` with the given scam
 * probabilities and its card queued as the loop does, its job settled.
 */
async function world(seeded: QuestionSet, answers: Readonly<Record<string, number>>) {
  const clock = new FakeClock();
  const db = new FakeDatabase({ fields: ["body"], clock });
  const journal: string[] = [];
  const connector = new RacingConnector(db, journal);
  await connector.install();
  // The review service's own connection to the same table: its writes race nothing.
  const reviewer = new FakeConnector(db);
  const log = new JournalLog(journal);
  const queue = new FakeReviewQueue();
  const reviews = reviewsOf(queue, SOURCE);
  db.edit("k1", { body: "Cheap phone, pay by gift card" });
  const { rows } = await connector.read(["k1"]);
  const hash = rows[0]?.hash ?? "";
  const entry: AnswerEntry = {
    kind: "answer",
    key: "k1",
    version: 1,
    model: "jev-1.14.0",
    stateHash: hash,
    answers: Object.fromEntries(
      seeded.questions.map((q) => [q.name, { type: "noul", probability: answers[q.name] ?? 0 }]),
    ),
    usage: { inputTokens: 100, outputTokens: 5 },
    at: new Date(clock.now()),
  };
  await recordAnswer(entry, seeded, log, (k, decision, expected) =>
    connector.write(k, decision, expected),
  );
  const [seed] = connector.writes;
  if (seed === undefined) {
    throw new Error("the seed's answer was not written");
  }
  await followReview(reviews, { key: "k1", stateHash: hash }, seed, entry);
  await connector.ack(await connector.claim(10));
  clock.advance(60_000);
  journal.length = 0;
  connector.writes.length = 0;

  /** A person's decision on `k1` at its state, logged at the clock's time plus `afterMs`. */
  const decision = (
    question: string,
    value: boolean,
    reviewer = "alice",
    version = 2,
  ): HumanEntry => ({
    kind: "human",
    key: "k1",
    question,
    value,
    reviewer,
    stateHash: hash,
    version,
    at: new Date(clock.now() + 5_000),
  });

  /** The person's decision lands in the log alone: their own write is still to come, or never. */
  const logs = (entry: HumanEntry) => () => log.appendHuman(entry);

  const worker = (questionSet: QuestionSet, version: number, provider = model({})) => {
    const runs: { record: ActionRecord; decisions: ActionDecisions }[] = [];
    const loop = createWorker({
      connector,
      provider,
      log,
      reviews,
      actions: [journalStep(runs)],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet,
      version,
      heldModel: freshHeldModel(version),
      spending: UNLIMITED,
    });
    return { loop, runs, provider };
  };

  return { clock, db, connector, reviewer, log, queue, reviews, hash, decision, logs, worker };
}

describe("a person's decision logged while the worker writes the same record", () => {
  it("the worker's answer path: the person's value and reviewed end in the row, the card leaves, the actions run done", async () => {
    // A release re-asks the record at an unchanged state; the person decides as the write goes.
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    expect(w.queue.rows.map((card) => card.key)).toEqual(["k1"]);
    const person = w.decision("scam", false);
    w.connector.duringWrite.push(w.logs(person));
    const { loop, runs } = w.worker(SCAM_ONLY, 2, model({ scam: UNSURE }));
    w.db.queue("k1");

    const report = await loop.runOnce();

    expect(report.failures).toEqual([]);
    expect(report.written).toEqual(["k1"]);
    expect(report.toReview).toEqual([]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: UNSURE } },
      status: "done",
      reviewed: true,
    });
    expect(w.queue.rows).toEqual([]);
    // The first write was the thresholds' alone; the second carries the person's decision.
    expect(w.connector.writes.map((write) => write.status)).toEqual(["needs_review", "done"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.record.status).toBe("done");
    expect(runs[0]?.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
    expect(runs[0]?.record.decidedAt).toEqual(person.at);
    expect(w.db.jobs.size).toBe(0);
  });

  it("the worker's answer path: a person's whole decision that landed just before the worker's write is not written over", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    const answer = await w.log.latestAnswer("k1");
    if (answer === undefined) {
      throw new Error("the seed's answer is not logged");
    }
    // The review service's door: logged, written with reviewed set, and the card taken out.
    w.connector.duringWrite.push(async () => {
      const result = await applyHumanDecision(
        w.decision("scam", false),
        {
          key: "k1",
          hash: w.hash,
          status: "needs_review",
          questions: [scam],
          decisions: { scam: { kind: "needs_review" } },
          answers: answer.answers,
        },
        w.log,
        (key, decision, expected) => w.reviewer.write(key, decision, expected),
      );
      expect(result).toEqual({ written: true, status: "done" });
      await w.reviews.remove("k1");
    });
    const { loop } = w.worker(SCAM_ONLY, 2, model({ scam: UNSURE }));
    w.db.queue("k1");

    await loop.runOnce();

    expect(w.db.decisionOf("k1")).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: UNSURE } },
      status: "done",
      reviewed: true,
    });
    expect(w.queue.rows).toEqual([]);
  });

  it("the no-call path: a record queued again at its answered state keeps the person's decision, and the actions run done", async () => {
    // Answered under the version in force: a lost ack hands the job out again, no model call.
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    const person = w.decision("scam", false, "alice", 1);
    w.connector.duringWrite.push(w.logs(person));
    const { loop, runs, provider } = w.worker(SCAM_ONLY, 1);
    w.db.queue("k1");

    const report = await loop.runOnce();

    expect(report.failures).toEqual([]);
    expect(report.alreadyAnswered).toEqual(["k1"]);
    expect(provider.requests).toEqual([]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: UNSURE } },
      status: "done",
      reviewed: true,
    });
    expect(w.queue.rows).toEqual([]);
    expect(w.connector.writes.map((write) => write.status)).toEqual(["needs_review", "done"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.record.status).toBe("done");
    expect(runs[0]?.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
    expect(runs[0]?.record.decidedAt).toEqual(person.at);
  });

  it("the backfill's merge of an added question keeps the person's decision on the other one", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    w.connector.duringWrite.push(w.logs(w.decision("scam", false)));
    const asked = model({ spam: SURE_NO });

    const report = await createBackfill({
      project: "proj_market",
      source: "listings",
      connector: w.connector,
      worker: asked,
      clock: w.clock,
      cursorStore: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
      log: w.log,
      questionSet: SCAM_AND_SPAM,
      version: 2,
      heldModel: freshHeldModel(2),
      spending: UNLIMITED,
      reviews: w.reviews,
    }).run({ onlyQuestions: ["spam"], onEstimate: () => true });

    expect(report).toMatchObject({ answered: ["k1"], discarded: [], failures: [] });
    expect(asked.requests.map((request) => request.questions.map((q) => q.name))).toEqual([
      ["spam"],
    ]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: {
        scam: { kind: "decided", value: false, probabilityOrConfidence: UNSURE },
        spam: { kind: "decided", value: false, probabilityOrConfidence: SURE_NO },
      },
      status: "done",
      reviewed: true,
    });
    expect(w.queue.rows).toEqual([]);
    expect(w.connector.writes.map((write) => write.status)).toEqual(["needs_review", "done"]);
  });

  it("a person deciding one question while the new answer leaves another open: needs_review, the person's value kept, the card on the other alone", async () => {
    const w = await world(SCAM_AND_SPAM, { scam: UNSURE, spam: UNSURE });
    w.connector.duringWrite.push(w.logs(w.decision("scam", true)));
    const { loop, runs } = w.worker(SCAM_AND_SPAM, 2, model({ scam: UNSURE, spam: UNSURE }));
    w.db.queue("k1");

    const report = await loop.runOnce();

    expect(report.toReview).toEqual(["k1"]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: {
        scam: { kind: "decided", value: true, probabilityOrConfidence: UNSURE },
        spam: { kind: "needs_review" },
      },
      status: "needs_review",
      reviewed: true,
    });
    const [card] = w.queue.rows;
    expect(w.queue.rows).toHaveLength(1);
    expect(card?.openQuestions).toEqual(["spam"]);
    expect(card?.stateHash).toBe(w.hash);
    expect(runs.map((run) => run.record.status)).toEqual(["needs_review"]);
    expect(runs[0]?.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
  });

  it("writes again for as long as a person decided since the last write: two people, three writes, done", async () => {
    const w = await world(SCAM_AND_SPAM, { scam: UNSURE, spam: UNSURE });
    w.connector.duringWrite.push(w.logs(w.decision("scam", true, "alice")));
    w.connector.duringWrite.push(w.logs(w.decision("spam", false, "bob")));
    const { loop } = w.worker(SCAM_AND_SPAM, 2, model({ scam: UNSURE, spam: UNSURE }));
    w.db.queue("k1");

    await loop.runOnce();

    expect(w.connector.writes.map((write) => write.status)).toEqual([
      "needs_review",
      "needs_review",
      "done",
    ]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: {
        scam: { kind: "decided", value: true, probabilityOrConfidence: UNSURE },
        spam: { kind: "decided", value: false, probabilityOrConfidence: UNSURE },
      },
      status: "done",
      reviewed: true,
    });
    expect(w.queue.rows).toEqual([]);
  });

  it("a person who closes the record just after the worker's read after its write has the last word on the card too", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    const answer = await w.log.latestAnswer("k1");
    if (answer === undefined) {
      throw new Error("the seed's answer is not logged");
    }
    // Armed by the worker's write, so it runs after the read that follows that write, which sees
    // no person's entry yet: the person's decision, write and card removal come after it.
    w.connector.duringWrite.push(() => {
      w.log.afterNextRead = async () => {
        await applyHumanDecision(
          w.decision("scam", false),
          {
            key: "k1",
            hash: w.hash,
            status: "needs_review",
            questions: [scam],
            decisions: { scam: { kind: "needs_review" } },
            answers: answer.answers,
          },
          w.log,
          (key, decision, expected) => w.reviewer.write(key, decision, expected),
        );
        await w.reviews.remove("k1");
      };
      return Promise.resolve();
    });
    const { loop } = w.worker(SCAM_ONLY, 2, model({ scam: UNSURE }));
    w.db.queue("k1");

    await loop.runOnce();

    expect(w.connector.writes).toHaveLength(1);
    expect(w.db.decisionOf("k1")?.status).toBe("done");
    // The worker's card for its own write was made before that read, so the removal stands.
    expect(w.queue.rows).toEqual([]);
  });
});

describe("with no person's entry in the window, the worker writes once and reads the log once after it", () => {
  it("the answer path of a record answered before: no extra read before the write, one after", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    const { loop } = w.worker(SCAM_ONLY, 2, model({ scam: UNSURE }));
    w.db.queue("k1");

    await loop.runOnce();

    expect(w.log.journal).toEqual(["append answer k1", "history k1", "write k1", "history k1"]);
    expect(w.db.decisionOf("k1")).toEqual({
      decisions: { scam: { kind: "needs_review" } },
      status: "needs_review",
    });
  });

  it("the answer path of a record never answered: the append, the write, and one read after it", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    w.db.edit("k2", { body: "A bicycle, barely used" });
    const { loop } = w.worker(SCAM_ONLY, 2, model({ scam: SURE_NO }));

    await loop.runOnce();

    expect(w.log.journal).toEqual(["append answer k2", "write k2", "history k2"]);
  });

  it("the no-call path: the read it decides from, the write, and one read after it", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });
    const { loop } = w.worker(SCAM_ONLY, 1);
    w.db.queue("k1");

    await loop.runOnce();

    expect(w.log.journal).toEqual(["history k1", "write k1", "history k1"]);
  });

  it("the backfill's merge: the append, the read it decides from, the write, and one read after it", async () => {
    const w = await world(SCAM_ONLY, { scam: UNSURE });

    await createBackfill({
      project: "proj_market",
      source: "listings",
      connector: w.connector,
      worker: model({ spam: SURE_NO }),
      clock: w.clock,
      cursorStore: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
      log: w.log,
      questionSet: SCAM_AND_SPAM,
      version: 2,
      heldModel: freshHeldModel(2),
      spending: UNLIMITED,
      reviews: w.reviews,
    }).run({ onlyQuestions: ["spam"], onEstimate: () => true });

    expect(w.log.journal).toEqual(["append answer k1", "history k1", "write k1", "history k1"]);
  });
});
