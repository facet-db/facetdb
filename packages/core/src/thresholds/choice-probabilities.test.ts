import { FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordDecision, WriteResult } from "../contracts/index.ts";
import {
  type AnswerEntry,
  applyHumanDecision,
  type HumanEntry,
  humanDecision,
  parseLoggedAnswers,
  type ReviewedRecord,
  reapplyThresholds,
  recordAnswer,
  WITHDRAWN,
  withOptionNames,
} from "../log/index.ts";
import type { ChoiceQuestion, QuestionSet } from "../questions/index.ts";
import { type ChoiceAnswer, decide, probabilitiesByName, resolveThresholds } from "./index.ts";

/**
 * A decided choice carries its option probabilities, keyed by option name in the question's present
 * option order, whenever the question sets `storeProbabilities` and the answer can be tied to the
 * present options by name: decided by the thresholds, decided by a person (the model's numbers
 * kept, as its confidence is), re-applied from the log. None in review, and none for an answer
 * whose options are not the present ones, so the column is NULL there and no write fails over it.
 */

const stored: ChoiceQuestion = {
  type: "choice",
  name: "team",
  instructions: "Which team owns this?",
  options: [
    { name: "billing", description: "Money questions" },
    { name: "tech", description: "Technical questions" },
    { name: "sales", description: "Buying questions" },
  ],
  stakes: "low",
  storeProbabilities: true,
};
const unstored: ChoiceQuestion = { ...stored, storeProbabilities: false };
const NAMES = ["billing", "tech", "sales"];

// Confidence (0.8 - 1/3) / (1 - 1/3) = 0.7: decided at the low-stakes 0.50.
const sure: ChoiceAnswer = {
  type: "choice",
  top: "billing",
  probabilities: [0.8, 0.15, 0.05],
  options: NAMES,
};
const SURE = { billing: 0.8, tech: 0.15, sales: 0.05 };
// Confidence (0.4 - 1/3) / (1 - 1/3) = 0.1: in review at 0.50.
const unsure: ChoiceAnswer = {
  type: "choice",
  top: "tech",
  probabilities: [0.3, 0.4, 0.3],
  options: NAMES,
};
const UNSURE = { billing: 0.3, tech: 0.4, sales: 0.3 };

const at = (question: ChoiceQuestion) => resolveThresholds(question, undefined);

function setOf(question: ChoiceQuestion): QuestionSet {
  return { questions: [question], read: ["body"], model: "jev-1.14.0", thresholds: {} };
}

function answerEntry(answer: ChoiceAnswer, key = "r1", version = 1): AnswerEntry {
  return {
    kind: "answer",
    key,
    version,
    model: "jev-1.14.0",
    stateHash: "h1",
    answers: { team: answer },
    usage: { inputTokens: 100, outputTokens: 10 },
    at: new Date("2026-11-19T10:00:00Z"),
  };
}

function humanEntry(value: HumanEntry["value"]): HumanEntry {
  return {
    kind: "human",
    key: "r1",
    question: "team",
    value,
    reviewer: "amara",
    stateHash: "h1",
    version: 1,
    at: new Date("2026-11-19T11:00:00Z"),
  };
}

/** A connector's write that keeps every decision it was given and lands while the hash is h1. */
function writer() {
  const writes: { key: string; decision: RecordDecision }[] = [];
  const write = (key: string, decision: RecordDecision, hash: string): Promise<WriteResult> => {
    writes.push({ key, decision });
    return Promise.resolve({ written: hash === "h1" });
  };
  return { write, writes, decisions: () => writes.map((w) => w.decision) };
}

describe("a choice that stores its probabilities carries them on its decision", () => {
  it("decided by the thresholds: the model's numbers keyed by option, beside the confidence", () => {
    expect(decide(stored, at(stored), sure)).toEqual({
      kind: "decided",
      value: "billing",
      probabilityOrConfidence: expect.closeTo(0.7, 10),
      probabilities: SURE,
    });
  });

  it("in review: none, as there is no confidence", () => {
    expect(decide(stored, at(stored), unsure)).toEqual({ kind: "needs_review" });
  });

  it("decided by a person: the model's numbers kept, whatever option the person chose", () => {
    expect(humanDecision(stored, "sales", unsure)).toEqual({
      kind: "decided",
      value: "sales",
      probabilityOrConfidence: expect.closeTo(0.1, 10),
      probabilities: UNSURE,
    });
  });

  it("a choice that does not store them carries none, decided either way", () => {
    expect(decide(unstored, at(unstored), sure)).not.toHaveProperty("probabilities");
    expect(humanDecision(unstored, "sales", unsure)).not.toHaveProperty("probabilities");
  });
});

