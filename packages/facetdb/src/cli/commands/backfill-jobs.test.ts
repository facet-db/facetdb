import type {
  AlertSignals,
  BackfillProgress,
  CursorStore,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  RecordKey,
  ScanCursor,
  ScanPage,
  SpendingGate,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeOpenConnector,
  FakeRunLog,
} from "@facetdb/core/testing";
import type { BackfillJobState, BackfillJobStatus } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type SourceConfig } from "../../config/index.ts";
import { createBackfillJobs, ESTIMATE_KEPT_MS, type JobLoop } from "./backfill-jobs.ts";
import { questionSetOf } from "./database.ts";

/**
 * The studio's backfills as jobs inside the worker on the fakes: core's backfill over a fake table
 * of 30 rows in pages of ten, a provider and a spending gate that note what they were asked, a
 * clock that moves only when told to, and loops the test swaps as a reload would. Nothing is queued
 * or asked before a start that carries the estimate's token; one job per source; a stop, a reload
 * and the worker stopping each end a job after its page in hand, with its place saved.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const START_MS = 1_700_000_000_000;
const PROJECT_ID = "proj_market";

const PROJECT = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: URL,
      table: "listings",
      read: ["body"],
      questions: { scam: noul("Is this listing a scam?"), spam: noul("Is this listing spam?") },
    },
    {
      name: "tickets",
      api: true,
      read: ["subject"],
      questions: { urgent: noul("Is this ticket urgent?") },
    },
  ],
});

/** The cursor store's keys of the two kinds of run of listings under version 1. */
const ALL_V1 = "backfill:proj_market:listings:all@v1";
const ONLY_SPAM_V1 = "backfill:proj_market:listings:only@v1:spam";

const NO_COUNTS = { records: 0, queued: 0, answered: 0, alreadyAnswered: 0, deferred: 0 };

function sourceOf(name: string): SourceConfig {
  const source = PROJECT.sources.find((candidate) => candidate.name === name);
  if (source === undefined) {
    throw new Error(`the test's project has no source called ${name}`);
  }
  return source;
}

/** A loop as the fleet holds one: a reload that restarts a source puts a new one in its place. */
function loopOf(name: string, version = 1): JobLoop {
  const source = sourceOf(name);
  return { source, questionSet: questionSetOf(PROJECT, source), version };
}

/** A point a test holds a job at: `entered` once the job is there, `release` lets it go on. */
function hold() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, entered: false };
}

type Hooks = {
  /** `scans` counts this connector's scans, this one included. */
  beforeScan: (scans: number) => Promise<void> | undefined;
  beforeEnqueue: (keys: readonly RecordKey[]) => Promise<void> | undefined;
  beforeAnswer: (body: string) => Promise<void> | undefined;
};

/**
 * The job's own connector: every scan's cursor, whether it was let go, and the keys put into its
 * own queue, which on a polling source is memory no loop reads.
 */
class JobConnector extends FakeOpenConnector {
  readonly scans: (ScanCursor | null)[] = [];
  readonly enqueued: RecordKey[] = [];
  readonly #hooks: Hooks;

  constructor(database: FakeDatabase, hooks: Hooks) {
    super(database);
    this.#hooks = hooks;
  }

  override async scan(cursor: ScanCursor | null): Promise<ScanPage> {
    this.scans.push(cursor);
    await this.#hooks.beforeScan(this.scans.length);
    return super.scan(cursor);
  }

  override async enqueue(keys: readonly RecordKey[]): Promise<void> {
    this.enqueued.push(...keys);
    return super.enqueue(keys);
  }
}

/** The queue of the loop in force, through the loop's own connector: what it is handed, in order. */
class LoopQueue {
  readonly enqueued: RecordKey[] = [];
  readonly #connector: FakeConnector;
  readonly #hooks: Hooks;

  constructor(database: FakeDatabase, hooks: Hooks) {
    this.#connector = new FakeConnector(database);
    this.#hooks = hooks;
  }

  async enqueue(keys: readonly RecordKey[]): Promise<void> {
    await this.#hooks.beforeEnqueue(keys);
    this.enqueued.push(...keys);
    return this.#connector.enqueue(keys);
  }
}

type Step = "admit" | "ask";

/** The workers' provider: says "no" to every question asked, and notes each request. */
class Provider implements ModelProvider {
  readonly asked: { readonly body: string; readonly questions: readonly string[] }[] = [];
  /** The record whose request fails, by its body. */
  failOn: string | undefined;
  readonly #hooks: Hooks;
  readonly #journal: Step[];

  constructor(hooks: Hooks, journal: Step[]) {
    this.#hooks = hooks;
    this.#journal = journal;
  }

