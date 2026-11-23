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
  RecordKey,
  ScanCursor,
  ScanPage,
} from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import {
  type BackfillDeps,
  type BackfillProgress,
  type BackfillWorker,
  backfillRun,
  type CursorStore,
  createBackfill,
  surveyBackfill,
} from "./backfill.ts";

/**
 * A backfill stopped from outside: `BackfillOptions.signal`. Aborted while a page is in hand, the
 * run settles that page, saves its cursor and reports `aborted`; the next run resumes after it.
 * Aborted before the estimate is shown, or before the first page, nothing is asked or queued and no
 * cursor moves.
 */

const scam: Question = { type: "noul", name: "scam", instructions: "A scam?", stakes: "low" };
const spam: Question = { type: "noul", name: "spam", instructions: "Spam?", stakes: "low" };
const SCAM_ONLY: QuestionSet = {
  questions: [scam],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};
const SCAM_AND_SPAM: QuestionSet = { ...SCAM_ONLY, questions: [scam, spam] };

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

class Cursors implements CursorStore {
  readonly saves: BackfillProgress[] = [];
  readonly #stored = new Map<string, BackfillProgress>();
  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#stored.get(run));
  }
  save(run: string, progress: BackfillProgress): Promise<void> {
    this.saves.push(progress);
    this.#stored.set(run, progress);
    return Promise.resolve();
  }
}

/** Notes every scan's cursor and every queued key; `onScan` and `onEnqueue` let a test act mid-run. */
class SpyConnector extends FakeConnector {
  readonly scans: (ScanCursor | null)[] = [];
  readonly enqueued: RecordKey[] = [];
  onScan: (scans: number) => void = () => undefined;
  onEnqueue: (keys: readonly RecordKey[]) => void = () => undefined;

  override async scan(cursor: ScanCursor | null): Promise<ScanPage> {
    this.scans.push(cursor);
    this.onScan(this.scans.length);
    return super.scan(cursor);
  }

  override async enqueue(keys: readonly RecordKey[]): Promise<void> {
    this.onEnqueue(keys);
    this.enqueued.push(...keys);
    return super.enqueue(keys);
  }
}

