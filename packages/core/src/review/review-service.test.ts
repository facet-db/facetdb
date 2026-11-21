import {
  FakeAction,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordKey } from "../contracts/index.ts";
import {
  type AnswerEntry,
  type HumanEntry,
  isWithdrawal,
  type LogEntry,
  recordAnswer,
  standingHuman,
} from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { Answer } from "../thresholds/index.ts";
import { configureAction } from "../worker/index.ts";
import { type LockResult, REVIEW_LOCK_MS, reviewEntryOf } from "./queue.ts";
import { type CardRef, createReviewService, type OpenedCard } from "./service.ts";

// The low-stakes defaults: a noul is yes at or above 0.70 and no at or below 0.30; a choice decides
// at confidence 0.50, which for two options is a top pick of 75%.
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

/** The fake log, with a hook that runs right after a human entry is appended (the app's edit). */
class HookedLog extends FakeDecisionLog {
  afterHuman: (() => void) | null = null;

  override async appendHuman(entry: HumanEntry): Promise<void> {
    await super.appendHuman(entry);
    this.afterHuman?.();
  }
}

/** The fake queue, with a hook that runs once right after a lock is taken (the worker's write in between). */
class HookedQueue extends FakeReviewQueue {
  afterLock: (() => Promise<void>) | null = null;

  override async lock(
    source: string,
    key: RecordKey,
    viewer: string,
    nowMs: number,
  ): Promise<LockResult> {
    const result = await super.lock(source, key, viewer, nowMs);
    const hook = this.afterLock;
    this.afterLock = null;
    await hook?.();
    return result;
  }
}

/** One source behind the service: the fake table, log, queue, clock and one recorded action. */
function setup() {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const connector = new FakeConnector(db);
  const log = new HookedLog();
  const queue = new HookedQueue();
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

  async function history(key: RecordKey): Promise<readonly LogEntry[]> {
    return log.history(key);
  }

  return { clock, db, connector, log, queue, notify, service, seed, history };
}

function refOf(card: OpenedCard): CardRef {
  return { source: card.source, key: card.key, stateHash: card.stateHash };
}

async function openOrFail(
  service: ReturnType<typeof setup>["service"],
  viewer: string,
): Promise<OpenedCard> {
  const card = await service.open(viewer, {});
  if (card === null) {
    throw new Error(`no card for ${viewer}`);
  }
  return card;
}

