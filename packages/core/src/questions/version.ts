import { createHash } from "node:crypto";
import type { QuestionSet } from "./question-set.ts";
import type { Question } from "./types.ts";

/** One version of a question set; every version is kept. */
export type QuestionSetVersion = {
  readonly version: number;
  readonly contentHash: string;
  readonly createdAt: Date;
};

/**
 * What the model sees of a question: its name, type, wording and criteria, in order (option order
 * matters, Jev leans toward the first option). Stakes and `storeProbabilities` are left out: stakes
 * only picks default thresholds, and `storeProbabilities` only adds a column; neither changes an answer.
 */
function questionContent(question: Question): unknown[] {
  switch (question.type) {
    case "noul":
      return [
        question.type,
        question.name,
        question.instructions,
        question.criteria?.true ?? null,
        question.criteria?.false ?? null,
      ];
    case "choice":
      return [
        question.type,
        question.name,
        question.instructions,
        question.options.map((option) => [option.name, option.description]),
      ];
    case "score":
      return [
        question.type,
        question.name,
        question.instructions,
        question.levels.map((level) => [level.name, level.description ?? null]),
      ];
  }
}

/**
 * Wording, criteria, state fields and the model version make a new version; thresholds (and the
 * `where` filter, which decides which records are asked, not what they are asked) do not.
 * Arrays fix the field order, so the serialization is stable.
 * Questions are sorted by name because each is answered on its own: reordering them changes nothing.
 */
export function contentHash(questionSet: QuestionSet): string {
  const questions = [...questionSet.questions]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(questionContent);
  const content = JSON.stringify([questionSet.model, questionSet.read, questions]);
  return createHash("sha256").update(content).digest("hex");
}

/** The version a set should run under: the previous one when its content is unchanged, else the next. */
export function nextVersion(
  previous: QuestionSetVersion | undefined,
  questionSet: QuestionSet,
  clock: { readonly now: () => Date },
): QuestionSetVersion {
  const hash = contentHash(questionSet);
  if (previous !== undefined && previous.contentHash === hash) {
    return previous;
  }
  return { version: (previous?.version ?? 0) + 1, contentHash: hash, createdAt: clock.now() };
}
