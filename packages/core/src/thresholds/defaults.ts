import type { Question, QuestionType, Stakes } from "../questions/index.ts";
import type { ThresholdOverride, Thresholds } from "./types.ts";

// TypeSafe's starting points at low stakes; stricter values where a wrong automatic answer
// removes, hides, rejects or charges.
const NOUL_LOW = { yesAbove: 0.7, noBelow: 0.3 } as const; // noul, low stakes
const NOUL_HIGH = { yesAbove: 0.9, noBelow: 0.1 } as const; // noul, high stakes
const CONFIDENCE_LOW = 0.5; // choice and score, low stakes
const CONFIDENCE_HIGH = 0.75; // choice and score, high stakes

/** The stakes defaults for a question type. */
export function defaultThresholds(type: QuestionType, stakes: Stakes): Thresholds {
  if (type === "noul") {
    const pair = stakes === "high" ? NOUL_HIGH : NOUL_LOW;
    return { kind: "yes-no", yesAbove: pair.yesAbove, noBelow: pair.noBelow };
  }
  return {
    kind: "confidence",
    confidenceAtLeast: stakes === "high" ? CONFIDENCE_HIGH : CONFIDENCE_LOW,
  };
}

/**
 * A question's thresholds: its stakes defaults with the config override applied key by key. The
 * override is trusted here; the question-set schema has already refused keys the type does not take.
 */
export function resolveThresholds(
  question: Question,
  override: ThresholdOverride | undefined,
): Thresholds {
  const base = defaultThresholds(question.type, question.stakes);
  if (base.kind === "yes-no") {
    return {
      kind: "yes-no",
      yesAbove: override?.yesAbove ?? base.yesAbove,
      noBelow: override?.noBelow ?? base.noBelow,
    };
  }
  return {
    kind: "confidence",
    confidenceAtLeast: override?.confidenceAtLeast ?? base.confidenceAtLeast,
  };
}
