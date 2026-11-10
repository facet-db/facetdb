import { FakeClock, FakeConnector, FakeDatabase, FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { AlertSignals } from "../alerts/index.ts";
import type {
  Connector,
  ProviderRequest,
  ProviderResponse,
  RecordKey,
  ScanCursor,
} from "../contracts/index.ts";
import { type AnswerEntry, recordAnswer } from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { buildRequest } from "../requests/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import {
  type BackfillDeps,
  type BackfillProgress,
  type BackfillReport,
  type BackfillWorker,
  type CursorStore,
  createBackfill,
} from "./backfill.ts";

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

/** A gate that admits everything and counts nothing: for the tests that are not about spending. */
const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
};

/**
 * A gate that pauses at its cap, as a project does: a request is admitted while the count and the open
 * reservations are under the cap, and every answer's tokens are counted.
 */
class CappedGate implements SpendingGate {
  counted = 0;
  reserved = 0;
  readonly #cap: number;
  readonly #open = new Map<string, number>();
  #admitted = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  allowsWork(): Promise<boolean> {
    return Promise.resolve(this.counted < this.#cap);
  }

  admit(requestTokens: number): Promise<string | undefined> {
    if (this.counted + this.reserved >= this.#cap) {
      return Promise.resolve(undefined);
    }
    this.#admitted += 1;
    const id = `r${this.#admitted}`;
    this.#open.set(id, requestTokens);
    this.reserved += requestTokens;
    return Promise.resolve(id);
  }

  settle(reservation: string): Promise<void> {
    this.reserved -= this.#open.get(reservation) ?? 0;
    this.#open.delete(reservation);
    return Promise.resolve();
  }

  record(inputTokens: number): Promise<void> {
    this.counted += inputTokens;
    return Promise.resolve();
  }
}

class FakeCursorStore implements CursorStore {
  readonly saves: { run: string; progress: BackfillProgress }[] = [];
  readonly #stored = new Map<string, BackfillProgress>();

  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#stored.get(run));
  }

  save(run: string, progress: BackfillProgress): Promise<void> {
    this.saves.push({ run, progress });
    this.#stored.set(run, progress);
    return Promise.resolve();
  }
}

/** The scam probabilities a script cycles through: a sure yes, an unsure one, a sure no. */
const SCAM_CYCLE = [0.95, 0.5, 0.05];

function rowNumber(request: ProviderRequest): number {
  const body = request.state["body"];
  if (typeof body !== "string") {
    throw new Error("the test rows keep their number in body");
  }
  return Number(body.replace("row-", ""));
}

/** A worker that answers from the row's number, remembers every request and the time it arrived. */
class ScriptedWorker implements BackfillWorker {
  readonly requests: { request: ProviderRequest; at: number }[] = [];
  readonly #clock: FakeClock;
  readonly #fail: (row: number) => boolean;
  readonly #journal: string[];