describe("open: the next card, locked for the viewer", () => {
  it("returns the oldest card with its state, open and decided questions, since and lock expiry", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car, wire only", {
      scam: UNSURE_SCAM,
      team: SURE_BILLING,
    });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const card = await openOrFail(t.service, "alice");

    expect(card).toEqual({
      source: SOURCE,
      key: "r1",
      stateHash: hash,
      state: { body: "Cheap car, wire only" },
      open: [{ question: scam, answer: UNSURE_SCAM, figure: 0.5 }],
      decided: [{ question: team, value: "billing" }],
      since: new Date(START),
      lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS),
    });
    expect(t.queue.rows.find((row) => row.key === "r1")?.lock?.by).toBe("alice");
  });

  it("withdraws a card whose record changed while it sat in the queue, and moves on", async () => {
    const t = setup();
    const oldHash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    t.db.edit("r1", { body: "Cheap car, now with photos" });

    const card = await openOrFail(t.service, "alice");

    expect(card.key).toBe("r2");
    expect(t.queue.rows.map((row) => [row.key, row.stateHash === oldHash])).toEqual([
      ["r2", false],
    ]);
    // Nothing was decided on the changed record; the worker asks it again.
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
  });

  it("returns null when every card is taken or the queue is empty", async () => {
    const t = setup();
    expect(await t.service.open("alice", {})).toBeNull();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await openOrFail(t.service, "alice");
    expect(await t.service.open("bob", {})).toBeNull();
  });

  it("reads the queue a short batch at a time, never whole, and walks past a batch of stale cards (2026-11-12)", async () => {
    const t = setup();
    for (let n = 1; n <= 9; n += 1) {
      await t.seed(`r${n}`, `Listing ${n}`, { scam: UNSURE_SCAM, team: SURE_BILLING });
    }
    // The first eight records changed since their cards were made: each is withdrawn when met.
    for (let n = 1; n <= 8; n += 1) {
      t.db.edit(`r${n}`, { body: `Listing ${n}, edited` });
    }
    const listings: (number | undefined)[] = [];
    const list = t.queue.list.bind(t.queue);
    t.queue.list = (filter, viewer, nowMs) => {
      listings.push(filter.limit);
      return list(filter, viewer, nowMs);
    };

    const card = await openOrFail(t.service, "alice");

    expect(card.key).toBe("r9");
    // A listing of eight, then a wider one, never one of everything first; the stale eight are
    // gone from the queue.
    expect(listings).toEqual([8, 64]);
    expect(t.queue.rows.map((row) => row.key)).toEqual(["r9"]);
  });

  it("gets past cards of a source the worker no longer runs, which stay in the queue until purge", async () => {
    const t = setup();
    // Eight orphans older than every live card: they are never withdrawn, only passed over.
    for (let n = 1; n <= 8; n += 1) {
      await t.queue.upsert({
        source: "acme:gone",
        key: `g${n}`,
        stateHash: `h-g${n}`,
        openQuestions: ["scam"],
        numbers: { scam: 0.5 },
        since: new Date(START - 60_000 + n),
      });
    }
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const listings: (number | undefined)[] = [];
    const list = t.queue.list.bind(t.queue);
    t.queue.list = (filter, viewer, nowMs) => {
      listings.push(filter.limit);
      return list(filter, viewer, nowMs);
    };

    const card = await openOrFail(t.service, "alice");

    expect(card.key).toBe("r1");
    expect(listings).toEqual([8, 64]);
    // Nothing locked or withdrawn on the orphans.
    expect(t.queue.rows.filter((row) => row.source === "acme:gone")).toHaveLength(8);
    expect(t.queue.rows.every((row) => row.source !== "acme:gone" || row.lock === null)).toBe(true);
  });
});

