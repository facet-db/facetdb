/**
 * The threshold and answer shapes the decision rule works on. Thresholds are resolved per question
 * from its stakes and its config override; the answer is the parsed model response, aligned to
 * the question's own option or level order.
 */

/** A noul decides yes or no from one probability: yes at or above `yesAbove`, no at or below `noBelow`. */
export type YesNoThresholds = {
  readonly kind: "yes-no";
  readonly yesAbove: number;
  readonly noBelow: number;
};

/** A choice or score decides the top option or level when its confidence reaches the threshold. */
export type ConfidenceThresholds = {
  readonly kind: "confidence";
  readonly confidenceAtLeast: number;
};

export type Thresholds = YesNoThresholds | ConfidenceThresholds;

/**
 * A per-question override from the config, as in `thresholds: { urgency: { confidenceAtLeast: 0.6 } }`.
 * Each value is a probability or confidence in [0, 1]; which keys a question may take depends on its
 * type, and the question-set schema refuses the rest.
 */
export type ThresholdOverride = {
  readonly yesAbove?: number;
  readonly noBelow?: number;
  readonly confidenceAtLeast?: number;
};

/** A noul answer: the probability that the answer is yes. */
export type NoulAnswer = {
  readonly type: "noul";
  readonly probability: number;
};

/**
 * A choice answer: the top option as the model named it (the decision log keeps it), and one
 * probability per option, in the question's option order. The parser guarantees `top` holds the
 * highest probability; on a tie, `top` decides.
 */
export type ChoiceAnswer = {
  readonly type: "choice";
  readonly top: string;
  readonly probabilities: readonly number[];
};

/**
 * A score answer: one probability per level, lowest level first, and the confidence and expected
 * value TypeSafe returns. FacetDB stores the model's expected value; it does not recompute one.
 */
export type ScoreAnswer = {
  readonly type: "score";
  readonly probabilities: readonly number[];
  readonly confidence: number;
  readonly expected: number;
};

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Decision =
  | {
      readonly kind: "decided";
      /** A yes or no for a noul, an option name or a level name otherwise. */
      readonly value: boolean | string;
      /** The yes probability for a noul, the confidence for a choice or a score. */
      readonly probabilityOrConfidence: number;
      /** A score's expected level, as the model returned it. */
      readonly expected?: number;
    }
  | { readonly kind: "needs_review" };
