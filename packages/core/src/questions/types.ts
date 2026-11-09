/**
 * The three question types FacetDB exposes, one-to-one with the TypeSafe primitives. The box type
 * is deliberately absent: TypeSafe does not support images for production.
 * These are the parsed shapes; `question-set.ts` validates input into them at the config boundary.
 */

export const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** What happens when an answer is wrong; selects the default thresholds. */
export type Stakes = "low" | "high";

/** What yes (`true`) and no (`false`) mean, each described as a concrete situation. */
export type NoulCriteria = {
  readonly true?: string;
  readonly false?: string;
};

export type NoulQuestion = {
  readonly type: "noul";
  readonly name: string;
  readonly instructions: string;
  readonly criteria?: NoulCriteria;
  readonly stakes: Stakes;
};

/** An option's name is sent to the model and becomes the stored value; the description is its criterion. */
export type ChoiceOption = {
  readonly name: string;
  readonly description: string;
};

export type ChoiceQuestion = {
  readonly type: "choice";
  readonly name: string;
  readonly instructions: string;
  readonly options: readonly ChoiceOption[];
  readonly stakes: Stakes;
  /** Adds the `<name>_probabilities` JSON column. */
  readonly storeProbabilities: boolean;
};

/** Levels are ordered lowest first; the order is what makes the expected value meaningful. */
export type ScoreLevel = {
  readonly name: string;
  readonly description?: string;
};

export type ScoreQuestion = {
  readonly type: "score";
  readonly name: string;
  readonly instructions: string;
  readonly levels: readonly ScoreLevel[];
  readonly stakes: Stakes;
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
