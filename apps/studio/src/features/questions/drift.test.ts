import { describe, expect, it } from "vitest";
// Core's own rule, read from its source for this test alone: the studio does not depend on
// @facetdb/core (it ships no Node code), so the page keeps a copy, and this test holds the copy to
// the original at every boundary.
import { parseQuestionSet } from "../../../../../packages/core/src/questions/index.ts";
import { decide, resolveThresholds } from "../../../../../packages/core/src/thresholds/index.ts";
import type { PreviewAnswer, QuestionJson, ThresholdOverride } from "../../api/index.ts";
import { decidedWords, figureOf } from "./answers.ts";
import { crossed } from "./cuts.ts";
import { formOf, thresholdsOf } from "./draft.ts";

/**
 * The drift test: the page re-decides the preview's answers under the thresholds on screen with a
 * copy of packages/core's decide, resolveThresholds and confidence formula. For each kind, at both
 * stakes, with and without an override, at each cut and just above and below it, the page's copy
 * and core's own must give the same decision.
 */

type CoreQuestion = Parameters<typeof decide>[0];

const EPSILON = 0.001;

const OPTIONS = [
  { name: "electronics", description: "phones" },
  { name: "furniture", description: "tables" },
  { name: "other", description: "anything else" },
];
const LEVELS = [{ name: "low" }, { name: "medium" }, { name: "high" }];

function questionJson(type: QuestionJson["type"], stakes: "low" | "high"): QuestionJson {
  switch (type) {
    case "noul":
      return { type, instructions: "Is it a scam?", stakes };
    case "choice":
      return {
        type,
        instructions: "Which category?",
        options: OPTIONS,
        stakes,
        storeProbabilities: false,
      };
    case "score":
      return { type, instructions: "How urgent?", levels: LEVELS, stakes };
  }
}

function coreQuestion(type: QuestionJson["type"], stakes: "low" | "high"): CoreQuestion {
  switch (type) {
    case "noul":
      return { type, name: "q", instructions: "Is it a scam?", stakes };
    case "choice":
      return {
        type,
        name: "q",
        instructions: "Which category?",
        options: OPTIONS,
        stakes,
        storeProbabilities: false,
      };
    case "score":
      return { type, name: "q", instructions: "How urgent?", levels: LEVELS, stakes };
  }
}

/** An answer whose figure (probability or confidence) is `figure`. */
function answerAt(type: QuestionJson["type"], figure: number): PreviewAnswer {
  switch (type) {
    case "noul":
      return { type, probability: figure };
    case "choice": {
      // confidence = (p - 1/3) / (1 - 1/3), so p = figure * 2/3 + 1/3; the rest share what is left.
      const top = figure * (2 / 3) + 1 / 3;
      return { type, top: "electronics", probabilities: [top, (1 - top) / 2, (1 - top) / 2] };
    }
    case "score":
      return { type, probabilities: [0.1, 0.2, 0.7], confidence: figure };
  }
}

function coreWords(question: CoreQuestion, override: ThresholdOverride, answer: PreviewAnswer) {
  const coreAnswer = answer.type === "score" ? { ...answer, expected: 2.6 } : answer;
  const decision = decide(question, resolveThresholds(question, override), coreAnswer);
  if (decision.kind === "needs_review") {
    return null;
  }
  return typeof decision.value === "boolean" ? (decision.value ? "yes" : "no") : decision.value;
}

const OVERRIDES: Record<QuestionJson["type"], readonly ThresholdOverride[]> = {
  noul: [{}, { yesAbove: 0.8 }, { noBelow: 0.2 }, { yesAbove: 0.6, noBelow: 0.4 }],
  choice: [{}, { confidenceAtLeast: 0.6 }],
  score: [{}, { confidenceAtLeast: 0.35 }],
};

describe("the page's threshold rule against packages/core's", () => {
  for (const type of ["noul", "choice", "score"] as const) {
    for (const stakes of ["low", "high"] as const) {
      for (const override of OVERRIDES[type]) {
        it(`${type}, ${stakes} stakes, override ${JSON.stringify(override)}`, () => {
          const [form] = formOf({
            name: "s",
            read: ["title"],
            questions: { q: questionJson(type, stakes) },
            thresholds: Object.keys(override).length === 0 ? {} : { q: override },
          }).questions;
          if (form === undefined) {
            throw new Error("the form has the question");
          }
          const core = coreQuestion(type, stakes);
          const page = thresholdsOf(form);
          const resolved = resolveThresholds(core, override);
          // The cut lines on the page are core's.
          expect(page).toEqual(
            resolved.kind === "yes-no"
              ? { kind: "cuts", yesAbove: resolved.yesAbove, noBelow: resolved.noBelow }
              : resolved,
          );
          const cuts =
            page.kind === "cuts" ? [page.noBelow, page.yesAbove] : [page.confidenceAtLeast];
          for (const cut of cuts) {
            for (const figure of [cut - EPSILON, cut, cut + EPSILON]) {
              const answer = answerAt(type, figure);
              expect(
                decidedWords(form, page, answer),
                `${type} at ${String(figure)} (cut ${String(cut)})`,
              ).toBe(coreWords(core, override, answer));
            }
          }
          // The page's figure for a pick-one is core's confidence formula.
          if (type === "choice") {
            const answer = answerAt(type, 0.5);
            expect(figureOf(answer)).toBeCloseTo(0.5, 12);
          }
        });
      }
    }
  }
});

describe("the page's crossed cut lines against the loader's rule in packages/core", () => {
  // At each stakes, overrides that leave the pair in order, touching, or crossed once the stakes
  // defaults fill the side the override leaves out.
  const PAIRS: readonly ThresholdOverride[] = [
    {},
    { yesAbove: 0.2 },
    { yesAbove: 0.3 },
    { yesAbove: 0.31 },
    { yesAbove: 0.1 },
    { yesAbove: 0.11 },
    { noBelow: 0.7 },
    { noBelow: 0.69 },
    { noBelow: 0.9 },
    { noBelow: 0.89 },
    { yesAbove: 0.5, noBelow: 0.5 },
    { yesAbove: 0.5, noBelow: 0.49 },
  ];
  for (const stakes of ["low", "high"] as const) {
    for (const override of PAIRS) {
      it(`yes or no, ${stakes} stakes, override ${JSON.stringify(override)}`, () => {
        const thresholds = Object.keys(override).length === 0 ? {} : { q: override };
        const [form] = formOf({
          name: "s",
          read: ["title"],
          questions: { q: questionJson("noul", stakes) },
          thresholds,
        }).questions;
        if (form === undefined) {
          throw new Error("the form has the question");
        }
        const loader = parseQuestionSet({
          questions: [coreQuestion("noul", stakes)],
          read: ["title"],
          model: "jev-1.14.0",
          thresholds,
        });
        expect(crossed(thresholdsOf(form))).toBe(!loader.ok);
      });
    }
  }
});