  async ask(request: ProviderRequest): Promise<ProviderResponse> {
    const body = String(request.state["body"]);
    this.#journal.push("ask");
    this.asked.push({ body, questions: request.questions.map((question) => question.name) });
    await this.#hooks.beforeAnswer(body);
    if (body === this.failOn) {
      throw new Error("the model is unreachable");
    }
    const answers: Record<string, { type: "noul"; probability: number }> = {};
    for (const question of request.questions) {
      answers[question.name] = { type: "noul", probability: 0.05 };
    }
    return { model: request.model, answers, usage: { inputTokens: 100, outputTokens: 5 } };
  }
}

/** The project's spending gate: admits `limit` requests, then refuses, as at the cap. */
class Gate implements SpendingGate {
  limit = Number.POSITIVE_INFINITY;
  admitted = 0;
  /** Input tokens counted. */
  counted = 0;
  readonly #journal: Step[];

  constructor(journal: Step[]) {
    this.#journal = journal;
  }

  allowsWork(): Promise<boolean> {
    return Promise.resolve(true);
  }

  admit(): Promise<string | undefined> {
    if (this.admitted >= this.limit) {
      return Promise.resolve(undefined);
    }
    this.admitted += 1;
    this.#journal.push("admit");
    return Promise.resolve(`reservation-${this.admitted}`);
  }

  settle(): Promise<void> {
    return Promise.resolve();
  }

  record(inputTokens: number): Promise<void> {
    this.counted += inputTokens;
    return Promise.resolve();
  }

  finish(): Promise<void> {
    return Promise.resolve();
  }
}

class Cursors implements CursorStore {
  readonly saves: {
    readonly run: string;
    readonly cursor: ScanCursor | null;
    readonly done: boolean;
  }[] = [];
  readonly #stored = new Map<string, BackfillProgress>();

  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#stored.get(run));
  }

  save(run: string, progress: BackfillProgress): Promise<void> {
    this.saves.push({ run, ...progress });
    this.#stored.set(run, progress);
    return Promise.resolve();
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) {
    await Promise.resolve();
  }
}

/** Every fake answers at once, so a job gets where it is going within a few turns or never does. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
    await flush();
  }
  if (!done()) {
    throw new Error(`the backfill never got to where ${what}`);
  }
}

/** True when every request was admitted by the gate before it was made. */
function eachAskAdmitted(journal: readonly Step[]): boolean {
  let admitted = 0;
  let asked = 0;
  for (const step of journal) {
    if (step === "admit") {
      admitted += 1;
    } else {
      asked += 1;
    }
    if (asked > admitted) {
      return false;
    }
  }
  return true;
}

/** Keys `k<from>` down to `k<to>`: the order a newest-first scan reads them in. */
const range = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, n) => `k${from - n}`);

