import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { AlertSignals } from "../alerts/index.ts";
import type { ProviderRequest, ProviderResponse, RecordKey } from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import {
  type BackfillProgress,
  type BackfillWorker,
  type CursorStore,
  createBackfill,
  type PageProgress,
} from "./backfill.ts";

/**
 * A whole-set backfill counts as queued only the keys the connector's `enqueue` says it queued. A
 * plugin source leaves out a key its plugin no longer returns on the read again; the report names
 * those apart, and no count a user reads (the report, a page's progress, the finished alert) holds
 * them as queued.
 */

const SET: QuestionSet = {
  questions: [{ type: "noul", name: "scam", instructions: "A scam?", stakes: "low" }],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

class Cursors implements CursorStore {
  readonly #stored = new Map<string, BackfillProgress>();
  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.#stored.get(run));
  }
  save(run: string, progress: BackfillProgress): Promise<void> {
    this.#stored.set(run, progress);
    return Promise.resolve();
  }
}

/** A whole-set run never asks the model: the worker does. */
class NeverAsked implements BackfillWorker {
  ask(_request: ProviderRequest): Promise<ProviderResponse> {
    return Promise.reject(new Error("a whole-set backfill asked the model"));
  }
}

/** Queues every key but those in `dropped`, as a plugin source does with keys its plugin no longer returns. */
class LeavesOut extends FakeConnector {
  readonly #dropped: ReadonlySet<RecordKey>;
  constructor(db: FakeDatabase, dropped: readonly RecordKey[]) {
    super(db);
    this.#dropped = new Set(dropped);
  }
  override async enqueue(keys: readonly RecordKey[]): Promise<readonly RecordKey[]> {
    return super.enqueue(keys.filter((key) => !this.#dropped.has(key)));
  }
}

function alertsTold(): { readonly signals: AlertSignals; readonly finished: number[] } {
  const finished: number[] = [];
  return {
    finished,
    signals: {
      modelCall: () => Promise.resolve(),
      modelChecked: () => Promise.resolve(),
      beat: () => Promise.resolve(),
      backfillFinished: ({ queued }) => {
        finished.push(queued);
        return Promise.resolve();
      },
      backfillFailed: () => Promise.resolve(),
    },
  };
}

describe("a whole-set backfill's queued count", () => {
  it("counts only the keys the connector queued, and names the two it left out", async () => {
    // 12 records, pages of 5, newest first: k12..k8, k7..k3, k2..k1.
    const db = new FakeDatabase({ fields: ["body"], pageSize: 5 });
    for (let n = 1; n <= 12; n += 1) {
      db.edit(`k${n}`, { body: `row-${n}` });
    }
    const connector = new LeavesOut(db, ["k9", "k4"]);
    await connector.install();
    const { signals, finished } = alertsTold();
    const pages: PageProgress[] = [];

    const report = await createBackfill({
      project: "proj_market",
      source: "listings",
      connector,
      worker: new NeverAsked(),
      clock: new FakeClock(),
      cursorStore: new Cursors(),
      log: new FakeDecisionLog(),
      reviews: reviewsOf(new FakeReviewQueue(), "listings"),
      questionSet: SET,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
      alerts: signals,
    }).run({ onEstimate: () => true, onPage: (page) => pages.push(page) });

    expect(report.status).toBe("completed");
    expect(report.enqueued).toEqual([
      "k12",
      "k11",
      "k10",
      "k8",
      "k7",
      "k6",
      "k5",
      "k3",
      "k2",
      "k1",
    ]);
    expect(report.notQueued).toEqual(["k9", "k4"]);
    expect(report.failures).toEqual([]);
    // Only what the queue holds: the two left out are in no queue.
    expect([...db.jobs.entries()].map(([key]) => key).sort()).toEqual([...report.enqueued].sort());
    expect(pages.map((page) => page.queued)).toEqual([4, 8, 10]);
    expect(finished).toEqual([10]);
  });

  it("counts every key as queued when the connector queues all it was given", async () => {
    const db = new FakeDatabase({ fields: ["body"], pageSize: 5 });
    for (let n = 1; n <= 3; n += 1) {
      db.edit(`k${n}`, { body: `row-${n}` });
    }
    const connector = new FakeConnector(db);
    await connector.install();

    const report = await createBackfill({
      project: "proj_market",
      source: "listings",
      connector,
      worker: new NeverAsked(),
      clock: new FakeClock(),
      cursorStore: new Cursors(),
      log: new FakeDecisionLog(),
      reviews: reviewsOf(new FakeReviewQueue(), "listings"),
      questionSet: SET,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
    }).run({ onEstimate: () => true });

    expect(report.enqueued).toEqual(["k3", "k2", "k1"]);
    expect(report.notQueued).toEqual([]);
  });
});