  constructor(clock: FakeClock, journal: string[], fail: (row: number) => boolean = () => false) {
    this.#clock = clock;
    this.#journal = journal;
    this.#fail = fail;
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push({ request, at: this.#clock.now() });
    this.#journal.push("ask");
    const row = rowNumber(request);
    if (this.#fail(row)) {
      return Promise.reject(new Error(`the model is down for row ${row}`));
    }
    const answers: Record<string, { type: "noul"; probability: number }> = {};
    for (const question of request.questions) {
      answers[question.name] = {
        type: "noul",
        probability: question.name === "scam" ? (SCAM_CYCLE[row % 3] ?? 0.5) : 0.9,
      };
    }
    return Promise.resolve({
      model: request.model,
      answers,
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  }

  askedRows(): number[] {
    return this.requests.map(({ request }) => rowNumber(request));
  }
}

/**
 * A connector that notes the cursor of every scan, to prove where a resumed run starts, and when
 * each key was enqueued, to prove the pace. `failEnqueue` makes the queue refuse a key.
 */
class SpyConnector extends FakeConnector {
  readonly scans: (ScanCursor | null)[] = [];
  readonly enqueued: { key: RecordKey; at: number }[] = [];
  writes = 0;
  failEnqueue: (key: RecordKey) => boolean = () => false;
  readonly #clock: FakeClock;

  constructor(db: FakeDatabase, clock: FakeClock) {
    super(db);
    this.#clock = clock;
  }

  override async enqueue(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (this.failEnqueue(key)) {
        throw new Error(`the queue refused ${key}`);
      }
      this.enqueued.push({ key, at: this.#clock.now() });
    }
    return super.enqueue(keys);
  }

  enqueuedKeys(): RecordKey[] {
    return this.enqueued.map(({ key }) => key);
  }

  override scan(cursor: ScanCursor | null): ReturnType<FakeConnector["scan"]> {
    this.scans.push(cursor);
    return super.scan(cursor);
  }

  override write(...args: Parameters<FakeConnector["write"]>): ReturnType<FakeConnector["write"]> {
    this.writes += 1;
    return super.write(...args);
  }
}

type Rig = {
  db: FakeDatabase;
  connector: SpyConnector;
  clock: FakeClock;
  log: FakeDecisionLog;
  cursors: FakeCursorStore;
  journal: string[];
  deps: (worker: BackfillWorker, questionSet?: QuestionSet, version?: number) => BackfillDeps;
};

async function rig(rows: number): Promise<Rig> {
  const db = new FakeDatabase({ fields: ["body"], pageSize: 10 });
  for (let n = 1; n <= rows; n += 1) {
    db.edit(`k${n}`, { body: `row-${n}` });
  }
  const clock = new FakeClock();
  const connector = new SpyConnector(db, clock);
  await connector.install();
  const journal: string[] = [];
  const log = new FakeDecisionLog(journal);
  const cursors = new FakeCursorStore();
  return {
    db,
    connector,
    clock,
    log,
    cursors,
    journal,
    deps: (worker, questionSet = SCAM_ONLY, version = 1) => ({
      connector: connector as Connector,
      worker,
      clock,
      cursorStore: cursors,
      log,
      questionSet,
      version,
      spending: UNLIMITED,
    }),
  };
}

const yes = (): boolean => true;

/** What the worker does with the queue a whole-set run filled: claims, asks, records, acks. */
async function drainQueue(
  r: Rig,
  worker: ScriptedWorker,
  questionSet: QuestionSet = SCAM_ONLY,
  version = 1,
): Promise<void> {
  const keys = await r.connector.claim(1_000);
  const { rows } = await r.connector.read(keys);
  for (const row of rows) {
    const response = await worker.ask({
      model: questionSet.model,
      state: row.state,
      questions: questionSet.questions,
    });
    const entry: AnswerEntry = {
      kind: "answer",
      key: row.key,
      version,
      model: questionSet.model,
      stateHash: row.hash,
      answers: response.answers,
      usage: response.usage,
      at: new Date(r.clock.now()),
    };
    await recordAnswer(entry, questionSet, r.log, (key, decision, hash) =>
      r.connector.write(key, decision, hash),
    );
  }
  await r.connector.ack(keys);
}

describe("backfill pacing", () => {
  it("@timing enqueues records at the pace, one interval apart, on the injected clock", async () => {
    const r = await rig(30);
    const worker = new ScriptedWorker(r.clock, r.journal);
    const backfill = createBackfill(r.deps(worker));

    const report = await backfill.run({ pace: 50, maxInFlight: 1, onEstimate: yes });

    expect(report.status).toBe("completed");
    expect(report.enqueued).toHaveLength(30);
    // One record every 20 ms: the first at once, the 30th after 29 intervals.
    expect(r.connector.enqueued.map(({ at }) => at)).toEqual(
      Array.from({ length: 30 }, (_, n) => n * 20),
    );
    expect(r.clock.sleeps.every((ms) => ms === 20)).toBe(true);
  });

  it("@timing holds the pace with several lanes", async () => {
    const r = await rig(30);
    const worker = new ScriptedWorker(r.clock, r.journal);
    const backfill = createBackfill(r.deps(worker));

    await backfill.run({ pace: 10, maxInFlight: 8, onEstimate: yes });

    // 30 records at 10 a second take 29 intervals of 100 ms, however many lanes share them.
    expect(r.clock.now()).toBe(2_900);
    expect(r.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(2_900);
    expect(r.connector.enqueued).toHaveLength(30);
  });

  it("asks nothing itself: the whole set goes through the worker's queue, one entry per record", async () => {
    const r = await rig(3);
    // A change already queued k2 and a worker holds it while it asks.
    r.db.queue("k2");
    const peer = new FakeConnector(r.db);
    expect(await peer.claim(1)).toEqual(["k2"]);
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report = await createBackfill(r.deps(worker)).run({ onEstimate: yes });

    expect(worker.requests).toHaveLength(0);
    expect(r.connector.writes).toBe(0);
    expect(report.enqueued).toEqual(["k3", "k2", "k1"]);
    // k2 stays the one entry the peer holds: nobody asks it twice.
    expect(r.db.jobs.size).toBe(3);
    expect(r.db.jobs.get("k2")?.claimedBy).not.toBeNull();
    expect([...(await r.connector.claim(10))].sort()).toEqual(["k1", "k3"]);
  });

  it("leaves out a record the source's filter excludes, and does not price it", async () => {
    const db = new FakeDatabase({
      fields: ["body"],
      excludes: (state) => state["body"] === "internal",
    });
    db.edit("k1", { body: "row-1" });
    db.edit("k2", { body: "internal" });
    const clock = new FakeClock();
    const connector = new SpyConnector(db, clock);
    await connector.install();
    const worker = new ScriptedWorker(clock, []);
    const backfill = createBackfill({
      connector,
      worker,
      clock,
      cursorStore: new FakeCursorStore(),
      log: new FakeDecisionLog([]),
      questionSet: SCAM_ONLY,
      version: 1,
      spending: UNLIMITED,
    });

    const report = await backfill.run({ onEstimate: yes });

    expect(report.estimate.records).toBe(1);
    // The worker gets both: an excluded record is marked skipped there, with no model call.
    expect([...report.enqueued].sort()).toEqual(["k1", "k2"]);
  });

  it("paces at 50 records per second when the pace is not given", async () => {
    const r = await rig(11);
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill(r.deps(worker)).run({ onEstimate: yes });

    expect(r.clock.now()).toBe(200);
  });

  it("goes newest first", async () => {
    const r = await rig(25);
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill(r.deps(worker)).run({ maxInFlight: 1, onEstimate: yes });

    expect(r.connector.enqueuedKeys()).toEqual(Array.from({ length: 25 }, (_, n) => `k${25 - n}`));
  });

  it("refuses a pace that is not a positive number", async () => {
    const r = await rig(1);
    const backfill = createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal)));

    await expect(backfill.run({ pace: 0, onEstimate: yes })).rejects.toThrow(/positive/);
    await expect(backfill.run({ pace: Number.NaN, onEstimate: yes })).rejects.toThrow(/positive/);
  });
});

describe("backfill resume", () => {
  it("resumes from the saved cursor after a restart without asking answered records again", async () => {
    const r = await rig(25);
    r.connector.failEnqueue = (key) => key === "k14";
    const worker = new ScriptedWorker(r.clock, r.journal);

    const first = await createBackfill(r.deps(worker)).run({ maxInFlight: 1, onEstimate: yes });

    // Rows 25 to 16 are page one and saved; page two (15 to 6) has the failure and is not saved.
    expect(first.status).toBe("stopped");
    expect(first.failures.map(({ key }) => key)).toEqual(["k14"]);
    const savedAfterFirstPage = r.cursors.saves.at(-1)?.progress;
    expect(r.cursors.saves).toHaveLength(1);
    expect(savedAfterFirstPage?.done).toBe(false);
    // Meanwhile the worker answers what reached the queue.
    await drainQueue(r, worker);

    // A restart: a new backfill, the same cursor store and the same log, a healthy queue.
    r.connector.failEnqueue = () => false;
    r.connector.enqueued.length = 0;
    r.connector.scans.length = 0;
    const second = await createBackfill(r.deps(worker)).run({ maxInFlight: 1, onEstimate: yes });

    expect(second.status).toBe("completed");
    // The survey and the run both start at the saved cursor, never at the top.
    expect(r.connector.scans[0]).toBe(savedAfterFirstPage?.cursor);
    expect(r.connector.scans).not.toContain(null);
    // Page two's answered rows are not queued again; the refused row and page three are.
    expect(r.connector.enqueuedKeys()).toEqual(["k14", "k5", "k4", "k3", "k2", "k1"]);
    expect([...second.alreadyAnswered].sort()).toEqual(
      ["k15", "k13", "k12", "k11", "k10", "k9", "k8", "k7", "k6"].sort(),
    );
    await drainQueue(r, worker);
    // Every record was asked exactly once overall.
    expect(worker.requests).toHaveLength(25);
    expect(r.cursors.saves.at(-1)?.progress).toEqual({ cursor: null, done: true });
  });

  it("saves the cursor after every page, and the last save says done", async () => {
    const r = await rig(25);
    const pages: (ScanCursor | null)[] = [];

    await createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal))).run({
      onEstimate: yes,
      onPage: ({ cursor }) => pages.push(cursor),
    });

    expect(r.cursors.saves).toHaveLength(3);
    expect(r.cursors.saves.map(({ progress }) => progress.done)).toEqual([false, false, true]);
    expect(pages).toEqual(r.cursors.saves.map(({ progress }) => progress.cursor));
  });

  it("starts from the top again once a run has finished", async () => {
    const r = await rig(5);
    const worker = new ScriptedWorker(r.clock, r.journal);
    const backfill = createBackfill(r.deps(worker));

    await backfill.run({ onEstimate: yes });
    await drainQueue(r, worker);
    r.connector.scans.length = 0;
    const again = await backfill.run({ onEstimate: yes });

    expect(r.connector.scans[0]).toBeNull();
    // Nothing changed since: the second pass queues no one.
    expect(again.alreadyAnswered).toHaveLength(5);
    expect(again.enqueued).toHaveLength(0);
    expect(worker.requests).toHaveLength(5);
  });
});

