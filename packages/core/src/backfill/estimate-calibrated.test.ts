import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { ProviderRequest, RecordKey } from "../contracts/index.ts";
import type { AnswerEntry } from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { buildRequest } from "../requests/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { type BackfillEstimate, createBackfill, estimateBackfill } from "./backfill.ts";

/**
 * A backfill's estimate is scaled by what the sampled records' answers were billed, never down, and
 * is uncalibrated (a floor, worded "at least") when none was billed at the record's present state.
 * Each case runs the backfill to its estimate and declines it.
 */

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

const RECORDS = 10;

/** The estimator's count for one record: the request's characters at four a token, rounded up. */
function estimated(set: QuestionSet, state: Record<string, string>): number {
  return Math.ceil(Array.from(JSON.stringify(buildRequest(set, state))).length / 4);
}

/** A body whose whole request is exactly `target` tokens to the estimator, for this set. */
function bodyOf(set: QuestionSet, target: number): string {
  for (let length = 0; length < 20_000; length += 1) {
    const body = "x".repeat(length);
    if (estimated(set, { body }) === target) {
      return body;
    }
  }
  throw new Error(`no body reaches ${target} tokens`);
}

const NEVER_ASKED: SpendingGate = {
  allowsWork: () => Promise.reject(new Error("an estimate checks no cap")),
  admit: () => Promise.reject(new Error("an estimate asks nothing")),
  settle: () => Promise.reject(new Error("an estimate asks nothing")),
  record: () => Promise.reject(new Error("an estimate counts nothing")),
  finish: () => Promise.reject(new Error("an estimate counts nothing")),
};

type Rig = {
  readonly db: FakeDatabase;
  readonly connector: FakeConnector;
  readonly log: FakeDecisionLog;
  /** The hash of each record's present state, as the connector reads it. */
  hashOf(key: RecordKey): Promise<string>;
  /**
   * Logs a model call for `key`, answering `questions`, billed `inputTokens`. The call asked
   * `more.asked` (by default the questions it answers, a whole call); `"not said"` logs it as an
   * answer logged by an earlier version did, with no list of what was asked.
   */
  answer(
    key: RecordKey,
    questions: readonly Question[],
    inputTokens: number,
    more?: {
      readonly stateHash?: string;
      readonly asked?: readonly Question[] | "not said";
      readonly model?: string;
    },
  ): Promise<void>;
  /** Runs the backfill to its estimate, declines it, and returns the estimate shown. */
  estimate(set: QuestionSet, onlyQuestions?: readonly string[]): Promise<BackfillEstimate>;
  /**
   * Runs an added-question backfill of `onlyQuestions` to its end through the engine's own path
   * (`askAdded`), the model billing each request `bill(request)` input tokens, so every record's
   * latest answer is shaped exactly as that path logs it.
   */
  addedRun(
    set: QuestionSet,
    onlyQuestions: readonly string[],
    bill: (request: ProviderRequest) => number,
  ): Promise<void>;
};

const ADMIT_ALL: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