describe("every write path carries them from the log", () => {
  it("the worker's write of an answer", async () => {
    const { write, decisions } = writer();
    await recordAnswer(answerEntry(sure), setOf(stored), new FakeDecisionLog(), write);
    expect(decisions()[0]?.decisions["team"]).toMatchObject({ probabilities: SURE });
  });

  it("a re-apply after a threshold change: the logged numbers, no model call", async () => {
    const log = new FakeDecisionLog();
    const { write, decisions } = writer();
    await recordAnswer(answerEntry(unsure), setOf(stored), log, write);
    expect(decisions()[0]?.decisions["team"]).toEqual({ kind: "needs_review" });

    await reapplyThresholds(setOf(stored), { team: { confidenceAtLeast: 0.05 } }, log, write, 1);

    expect(decisions()[1]?.decisions["team"]).toMatchObject({
      kind: "decided",
      value: "tech",
      probabilities: UNSURE,
    });
  });

  it("a person's decision on the review screen, and its undo back to review", async () => {
    const log = new FakeDecisionLog();
    const { write, decisions } = writer();
    const card: ReviewedRecord = {
      key: "r1",
      hash: "h1",
      status: "needs_review",
      questions: [stored],
      decisions: { team: { kind: "needs_review" } },
      answers: { team: unsure },
    };
    await log.appendAnswer(answerEntry(unsure));

    await applyHumanDecision(humanEntry("sales"), card, log, write);
    expect(decisions().at(-1)?.decisions["team"]).toMatchObject({
      value: "sales",
      probabilities: UNSURE,
    });

    await applyHumanDecision(humanEntry(WITHDRAWN), { ...card, status: "done" }, log, write);
    expect(decisions().at(-1)?.decisions["team"]).toEqual({ kind: "needs_review" });
  });

  it("a person's standing decision laid over a new answer at the same state keeps that answer's numbers", async () => {
    const log = new FakeDecisionLog();
    const { write, decisions } = writer();
    await log.appendAnswer(answerEntry(unsure));
    await log.appendHuman(humanEntry("sales"));

    await recordAnswer(answerEntry(sure), setOf(stored), log, write);

    expect(decisions()[0]?.decisions["team"]).toMatchObject({
      value: "sales",
      probabilities: SURE,
    });
  });
});

describe("probabilitiesByName ties an answer to the present options by name", () => {
  it("options reordered since the answer: each option keeps its own number, in the present order", () => {
    const reordered: ChoiceQuestion = {
      ...stored,
      options: [...stored.options].reverse(),
    };
    const tied = probabilitiesByName(reordered, sure);
    expect(tied).toEqual(SURE);
    expect(Object.keys(tied ?? {})).toEqual(["sales", "tech", "billing"]);
  });

  it("an option added, removed or renamed since, or no names at all: nothing, so NULL", () => {
    const added: ChoiceQuestion = {
      ...stored,
      options: [...stored.options, { name: "legal", description: "Contracts" }],
    };
    const removed: ChoiceQuestion = { ...stored, options: stored.options.slice(0, 2) };
    const renamed: ChoiceQuestion = {
      ...stored,
      options: stored.options.map((option) =>
        option.name === "sales" ? { ...option, name: "sales_emea" } : option,
      ),
    };
    const { options: _names, ...nameless } = sure;
    expect(probabilitiesByName(added, sure)).toBeUndefined();
    expect(probabilitiesByName(removed, sure)).toBeUndefined();
    expect(probabilitiesByName(renamed, sure)).toBeUndefined();
    expect(probabilitiesByName(stored, nameless)).toBeUndefined();
    expect(probabilitiesByName(stored, { ...sure, options: ["billing", "billing", "tech"] })).toBe(
      undefined,
    );
  });

  it("names every option as written, quotes, dots, unicode and __proto__ included", () => {
    const names = [`O'Brien "ops"`, "sales.emea", "équipe ✓", "__proto__"];
    const named: ChoiceQuestion = {
      ...stored,
      options: names.map((name) => ({ name, description: name })),
    };
    const answer: ChoiceAnswer = {
      type: "choice",
      top: names[0] ?? "",
      probabilities: [0.4, 0.3, 0.2, 0.1],
      options: names,
    };
    const keyed = probabilitiesByName(named, answer);
    expect(Object.keys(keyed ?? {})).toEqual(names);
    expect(JSON.parse(JSON.stringify(keyed))).toEqual(
      Object.fromEntries(names.map((name, index) => [name, [0.4, 0.3, 0.2, 0.1][index]])),
    );
  });
});