describe("backfill of an added question", () => {
  async function answeredBeforeTheNewQuestion(rows: number): Promise<Rig> {
    const r = await rig(rows);
    const worker = new ScriptedWorker(r.clock, r.journal);
    await createBackfill(r.deps(worker)).run({ onEstimate: yes });
    await drainQueue(r, worker);
    return r;
  }

  it("asks the added question alone and leaves every other column as it was", async () => {
    const r = await answeredBeforeTheNewQuestion(12);
    const before = new Map<RecordKey, ReturnType<FakeDatabase["decisionOf"]>>();
    for (let n = 1; n <= 12; n += 1) {
      before.set(`k${n}`, r.db.decisionOf(`k${n}`));
    }
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report = await createBackfill(r.deps(worker, SCAM_AND_SPAM, 2)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect(report.status).toBe("completed");
    expect(report.answered).toHaveLength(12);
    // Only the added question goes to the model, one request per record.
    expect(worker.requests).toHaveLength(12);
    for (const { request } of worker.requests) {
      expect(request.questions.map((question) => question.name)).toEqual(["spam"]);
    }
    for (let n = 1; n <= 12; n += 1) {
      const after = r.db.decisionOf(`k${n}`);
      const was = before.get(`k${n}`);
      expect(after?.decisions["scam"]).toEqual(was?.decisions["scam"]);
      expect(after?.decisions["spam"]).toEqual({
        kind: "decided",
        value: true,
        probabilityOrConfidence: 0.9,
      });
      // The unsure scam answer still waits for a person, so the record does too.
      expect(after?.status).toBe(n % 3 === 1 ? "needs_review" : "done");
    }
    // Each record was held while asked and its job settled afterwards.
    expect(r.db.jobs.size).toBe(0);
  });

  it("stops at the spending cap: no call is made past it, and every answer is counted", async () => {
    const r = await answeredBeforeTheNewQuestion(12);
    const worker = new ScriptedWorker(r.clock, r.journal);
    // Each answer costs 100 input tokens: the cap admits three requests and refuses the fourth.
    const gate = new CappedGate(250);

    const report = await createBackfill({
      ...r.deps(worker, SCAM_AND_SPAM, 2),
      spending: gate,
    }).run({ onlyQuestions: ["spam"], maxInFlight: 1, onEstimate: yes });

    expect(report.status).toBe("paused");
    expect(worker.requests).toHaveLength(3);
    expect(report.answered).toHaveLength(3);
    expect(gate.counted).toBe(300);
    expect(gate.reserved).toBe(0);
    // The refused record went back to the queue with its claim; no cursor of this run was saved.
    expect(r.db.jobs.size).toBe(0);
    expect(r.cursors.saves.some(({ run }) => run.startsWith("only@"))).toBe(false);
  });

  it("leaves a record already in the queue to the worker, which asks it whole", async () => {
    const r = await answeredBeforeTheNewQuestion(3);
    await r.connector.enqueue(["k2"]);
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report = await createBackfill(r.deps(worker, SCAM_AND_SPAM, 2)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect([...report.answered].sort()).toEqual(["k1", "k3"]);
    expect(report.deferred).toEqual([{ key: "k2", reason: "queued" }]);
    expect(r.db.jobs.get("k2")).toEqual({ claimedBy: null });
  });

  it("does not ask a record that already holds the added question's answer", async () => {
    const r = await answeredBeforeTheNewQuestion(12);
    const backfill = createBackfill(
      r.deps(new ScriptedWorker(r.clock, r.journal), SCAM_AND_SPAM, 2),
    );
    await backfill.run({ onlyQuestions: ["spam"], onEstimate: yes });

    const worker = new ScriptedWorker(r.clock, r.journal);
    const again = await createBackfill(r.deps(worker, SCAM_AND_SPAM, 2)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect(worker.requests).toHaveLength(0);
    expect(again.alreadyAnswered).toHaveLength(12);
  });

  it("leaves records the worker must ask whole to the worker", async () => {
    const r = await answeredBeforeTheNewQuestion(3);
    r.db.edit("k2", { body: "changed after it was answered" });
    r.db.edit("k9", { body: "row-9" });
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report = await createBackfill(r.deps(worker, SCAM_AND_SPAM, 2)).run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
    });

    expect([...report.answered].sort()).toEqual(["k1", "k3"]);
    expect([...report.deferred].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "k2", reason: "stale" },
      { key: "k9", reason: "unanswered" },
    ]);
    expect(r.db.decisionOf("k2")?.decisions["spam"]).toBeUndefined();
  });

  it("refuses a question the set does not have", async () => {
    const r = await rig(1);
    const backfill = createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal)));

    await expect(backfill.run({ onlyQuestions: ["nope"], onEstimate: yes })).rejects.toThrow(
      /no question named "nope"/,
    );
  });
});

