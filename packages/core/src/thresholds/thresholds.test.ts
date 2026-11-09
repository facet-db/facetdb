import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseQuestionSet, type Question } from "../questions/index.ts";
import {
  choiceConfidence,
  decide,
  defaultThresholds,
  resolveThresholds,
  type Thresholds,
} from "./index.ts";

// One case per row of the thresholds table, plus the choice confidence formula.
const noul = (stakes: "low" | "high" = "low"): Question => ({
  type: "noul",
  name: "wants_refund",
  instructions: "Is the customer asking for their money back?",
  stakes,
});

const choice = (count: number, stakes: "low" | "high" = "low"): Question => ({
  type: "choice",
  name: "team",
  instructions: "Which team?",
  options: Array.from({ length: count }, (_, i) => ({
    name: `option_${i}`,
    description: `Option ${i}`,
  })),
  stakes,
  storeProbabilities: false,
});

const score = (stakes: "low" | "high" = "low"): Question => ({
  type: "score",
  name: "urgency",
  instructions: "How urgent?",
  levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
  stakes,
});

const yesNo = (yesAbove: number, noBelow: number): Thresholds => ({
  kind: "yes-no",
  yesAbove,
  noBelow,
});

const confidence = (confidenceAtLeast: number): Thresholds => ({
  kind: "confidence",
  confidenceAtLeast,
});

describe("default thresholds by stakes", () => {
  it("gives noul 0.70 and 0.30 at low stakes, 0.90 and 0.10 at high", () => {
    expect(defaultThresholds("noul", "low")).toEqual(yesNo(0.7, 0.3));
    expect(defaultThresholds("noul", "high")).toEqual(yesNo(0.9, 0.1));
  });

  it("gives choice and score a confidence of 0.50 at low stakes and 0.75 at high", () => {
    expect(defaultThresholds("choice", "low")).toEqual(confidence(0.5));
    expect(defaultThresholds("score", "low")).toEqual(confidence(0.5));
    expect(defaultThresholds("choice", "high")).toEqual(confidence(0.75));
    expect(defaultThresholds("score", "high")).toEqual(confidence(0.75));
  });

  it("applies a per-question override key by key over the stakes default", () => {
    expect(resolveThresholds(noul("high"), { noBelow: 0.05 })).toEqual(yesNo(0.9, 0.05));
    expect(resolveThresholds(score(), { confidenceAtLeast: 0.6 })).toEqual(confidence(0.6));
    expect(resolveThresholds(noul(), undefined)).toEqual(yesNo(0.7, 0.3));
  });

  it("keeps an override of zero rather than falling back to the default", () => {
    expect(resolveThresholds(noul(), { noBelow: 0 })).toEqual(yesNo(0.7, 0));
  });
});

describe("choice confidence", () => {
  it("is 0 for an even split and 1 for certainty", () => {
    expect(choiceConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 12);
    expect(choiceConfidence([1, 0, 0])).toBe(1);
  });

  it("gives 0.50 for two options when the top holds 75%", () => {
    expect(choiceConfidence([0.75, 0.25])).toBe(0.5);
  });

  it("gives about 0.50 for forty options when the top holds about 51%", () => {
    const fortyTop = 1 / 40 + 0.5 * (1 - 1 / 40);
    const rest = (1 - fortyTop) / 39;
    const probabilities = [fortyTop, ...Array.from({ length: 39 }, () => rest)];
    expect(choiceConfidence(probabilities)).toBeCloseTo(0.5, 12);
    expect(fortyTop).toBeCloseTo(0.5125, 4);
  });
});

describe("noul decisions", () => {
  const low = defaultThresholds("noul", "low");

  it.each([
    [1, true],
    [0.9, true],
    [0.7, true], // exactly yesAbove: yes
    [0.69999, null],
    [0.5, null],
    [0.3, false], // exactly noBelow: no
    [0.30001, null],
    [0, false],
  ] as const)("probability %s decides %s at low stakes", (probability, value) => {
    const decision = decide(noul(), low, { type: "noul", probability });
    if (value === null) {
      expect(decision).toEqual({ kind: "needs_review" });
    } else {
      expect(decision).toEqual({ kind: "decided", value, probabilityOrConfidence: probability });
    }
  });

  it("uses the high-stakes pair when the question is high stakes", () => {
    const high = defaultThresholds("noul", "high");
    expect(decide(noul("high"), high, { type: "noul", probability: 0.85 })).toEqual({
      kind: "needs_review",
    });
    expect(decide(noul("high"), high, { type: "noul", probability: 0.9 })).toMatchObject({
      kind: "decided",
      value: true,
    });
    expect(decide(noul("high"), high, { type: "noul", probability: 0.1 })).toMatchObject({
      kind: "decided",
      value: false,
    });
  });

  it("is needs review for a noul whose probability sits between the two thresholds", () => {
    expect(decide(noul(), low, { type: "noul", probability: 0.5 })).toEqual({
      kind: "needs_review",
    });
  });
});