describe("decide: one door for a person's decision", () => {
  it("logs the decision with reviewer and note, writes it, runs the actions, and removes the card when done", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");

    const result = await t.service.decide("alice", refOf(card), "scam", true, "wire only");

    expect(result).toEqual({ kind: "decided", status: "done", open: [], failures: [] });
    const human = (await t.history("r1")).at(-1);
    expect(human).toEqual({
      kind: "human",
      key: "r1",
      question: "scam",
      value: true,
      reviewer: "alice",
      note: "wire only",
      stateHash: hash,
      version: 3,
      at: new Date(t.clock.now()),
    });
    const row = t.db.decisionOf("r1");
    expect(row?.status).toBe("done");
    expect(row?.reviewed).toBe(true);
    expect(row?.decisions["scam"]).toEqual({
      kind: "decided",
      value: true,
      probabilityOrConfidence: 0.5,
    });
    // The actions run again with the record's decisions after a person's decision.
    expect(t.notify.calls).toHaveLength(1);
    expect(t.notify.calls[0]?.record).toEqual({
      key: "r1",
      state: { body: "Cheap car" },
      status: "done",
      // The decision's state, so a queued action can tell whether it is still the record's.
      stateHash: hash,
      decidedAt: new Date(t.clock.now()),
    });
    expect(t.notify.calls[0]?.decisions["team"]).toMatchObject({ value: "billing" });
    expect(t.queue.rows).toEqual([]);
  });

  it("keeps the card, refreshed and still the viewer's, while another question is open", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const card = await openOrFail(t.service, "alice");

    const result = await t.service.decide("alice", refOf(card), "scam", false);

    expect(result).toMatchObject({ kind: "decided", status: "needs_review", open: ["team"] });
    expect(t.db.decisionOf("r1")?.status).toBe("needs_review");
    expect(t.db.decisionOf("r1")?.reviewed).toBe(true);
    const [row] = t.queue.rows;
    expect(row?.openQuestions).toEqual(["team"]);
    expect(row?.lock?.by).toBe("alice");
    expect(row?.since).toEqual(new Date(START));

    const second = await t.service.decide("alice", refOf(card), "team", "tech");
    expect(second).toMatchObject({ kind: "decided", status: "done", open: [] });
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toMatchObject({ value: false });
    expect(t.notify.calls.map((call) => call.record.status)).toEqual(["needs_review", "done"]);
  });

  it("refuses a record changed since the card was opened, logs nothing, and withdraws the card", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    t.db.edit("r1", { body: "Cheap car, edited" });

    const result = await t.service.decide("alice", refOf(card), "scam", true);

    expect(result).toEqual({
      kind: "stale",
      reason:
        "the record was edited while the card was open, so it left the queue to be asked again",
    });
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
    expect(t.db.decisionOf("r1")?.status).toBe("needs_review");
    expect(t.queue.rows).toEqual([]);
    expect(t.notify.calls).toEqual([]);
    // Nothing to undo: the refused decision never stood.
    expect(await t.service.undo("alice")).toEqual({ kind: "nothing" });
  });

  it("refuses when the record changes between the read and the write: logged, not standing, card withdrawn", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    // The app edits the row just as the decision is appended to the log.
    t.log.afterHuman = () => t.db.edit("r1", { body: "Cheap car, edited" });

    const result = await t.service.decide("alice", refOf(card), "scam", true);

    expect(result).toMatchObject({ kind: "stale", reason: expect.stringMatching(/edited/) });
    const history = await t.history("r1");
    expect(history.filter((entry) => entry.kind === "human")).toHaveLength(1);
    const edited = stateHash(["body"], { body: "Cheap car, edited" });
    expect(standingHuman(history, "scam", edited)).toBeUndefined();
    expect(t.db.decisionOf("r1")?.reviewed).toBeUndefined();
    expect(t.queue.rows).toEqual([]);
  });

  it("refuses a record deleted since the card was opened, saying so, and withdraws the card", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    t.db.rows.delete("r1");

    expect(await t.service.decide("alice", refOf(card), "scam", true)).toEqual({
      kind: "stale",
      reason: "the record was deleted, so its card left the queue",
    });
    expect(t.queue.rows).toEqual([]);
  });

  it("refuses a value that does not fit the question, and a question already decided", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const ref = refOf(await openOrFail(t.service, "alice"));

    expect(await t.service.decide("alice", ref, "scam", "maybe")).toEqual({
      kind: "refused",
      reason: '"scam" is a yes-or-no question; answer yes or no',
    });
    expect(await t.service.decide("alice", ref, "team", "sales")).toEqual({
      kind: "refused",
      reason: '"sales" is not an option of "team"; pick one of billing, tech',
    });
    expect(await t.service.decide("alice", ref, "team", "tech")).toEqual({
      kind: "refused",
      reason: '"team" is already decided on this card',
    });
    expect(await t.service.decide("alice", ref, "price", true)).toEqual({
      kind: "refused",
      reason: '"price" is not a question of this source',
    });
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
  });
});

describe("two viewers on different cards never collide", () => {
  it("each opens a different card, neither can decide the other's, and each undo is their own", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const alices = await openOrFail(t.service, "alice");
    const bobs = await openOrFail(t.service, "bob");
    expect([alices.key, bobs.key]).toEqual(["r1", "r2"]);

    expect(await t.service.decide("bob", refOf(alices), "scam", false)).toEqual({
      kind: "held",
      by: "alice",
      until: alices.lockedUntil,
    });
    expect(await t.service.decide("alice", refOf(alices), "scam", true)).toMatchObject({
      kind: "decided",
      status: "done",
    });
    expect(await t.service.decide("bob", refOf(bobs), "scam", false)).toMatchObject({
      kind: "decided",
      status: "done",
    });
    const reviewers = async (key: RecordKey) =>
      (await t.history(key)).flatMap((entry) => (entry.kind === "human" ? [entry.reviewer] : []));
    expect(await reviewers("r1")).toEqual(["alice"]);
    expect(await reviewers("r2")).toEqual(["bob"]);

    // Alice's undo takes back her decision on r1 and leaves Bob's on r2 alone.
    const undone = await t.service.undo("alice");
    expect(undone).toMatchObject({ kind: "undone", status: "needs_review" });
    expect(t.db.decisionOf("r1")?.status).toBe("needs_review");
    expect(t.db.decisionOf("r2")?.status).toBe("done");
    expect(t.queue.rows.map((row) => [row.key, row.lock?.by])).toEqual([["r1", "alice"]]);
  });
});

