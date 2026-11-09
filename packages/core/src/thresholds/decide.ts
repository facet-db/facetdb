import type { ChoiceQuestion, Question, ScoreQuestion } from "../questions/index.ts";
import { choiceConfidence } from "./confidence.ts";
import type {
  Answer,
  ChoiceAnswer,
  ConfidenceThresholds,
  Decision,
  NoulAnswer,
  ScoreAnswer,
  Thresholds,
  YesNoThresholds,
} from "./types.ts";

/**
 * Turns one answer into a decision, or into needs review. Every comparison is inclusive: a noul
 * is yes at or above `yesAbove`, no at or below `noBelow`; a choice or score decides at or above
 * `confidenceAtLeast`.
 * The thresholds and the answer must match the question's type; a mismatch is a caller bug.
 */
export function decide(question: Question, thresholds: Thresholds, answer: Answer): Decision {
  switch (question.type) {
    case "noul":
      if (answer.type !== "noul" || thresholds.kind !== "yes-no") {
        throw mismatch(question.type, thresholds, answer);
      }
      return decideNoul(thresholds, answer);
    case "choice":
      if (answer.type !== "choice" || thresholds.kind !== "confidence") {
        throw mismatch(question.type, thresholds, answer);
      }
      return decideChoice(question, thresholds, answer);
    case "score":
      if (answer.type !== "score" || thresholds.kind !== "confidence") {
        throw mismatch(question.type, thresholds, answer);
      }
      return decideScore(question, thresholds, answer);
  }
}

function decideNoul(thresholds: YesNoThresholds, answer: NoulAnswer): Decision {
  if (answer.probability >= thresholds.yesAbove) {
    return { kind: "decided", value: true, probabilityOrConfidence: answer.probability };
  }
  if (answer.probability <= thresholds.noBelow) {
    return { kind: "decided", value: false, probabilityOrConfidence: answer.probability };
  }
  return { kind: "needs_review" };
}

function decideChoice(
  question: ChoiceQuestion,
  thresholds: ConfidenceThresholds,
  answer: ChoiceAnswer,
): Decision {
  const confidence = choiceConfidence(answer.probabilities);
  const option = question.options[topIndex(answer.probabilities)];
  if (option === undefined) {
    throw new Error(`choice "${question.name}" has no option for its probabilities`);
  }
  if (confidence >= thresholds.confidenceAtLeast) {
    return { kind: "decided", value: option.name, probabilityOrConfidence: confidence };
  }
  return { kind: "needs_review" };
}

function decideScore(
  question: ScoreQuestion,
  thresholds: ConfidenceThresholds,
  answer: ScoreAnswer,
): Decision {
  const level = question.levels[topIndex(answer.probabilities)];
  if (level === undefined) {
    throw new Error(`score "${question.name}" has no level for its probabilities`);
  }
  if (answer.confidence >= thresholds.confidenceAtLeast) {
    return {
      kind: "decided",
      value: level.name,
      probabilityOrConfidence: answer.confidence,
      expected: answer.expected,
    };
  }
  return { kind: "needs_review" };
}

/** The most likely level: the first one when two share the highest probability, as Jev leans to the first. */
function topIndex(probabilities: readonly number[]): number {
  return probabilities.indexOf(Math.max(...probabilities));
}

function mismatch(type: Question["type"], thresholds: Thresholds, answer: Answer): Error {
  return new Error(
    `a ${type} question needs ${type} answers and ${type === "noul" ? "yes-no" : "confidence"} thresholds; got a ${answer.type} answer and ${thresholds.kind} thresholds`,
  );
}
