import {
  FakeAction,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordDecision, RecordKey, WriteResult } from "../contracts/index.ts";
import {
  type AnswerEntry,
  type HumanEntry,
  isWithdrawal,
  type LogEntry,
  recordAnswer,
} from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { Answer } from "../thresholds/index.ts";
import { configureAction } from "../worker/index.ts";
import { type LockResult, REVIEW_LOCK_MS, type ReviewEntry, reviewEntryOf } from "./queue.ts";
import { type CardRef, createReviewService, type OpenedCard } from "./service.ts";

/**
 * An undo names the decision it takes back, and core refuses any but the reviewer's last one; the
 * card's lease is renewed or taken before the withdrawal, so none lands while another reviewer
 * holds the card; a card the decision closed comes back locked for the one who undid it; and
 * `forget` (a sign-out) leaves nothing to undo.
 */

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
const questionSet: QuestionSet = {
  questions: [scam, team],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const SOURCE = "acme:listings";
const START = Date.parse("2026-11-05T10:00:00Z");

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.5 };
const SURE_BILLING: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };

type Notify = { readonly to: string };

/** The fake table's connection, with every write it was asked for in the journal. */
class JournalConnector extends FakeConnector {
  readonly journal: string[];

  constructor(database: FakeDatabase, journal: string[]) {
    super(database);
    this.journal = journal;
  }

  override async write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    this.journal.push(`write ${key}`);
    return super.write(key, decision, expectedHash);
  }
}

/**
 * The fake queue, with every lease call in the journal, and a hook that runs once right after a
 * card is put back (another reviewer opening it before the undo's own lock).
 */
class JournalQueue extends FakeReviewQueue {
  afterUpsert: (() => Promise<void>) | null = null;
  readonly journal: string[];

  constructor(journal: string[]) {
    super();
    this.journal = journal;
  }

  override async upsert(entry: ReviewEntry): Promise<void> {
    await super.upsert(entry);
    const hook = this.afterUpsert;
    this.afterUpsert = null;
    await hook?.();
  }

  override async lock(
    source: string,
    key: RecordKey,
    viewer: string,
    nowMs: number,
  ): Promise<LockResult> {
    const result = await super.lock(source, key, viewer, nowMs);
    this.journal.push(`lock ${key} ${viewer}: ${result.kind}`);
    return result;
  }

  override async renew(
    source: string,
    key: RecordKey,
    viewer: string,
    nowMs: number,
  ): Promise<LockResult> {
    const result = await super.renew(source, key, viewer, nowMs);
    this.journal.push(`renew ${key} ${viewer}: ${result.kind}`);
    return result;
  }

  override async release(source: string, key: RecordKey, viewer: string): Promise<void> {
    this.journal.push(`release ${key} ${viewer}`);
    await super.release(source, key, viewer);
  }
}

function setup() {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const journal: string[] = [];
  const connector = new JournalConnector(db, journal);
  // The fake log writes `append human <key>` into the same journal.
  const log = new FakeDecisionLog(journal);
  const queue = new JournalQueue(journal);
  const notify = new FakeAction<Notify>();
  const service = createReviewService({
    queue,
    log: new Map([[SOURCE, log]]),
    connectors: new Map([[SOURCE, connector]]),
    actions: new Map([[SOURCE, [configureAction("notify", notify, { to: "#mods" })]]]),
    questionSets: new Map([[SOURCE, { questionSet, version: 3 }]]),
    clock,
  });

  /** As the worker leaves a record: answered, logged, written needs_review, its card queued. */
  async function seed(key: RecordKey, body: string, answers: Record<string, Answer>) {
    db.edit(key, { body });
    const hash = stateHash(["body"], { body });
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 3,
      model: "jev-1.14.0",
      stateHash: hash,
      answers,
      usage: { inputTokens: 100, outputTokens: 8 },
      at: new Date(clock.now()),
    };
    const decisions: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
    await recordAnswer(entry, questionSet, log, (k, decision, expected) => {
      decisions.push(decision.decisions);
      return connector.write(k, decision, expected);
    });
    const [written] = decisions;
    if (written === undefined) {
      throw new Error("the seed's answer was not written");
    }
    await queue.upsert({
      source: SOURCE,
      ...reviewEntryOf({ key, stateHash: hash, decisions: written, answers, since: entry.at }),
    });
    clock.advance(1_000);
    return hash;
  }

  async function open(viewer: string): Promise<{ card: OpenedCard; ref: CardRef }> {
    const card = await service.open(viewer, {});
    if (card === null) {
      throw new Error(`no card for ${viewer}`);
    }
    return { card, ref: { source: card.source, key: card.key, stateHash: card.stateHash } };
  }

  async function humans(key: RecordKey): Promise<readonly HumanEntry[]> {
    const history: readonly LogEntry[] = await log.history(key);
    return history.filter((entry): entry is HumanEntry => entry.kind === "human");
  }

  return { clock, db, journal, queue, notify, service, seed, open, humans };
}

