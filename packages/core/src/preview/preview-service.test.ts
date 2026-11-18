import { FakeClock, FakeConnector, FakeDatabase } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import {
  createSpending,
  type Reserved,
  type SpendingAlertKind,
  type SpendingGate,
  spendingGate,
  type UsageStore,
} from "../spending/index.ts";
import { createPreviewService, PREVIEW_CAPPED, PreviewModelError } from "./index.ts";

/**
 * The preview service on the fakes: the fake database and connector, a scripted provider, and the
 * project's spending gate (a recording one, or the real spending module over an in-memory usage
 * store). A preview writes nothing: each test that reads rows checks the database after.
 */

const scam: Question = {
  type: "noul",
  name: "is_scam",
  instructions: "Is it a scam?",
  stakes: "low",
};
const category: Question = {
  type: "choice",
  name: "category",
  instructions: "Which category is it?",
  stakes: "low",
  options: [
    { name: "car", description: "A car" },
    { name: "flat", description: "A flat" },
  ],
  storeProbabilities: false,
};

const SET: QuestionSet = {
  questions: [scam, category],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

const TOKENS_PER_ANSWER = 120;

/** 25 rows, r1 the oldest and r25 the newest, ten to a scan page. */
function listings(
  options: { readonly excludes?: (state: Readonly<Record<string, string | null>>) => boolean } = {},
): FakeDatabase {
  const database = new FakeDatabase({ fields: ["title"], pageSize: 10, ...options });
  for (let n = 1; n <= 25; n += 1) {
    database.edit(`r${n}`, { title: `Listing ${n}` });
  }
  return database;
}

/** Answers every row as an unsure scam (r25) or a sure non-scam car (the rest), and keeps the requests. */
class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #fail: (call: number) => boolean;

  constructor(fail: (call: number) => boolean = () => false) {
    this.#fail = fail;
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.#fail(this.requests.length - 1)) {
      return Promise.reject(new Error("the model answered 503"));
    }
    const unsure = request.state["title"] === "Listing 25";
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: unsure ? 0.58 : 0.02 },
        category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
      },
      usage: { inputTokens: TOKENS_PER_ANSWER, outputTokens: 4 },
    });
  }
}

/** A gate that admits everything and records each call, in order. */
function recordingGate(calls: string[]): SpendingGate {
  let issued = 0;
  return {
    allowsWork: () => {
      calls.push("allowsWork");
      return Promise.resolve(true);
    },
    admit: (tokens) => {
      issued += 1;
      calls.push(`admit ${tokens}`);
      return Promise.resolve(`reservation-${issued}`);
    },
    settle: (reservation) => {
      calls.push(`settle ${reservation}`);
      return Promise.resolve();
    },
    record: () => Promise.reject(new Error("a preview counts through finish, never record")),
    finish: (reservation, tokens) => {
      calls.push(`finish ${reservation} ${tokens}`);
      return Promise.resolve();
    },
  };
}

/** The usage table as the store keeps it: totals, reservations and alert claims, in one process. */
class MemoryUsageStore implements UsageStore {
  readonly totals = new Map<string, number>();
  readonly open = new Map<string, number>();
  #issued = 0;