/** 30 rows `k1` to `k30` (body `row-<n>`) in pages of ten, newest first: k30 to k21 is page one. */
function rig(table: { readonly rows?: number; readonly pageSize?: number } = {}) {
  const rows = table.rows ?? 30;
  const clock = new FakeClock(START_MS);
  const database = new FakeDatabase({ fields: ["body"], pageSize: table.pageSize ?? 10, clock });
  for (let n = 1; n <= rows; n += 1) {
    database.edit(`k${n}`, { body: `row-${n}` });
  }
  database.install();
  const loops = new Map<string, JobLoop>([
    ["listings", loopOf("listings")],
    ["tickets", loopOf("tickets")],
  ]);
  const hooks: Hooks = {
    beforeScan: () => undefined,
    beforeEnqueue: () => undefined,
    beforeAnswer: () => undefined,
  };
  const journal: Step[] = [];
  const opened: JobConnector[] = [];
  /** The worker id each of `opened` was opened under. */
  const openedAs: string[] = [];
  const queue = new LoopQueue(database, hooks);
  /** `open` fails the next connector asked for; `log` fails every line of the log that holds it. */
  const failing: { open: Error | undefined; log: string | undefined } = {
    open: undefined,
    log: undefined,
  };
  const cursors = new Cursors();
  const log = new FakeDecisionLog();
  const runs = new FakeRunLog();
  const provider = new Provider(hooks, journal);
  const gate = new Gate(journal);
  const alerts: string[] = [];
  const expiries: { readonly ms: number; readonly timer: AbortController }[] = [];
  const lines: string[] = [];
  let tokens = 0;
  let workers = 0;

  const signals = (name: string): AlertSignals => ({
    modelCall: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    backfillFinished: (summary) => {
      alerts.push(`${name} finished ${JSON.stringify(summary)}`);
      return Promise.resolve();
    },
    backfillFailed: (summary) => {
      alerts.push(`${name} failed ${JSON.stringify(summary)}`);
      return Promise.resolve();
    },
  });

  const jobs = createBackfillJobs({
    projectId: PROJECT_ID,
    loop: (name) => loops.get(name),
    open: (_loop, workerId) => {
      if (failing.open !== undefined) {
        return Promise.reject(failing.open);
      }
      const connector = new JobConnector(database, hooks);
      opened.push(connector);
      openedAs.push(workerId);
      return Promise.resolve(connector);
    },
    newWorkerId: () => {
      workers += 1;
      return `backfill-${workers}`;
    },
    queue: (name) => (loops.has(name) ? queue : undefined),
    provider,
    spending: gate,
    clock,
    cursors,
    log: () => log,
    runs: (name) => ({ log: runs, source: `${PROJECT_ID}:${name}` }),
    alerts: signals,
    expireAfter: (ms) => {
      const timer = new AbortController();
      expiries.push({ ms, timer });
      return timer.signal;
    },
    newToken: () => {
      tokens += 1;
      return `token-${tokens}`;
    },
    print: (line) => {
      if (failing.log !== undefined && line.includes(failing.log)) {
        throw new Error("the worker's log is closed");
      }
      lines.push(line);
    },
  });

  async function status(name = "listings"): Promise<BackfillJobStatus> {
    const outcome = await jobs.status(name);
    if (outcome.kind !== "status") {
      throw new Error(`the worker runs no source called ${name}`);
    }
    return outcome.status;
  }

  /** Lets the job go on until it is in `state`. Each look is a call, which the job takes as one. */
  async function reaches(state: BackfillJobState, name = "listings"): Promise<BackfillJobStatus> {
    let last = await status(name);
    for (let attempt = 0; attempt < 200 && last.state !== state; attempt += 1) {
      await flush();
      last = await status(name);
    }
    if (last.state !== state) {
      throw new Error(`the backfill of ${name} is ${last.state}, not ${state}: ${last.words}`);
    }
    return last;
  }

  /** An estimate of listings asked for and shown: the job waits to be started. */
  async function estimated(questions?: readonly string[]): Promise<BackfillJobStatus> {
    const outcome = await jobs.estimate("listings", questions);
    if (outcome.kind !== "estimating") {
      throw new Error(`the estimate was refused: ${outcome.kind}`);
    }
    return reaches("waiting");
  }

  /** Holds a job while it still counts: its second page of three is about to be read. */
  function holdTheCount() {
    const held = hold();
    hooks.beforeScan = (scans) => {
      if (scans !== 2) {
        return undefined;
      }
      held.entered = true;
      return held.promise;
    };
    return held;
  }

  /** Holds a whole-set job inside page two: its ten records are about to go into the queue. */
  function holdPageTwo() {
    const held = hold();
    hooks.beforeEnqueue = (keys) => {
      if (!keys.includes("k20")) {
        return undefined;
      }
      held.entered = true;
      return held.promise;
    };
    return held;
  }

  /** A whole-set job started and held inside page two, page one done. */
  async function runningInPageTwo() {
    await estimated();
    const held = holdPageTwo();
    await jobs.start("listings", "token-1");
    await until(() => held.entered, "page two is being queued");
    return held;
  }

  /** Every record answered `question` at its present state under version 1: an added one merges. */
  async function answered(question: string): Promise<void> {
    const keys = Array.from({ length: rows }, (_, n) => `k${n + 1}`);
    const read = await new FakeConnector(database).read(keys);
    for (const row of read.rows) {
      await log.appendAnswer({
        kind: "answer",
        key: row.key,
        version: 1,
        model: "jev-1.14.0",
        stateHash: row.hash,
        answers: { [question]: { type: "noul", probability: 0.05 } },
        usage: { inputTokens: 100, outputTokens: 5 },
        at: new Date(START_MS),
      });
    }
  }

  return {
    jobs,
    clock,
    database,
    loops,
    hooks,
    journal,
    opened,
    openedAs,
    queue,
    failing,
    cursors,
    log,
    runs,
    provider,
    gate,
    alerts,
    expiries,
    lines,
    status,
    reaches,
    estimated,
    holdTheCount,
    holdPageTwo,
    runningInPageTwo,
    answered,
  };
}