describe("backfill estimate", () => {
  /** A state whose full request is exactly `target` tokens for this question set. */
  function stateWithTokens(set: QuestionSet, target: number): Record<string, string> {
    for (let length = 0; length < 20_000; length += 1) {
      const state = { body: "x".repeat(length) };
      const tokens = Math.ceil(Array.from(JSON.stringify(buildRequest(set, state))).length / 4);
      if (tokens === target) {
        return state;
      }
    }
    throw new Error(`no state reaches ${target} tokens`);
  }

  function twelve(): QuestionSet {
    const questions = Array.from(
      { length: 12 },
      (_, n): Question => ({
        type: "noul",
        name: `q${n + 1}`,
        instructions: `Question number ${n + 1}?`,
        stakes: "low",
      }),
    );
    return setOf(questions);
  }

  async function estimateFor(set: QuestionSet, tokens: number, records: number) {
    const r = await rig(0);
    const backfill = createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal), set));
    const state = stateWithTokens(set, tokens);
    return backfill.estimate(set, { records, states: Array.from({ length: 100 }, () => state) });
  }

  it("matches the marketplace example: 2,000 listings a day for a month, 2 questions", async () => {
    const estimate = await estimateFor(SCAM_AND_SPAM, 360, 2_000 * 30);

    expect(estimate.tokensPerRecord).toBe(360);
    expect(estimate.tokens).toBe(21_600_000);
    expect(estimate.dollars).toBeCloseTo(0.9072, 10);
    expect(estimate.dollars).toBeCloseTo(0.91, 2);
    expect(estimate.sampled).toBe(100);
  });

  it("matches the support inbox example: 5,000 messages a day, 12 questions", async () => {
    const estimate = await estimateFor(twelve(), 730, 5_000 * 30);

    expect(estimate.dollars).toBeCloseTo(4.6, 2);
  });

  it("matches the one-off backfill of 10 million records with 12 questions", async () => {
    const estimate = await estimateFor(twelve(), 730, 10_000_000);

    expect(Math.round(estimate.dollars)).toBe(307);
  });

  it("prices an added question as the state plus its own words, and a blank record as nothing", async () => {
    const r = await rig(0);
    const backfill = createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal)));
    const state = { body: "x".repeat(400) };
    const sample = { records: 1_000, states: [state, { body: "  " }] };

    const whole = backfill.estimate(SCAM_AND_SPAM, sample);
    const added = backfill.estimate(SCAM_AND_SPAM, sample, ["spam"]);

    expect(added.tokensPerRecord).toBeLessThan(whole.tokensPerRecord);
    expect(added.tokensPerRecord).toBeGreaterThan(100 / 2);
    // Half the sample is blank and costs nothing.
    expect(whole.tokensPerRecord).toBeLessThan(
      Math.ceil(Array.from(JSON.stringify(buildRequest(SCAM_AND_SPAM, state))).length / 4),
    );
  });

  it("is made from the first 100 states and the whole record count", async () => {
    const r = await rig(250);
    const seen: { records: number; sampled: number }[] = [];

    await createBackfill(r.deps(new ScriptedWorker(r.clock, r.journal))).run({
      onEstimate: (estimate) => {
        seen.push({ records: estimate.records, sampled: estimate.sampled });
        return false;
      },
    });

    expect(seen).toEqual([{ records: 250, sampled: 100 }]);
  });
});