describe("choice decisions", () => {
  it("decides the top option when confidence is exactly at the threshold", () => {
    const decision = decide(choice(2), confidence(0.5), {
      type: "choice",
      probabilities: [0.75, 0.25],
    });
    expect(decision).toEqual({ kind: "decided", value: "option_0", probabilityOrConfidence: 0.5 });
  });

  it("needs review when confidence sits just under the threshold", () => {
    const decision = decide(choice(2), confidence(0.5), {
      type: "choice",
      probabilities: [0.7, 0.3],
    });
    expect(decision).toEqual({ kind: "needs_review" });
  });

  it("uses the high-stakes 0.75 for a choice", () => {
    const high = defaultThresholds("choice", "high");
    expect(
      decide(choice(2, "high"), high, { type: "choice", probabilities: [0.875, 0.125] }),
    ).toMatchObject({ kind: "decided", value: "option_0" });
    // Confidence 0.6 at 0.8 versus 0.2: below 0.75, so it is not decided at high stakes.
    expect(decide(choice(2, "high"), high, { type: "choice", probabilities: [0.8, 0.2] })).toEqual({
      kind: "needs_review",
    });
    expect(decide(choice(2, "high"), high, { type: "choice", probabilities: [0.7, 0.3] })).toEqual({
      kind: "needs_review",
    });
  });

  it("gives the first option on a tie, as Jev leans to the first option listed", () => {
    const decision = decide(choice(3), confidence(0), {
      type: "choice",
      probabilities: [0.4, 0.4, 0.2],
    });
    expect(decision).toMatchObject({ kind: "decided", value: "option_0" });
  });

  it("means different things for different list sizes: 0.50 is 75% for two and about 51% for forty", () => {
    const forty = choice(40);
    const fortyTop = 1 / 40 + 0.52 * (1 - 1 / 40);
    const rest = (1 - fortyTop) / 39;
    const probabilities = [fortyTop, ...Array.from({ length: 39 }, () => rest)];
    expect(decide(forty, confidence(0.5), { type: "choice", probabilities })).toMatchObject({
      kind: "decided",
    });
    const below = [0.5, ...Array.from({ length: 39 }, () => 0.5 / 39)];
    expect(decide(forty, confidence(0.5), { type: "choice", probabilities: below })).toEqual({
      kind: "needs_review",
    });
  });
});

describe("score decisions", () => {
  const low = defaultThresholds("score", "low");

  it("decides the most likely level at the threshold, passing through the model's expected level", () => {
    const decision = decide(score(), low, {
      type: "score",
      probabilities: [0.1, 0.2, 0.7],
      confidence: 0.5,
      expected: 2.6,
    });
    expect(decision).toEqual({
      kind: "decided",
      value: "high",
      probabilityOrConfidence: 0.5,
      expected: 2.6,
    });
  });

  it("needs review when the score's confidence is below the threshold", () => {
    expect(
      decide(score(), low, {
        type: "score",
        probabilities: [0.3, 0.4, 0.3],
        confidence: 0.49,
        expected: 2,
      }),
    ).toEqual({ kind: "needs_review" });
  });

  it("uses 0.75 at high stakes", () => {
    const high = defaultThresholds("score", "high");
    expect(
      decide(score("high"), high, {
        type: "score",
        probabilities: [0, 0, 1],
        confidence: 0.75,
        expected: 3,
      }),
    ).toMatchObject({ kind: "decided", value: "high" });
    expect(
      decide(score("high"), high, {
        type: "score",
        probabilities: [0, 0, 1],
        confidence: 0.74,
        expected: 3,
      }),
    ).toEqual({ kind: "needs_review" });
  });
});