describe("undo: a logged withdrawal by the same reviewer", () => {
  it("returns the card and the status: the log keeps the decision and its withdrawal, reviewed stays true", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    await t.service.decide("alice", refOf(card), "scam", true, "wire only");
    expect(t.db.decisionOf("r1")?.status).toBe("done");
    t.clock.advance(5_000);

    const result = await t.service.undo("alice");

    expect(result).toEqual({
      kind: "undone",
      status: "needs_review",
      card: { ...card, lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS) },
      failures: [],
    });
    const humans = (await t.history("r1")).filter((entry) => entry.kind === "human");
    expect(humans.map((entry) => [entry.reviewer, entry.question, entry.value])).toEqual([
      ["alice", "scam", true],
      ["alice", "scam", { withdrawn: true }],
    ]);
    expect(humans[1]).toMatchObject({ stateHash: hash, version: 3, at: new Date(t.clock.now()) });
    expect(standingHuman(await t.history("r1"), "scam", hash)).toBeUndefined();
    const row = t.db.decisionOf("r1");
    expect(row?.status).toBe("needs_review");
    expect(row?.reviewed).toBe(true);
    expect(row?.decisions["scam"]).toEqual({ kind: "needs_review" });
    expect(row?.decisions["team"]).toMatchObject({ kind: "decided", value: "billing" });
    // The card is back in the queue, with its open question, and open for the one who undid.
    expect(t.queue.rows).toMatchObject([
      { key: "r1", stateHash: hash, openQuestions: ["scam"], lock: { by: "alice" } },
    ]);
    // The actions ran on the decision and again on its withdrawal.
    expect(t.notify.calls.map((call) => call.record.status)).toEqual(["done", "needs_review"]);
    expect(t.notify.calls[1]?.record.decidedAt).toEqual(new Date(t.clock.now()));
  });

  it("refuses a second undo in a row: only the last decision of the session can be undone", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const ref = refOf(await openOrFail(t.service, "alice"));
    await t.service.decide("alice", ref, "scam", true);
    await t.service.decide("alice", ref, "team", "tech");

    expect(await t.service.undo("alice")).toMatchObject({ kind: "undone", status: "needs_review" });
    expect(await t.service.undo("alice")).toEqual({ kind: "nothing" });

    // The first decision still stands; only the last was taken back.
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toMatchObject({ value: true });
    expect(t.db.decisionOf("r1")?.decisions["team"]).toEqual({ kind: "needs_review" });
    const values = (await t.history("r1")).flatMap((entry) =>
      entry.kind === "human" ? [isWithdrawal(entry.value)] : [],
    );
    expect(values).toEqual([false, false, true]);
  });

  it("has nothing to undo for a viewer who decided nothing", async () => {
    const t = setup();
    expect(await t.service.undo("alice")).toEqual({ kind: "nothing" });
  });

  it("refuses an undo once the record changed: the decision already stopped standing", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    await t.service.decide("alice", refOf(card), "scam", true);
    t.db.edit("r1", { body: "Cheap car, edited" });

    expect(await t.service.undo("alice")).toMatchObject({
      kind: "stale",
      reason: expect.stringMatching(/edited/),
    });
    expect(await t.service.undo("alice")).toEqual({ kind: "nothing" });
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toHaveLength(1);
  });

  it("lets the viewer decide the card again after the undo", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");
    await t.service.decide("alice", refOf(card), "scam", true);
    const undone = await t.service.undo("alice");
    if (undone.kind !== "undone" || undone.card === null) {
      throw new Error("the undo did not return the card");
    }

    const again = await t.service.decide("alice", refOf(undone.card), "scam", false);

    expect(again).toMatchObject({ kind: "decided", status: "done" });
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toMatchObject({ value: false });
    expect(t.queue.rows).toEqual([]);
  });
});