async function rig(body: string): Promise<Rig> {
  const db = new FakeDatabase({ fields: ["body"], pageSize: 4 });
  for (let n = 1; n <= RECORDS; n += 1) {
    db.edit(`k${n}`, { body });
  }
  const clock = new FakeClock();
  const connector = new FakeConnector(db);
  await connector.install();
  const log = new FakeDecisionLog();

  async function hashOf(key: RecordKey): Promise<string> {
    const { rows } = await connector.read([key]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no record ${key}`);
    }
    return row.hash;
  }

  return {
    db,
    connector,
    log,
    hashOf,
    async answer(key, questions, inputTokens, more = {}) {
      const asked = more.asked ?? questions;
      const entry: AnswerEntry = {
        kind: "answer",
        key,
        version: 1,
        model: more.model ?? "jev-1.14.0",
        stateHash: more.stateHash ?? (await hashOf(key)),
        answers: Object.fromEntries(
          questions.map((question) => [question.name, { type: "noul" as const, probability: 0.9 }]),
        ),
        usage:
          asked === "not said"
            ? { inputTokens, outputTokens: 5 }
            : { inputTokens, outputTokens: 5, asked: asked.map((question) => question.name) },
        at: new Date(clock.now()),
      };
      await log.appendAnswer(entry);
    },
    async addedRun(set, onlyQuestions, bill) {
      const backfill = createBackfill({
        project: "proj_market",
        source: "listings",
        connector,
        worker: {
          ask: (request) =>
            Promise.resolve({
              model: request.model,
              answers: Object.fromEntries(
                request.questions.map((question) => [
                  question.name,
                  { type: "noul" as const, probability: 0.9 },
                ]),
              ),
              usage: { inputTokens: bill(request), outputTokens: 5 },
            }),
        },
        clock,
        cursorStore: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
        log,
        reviews: reviewsOf(new FakeReviewQueue(), "listings"),
        questionSet: set,
        version: 1,
        heldModel: freshHeldModel(1),
        spending: ADMIT_ALL,
      });
      const report = await backfill.run({ onlyQuestions, onEstimate: () => true });
      expect(report.status).toBe("completed");
      expect(report.answered).toHaveLength(RECORDS);
    },
    async estimate(set, onlyQuestions) {
      const backfill = createBackfill({
        project: "proj_market",
        source: "listings",
        connector,
        worker: { ask: () => Promise.reject(new Error("an estimate asks the model nothing")) },
        clock,
        cursorStore: {
          load: () => Promise.resolve(undefined),
          save: () => Promise.reject(new Error("a declined estimate saves no place")),
        },
        log,
        reviews: reviewsOf(new FakeReviewQueue(), "listings"),
        questionSet: set,
        version: 1,
        heldModel: freshHeldModel(1),
        spending: NEVER_ASKED,
      });
      const shown: BackfillEstimate[] = [];
      const report = await backfill.run({
        ...(onlyQuestions === undefined ? {} : { onlyQuestions }),
        onEstimate: (estimate) => {
          shown.push(estimate);
          return false;
        },
      });
      expect(report.status).toBe("declined");
      expect(shown).toHaveLength(1);
      const [estimate] = shown;
      if (estimate === undefined) {
        throw new Error("the estimate was never shown");
      }
      return estimate;
    },
  };
}

const keys = Array.from({ length: RECORDS }, (_, n) => `k${n + 1}`);

describe("a backfill's estimate, calibrated from billed answers", () => {
  it("is scaled by 2.7 when the answers were billed 2.7 times what the estimator counts", async () => {
    const body = bodyOf(SCAM_AND_SPAM, 100);
    const r = await rig(body);
    for (const key of keys) {
      await r.answer(key, [scam, spam], 270);
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration?.records).toBe(RECORDS);
    expect(estimate.calibration?.scale).toBeCloseTo(2.7, 12);
    expect(estimate.records).toBe(RECORDS);
    expect(estimate.tokensPerRecord).toBeCloseTo(270, 9);
    expect(estimate.tokens).toBeCloseTo(2_700, 9);
    expect(estimate.dollars).toBeCloseTo((2_700 * 0.042) / 1_000_000, 15);
    // The same sample, unscaled, is the estimator's 100 a record.
    const unscaled = estimateBackfill(SCAM_AND_SPAM, {
      records: RECORDS,
      states: keys.map(() => ({ body })),
    });
    expect(unscaled.tokensPerRecord).toBe(100);
    expect(estimate.tokens / unscaled.tokens).toBeCloseTo(2.7, 12);
  });

  it("weighs every billed answer by its size: the billed sum over the estimator's sum", async () => {
    const short = bodyOf(SCAM_AND_SPAM, 100);
    const r = await rig(short);
    // Half the records are twice as long and were billed 4 times the estimator, the rest 2 times:
    // (5 × 200 × 4 + 5 × 100 × 2) / (5 × 200 + 5 × 100) = 5,000 / 1,500.
    const long = bodyOf(SCAM_AND_SPAM, 200);
    for (const [n, key] of keys.entries()) {
      if (n % 2 === 0) {
        r.db.edit(key, { body: long });
        await r.answer(key, [scam, spam], 800);
      } else {
        await r.answer(key, [scam, spam], 200);
      }
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration?.records).toBe(RECORDS);
    expect(estimate.calibration?.scale).toBeCloseTo(5_000 / 1_500, 12);
    expect(estimate.tokensPerRecord).toBeCloseTo(150 * (5_000 / 1_500), 9);
  });

  it("is left unscaled, and still calibrated, when the answers were billed below the estimator", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    for (const key of keys) {
      await r.answer(key, [scam, spam], 60);
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration).toEqual({ records: RECORDS, scale: 1 });
    expect(estimate.tokensPerRecord).toBe(100);
    expect(estimate.tokens).toBe(1_000);
  });

  it("is uncalibrated, the estimator's count alone, when no record was ever answered", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration).toBeNull();
    expect(estimate.tokensPerRecord).toBe(100);
    expect(estimate.tokens).toBe(1_000);
  });

  it("is uncalibrated when every answer was given at a state the record has since left", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    for (const key of keys) {
      await r.answer(key, [scam, spam], 270, { stateHash: "a-state-long-gone" });
    }

    expect((await r.estimate(SCAM_AND_SPAM)).calibration).toBeNull();
  });

  it("is uncalibrated when the provider billed the answers nothing", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    for (const key of keys) {
      await r.answer(key, [scam, spam], 0);
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration).toBeNull();
    expect(estimate.tokensPerRecord).toBe(100);
  });

  it("counts only the records with a billed answer at their present state", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    // Three billed at their state; two at an old state; the rest never answered.
    for (const key of keys.slice(0, 3)) {
      await r.answer(key, [scam, spam], 270);
    }
    for (const key of keys.slice(3, 5)) {
      await r.answer(key, [scam, spam], 1_000, { stateHash: "a-state-long-gone" });
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration?.records).toBe(3);
    expect(estimate.calibration?.scale).toBeCloseTo(2.7, 12);
    expect(estimate.tokensPerRecord).toBeCloseTo(270, 9);
  });

  it("leaves out an answer to a question the set no longer has: its words are not there to count", async () => {
    const r = await rig(bodyOf(SCAM_ONLY, 100));
    for (const key of keys) {
      await r.answer(key, [scam, spam], 5_000);
    }

    expect((await r.estimate(SCAM_ONLY)).calibration).toBeNull();
  });

  it("scales an added-question estimate by the same ratio", async () => {
    // The records were answered before spam was added: scam alone, billed 2.7 times the estimator.
    const body = bodyOf(SCAM_ONLY, 100);
    const r = await rig(body);
    for (const key of keys) {
      await r.answer(key, [scam], 270);
    }

    const added = await r.estimate(SCAM_AND_SPAM, ["spam"]);

    const spamOnly = estimated(setOf([spam]), { body });
    expect(added.calibration?.records).toBe(RECORDS);
    expect(added.calibration?.scale).toBeCloseTo(2.7, 12);
    expect(added.tokensPerRecord).toBeCloseTo(spamOnly * 2.7, 9);
    expect(added.tokens).toBeCloseTo(spamOnly * 2.7 * RECORDS, 9);
  });

  describe("over answers an added-question run logged, which hold every question's answer", () => {
    const SPAM_ONLY = setOf([spam]);
    // spam alone is 60 tokens to the estimator; the call that asked it was billed 2.7 times that.
    const body = bodyOf(SPAM_ONLY, 60);
    const whole = estimated(SCAM_AND_SPAM, { body });

    /** {scam} answered at every record, spam added and backfilled alone: askAdded's own entries. */
    async function afterAddedRun(): Promise<Rig> {
      const r = await rig(body);
      for (const key of keys) {
        await r.answer(key, [scam], 1_000);
      }
      await r.addedRun(SCAM_AND_SPAM, ["spam"], () => 162);
      return r;
    }

    it("logs what the call asked beside what it was billed: the added question alone", async () => {
      const r = await afterAddedRun();

      for (const key of keys) {
        const entry = await r.log.latestAnswer(key);
        expect(Object.keys(entry?.answers ?? {}).sort()).toEqual(["scam", "spam"]);
        expect(entry?.usage).toEqual({ inputTokens: 162, outputTokens: 5, asked: ["spam"] });
      }
    });

    it("scales by the true ratio, the bill over the asked question's count: 2.7", async () => {
      const r = await afterAddedRun();

      const estimate = await r.estimate(SCAM_AND_SPAM);

      expect(estimate.calibration?.records).toBe(RECORDS);
      expect(estimate.calibration?.scale).toBeCloseTo(2.7, 12);
      expect(estimate.tokensPerRecord).toBeCloseTo(whole * 2.7, 9);
    });

    it("never says about below the billed rate for such an answer logged by an earlier version: it is left out", async () => {
      const r = await afterAddedRun();
      // The same entries as askAdded wrote them before the call's questions were logged.
      for (const key of keys) {
        const entry = await r.log.latestAnswer(key);
        if (entry === undefined) {
          throw new Error(`${key} was answered`);
        }
        const { asked: _asked, ...billed } = entry.usage;
        await r.log.appendAnswer({ ...entry, usage: billed });
      }
      // Set against every question it holds, the bill reads 162 over the whole set's count, a
      // ratio well under 2.7: an "about" there would be the incident again.
      expect(162 / whole).toBeLessThan(2.7);

      const estimate = await r.estimate(SCAM_AND_SPAM);

      expect(estimate.calibration).toBeNull();
      expect(estimate.tokensPerRecord).toBe(whole);
    });
  });

  it("counts only answers from the set's present model", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    // Half answered by another version, billed far more by its own count; half by the set's.
    for (const [n, key] of keys.entries()) {
      await r.answer(
        key,
        [scam, spam],
        n % 2 === 0 ? 900 : 270,
        n % 2 === 0 ? { model: "jev-1.13.0" } : {},
      );
    }

    const estimate = await r.estimate(SCAM_AND_SPAM);

    expect(estimate.calibration?.records).toBe(RECORDS / 2);
    expect(estimate.calibration?.scale).toBeCloseTo(2.7, 12);
  });

  it("is uncalibrated when every answer came from another model", async () => {
    const r = await rig(bodyOf(SCAM_AND_SPAM, 100));
    for (const key of keys) {
      await r.answer(key, [scam, spam], 270, { model: "jev-1.13.0" });
    }

    expect((await r.estimate(SCAM_AND_SPAM)).calibration).toBeNull();
  });
});