describe("a backfill job: the estimate first", () => {
  it("counts and prices the source, then waits: nothing is queued, asked or saved until a start carries the estimate's token", async () => {
    const t = rig();

    const asked = await t.jobs.estimate("listings", undefined);
    expect(asked).toMatchObject({
      kind: "estimating",
      status: {
        source: "listings",
        state: "estimating",
        questions: null,
        version: 1,
        surveyed: 0,
        estimate: null,
        token: null,
        expiresAt: null,
      },
    });

    const waiting = await t.reaches("waiting");
    expect(waiting).toMatchObject({
      state: "waiting",
      surveyed: 30,
      token: "token-1",
      expiresAt: new Date(START_MS + ESTIMATE_KEPT_MS).toISOString(),
      counts: NO_COUNTS,
    });
    expect(waiting.estimate).toMatchObject({ records: 30, sampled: 30 });
    expect(waiting.estimate?.dollars).toBeGreaterThan(0);
    expect(waiting.words).toMatch(/^Estimated: 30 records, about [\d,]+ input tokens, /);
    expect(waiting.words).toMatch(
      /Nothing is asked until it is started; an estimate not started within 10 minutes is dropped\.$/,
    );
    expect(t.expiries.map((expiry) => expiry.ms)).toEqual([ESTIMATE_KEPT_MS]);

    // A start that does not carry this estimate's token starts nothing.
    expect(await t.jobs.start("listings", "token-of-another-estimate")).toMatchObject({
      kind: "wrong_token",
      status: { state: "waiting" },
    });
    await flush();
    expect((await t.status()).state).toBe("waiting");
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]?.closed).toBe(false);
    expect(t.queue.enqueued).toEqual([]);
    expect(t.provider.asked).toEqual([]);
    expect(t.gate.admitted).toBe(0);
    expect(t.cursors.saves).toEqual([]);
  });

  it("queues the whole set under the loop's version at 50 records a second, and says when it finished @timing", async () => {
    const t = rig();
    await t.estimated();

    expect(await t.jobs.start("listings", "token-1")).toMatchObject({
      kind: "started",
      status: { state: "running", token: null, expiresAt: null },
    });
    const done = await t.reaches("finished");

    expect(done).toMatchObject({
      state: "finished",
      version: 1,
      token: null,
      why: null,
      counts: { records: 30, queued: 30, answered: 0, alreadyAnswered: 0, deferred: 0 },
      // Two pages waited their turn: ten records take 200 ms at 50 a second.
      endedAt: new Date(START_MS + 400).toISOString(),
      words: "Finished: 30 records queued for the worker, 0 already answered.",
    });
    expect(t.clock.sleeps).toEqual([200, 200]);
    // Handed to the loop in force, which asks them. None went through the job's own connector: a
    // polling source keeps that queue in the connector's memory, where no loop would ever look.
    expect(t.queue.enqueued).toEqual(range(30, 1));
    expect(t.opened[0]?.enqueued).toEqual([]);
    expect(t.opened[0]?.closed).toBe(true);
    expect(t.cursors.saves).toEqual([
      { run: ALL_V1, cursor: "21", done: false },
      { run: ALL_V1, cursor: "11", done: false },
      { run: ALL_V1, cursor: null, done: true },
    ]);
    // The loop asks what was queued: the job itself made no request.
    expect(t.provider.asked).toEqual([]);
    expect(t.alerts).toEqual(['listings finished {"answered":0,"queued":30,"question":null}']);
    expect(t.runs.runs.map(({ source, kind, claimed }) => ({ source, kind, claimed }))).toEqual([
      { source: "proj_market:listings", kind: "backfill", claimed: 10 },
      { source: "proj_market:listings", kind: "backfill", claimed: 10 },
      { source: "proj_market:listings", kind: "backfill", claimed: 10 },
    ]);
    expect(t.lines).toEqual([
      "listings: backfill started under version 1.",
      "listings: backfill finished. Finished: 30 records queued for the worker, 0 already answered.",
    ]);
  });

  it("asks named questions alone through the workers' provider and spending gate, and merges with the answers each record has", async () => {
    const t = rig();
    await t.answered("scam");

    // A name given twice is one question.
    expect(await t.jobs.estimate("listings", ["spam", "spam"])).toMatchObject({
      kind: "estimating",
      status: { questions: ["spam"] },
    });
    const waiting = await t.reaches("waiting");
    expect(waiting.words).toMatch(/^Estimated of "spam": 30 records, /);
    await t.jobs.start("listings", "token-1");
    const done = await t.reaches("finished");

    expect(done).toMatchObject({
      questions: ["spam"],
      counts: { records: 30, queued: 0, answered: 30, alreadyAnswered: 0, deferred: 0 },
      words: "Finished: 30 records answered, 0 already had these answers, 0 left for the worker.",
    });
    // One request a record, of the added question alone, each admitted before it was made.
    expect(t.provider.asked).toHaveLength(30);
    expect(new Set(t.provider.asked.map((request) => request.body)).size).toBe(30);
    expect(t.provider.asked.every((request) => request.questions.join() === "spam")).toBe(true);
    expect(eachAskAdmitted(t.journal)).toBe(true);
    expect(t.gate.admitted).toBe(30);
    expect(t.gate.counted).toBe(3_000);
    // Logged under the loop's version, the answer already there kept beside the new one.
    const latest = await t.log.latestAnswer("k1");
    expect(latest?.version).toBe(1);
    expect(Object.keys(latest?.answers ?? {}).sort()).toEqual(["scam", "spam"]);
    expect(t.database.decisionOf("k1")).not.toBeNull();
    // Nothing went through the queue, and no claim of the job is left in it.
    expect(t.queue.enqueued).toEqual([]);
    expect([...t.database.jobs.entries()]).toEqual([]);
    expect(t.cursors.saves.at(-1)).toEqual({ run: ONLY_SPAM_V1, cursor: null, done: true });
    expect(t.alerts).toEqual(['listings finished {"answered":30,"queued":0,"question":"spam"}']);
  });

  it("refuses a second job of a source while one lives, and takes a new one once it has ended", async () => {
    const t = rig();

    await t.jobs.estimate("listings", undefined);
    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({
      kind: "busy",
      status: { state: "estimating" },
    });
    await t.reaches("waiting");
    expect(await t.jobs.estimate("listings", ["spam"])).toMatchObject({
      kind: "busy",
      status: { state: "waiting" },
    });
    const held = t.holdPageTwo();
    await t.jobs.start("listings", "token-1");
    await until(() => held.entered, "page two is being queued");
    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({
      kind: "busy",
      status: { state: "running" },
    });
    await t.jobs.stop("listings");
    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({
      kind: "busy",
      status: { state: "stopping" },
    });
    expect(t.opened).toHaveLength(1);

    held.release();
    await t.reaches("stopped");
    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({ kind: "estimating" });
    expect((await t.reaches("waiting")).token).toBe("token-2");
    expect(t.opened).toHaveLength(2);
  });

  it("refuses a source the worker does not run, a source with no table and a question the loop does not run, and opens nothing", async () => {
    const t = rig();

    expect(await t.jobs.estimate("orders", undefined)).toEqual({ kind: "unknown_source" });
    expect(await t.jobs.start("orders", "token-1")).toEqual({ kind: "unknown_source" });
    expect(await t.jobs.stop("orders")).toEqual({ kind: "unknown_source" });
    expect(await t.jobs.status("orders")).toEqual({ kind: "unknown_source" });
    // An API source's records arrive one by one: there is no table to page through.
    expect(await t.jobs.estimate("tickets", undefined)).toEqual({ kind: "not_a_table" });
    // In the file, perhaps, and not installed or not reloaded: the loop in force is what counts.
    expect(await t.jobs.estimate("listings", ["spam", "is_vehicle", "is_new"])).toEqual({
      kind: "not_installed",
      questions: ["is_vehicle", "is_new"],
    });

    const idle = {
      source: "listings",
      state: "idle",
      questions: null,
      version: null,
      surveyed: null,
      estimate: null,
      pace: null,
      token: null,
      expiresAt: null,
      counts: null,
      since: null,
      endedAt: null,
      why: null,
      words: "No backfill is running. Estimate one to see its cost first.",
    };
    expect(await t.jobs.status("listings")).toEqual({ kind: "status", status: idle });
    expect(await t.jobs.start("listings", "token-1")).toEqual({
      kind: "no_estimate",
      status: idle,
    });
    expect(await t.jobs.stop("listings")).toEqual({ kind: "nothing_to_stop", status: idle });
    expect(t.jobs.available).toBe(true);
    expect(t.opened).toEqual([]);
  });
});