describe("backfill consent", () => {
  it("shows the estimate before any record is asked", async () => {
    const r = await rig(5);
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill(r.deps(worker)).run({
      onEstimate: () => {
        r.journal.push("estimate shown");
        return true;
      },
    });

    expect(r.journal[0]).toBe("estimate shown");
    expect(r.connector.enqueued).toHaveLength(5);
  });

  it("makes no model call, no write and no cursor save when the caller declines", async () => {
    const r = await rig(25);
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report: BackfillReport = await createBackfill(r.deps(worker)).run({
      onEstimate: () => false,
    });

    expect(report.status).toBe("declined");
    expect(report.estimate.records).toBe(25);
    expect(worker.requests).toHaveLength(0);
    expect(r.connector.writes).toBe(0);
    expect(r.cursors.saves).toHaveLength(0);
    expect(r.journal).not.toContain("append answer k1");
    expect(r.clock.sleeps).toHaveLength(0);
  });

  it("waits for an estimate callback that answers later", async () => {
    const r = await rig(3);
    const worker = new ScriptedWorker(r.clock, r.journal);

    const report = await createBackfill(r.deps(worker)).run({
      onEstimate: async () => {
        await Promise.resolve();
        return false;
      },
    });

    expect(report.status).toBe("declined");
    expect(worker.requests).toHaveLength(0);
  });
});