  add(projectId: string, month: string, inputTokens: number): Promise<number> {
    return Promise.resolve(this.#count(projectId, month, inputTokens));
  }

  total(projectId: string, month: string): Promise<number> {
    return Promise.resolve(this.totals.get(`${projectId}|${month}`) ?? 0);
  }

  reserve(
    projectId: string,
    month: string,
    requestTokens: number,
    limit: number | undefined,
  ): Promise<Reserved> {
    const monthTotal = this.totals.get(`${projectId}|${month}`) ?? 0;
    const held = [...this.open.values()].reduce((sum, tokens) => sum + tokens, 0);
    if (limit !== undefined && monthTotal + held >= limit) {
      return Promise.resolve({ reservation: undefined, monthTotal });
    }
    this.#issued += 1;
    const id = `reservation-${this.#issued}`;
    this.open.set(id, requestTokens);
    return Promise.resolve({ reservation: id, monthTotal });
  }

  release(_projectId: string, reservation: string): Promise<void> {
    this.open.delete(reservation);
    return Promise.resolve();
  }

  finish(
    projectId: string,
    month: string,
    reservation: string,
    inputTokens: number,
  ): Promise<number> {
    this.open.delete(reservation);
    return Promise.resolve(this.#count(projectId, month, inputTokens));
  }

  claimAlert(_projectId: string, _month: string, _kind: SpendingAlertKind): Promise<boolean> {
    return Promise.resolve(false);
  }

  releaseAlert(): Promise<void> {
    return Promise.resolve();
  }

  #count(projectId: string, month: string, inputTokens: number): number {
    const key = `${projectId}|${month}`;
    const total = (this.totals.get(key) ?? 0) + inputTokens;
    this.totals.set(key, total);
    return total;
  }
}

const MONTH = "2026-11";
const NOV_5 = Date.UTC(2026, 10, 5);
/** Read by the service only when the cap is reached: 26 days before December. */
const CLOCK = new FakeClock(NOV_5);

/** The project's gate as the worker builds it: the real spending module, this cap, pausing at 100%. */
function projectGate(usage: UsageStore, capTokens: number): SpendingGate {
  const spending = createSpending({
    usageStore: usage,
    clock: new FakeClock(NOV_5),
    alerts: { raise: () => Promise.resolve({ status: "sent", failures: [] }) },
    capLink: () => "https://docs.facetdb.dev/fix/spending-cap",
  });
  return spendingGate(spending, "listings-app", () =>
    Promise.resolve({ inputTokens: capTokens, onCapReached: "pause" }),
  );
}

/** Nothing was written: no decision on any row, no job queued. */
function expectUntouched(database: FakeDatabase): void {
  for (const [key] of database.rows.entries()) {
    expect(database.decisionOf(key)).toBeNull();
  }
  expect(database.jobs.size).toBe(0);
}

describe("the preview service", () => {
  it("answers the 20 newest rows, one request each under its own reservation, and writes nothing", async () => {
    const database = listings();
    const provider = new ScriptedProvider();
    const calls: string[] = [];
    const service = createPreviewService({
      connector: new FakeConnector(database),
      provider,
      spending: recordingGate(calls),
      log: (line) => {
        throw new Error(`nothing should be logged: ${line}`);
      },
      clock: CLOCK,
    });

    const result = await service.preview(SET, 20);

    if (result.kind !== "previewed") {
      throw new Error(`expected a preview, got ${result.kind}`);
    }
    // Newest first across two scan pages: r25 down to r6.
    expect(result.rows.map((row) => row.key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `r${25 - index}`),
    );
    // One request per row carrying every question of the set.
    expect(provider.requests).toHaveLength(20);
    expect(provider.requests.every((request) => request.questions.length === 2)).toBe(true);
    // Every request is admitted before it is sent and finished with the tokens the model counted.
    expect(calls[0]).toBe("allowsWork");
    expect(calls.filter((call) => call.startsWith("admit "))).toHaveLength(20);
    expect(calls.filter((call) => call.startsWith("finish "))).toEqual(
      Array.from({ length: 20 }, (_, index) => `finish reservation-${index + 1} 120`),
    );
    expect(calls.some((call) => call.startsWith("settle "))).toBe(false);
    // Every probability comes back with the decision at the set's thresholds.
    const newest = result.rows[0];
    expect(newest).toMatchObject({
      key: "r25",
      kind: "answered",
      state: { title: "Listing 25" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.58 },
        category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
      },
      decisions: {
        is_scam: { kind: "needs_review" },
        category: { kind: "decided", value: "car" },
      },
      status: "needs_review",
    });
    expect(result.rows[1]).toMatchObject({
      key: "r24",
      decisions: { is_scam: { kind: "decided", value: false } },
      status: "done",
    });
    expect(result.decided).toBe(19);
    expect(result.review).toBe(1);
    // The cost in tokens and dollars: 20 answers of 120 tokens at $0.042 per million.
    expect(result.cost).toEqual({
      inputTokens: 2400,
      dollars: (2400 * 0.042) / 1_000_000,
    });
    expectUntouched(database);
  });

  it("applies the set's own thresholds, so a draft's override changes the decision", async () => {
    const result = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider: new ScriptedProvider(),
      spending: recordingGate([]),
      log: () => undefined,
      clock: CLOCK,
    }).preview({ ...SET, thresholds: { is_scam: { yesAbove: 0.55 } } }, 1);

    expect(result).toMatchObject({
      kind: "previewed",
      rows: [{ key: "r25", decisions: { is_scam: { kind: "decided", value: true } } }],
      decided: 1,
      review: 0,
    });
  });

  it("reserves and settles against the project's cap like the worker: the month's count grows by what was answered", async () => {
    const usage = new MemoryUsageStore();
    const result = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider: new ScriptedProvider(),
      spending: projectGate(usage, 1_000_000),
      log: () => undefined,
      clock: CLOCK,
    }).preview(SET, 20);

    expect(result.kind).toBe("previewed");
    expect(usage.totals.get(`listings-app|${MONTH}`)).toBe(2400);
    // Every reservation gave way to its count.
    expect(usage.open.size).toBe(0);
  });

  it("returns the cap's words when the cap is already reached, without reading a row or calling the model", async () => {
    const usage = new MemoryUsageStore();
    await usage.add("listings-app", MONTH, 5_000);
    const provider = new ScriptedProvider();
    const scans: string[] = [];
    const connector = new FakeConnector(listings());

    const result = await createPreviewService({
      connector: {
        scan: (cursor) => {
          scans.push(String(cursor));
          return connector.scan(cursor);
        },
      },
      provider,
      spending: projectGate(usage, 5_000),
      log: () => undefined,
      clock: CLOCK,
    }).preview(SET, 20);

    // Retry when the month resets: November 5, 00:00 UTC to December 1 is 26 days.
    expect(result).toEqual({
      kind: "capped",
      ...PREVIEW_CAPPED,
      retryAfterSeconds: 26 * 24 * 60 * 60,
    });
    expect(result.kind === "capped" && result.message).toContain("spending cap");
    expect(provider.requests).toHaveLength(0);
    expect(scans).toHaveLength(0);
    expect(usage.totals.get(`listings-app|${MONTH}`)).toBe(5_000);
  });

  it("stops asking once a request crosses the cap: the rows after it are shown as not asked", async () => {
    const usage = new MemoryUsageStore();
    // Room for a few requests: one crosses the cap and no more follow.
    await usage.add("listings-app", MONTH, 4_700);
    const provider = new ScriptedProvider();

    const result = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider,
      spending: projectGate(usage, 5_000),
      log: () => undefined,
      clock: CLOCK,
    }).preview(SET, 20);

    if (result.kind !== "previewed") {
      throw new Error(`expected a preview, got ${result.kind}`);
    }
    const answered = result.rows.filter((row) => row.kind === "answered");
    const capped = result.rows.filter((row) => row.kind === "skipped");
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.length).toBeLessThan(20);
    expect(provider.requests).toHaveLength(answered.length);
    expect(capped.every((row) => row.reason === "spending-cap")).toBe(true);
    expect(usage.totals.get(`listings-app|${MONTH}`)).toBe(4_700 + answered.length * 120);
    expect(result.cost.inputTokens).toBe(answered.length * 120);
    expect(usage.open.size).toBe(0);
  });

  it("skips a filtered, an empty and an oversize row without a reservation or a model call", async () => {
    const database = new FakeDatabase({
      fields: ["title"],
      excludes: (state) => state["title"] === "internal",
    });
    database.edit("r1", { title: "internal" });
    database.edit("r2", { title: "   " });
    database.edit("r3", { title: "x".repeat(400) });
    const provider = new ScriptedProvider();
    const calls: string[] = [];

    const result = await createPreviewService({
      connector: new FakeConnector(database),
      provider,
      spending: recordingGate(calls),
      log: () => undefined,
      clock: CLOCK,
      maxStateTokens: 50,
    }).preview(SET, 20);

    // Exactly the key and the reason: a row the model was not shown carries no state.
    expect(result).toEqual({
      kind: "previewed",
      rows: [
        { key: "r3", kind: "skipped", reason: "too-large" },
        { key: "r2", kind: "skipped", reason: "empty-state" },
        { key: "r1", kind: "skipped", reason: "filtered-out" },
      ],
      decided: 0,
      review: 0,
      cost: { inputTokens: 0, dollars: 0 },
    });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toEqual(["allowsWork"]);
  });

  it("keeps the model's failure when the store refuses to give the reservation back", async () => {
    const lines: string[] = [];
    const gate = recordingGate([]);

    const error = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider: new ScriptedProvider(() => true),
      spending: { ...gate, settle: () => Promise.reject(new Error("the store is down")) },
      log: (line) => lines.push(line),
      clock: CLOCK,
    })
      .preview(SET, 1)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreviewModelError);
    expect(error).toMatchObject({ key: "r25", message: "the model answered 503" });
    expect(lines).toEqual(["the reservation is left to its lease: the store is down"]);
  });

  it("fails on a failed model call, naming the row, and gives its reservation back", async () => {
    const database = listings();
    const usage = new MemoryUsageStore();

    const failed = createPreviewService({
      connector: new FakeConnector(database),
      provider: new ScriptedProvider((call) => call === 0),
      spending: projectGate(usage, 1_000_000),
      log: () => undefined,
      clock: CLOCK,
    }).preview(SET, 4);

    const error = await failed.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreviewModelError);
    expect(error).toMatchObject({
      key: "r25",
      question: undefined,
      message: "the model answered 503",
    });
    // The three answered rows of the chunk are counted; the failed one's reservation went back.
    expect(usage.totals.get(`listings-app|${MONTH}`)).toBe(360);
    expect(usage.open.size).toBe(0);
    expectUntouched(database);
  });

  it("fails on a response without a question's answer, after counting what the call cost", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = {
      ask: () =>
        Promise.resolve({
          model: "jev-1.14.0",
          answers: { is_scam: { type: "noul", probability: 0.1 } },
          usage: { inputTokens: 90, outputTokens: 2 },
        }),
    };

    const error = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider,
      spending: recordingGate(calls),
      log: () => undefined,
      clock: CLOCK,
    })
      .preview(SET, 1)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreviewModelError);
    expect(error).toMatchObject({ key: "r25", question: "category" });
    expect(calls).toContain("finish reservation-1 90");
  });

  it("hears a count the store refused through the log, and still shows the answer", async () => {
    const lines: string[] = [];
    const gate = recordingGate([]);
    const result = await createPreviewService({
      connector: new FakeConnector(listings()),
      provider: new ScriptedProvider(),
      spending: { ...gate, finish: () => Promise.reject(new Error("the store is down")) },
      log: (line) => lines.push(line),
      clock: CLOCK,
    }).preview(SET, 1);

    expect(result).toMatchObject({ kind: "previewed", rows: [{ key: "r25", kind: "answered" }] });
    expect(lines).toEqual(["the preview's tokens are held to be counted again: the store is down"]);
  });
});