describe("a backfill job stopped", () => {
  it("on request while it still counts: between two pages of the count, with no estimate shown", async () => {
    const t = rig();
    const held = t.holdTheCount();
    await t.jobs.estimate("listings", undefined);
    await until(() => held.entered, "the second page is being counted");
    expect(await t.status()).toMatchObject({ state: "estimating", surveyed: 10 });
    expect((await t.status()).words).toBe(
      "Counting the records of listings to price the backfill: 10 read so far, newest first. Nothing is asked until it is started.",
    );

    expect(await t.jobs.stop("listings")).toMatchObject({
      kind: "stopping",
      status: { state: "stopping" },
    });
    held.release();
    const stopped = await t.reaches("stopped");

    expect(stopped).toMatchObject({
      why: "Stopped on request before it started; nothing was asked.",
      estimate: null,
      token: null,
    });
    // The page being read was read; the third never was.
    expect(t.opened[0]?.scans).toEqual([null, "21"]);
    expect(t.opened[0]?.closed).toBe(true);
    expect(t.expiries).toEqual([]);
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({ kind: "no_estimate" });
  });

  it("by a reload while it still counts: the estimate of a source that has since restarted is never offered", async () => {
    const t = rig();
    const held = t.holdTheCount();
    await t.jobs.estimate("listings", undefined);
    await until(() => held.entered, "the second page is being counted");

    t.loops.set("listings", loopOf("listings", 2));
    held.release();
    await until(() => t.opened[0]?.closed === true, "the job let go of its connection");

    expect(await t.status()).toMatchObject({
      state: "stopped",
      why: "listings restarted under version 2 after a reload, so the backfill under version 1 stopped before it started; nothing was asked. Estimate again under version 2.",
      token: null,
    });
    // It counted to the end, then looked at the fleet before waiting for a start.
    expect(t.opened[0]?.scans).toEqual([null, "21", "11"]);
    expect(t.expiries).toEqual([]);
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({ kind: "restarted" });
    expect(t.queue.enqueued).toEqual([]);
  });

  it("on request while it waits: at once, with nothing asked, and its estimate starts nothing afterwards", async () => {
    const t = rig();
    await t.estimated();

    expect(await t.jobs.stop("listings")).toMatchObject({
      kind: "stopping",
      status: { state: "stopping" },
    });
    const stopped = await t.reaches("stopped");

    expect(stopped).toMatchObject({
      why: "Stopped on request before it started; nothing was asked.",
      words: "Stopped on request before it started; nothing was asked.",
      token: null,
      counts: NO_COUNTS,
    });
    expect(t.opened[0]?.closed).toBe(true);
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({ kind: "no_estimate" });
    expect(await t.jobs.stop("listings")).toMatchObject({
      kind: "nothing_to_stop",
      status: { state: "stopped" },
    });
    await flush();
    expect(t.queue.enqueued).toEqual([]);
    expect(t.cursors.saves).toEqual([]);
  });

  it("on request while it runs: after the page in hand, its place saved, and the next job resumes after it", async () => {
    const t = rig();
    const held = await t.runningInPageTwo();
    expect(await t.status()).toMatchObject({
      state: "running",
      counts: { records: 10, queued: 10 },
      words:
        "Running under version 1, newest first, at most 50 records a second: 10 of 30 records done.",
    });

    expect(await t.jobs.stop("listings")).toMatchObject({
      kind: "stopping",
      status: {
        state: "stopping",
        words: "Stopping after the page in hand: that page is settled and its place saved first.",
      },
    });
    // Asked twice, told the same; and the page in hand is not cut short.
    expect(await t.jobs.stop("listings")).toMatchObject({ kind: "stopping" });
    await flush();
    expect((await t.status()).state).toBe("stopping");

    held.release();
    const stopped = await t.reaches("stopped");
    expect(stopped).toMatchObject({
      why: "Stopped on request after the page in hand; the pages done stay done, and the next backfill resumes after the last one.",
      counts: { records: 20, queued: 20 },
    });
    // Page two went into the queue whole, and its place is the last one saved.
    expect(t.queue.enqueued).toEqual(range(30, 11));
    expect(t.cursors.saves).toEqual([
      { run: ALL_V1, cursor: "21", done: false },
      { run: ALL_V1, cursor: "11", done: false },
    ]);
    expect(t.opened[0]?.closed).toBe(true);

    // The next job counts and queues what is left: page three alone.
    const next = await t.estimated();
    expect(next.token).toBe("token-2");
    expect(next.estimate?.records).toBe(10);
    expect(t.opened[1]?.scans).toEqual(["11"]);
    await t.jobs.start("listings", "token-2");
    await t.reaches("finished");
    expect(t.queue.enqueued).toEqual(range(30, 1));
    expect(t.cursors.saves.at(-1)).toEqual({ run: ALL_V1, cursor: null, done: true });
    // Each job read under a worker id of its own, never a loop's: a queue in the database tells a
    // job's claims from the loop's by it.
    expect(t.openedAs).toEqual(["backfill-1", "backfill-2"]);
  });

  it("by a reload that restarts the source under the same version: after the page in hand, and the next job resumes after it", async () => {
    const t = rig();
    const held = await t.runningInPageTwo();

    // A threshold changed: the fleet put a new loop in the source's place, its version unchanged.
    t.loops.set("listings", loopOf("listings", 1));
    held.release();
    // No call tells the job: it looks at the fleet itself once its page is settled.
    await until(() => t.opened[0]?.closed === true, "the job let go of its connection");

    expect(await t.status()).toMatchObject({
      state: "stopped",
      why: "listings restarted after a reload, so the backfill stopped after the page in hand; the pages done stay done, and the next backfill resumes after the last one. Estimate again: it runs with the source as it is now.",
      counts: { records: 20, queued: 20 },
    });
    expect(t.queue.enqueued).toEqual(range(30, 11));
    expect(t.cursors.saves.at(-1)).toEqual({ run: ALL_V1, cursor: "11", done: false });
    const next = await t.estimated();
    expect(next.estimate?.records).toBe(10);
    expect(t.opened[1]?.scans).toEqual(["11"]);
  });

  it("by a reload that restarts the source under a new version: after the page in hand, and the next job is a new one from the newest record", async () => {
    const t = rig();
    const held = await t.runningInPageTwo();

    t.loops.set("listings", loopOf("listings", 2));
    held.release();
    await until(() => t.opened[0]?.closed === true, "the job let go of its connection");

    expect(await t.status()).toMatchObject({
      state: "stopped",
      version: 1,
      why: "listings restarted under version 2 after a reload, so the backfill under version 1 stopped after the page in hand. A backfill under version 2 is a new one: estimate again, and it starts from the newest record.",
    });
    // Version 1's place stays saved under its own key; version 2 has none.
    expect(t.cursors.saves.at(-1)).toEqual({ run: ALL_V1, cursor: "11", done: false });
    const next = await t.estimated();
    expect(next.version).toBe(2);
    expect(next.estimate?.records).toBe(30);
    expect(t.opened[1]?.scans).toEqual([null, "21", "11"]);
  });

  it("by a reload that takes the source out of the file: after the page in hand, and the source takes no new job", async () => {
    const t = rig();
    const held = await t.runningInPageTwo();

    t.loops.delete("listings");
    held.release();
    await until(() => t.opened[0]?.closed === true, "the job let go of its connection");

    expect(await t.jobs.status("listings")).toMatchObject({
      kind: "status",
      status: {
        state: "stopped",
        why: "listings is no longer in facetdb.config.ts, so the backfill stopped after the page in hand; the pages done stay done, and the next backfill resumes after the last one.",
      },
    });
    expect(t.queue.enqueued).toEqual(range(30, 11));
    expect(await t.jobs.estimate("listings", undefined)).toEqual({ kind: "unknown_source" });
  });

  it("by a reload that takes the source out of the file between two chunks of a page: the rest of the page goes to the table's queue through the job's own connector", async () => {
    // One page of 60 records, queued 50 a second: a chunk of 50, then one of ten.
    const t = rig({ rows: 60, pageSize: 60 });
    await t.estimated();
    const held = hold();
    t.hooks.beforeEnqueue = (keys) => {
      if (!keys.includes("k60")) {
        return undefined;
      }
      held.entered = true;
      return held.promise;
    };
    await t.jobs.start("listings", "token-1");
    await until(() => held.entered, "the page's first chunk is being queued");

    t.loops.delete("listings");
    held.release();
    await until(() => t.opened[0]?.closed === true, "the job let go of its connection");

    // No loop is left to hand the last ten to: the page in hand is finished all the same.
    expect(t.queue.enqueued).toEqual(range(60, 11));
    expect(t.opened[0]?.enqueued).toEqual(range(10, 1));
    expect(t.cursors.saves).toEqual([{ run: ALL_V1, cursor: null, done: true }]);
  });

  it("by a reload while its estimate waits: the start is refused, since the estimate no longer prices what would run", async () => {
    const t = rig();
    await t.estimated();

    t.loops.set("listings", loopOf("listings", 2));
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({
      kind: "restarted",
      status: { state: "stopping" },
    });
    const stopped = await t.reaches("stopped");

    expect(stopped.why).toBe(
      "listings restarted under version 2 after a reload, so the backfill under version 1 stopped before it started; nothing was asked. Estimate again under version 2.",
    );
    // Told the same when the start comes after the job has ended.
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({
      kind: "restarted",
      status: { state: "stopped" },
    });
    expect(t.queue.enqueued).toEqual([]);
    expect(t.cursors.saves).toEqual([]);
  });

  it("by the worker stopping: the close waits for the page in hand, and a job asked for meanwhile opens nothing", async () => {
    const t = rig();
    const held = await t.runningInPageTwo();

    let closed = false;
    const closing = t.jobs.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    expect((await t.status()).state).toBe("stopping");

    held.release();
    await closing;
    expect(await t.status()).toMatchObject({
      state: "stopped",
      why: "The worker stopped, so the backfill stopped after the page in hand; the pages done stay done, and the next backfill resumes after the last one. Estimate again once the worker runs.",
      counts: { records: 20, queued: 20 },
    });
    expect(t.queue.enqueued).toEqual(range(30, 11));
    expect(t.cursors.saves.at(-1)).toEqual({ run: ALL_V1, cursor: "11", done: false });
    expect(t.opened[0]?.closed).toBe(true);

    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({
      status: {
        state: "stopped",
        why: "The worker stopped, so the backfill stopped before it started; nothing was asked. Estimate again once the worker runs.",
      },
    });
    expect(t.opened).toHaveLength(1);
  });

  it("when the worker's stop signal fires: a waiting estimate is dropped before the worker goes on to close", async () => {
    const t = rig();
    await t.estimated();
    const stop = new AbortController();

    let done = false;
    const stopped = t.jobs.until(stop.signal).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    expect((await t.status()).state).toBe("waiting");

    stop.abort();
    await stopped;
    expect(await t.status()).toMatchObject({
      state: "stopped",
      why: "The worker stopped, so the backfill stopped before it started; nothing was asked. Estimate again once the worker runs.",
    });
    expect(t.opened[0]?.closed).toBe(true);
    expect(t.queue.enqueued).toEqual([]);
  });
});