describe("an undo names the decision it takes back, and only the reviewer's last one", () => {
  it("refuses a decision that is not the last one, writes nothing, and keeps the last one undoable", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    await t.service.decide("alice", ref, "team", "tech");
    t.journal.length = 0;
    const notified = t.notify.calls.length;

    // The earlier question of the same card, the same question at another state, another record:
    // none is the last decision, and none takes it back.
    for (const [named, question] of [
      [ref, "scam"],
      [{ ...ref, stateHash: "an-older-state" }, "team"],
      [{ ...ref, key: "r2" }, "team"],
      [{ ...ref, source: "acme:other" }, "team"],
    ] as const) {
      expect(await t.service.undo("alice", named, question)).toEqual({
        kind: "stale",
        reason: "that decision is not your last one, and only your last decision can be taken back",
      });
    }
    expect(t.journal).toEqual([]);
    expect(t.notify.calls).toHaveLength(notified);
    expect((await t.humans("r1")).map((entry) => isWithdrawal(entry.value))).toEqual([
      false,
      false,
    ]);

    // The refusals spent nothing: the last decision is taken back when it is the one named.
    expect(await t.service.undo("alice", ref, "team")).toMatchObject({ kind: "undone" });
    expect(t.db.decisionOf("r1")?.decisions["team"]).toEqual({ kind: "needs_review" });
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toMatchObject({ value: true });
  });

  it("is one reviewer's last decision: another reviewer naming it has nothing to undo", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);

    expect(await t.service.undo("bob", ref, "scam")).toEqual({ kind: "nothing" });
    expect(t.db.decisionOf("r1")?.status).toBe("done");
  });

  it("withdraws a decision once when two undos naming it arrive together", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);

    const both = await Promise.all([
      t.service.undo("alice", ref, "scam"),
      t.service.undo("alice", ref, "scam"),
    ]);

    expect(both.map((result) => result.kind)).toEqual(["undone", "nothing"]);
    expect((await t.humans("r1")).map((entry) => isWithdrawal(entry.value))).toEqual([false, true]);
  });
});

