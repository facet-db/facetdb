import { FakeClock, FakeConnector, FakeDatabase, FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../contracts/index.ts";
import type { HumanEntry } from "../log/index.ts";
import { PREVIEW_CAPPED, PreviewModelError } from "../preview/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import type { Answer } from "../thresholds/index.ts";
import {
  createQuestionTestService,
  type QuestionTestDeps,
  QuestionTestFieldsError,
  type QuestionTestResult,
  TEST_ESTIMATE_TOLERANCE,
} from "./index.ts";

/**
 * `testQuestionSet` on the fakes: the fake database and connector, the fake decision log holding
 * what the version in force answered and what people decided, a scripted provider that answers as
 * the draft would, and a spending gate that records each call. Nothing the test does may write a
 * row, a decision or a log entry; each test that runs the draft checks that.
 */

const NOV_5 = Date.UTC(2026, 10, 5);

const scam = (stakes: "low" | "high"): Question => ({
  type: "noul",
  name: "is_scam",
  instructions: "Is it a scam?",
  stakes,
});
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
const refund: Question = {
  type: "noul",
  name: "wants_refund",
  instructions: "Does the buyer want a refund?",
  stakes: "low",
};
const legacy: Question = {
  type: "noul",
  name: "legacy",
  instructions: "Is it old?",
  stakes: "low",
};

/** Version 3: is_scam decides at 70% and 30%. */
const CURRENT: QuestionSet = {
  questions: [scam("low"), category, legacy],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The draft: is_scam is high stakes (90% and 10%), wants_refund is new, legacy is gone. */
const DRAFT: QuestionSet = {
  questions: [scam("high"), category, refund],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** What the draft's model says of is_scam for each title; every other answer is the same for all. */
const DRAFT_SCAM: Readonly<Record<string, number>> = {
  "Listing r1": 0.95,
  "Listing r2": 0.8,
  "Listing r3": 0.5,
  "Listing r4": 0.97,
  "Listing r5": 0.02,
  "Listing r6": 0.5,
  "Listing r7": 0.95,
  "Listing old1": 0.5,
  "Listing old2": 0.05,
  "Listing old3": 0.95,
};

/** What the version in force logged for is_scam; r6 was never answered. */
const LOGGED_SCAM: Readonly<Record<string, number>> = {
  "Listing r1": 0.95,
  "Listing r2": 0.8,
  "Listing r3": 0.5,
  "Listing r4": 0.5,
  "Listing r5": 0.95,
  "Listing r7": 0.5,
  "Listing old1": 0.2,
  "Listing old2": 0.9,
  "Listing old3": 0.9,
};

function noul(probability: number): Answer {
  return { type: "noul", probability };
}
const CAR: Answer = { type: "choice", top: "car", probabilities: [0.95, 0.05] };

/** Answers as the draft would, with a token count a little denser than the estimate's 4 characters. */
class DraftProvider implements ModelProvider {
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
    const title = request.state["title"] ?? "";
    const p = DRAFT_SCAM[title];
    if (p === undefined) {
      return Promise.reject(new Error(`no scripted answer for "${title}"`));
    }
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: { is_scam: noul(p), category: CAR, wants_refund: noul(0.02) },
      usage: { inputTokens: Math.round(JSON.stringify(request).length / 3.6), outputTokens: 6 },
    });
  }
}

type GateCalls = { readonly calls: string[]; readonly gate: SpendingGate };

