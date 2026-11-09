/**
 * The confidence of a choice answer: `(p_top - 1/n) / (1 - 1/n)`, where n is the number of
 * options. 0 means an even split and 1 means certainty. A score's confidence comes from
 * the model and has no formula here; a noul has none at all.
 */
export function choiceConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  const pTop = Math.max(...probabilities);
  return (pTop - 1 / n) / (1 - 1 / n);
}