describe("no withdrawal lands while another reviewer holds the card", () => {
  it("answers held, writes nothing, and keeps the decision undoable until their hold ends", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    // Alice moves on; Bob opens the card, still waiting for its team.
    await t.service.release("alice", ref);
    const bobs = await t.open("bob");
    t.journal.length = 0;
    const notified = t.notify.calls.length;
    const before = t.db.decisionOf("r1");

    const held = await t.service.undo("alice", ref, "scam");

    expect(held).toEqual({ kind: "held", by: "bob", until: bobs.card.lockedUntil });
    // The lease was asked for, and nothing was read, logged or written after it.
    expect(t.journal).toEqual(["renew r1 alice: held"]);
    expect(t.db.decisionOf("r1")).toEqual(before);
    expect(t.notify.calls).toHaveLength(notified);
    expect(t.queue.rows.map((row) => row.lock?.by)).toEqual(["bob"]);

    // Bob lets go: the same undo now lands, under Alice's lease, taken before the withdrawal.
    await t.service.release("bob", bobs.ref);
    t.journal.length = 0;
    const undone = await t.service.undo("alice", ref, "scam");

    expect(undone).toMatchObject({ kind: "undone", status: "needs_review" });
    expect(t.journal.slice(0, 3)).toEqual([
      "renew r1 alice: lost",
      "lock r1 alice: locked",
      "append human r1",
    ]);
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toEqual({ kind: "needs_review" });
    expect(t.queue.rows.map((row) => row.lock?.by)).toEqual(["alice"]);
  });

  it("renews the reviewer's own lease before the withdrawal", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    t.clock.advance(4 * 60_000);
    t.journal.length = 0;

    const undone = await t.service.undo("alice", ref, "scam");

    expect(t.journal.slice(0, 2)).toEqual(["renew r1 alice: locked", "append human r1"]);
    expect(undone).toMatchObject({
      kind: "undone",
      card: { lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS) },
    });
  });

  it("gives back a lease it took itself when the undo writes nothing", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    await t.service.release("alice", ref);
    t.db.edit("r1", { body: "Cheap car, edited" });

    expect(await t.service.undo("alice", ref, "scam")).toMatchObject({
      kind: "stale",
      reason: expect.stringMatching(/edited/),
    });
    // The card Alice had let go of is nobody's again, for another reviewer to open.
    expect(t.queue.rows.map((row) => row.lock)).toEqual([null]);
    expect((await t.humans("r1")).map((entry) => isWithdrawal(entry.value))).toEqual([false]);
  });
});

describe("a decision that closed the record", () => {
  it("is undone, and its card comes back locked for the reviewer who undid it", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    expect(t.queue.rows).toEqual([]);
    t.journal.length = 0;

    const undone = await t.service.undo("alice", ref, "scam");

    expect(undone).toMatchObject({
      kind: "undone",
      status: "needs_review",
      card: { key: "r1", stateHash: ref.stateHash },
    });
    // No card to hold before the withdrawal; the card it brought back is locked after it.
    expect(t.journal).toEqual([
      "renew r1 alice: gone",
      "append human r1",
      "write r1",
      "lock r1 alice: locked",
    ]);
    expect(t.queue.rows).toMatchObject([{ key: "r1", lock: { by: "alice" } }]);
    // Bob cannot open it now.
    expect(await t.service.open("bob", {})).toBeNull();
  });

  it("leaves the card to a reviewer who opened it between the withdrawal and the undo's lock", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const { ref } = await t.open("alice");
    await t.service.decide("alice", ref, "scam", true);
    let bobs: OpenedCard | null = null;
    t.queue.afterUpsert = async () => {
      bobs = await t.service.open("bob", {});
    };

    const undone = await t.service.undo("alice", ref, "scam");

    // The withdrawal landed while nobody held the card; Bob opened the card it brought back first,
    // and it is his: the undo hands Alice no card.
    expect(undone).toMatchObject({ kind: "undone", status: "needs_review", card: null });
    expect(bobs).toMatchObject({ key: "r1", open: [{ question: { name: "scam" } }] });
    expect(t.queue.rows).toMatchObject([{ key: "r1", lock: { by: "bob" } }]);
  });
});

describe("forget: a sign-out", () => {
  it("leaves the reviewer nothing to undo, and nobody else's undo changes", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const alices = await t.open("alice");
    const bobs = await t.open("bob");
    await t.service.decide("alice", alices.ref, "scam", true);
    await t.service.decide("bob", bobs.ref, "scam", false);

    t.service.forget("alice");

    expect(await t.service.undo("alice", alices.ref, "scam")).toEqual({ kind: "nothing" });
    expect(t.db.decisionOf("r1")?.status).toBe("done");
    expect((await t.humans("r1")).map((entry) => isWithdrawal(entry.value))).toEqual([false]);
    expect(await t.service.undo("bob", bobs.ref, "scam")).toMatchObject({ kind: "undone" });
  });
});