describe("an estimate nobody starts", () => {
  it("is dropped when its ten minutes are up, and a start that comes later is told so", async () => {
    const t = rig();
    await t.estimated();

    t.expiries[0]?.timer.abort();
    const dropped = await t.reaches("stopped");

    expect(dropped.why).toBe(
      "The estimate was not started within 10 minutes, so it was dropped; nothing was asked.",
    );
    expect(await t.jobs.start("listings", "token-1")).toMatchObject({ kind: "expired" });
    expect(t.opened[0]?.closed).toBe(true);
    expect(t.queue.enqueued).toEqual([]);
  });

  it("starts nothing once the clock is past its time, whether or not the timer fired @timing", async () => {
    const t = rig();
    await t.estimated();

    t.clock.advance(ESTIMATE_KEPT_MS - 1);
    expect((await t.status()).state).toBe("waiting");
    t.clock.advance(1);

    expect(await t.jobs.start("listings", "token-1")).toMatchObject({ kind: "expired" });
    await t.reaches("stopped");
    expect(t.queue.enqueued).toEqual([]);
    expect(t.cursors.saves).toEqual([]);
  });
});

describe("a backfill job that cannot go on", () => {
  it("pauses at the spending cap without losing its place: the next job asks only what was not answered", async () => {
    const t = rig();
    await t.answered("scam");
    t.gate.limit = 15;
    await t.estimated(["spam"]);
    await t.jobs.start("listings", "token-1");

    const paused = await t.reaches("paused");

    expect(paused.why).toBe(
      "The project's spending cap was reached, so the backfill paused before its next request; the page it was on is not saved, and nothing is lost. Raise spendingCap in facetdb.config.ts or wait for next month, then estimate again: it resumes after the last finished page.",
    );
    // Page one, and five records of page two before the gate said no: none asked without it.
    expect(t.provider.asked).toHaveLength(15);
    expect(eachAskAdmitted(t.journal)).toBe(true);
    expect(paused.counts).toMatchObject({ records: 10, answered: 15 });
    expect(t.cursors.saves).toEqual([{ run: ONLY_SPAM_V1, cursor: "21", done: false }]);
    expect([...t.database.jobs.entries()]).toEqual([]);
    expect(t.opened[0]?.closed).toBe(true);

    // The cap raised: the next job starts at page two and skips the five it answered there.
    t.gate.limit = Number.POSITIVE_INFINITY;
    const next = await t.estimated(["spam"]);
    expect(next.estimate?.records).toBe(20);
    await t.jobs.start("listings", "token-2");
    const done = await t.reaches("finished");
    expect(done.counts).toMatchObject({ records: 20, answered: 15, alreadyAnswered: 5 });
    expect(t.provider.asked).toHaveLength(30);
    expect(new Set(t.provider.asked.map((request) => request.body)).size).toBe(30);
  });

  it("fails with the first failure's words when a page has one, the earlier pages saved", async () => {
    const t = rig();
    await t.answered("scam");
    // k15 is on page two.
    t.provider.failOn = "row-15";
    await t.estimated(["spam"]);
    await t.jobs.start("listings", "token-1");

    const failed = await t.reaches("failed");

    expect(failed.why).toBe(
      "1 record failed on a page (the first: the model is unreachable), so the backfill stopped there; the earlier pages are saved. Run facetdb doctor to check the model key and the connection, then estimate again: it resumes at that page and skips what was answered.",
    );
    expect(failed.counts).toMatchObject({ records: 10, answered: 19 });
    expect(t.cursors.saves).toEqual([{ run: ONLY_SPAM_V1, cursor: "21", done: false }]);
    expect(t.alerts).toEqual(['listings failed {"failed":1,"question":"spam"}']);
    expect([...t.database.jobs.entries()]).toEqual([]);
    expect(t.opened[0]?.closed).toBe(true);
  });

  it("ends all the same when its end cannot be written to the worker's log, and the worker still closes", async () => {
    const t = rig();
    t.failing.log = "backfill finished";
    await t.estimated();
    await t.jobs.start("listings", "token-1");

    // A rejection nobody takes would end the worker's process, and fail this test.
    const done = await t.reaches("finished");

    expect(done.counts).toMatchObject({ records: 30, queued: 30 });
    expect(t.opened[0]?.closed).toBe(true);
    expect(t.lines).toEqual(["listings: backfill started under version 1."]);
    await t.jobs.close();
  });

  it("fails when the source cannot be opened, and the source takes another job afterwards", async () => {
    const t = rig();
    t.failing.open = new Error("connection refused");

    expect(await t.jobs.estimate("listings", undefined)).toMatchObject({ kind: "estimating" });
    const failed = await t.reaches("failed");

    expect(failed.why).toBe(
      "The backfill could not go on: connection refused. Run facetdb doctor to check the connection, then estimate again: it resumes after the last finished page.",
    );
    expect(t.lines).toEqual(["listings: backfill failed: connection refused"]);

    t.failing.open = undefined;
    expect((await t.estimated()).token).toBe("token-1");
  });
});