/** Says "no" to every question asked; `onAsk` lets a test act while a record is in flight. */
class Worker implements BackfillWorker {
  readonly asked: RecordKey[] = [];
  onAsk: (body: string) => void = () => undefined;
  ask(request: ProviderRequest): Promise<ProviderResponse> {
    const body = String(request.state["body"]);
    this.asked.push(body);
    this.onAsk(body);
    const answers: Record<string, { type: "noul"; probability: number }> = {};
    for (const question of request.questions) {
      answers[question.name] = { type: "noul", probability: 0.05 };
    }
    return Promise.resolve({
      model: request.model,
      answers,
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  }
}

type Rig = {
  readonly database: FakeDatabase;
  readonly connector: SpyConnector;
  readonly cursors: Cursors;
  readonly log: FakeDecisionLog;
  readonly worker: Worker;
  readonly deps: (questionSet: QuestionSet) => BackfillDeps;
};

/** 30 rows `k1` to `k30` (body `row-<n>`), pages of 10, newest first: k30 to k21 is page one. */
async function rig(rows = 30): Promise<Rig> {
  const db = new FakeDatabase({ fields: ["body"], pageSize: 10 });
  for (let n = 1; n <= rows; n += 1) {
    db.edit(`k${n}`, { body: `row-${n}` });
  }
  const connector = new SpyConnector(db);
  await connector.install();
  const cursors = new Cursors();
  const log = new FakeDecisionLog();
  const worker = new Worker();
  const clock = new FakeClock();
  return {
    database: db,
    connector,
    cursors,
    log,
    worker,
    deps: (questionSet) => ({
      project: "proj_market",
      source: "listings",
      connector,
      worker,
      clock,
      cursorStore: cursors,
      log,
      reviews: reviewsOf(new FakeReviewQueue(), "listings"),
      questionSet,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
    }),
  };
}

/** Every record answered `scam` at its present state: an added `spam` merges with it. */
async function answeredScam(r: Rig, rows = 30): Promise<void> {
  const keys = Array.from({ length: rows }, (_, n) => `k${n + 1}`);
  const { rows: read } = await r.connector.read(keys);
  for (const row of read) {
    await r.log.appendAnswer({
      kind: "answer",
      key: row.key,
      version: 1,
      model: SCAM_ONLY.model,
      stateHash: row.hash,
      answers: { scam: { type: "noul", probability: 0.05 } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date(0),
    });
  }
}

const yes = (): boolean => true;
const range = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, n) => `k${from - n}`);

describe("a backfill stopped from outside", () => {
  it("queues the whole page in hand, saves its cursor, and the next run resumes after it", async () => {
    const r = await rig();
    const stop = new AbortController();
    // Aborted while page two is being queued: page two still goes in whole.
    r.connector.onEnqueue = (keys) => {
      if (keys.includes("k20")) {
        stop.abort();
      }
    };
    const backfill = createBackfill(r.deps(SCAM_ONLY));

    const report = await backfill.run({ onEstimate: yes, signal: stop.signal });

    expect(report.status).toBe("aborted");
    expect(report.enqueued).toEqual(range(30, 11));
    expect(r.connector.enqueued).toEqual(range(30, 11));
    // Page two's cursor is the last saved: its oldest row's place, not done.
    expect(r.cursors.saves).toEqual([
      { cursor: "21", done: false },
      { cursor: "11", done: false },
    ]);
    expect(report.cursor).toBe("11");

    r.connector.onEnqueue = () => undefined;
    const scansBefore = r.connector.scans.length;
    const again = await backfill.run({ onEstimate: yes });
    expect(again.status).toBe("completed");
    // The survey and the run both start where the stop left off, and queue page three alone.
    expect(r.connector.scans.slice(scansBefore)).toEqual(["11", "11"]);
    expect(again.enqueued).toEqual(range(10, 1));
  });

  it("asks the whole page in hand of an added question, then stops with its cursor saved", async () => {
    const r = await rig();
    await answeredScam(r);
    const stop = new AbortController();
    r.worker.onAsk = (body) => {
      if (body === "row-28") {
        stop.abort();
      }
    };
    const backfill = createBackfill(r.deps(SCAM_AND_SPAM));

    const report = await backfill.run({
      onlyQuestions: ["spam"],
      onEstimate: yes,
      signal: stop.signal,
    });

    expect(report.status).toBe("aborted");
    expect([...report.answered].sort()).toEqual([...range(30, 21)].sort());
    expect(r.worker.asked).toHaveLength(10);
    expect(r.cursors.saves).toEqual([{ cursor: "21", done: false }]);
    // Every claim of the page in hand was settled: the stop leaves none behind in the queue.
    expect([...r.database.jobs.entries()]).toEqual([]);

    r.worker.onAsk = () => undefined;
    const again = await backfill.run({ onlyQuestions: ["spam"], onEstimate: yes });
    expect(again.status).toBe("completed");
    expect([...again.answered].sort()).toEqual([...range(20, 1)].sort());
    // No record was asked twice across the stop.
    expect(new Set(r.worker.asked).size).toBe(30);
  });

  it("stops the survey between its pages: no estimate is shown, nothing asked, no cursor saved", async () => {
    const r = await rig();
    const stop = new AbortController();
    r.connector.onScan = (scans) => {
      if (scans === 2) {
        stop.abort();
      }
    };
    let shown = false;

    const report = await createBackfill(r.deps(SCAM_ONLY)).run({
      onEstimate: () => {
        shown = true;
        return true;
      },
      signal: stop.signal,
    });

    expect(report.status).toBe("aborted");
    expect(shown).toBe(false);
    // Two pages read of three: the survey went no further.
    expect(r.connector.scans).toEqual([null, "21"]);
    expect(r.connector.enqueued).toEqual([]);
    expect(r.cursors.saves).toEqual([]);
  });

  it("asks and queues nothing when the stop comes while the estimate is shown", async () => {
    const r = await rig();
    await answeredScam(r);
    const stop = new AbortController();

    for (const onlyQuestions of [undefined, ["spam"]]) {
      const report = await createBackfill(r.deps(SCAM_AND_SPAM)).run({
        ...(onlyQuestions === undefined ? {} : { onlyQuestions }),
        // A yes that arrives after the stop.
        onEstimate: () => {
          stop.abort();
          return true;
        },
        signal: stop.signal,
      });
      expect(report.status).toBe("aborted");
    }

    expect(r.connector.enqueued).toEqual([]);
    expect(r.worker.asked).toEqual([]);
    expect(r.cursors.saves).toEqual([]);
  });

  it("finishes when the stop comes on the last page: its cursor is saved as done", async () => {
    const r = await rig();
    const stop = new AbortController();
    r.connector.onEnqueue = (keys) => {
      if (keys.includes("k1")) {
        stop.abort();
      }
    };

    const report = await createBackfill(r.deps(SCAM_ONLY)).run({
      onEstimate: yes,
      signal: stop.signal,
    });

    expect(report.status).toBe("completed");
    expect(r.cursors.saves.at(-1)).toEqual({ cursor: null, done: true });
  });

  it("keeps a failed page unsaved even when stopped: the failure is what it reports", async () => {
    const r = await rig();
    const stop = new AbortController();
    r.connector.onEnqueue = (keys) => {
      if (keys.includes("k20")) {
        stop.abort();
        throw new Error("the queue is unreachable");
      }
    };

    const report = await createBackfill(r.deps(SCAM_ONLY)).run({
      onEstimate: yes,
      signal: stop.signal,
    });

    expect(report.status).toBe("stopped");
    expect(r.cursors.saves).toEqual([{ cursor: "21", done: false }]);
  });

  it("tells each page's counts so far, and keeps every run's place under its own key", async () => {
    const r = await rig();
    const pages: { records: number; queued: number }[] = [];
    await createBackfill(r.deps(SCAM_ONLY)).run({
      onEstimate: yes,
      onPage: ({ records, queued }) => pages.push({ records, queued }),
    });
    expect(pages).toEqual([
      { records: 10, queued: 10 },
      { records: 10, queued: 20 },
      { records: 10, queued: 30 },
    ]);
    expect(backfillRun("proj_market", "listings", 1, undefined)).toBe(
      "backfill:proj_market:listings:all@v1",
    );
  });

  it("surveys with what it counted so far when stopped between pages", async () => {
    const r = await rig();
    const stop = new AbortController();
    r.connector.onScan = (scans) => {
      if (scans === 1) {
        stop.abort();
      }
    };
    const sample = await surveyBackfill(r.connector, null, stop.signal);
    expect(sample.records).toBe(10);
    expect(r.connector.scans).toEqual([null]);
  });
});