describe("an answer logged by an earlier version, without option names", () => {
  const { options: _names, ...old } = sure;

  it("is given the present names at the version in force, and only there", () => {
    expect(withOptionNames(answerEntry(old, "r1", 2), setOf(stored), 2).answers["team"]).toEqual(
      sure,
    );
    const older = answerEntry(old, "r1", 1);
    expect(withOptionNames(older, setOf(stored), 2)).toBe(older);
  });

  it("is not named when its entry only kept it from an earlier call (an added-question run)", () => {
    const merged: AnswerEntry = {
      ...answerEntry(old, "r1", 2),
      usage: { inputTokens: 10, outputTokens: 1, asked: ["vehicle"] },
    };
    expect(withOptionNames(merged, setOf(stored), 2)).toBe(merged);
  });

  it("reads back from a log row as it was logged; a row whose two lists disagree is refused", () => {
    expect(parseLoggedAnswers({ team: old }, "row")).toEqual({ team: old });
    expect(parseLoggedAnswers({ team: sure }, "row")).toEqual({ team: sure });
    expect(() =>
      parseLoggedAnswers({ team: { ...sure, options: ["billing", "tech"] } }, "row"),
    ).toThrow(/row: the logged answers at team are not answers/);
  });
});

describe("re-apply over answers logged before the options changed", () => {
  it("finishes, writing by name where it can and NULL where it cannot", async () => {
    // In force, version 2: an option added (legal) and the order changed since version 1.
    const now: ChoiceQuestion = {
      ...stored,
      options: [
        { name: "sales", description: "Buying questions" },
        { name: "billing", description: "Money questions" },
        { name: "tech", description: "Technical questions" },
        { name: "legal", description: "Contracts" },
      ],
    };
    const { options: _names, ...nameless } = unsure;
    const log = new FakeDecisionLog();
    // r1 named under the three options of version 1; r2 nameless at version 1; r3 nameless at
    // version 2 (its order is the present one); r4 named under the present four, reordered.
    await log.appendAnswer(answerEntry(unsure, "r1", 1));
    await log.appendAnswer(answerEntry(nameless, "r2", 1));
    await log.appendAnswer(
      answerEntry({ type: "choice", top: "sales", probabilities: [0.4, 0.3, 0.2, 0.1] }, "r3", 2),
    );
    await log.appendAnswer(
      answerEntry(
        {
          type: "choice",
          top: "sales",
          probabilities: [0.1, 0.2, 0.3, 0.4],
          options: ["legal", "tech", "billing", "sales"],
        },
        "r4",
        2,
      ),
    );
    const { write, writes } = writer();

    const report = await reapplyThresholds(
      setOf(now),
      { team: { confidenceAtLeast: 0.01 } },
      log,
      write,
      2,
    );

    expect([...report.written].sort()).toEqual(["r1", "r2", "r3", "r4"]);
    const team = (key: string) =>
      writes.find((write) => write.key === key)?.decision.decisions["team"];
    expect(team("r1")).not.toHaveProperty("probabilities");
    expect(team("r2")).not.toHaveProperty("probabilities");
    expect(team("r3")).toMatchObject({
      probabilities: { sales: 0.4, billing: 0.3, tech: 0.2, legal: 0.1 },
    });
    expect(team("r4")).toMatchObject({
      probabilities: { sales: 0.4, billing: 0.3, tech: 0.2, legal: 0.1 },
    });
  });
});