function recordingGate(options: { readonly paused?: boolean } = {}): GateCalls {
  const calls: string[] = [];
  let issued = 0;
  const gate: SpendingGate = {
    allowsWork: () => {
      calls.push("allowsWork");
      return Promise.resolve(options.paused !== true);
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
    record: () => Promise.reject(new Error("a test counts through finish, never record")),
    finish: (reservation, tokens) => {
      calls.push(`finish ${reservation} ${tokens}`);
      return Promise.resolve();
    },
  };
  return { calls, gate };
}

type World = {
  readonly database: FakeDatabase;
  readonly log: FakeDecisionLog;
  readonly provider: DraftProvider;
  readonly gate: GateCalls;
  readonly deps: QuestionTestDeps;
  /** Entries in the log when the world was built: a test appends none. */
  readonly logged: number;
};

function human(
  key: string,
  question: string,
  value: boolean | string,
  stateOfTitle: string,
): HumanEntry {
  return {
    kind: "human",
    key,
    question,
    value,
    reviewer: "maya",
    stateHash: stateHash(["title"], { title: stateOfTitle }),
    version: 3,
    at: new Date(NOV_5),
  };
}

/**
 * Three old records outside a sample of seven (old1 and old2 decided by a person, old3 decided and
 * then edited), then r1 to r7 with r7 the newest and decided by a person. The log holds the answers
 * the version in force gave, at the state each record has now (r6: none).
 */
async function world(
  options: {
    readonly paused?: boolean;
    readonly provider?: DraftProvider;
    readonly people?: boolean;
  } = {},
): Promise<World> {
  const database = new FakeDatabase({ fields: ["title"], pageSize: 4 });
  for (const key of ["old1", "old2", "old3", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]) {
    database.edit(key, { title: `Listing ${key}` });
  }
  const log = new FakeDecisionLog();
  for (const key of Object.keys(LOGGED_SCAM).map((title) => title.replace("Listing ", ""))) {
    const title = `Listing ${key}`;
    const p = LOGGED_SCAM[title];
    if (p === undefined) {
      throw new Error(`no logged answer for ${title}`);
    }
    await log.appendAnswer({
      kind: "answer",
      key,
      version: 3,
      model: "jev-1.14.0",
      stateHash: stateHash(["title"], { title }),
      answers: { is_scam: noul(p), category: CAR },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date(NOV_5),
    });
  }
  if (options.people !== false) {
    await log.appendHuman(human("old1", "is_scam", false, "Listing old1"));
    await log.appendHuman(human("old2", "is_scam", true, "Listing old2"));
    // old3 was decided against a title it no longer has: the decision does not stand.
    await log.appendHuman(human("old3", "is_scam", true, "Listing old3, before the edit"));
    await log.appendHuman(human("r7", "is_scam", true, "Listing r7"));
  }
  const provider = options.provider ?? new DraftProvider();
  const gate = recordingGate(options.paused === undefined ? {} : { paused: options.paused });
  return {
    database,
    log,
    provider,
    gate,
    logged: await log.count(),
    deps: {
      connector: new FakeConnector(database),
      decisions: log,
      provider,
      spending: gate.gate,
      note: (line) => {
        throw new Error(`nothing should be noted: ${line}`);
      },
      clock: new FakeClock(NOV_5),
    },
  };
}

async function tested(
  w: World,
  options: { readonly sample?: number; readonly reviewed?: boolean } = {},
): Promise<Extract<QuestionTestResult, { kind: "tested" }>> {
  const plan = await createQuestionTestService(w.deps).testQuestionSet({
    current: CURRENT,
    draft: DRAFT,
    sample: options.sample ?? 7,
    reviewed: options.reviewed ?? true,
  });
  const result = await plan.run();
  if (result.kind !== "tested") {
    throw new Error(`expected a tested result, got ${result.kind}`);
  }
  return result;
}

/** Nothing was written: no decision on any row, no job, no entry added to the log. */
async function expectUntouched(w: World): Promise<void> {
  for (const [key] of w.database.rows.entries()) {
    expect(w.database.decisionOf(key)).toBeNull();
  }
  expect(w.database.jobs.size).toBe(0);
  expect(await w.log.count()).toBe(w.logged);
}

function rowOf(result: Extract<QuestionTestResult, { kind: "tested" }>, question: string) {
  const row = result.questions.find((candidate) => candidate.question === question);
  if (row === undefined) {
    throw new Error(`the result has no row for ${question}`);
  }
  return row;
}

describe("testQuestionSet", () => {
  it("prices the run first and asks the model nothing until it is run", async () => {
    const w = await world();
    const plan = await createQuestionTestService(w.deps).testQuestionSet({
      current: CURRENT,
      draft: DRAFT,
      sample: 7,
      reviewed: true,
    });

    // The seven newest records, plus old1 and old2 whose decisions stand; old3's does not.
    expect(plan.estimate).toMatchObject({ sampleRecords: 7, reviewedRecords: 3, requests: 9 });
    expect(plan.estimate.inputTokens).toBeGreaterThan(0);
    expect(plan.estimate.dollars).toBeCloseTo((plan.estimate.inputTokens * 0.042) / 1_000_000, 12);
    expect(w.provider.requests).toHaveLength(0);
    expect(w.gate.calls).toEqual([]);
    await expectUntouched(w);
  });

  it("counts, per question, the answers that would change and where they move", async () => {
    const w = await world();
    const result = await tested(w);

    // r1 same, r2 decided -> unsure, r3 unsure both ways, r4 unsure -> decided, r5 yes -> no,
    // r6 never answered, r7 a person's: kept.
    expect(rowOf(result, "is_scam")).toMatchObject({
      comparison: "compared",
      compared: 5,
      changed: 3,
      toDecided: 1,
      toReview: 1,
      toAnotherValue: 1,
      noCurrentAnswer: 1,
      keptForPeople: 1,
    });
    // Same answers, same stakes: nothing moves.
    expect(rowOf(result, "category")).toMatchObject({
      comparison: "compared",
      compared: 6,
      changed: 0,
      noCurrentAnswer: 1,
    });
    // The new question has no current answer to set the draft's against.
    expect(rowOf(result, "wants_refund")).toMatchObject({
      comparison: "new",
      compared: 0,
      changed: 0,
    });
    expect(result.removed).toEqual(["legacy"]);
    expect(result.sample).toEqual({ records: 7, asked: 7 });
    expect(result.reviewed).toEqual({ records: 3, asked: 3 });
    await expectUntouched(w);
  });

  it("measures agreement with the people who decided, now and with the draft", async () => {
    const w = await world();
    const result = await tested(w);

    // old1 (no): now 20% -> no, agreed; draft 50% is unsure at 90% / 10%.
    // old2 (yes): now 90% -> yes, agreed; draft 5% -> no, disagreed.
    // r7 (yes): now 50% is unsure; draft 95% -> yes, agreed.
    expect(rowOf(result, "is_scam").agreement).toEqual({
      kind: "measured",
      records: 3,
      now: { agreed: 2, disagreed: 0, unsure: 1, rate: 1 },
      draft: { agreed: 1, disagreed: 1, unsure: 1, rate: 0.5 },
    });
    // Nobody decided category or the new question: no number, and it says why.
    expect(rowOf(result, "category").agreement).toEqual({
      kind: "none",
      reason: "no-reviewed-records",
    });
    expect(rowOf(result, "wants_refund").agreement).toEqual({
      kind: "none",
      reason: "no-reviewed-records",
    });
  });

  it("gives no agreement number when no record has a person's decision", async () => {
    const w = await world({ people: false });
    const plan = await createQuestionTestService(w.deps).testQuestionSet({
      current: CURRENT,
      draft: DRAFT,
      sample: 7,
      reviewed: true,
    });
    const result = await plan.run();
    if (result.kind !== "tested") {
      throw new Error(`expected a tested result, got ${result.kind}`);
    }

    expect(plan.estimate.reviewedRecords).toBe(0);
    expect(plan.estimate.requests).toBe(7);
    expect(result.reviewed).toEqual({ records: 0, asked: 0 });
    for (const row of result.questions) {
      expect(row.agreement).toEqual({ kind: "none", reason: "no-reviewed-records" });
    }
    // Without people nothing is kept for them either.
    expect(rowOf(result, "is_scam")).toMatchObject({ compared: 6, keptForPeople: 0 });
  });

  it("leaves the older reviewed records out when asked for the newest alone, and still keeps a person's decision", async () => {
    const w = await world();
    const result = await tested(w, { reviewed: false });

    expect(result.reviewed).toEqual({ records: 0, asked: 0 });
    expect(w.provider.requests).toHaveLength(7);
    expect(rowOf(result, "is_scam")).toMatchObject({ keptForPeople: 1, compared: 5 });
    expect(rowOf(result, "is_scam").agreement).toEqual({
      kind: "none",
      reason: "no-reviewed-records",
    });
  });

  it("counts a smaller sample from the newest end", async () => {
    const w = await world();
    const result = await tested(w, { sample: 2 });

    // r7 and r6 are the sample; old1, old2 and r7 are reviewed, so r7 is asked once.
    expect(result.sample).toEqual({ records: 2, asked: 2 });
    expect(result.reviewed).toEqual({ records: 3, asked: 3 });
    expect(w.provider.requests).toHaveLength(4);
  });

  it("prints a cost the counted usage lands within the estimate's tolerance of", async () => {
    const w = await world();
    const result = await tested(w);

    const off =
      Math.abs(result.cost.inputTokens - result.estimate.inputTokens) / result.estimate.inputTokens;
    expect(off).toBeLessThanOrEqual(TEST_ESTIMATE_TOLERANCE);
    expect(result.cost.inputTokens).toBe(
      w.gate.calls
        .filter((call) => call.startsWith("finish "))
        .reduce((sum, call) => sum + Number(call.split(" ")[2]), 0),
    );
    // Every request is admitted before it is sent, under the project's cap.
    expect(w.gate.calls[0]).toBe("allowsWork");
    expect(w.gate.calls.filter((call) => call.startsWith("admit "))).toHaveLength(9);
  });

  it("shows the model only the draft's state fields, though the current version reads more", async () => {
    const database = new FakeDatabase({ fields: ["title", "body"], pageSize: 4 });
    database.edit("a", { title: "Listing r1", body: "private text" });
    const log = new FakeDecisionLog();
    const w = await world();
    const provider = new DraftProvider();
    const service = createQuestionTestService({
      ...w.deps,
      connector: new FakeConnector(database),
      decisions: log,
      provider,
    });

    const plan = await service.testQuestionSet({
      current: { ...CURRENT, read: ["title", "body"] },
      draft: DRAFT,
      sample: 5,
      reviewed: true,
    });
    await plan.run();

    expect(provider.requests.map((request) => request.state)).toEqual([{ title: "Listing r1" }]);
  });

  it("refuses rows that lack a state field the draft reads", async () => {
    const w = await world();
    const service = createQuestionTestService(w.deps);

    await expect(
      service.testQuestionSet({
        current: CURRENT,
        draft: { ...DRAFT, read: ["title", "body"] },
        sample: 7,
        reviewed: true,
      }),
    ).rejects.toMatchObject({ name: QuestionTestFieldsError.name, missing: ["body"] });
    expect(w.provider.requests).toHaveLength(0);
  });

  it("returns the cap's words and asks nothing when the project is paused", async () => {
    const w = await world({ paused: true });
    const plan = await createQuestionTestService(w.deps).testQuestionSet({
      current: CURRENT,
      draft: DRAFT,
      sample: 7,
      reviewed: true,
    });

    const result = await plan.run();

    expect(result).toMatchObject({ kind: "capped", ...PREVIEW_CAPPED });
    expect(w.provider.requests).toHaveLength(0);
    expect(w.gate.calls.some((call) => call.startsWith("admit "))).toBe(false);
  });

  it("fails the whole test when the model fails a record, never counting it as an answer", async () => {
    const w = await world({ provider: new DraftProvider((call) => call === 2) });
    const plan = await createQuestionTestService(w.deps).testQuestionSet({
      current: CURRENT,
      draft: DRAFT,
      sample: 7,
      reviewed: true,
    });

    await expect(plan.run()).rejects.toBeInstanceOf(PreviewModelError);
    await expectUntouched(w);
  });

  it("tests nothing and costs nothing on an empty source", async () => {
    const w = await world();
    const service = createQuestionTestService({
      ...w.deps,
      connector: new FakeConnector(new FakeDatabase({ fields: ["title"] })),
      decisions: new FakeDecisionLog(),
    });

    const plan = await service.testQuestionSet({
      current: CURRENT,
      draft: DRAFT,
      sample: 7,
      reviewed: true,
    });

    expect(plan.estimate).toEqual({
      sampleRecords: 0,
      reviewedRecords: 0,
      requests: 0,
      inputTokens: 0,
      dollars: 0,
    });
    expect(await plan.run()).toMatchObject({ kind: "tested", cost: { inputTokens: 0 } });
  });
});