describe("the decision rule's properties (fast-check prints a seed on failure)", () => {
  it("for every probability, a noul is yes, no or needs review, never two of them, at both stakes", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("low", "high" as const),
        (probability, stakes) => {
          const thresholds = defaultThresholds("noul", stakes);
          if (thresholds.kind !== "yes-no") {
            throw new Error("a noul takes yes-no thresholds");
          }
          const yes = probability >= thresholds.yesAbove;
          const no = probability <= thresholds.noBelow;
          expect(yes && no).toBe(false);
          const decision = decide(noul(stakes), thresholds, { type: "noul", probability });
          if (yes) {
            expect(decision).toMatchObject({ kind: "decided", value: true });
          } else if (no) {
            expect(decision).toMatchObject({ kind: "decided", value: false });
          } else {
            expect(decision).toEqual({ kind: "needs_review" });
          }
        },
      ),
    );
  });

  it("for every confidence, a score is decided exactly when confidence is at or above the threshold", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("low", "high" as const),
        (conf, stakes) => {
          const thresholds = defaultThresholds("score", stakes);
          const decision = decide(score(stakes), thresholds, {
            type: "score",
            probabilities: [0.2, 0.3, 0.5],
            confidence: conf,
            expected: 2.3,
          });
          const threshold = thresholds.kind === "confidence" ? thresholds.confidenceAtLeast : 0;
          expect(decision.kind === "decided").toBe(conf >= threshold);
        },
      ),
    );
  });

  it("for every two-option probability, a choice is decided exactly when its confidence is at or above the threshold", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("low", "high" as const),
        (p, stakes) => {
          const probabilities = [p, 1 - p];
          const thresholds = defaultThresholds("choice", stakes);
          const decision = decide(choice(2, stakes), thresholds, { type: "choice", probabilities });
          const conf = choiceConfidence(probabilities);
          const threshold = thresholds.kind === "confidence" ? thresholds.confidenceAtLeast : 0;
          expect(decision.kind === "decided").toBe(conf >= threshold);
        },
      ),
    );
  });
});

describe("threshold overrides at the config boundary", () => {
  const set = (thresholds: Record<string, unknown>, questions: unknown[] = [noulInput()]) =>
    parseQuestionSet({ model: "jev-1.14.0", read: ["body"], questions, thresholds });

  it("accepts a noul pair that keeps noBelow lower than yesAbove, including a single override", () => {
    expect(set({ wants_refund: { yesAbove: 0.8, noBelow: 0.2 } }).ok).toBe(true);
    expect(set({ wants_refund: { yesAbove: 0.2 } }).ok).toBe(false);
  });

  it("refuses noBelow not below yesAbove, checked against the stakes default for the missing key", () => {
    const result = set({ wants_refund: { noBelow: 0.95 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "thresholds.wants_refund: noBelow (0.95) must be lower than yesAbove (0.7)",
      ]);
    }
  });

  it("refuses a value outside [0, 1]", () => {
    expect(set({ wants_refund: { yesAbove: 1.2 } }).ok).toBe(false);
    expect(set({ wants_refund: { noBelow: -0.1 } }).ok).toBe(false);
  });

  it("refuses a threshold that names no question, so a typo cannot keep the defaults silently", () => {
    const result = set({ wants_refunds: { yesAbove: 0.9 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(
        /^thresholds\.wants_refunds: no question is named "wants_refunds"; thresholds are keyed by question name \(.*wants_refund.*\)$/,
      );
    }
  });

  it("refuses a key that does not belong to the question's type", () => {
    const scoreInput = {
      type: "score",
      name: "urgency",
      instructions: "How urgent?",
      levels: [{ name: "low" }, { name: "high" }],
    };
    expect(set({ urgency: { yesAbove: 0.9 } }, [scoreInput]).ok).toBe(false);
    expect(set({ wants_refund: { confidenceAtLeast: 0.6 } }).ok).toBe(false);
    expect(set({ urgency: { confidenceAtLeast: 0.6 } }, [scoreInput]).ok).toBe(true);
  });
});

function noulInput(): Record<string, unknown> {
  return {
    type: "noul",
    name: "wants_refund",
    instructions: "Is the customer asking for their money back?",
  };
}
