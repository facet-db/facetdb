import type { Thresholds } from "@facetdb/ui";

/**
 * The loader's rule for a yes-or-no question's cut lines, copied from packages/core
 * (questions/question-set.ts): once the stakes defaults fill the gaps, `noBelow` must be lower than
 * `yesAbove`. A cut set by hand stands through a change of the stakes, so it can cross the new
 * stakes' default; the page says so at once, decides nothing under the crossed pair, and sends
 * nothing until the lines are in order. drift.test.ts holds this copy to core's.
 */
export function crossed(thresholds: Thresholds): boolean {
  return thresholds.kind === "cuts" && thresholds.noBelow >= thresholds.yesAbove;
}