describe("renew, skip and release", () => {
  it("renew extends the viewer's lease; skip puts the card behind; release lets another open it", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const first = await openOrFail(t.service, "alice");
    expect(first.key).toBe("r1");

    t.clock.advance(60_000);
    expect(await t.service.renew("alice", refOf(first))).toEqual({
      kind: "locked",
      until: new Date(t.clock.now() + REVIEW_LOCK_MS),
    });

    await t.service.skip("alice", refOf(first));
    const next = await openOrFail(t.service, "alice");
    expect(next.key).toBe("r2");

    await t.service.release("alice", refOf(next));
    expect((await openOrFail(t.service, "bob")).key).toBe("r1");
    expect(t.queue.rows.map((row) => [row.key, row.lock?.by ?? null])).toEqual([
      ["r1", "bob"],
      ["r2", null],
    ]);
  });
});

describe("openKey: one named card, locked for the viewer", () => {
  it("opens the card of the key whatever its place in the queue, and locks it", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const hash = await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await t.service.openKey("alice", SOURCE, "r2");

    expect(result).toMatchObject({
      kind: "opened",
      card: { key: "r2", stateHash: hash, lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS) },
    });
    expect(t.queue.rows.find((row) => row.key === "r2")?.lock?.by).toBe("alice");
    // The next card for anyone else is the one nobody holds.
    expect((await openOrFail(t.service, "bob")).key).toBe("r1");
  });

  it("answers held, with who and until when, for a card another reviewer holds", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openOrFail(t.service, "alice");

    expect(await t.service.openKey("bob", SOURCE, "r1")).toEqual({
      kind: "held",
      by: "alice",
      until: card.lockedUntil,
    });
    // The holder opens it again and the lease is extended, not refused.
    expect(await t.service.openKey("alice", SOURCE, "r1")).toMatchObject({ kind: "opened" });
  });

  it("answers gone for a key with no card, and withdraws a card whose record changed", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    expect(await t.service.openKey("alice", SOURCE, "nope")).toEqual({ kind: "gone" });

    t.db.edit("r1", { body: "Cheap car, edited" });
    expect(await t.service.openKey("alice", SOURCE, "r1")).toEqual({ kind: "gone" });
    expect(t.queue.rows).toEqual([]);
  });

  it("never returns a card the viewer does not hold: the worker re-answers the record between the lock and the listing", async () => {
    const t = setup();
    const oldHash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    // Alice takes the lease at the old hash; before the listing the worker upserts the record at a
    // new hash, which clears the lease (the store's rule), so the card at the new hash is nobody's.
    let newHash = "";
    t.queue.afterLock = async () => {
      newHash = await t.seed("r1", "Cheap car, new wording", {
        scam: UNSURE_SCAM,
        team: SURE_BILLING,
      });
    };

    const result = await t.service.openKey("alice", SOURCE, "r1");

    expect(result).toEqual({ kind: "gone" });
    expect(newHash).not.toBe(oldHash);
    // The card at the new hash waits, unlocked, for whoever opens it next: nobody saw its state.
    expect(t.queue.rows.map((row) => [row.key, row.stateHash === newHash, row.lock])).toEqual([
      ["r1", true, null],
    ]);
    expect(await t.service.openKey("bob", SOURCE, "r1")).toMatchObject({
      kind: "opened",
      card: { stateHash: newHash, state: { body: "Cheap car, new wording" } },
    });
  });
});