describe("backfill alerts", () => {
  function recorder(): { signals: AlertSignals; told: string[] } {
    const told: string[] = [];
    return {
      told,
      signals: {
        modelCall: () => Promise.resolve(),
        beat: () => Promise.resolve(),
        backfillFinished: ({ answered, queued, question }) => {
          told.push(`finished ${answered}+${queued} ${question}`);
          return Promise.resolve();
        },
        backfillFailed: ({ failed, question }) => {
          told.push(`failed ${failed} ${question}`);
          return Promise.resolve();
        },
      },
    };
  }

  it("says a finished run finished, with how many records it queued", async () => {
    const r = await rig(4);
    const { signals, told } = recorder();
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill({ ...r.deps(worker), alerts: signals }).run({ onEstimate: yes });

    expect(told).toEqual(["finished 0+4 null"]);
  });

  it("says a stopped run failed, with how many records could not be queued", async () => {
    const r = await rig(3);
    const { signals, told } = recorder();
    r.connector.failEnqueue = (key) => key === "k2";
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill({ ...r.deps(worker), alerts: signals }).run({
      maxInFlight: 1,
      onEstimate: yes,
    });

    expect(told).toEqual(["failed 1 null"]);
  });

  it("says nothing when the caller declines the estimate", async () => {
    const r = await rig(3);
    const { signals, told } = recorder();
    const worker = new ScriptedWorker(r.clock, r.journal);

    await createBackfill({ ...r.deps(worker), alerts: signals }).run({ onEstimate: () => false });

    expect(told).toEqual([]);
  });
});

describe("backfill failures", () => {
  it("never turns a failed call into an answer, and lets an unchanged record go for the next run", async () => {
    const r = await rig(3);
    const worker = new ScriptedWorker(r.clock, r.journal);
    await createBackfill(r.deps(worker)).run({ onEstimate: yes });
    await drainQueue(r, worker);
    const before = await r.log.latestAnswer("k2");
    const down = new ScriptedWorker(r.clock, r.journal, (row) => row === 2);

    const report = await createBackfill(r.deps(down, SCAM_AND_SPAM, 2)).run({
      onlyQuestions: ["spam"],
      maxInFlight: 1,
      onEstimate: yes,
    });

    expect(report.status).toBe("stopped");
    expect(r.db.decisionOf("k2")?.decisions["spam"]).toBeUndefined();
    expect(await r.log.latestAnswer("k2")).toEqual(before);
    // Unchanged, so not queued for a whole-set call; the unsaved cursor brings it back next run.
    expect(r.db.jobs.has("k2")).toBe(false);
    const retry = await createBackfill(
      r.deps(new ScriptedWorker(r.clock, r.journal), SCAM_AND_SPAM, 2),
    ).run({ onlyQuestions: ["spam"], maxInFlight: 1, onEstimate: yes });
    expect(retry.answered).toContain("k2");
  });
});
