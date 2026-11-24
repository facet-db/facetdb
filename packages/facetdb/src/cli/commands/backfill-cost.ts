import { type BackfillEstimate, compactTokens } from "@facetdb/core";

/**
 * A backfill estimate's tokens and dollars in words, for `facetdb backfill` and the worker's job
 * alike. Scaled by what answered records were billed, the figures are about the cost: "about 43.4k
 * input tokens, less than $0.01". With no billed answer to scale by, they are the estimator's count
 * of characters, a floor, and said so: "at least 15.8k input tokens, at least $0.0006", the dollars
 * rounded down so the floor stays one. A cost of nothing is exact either way.
 */
export function costWords(estimate: BackfillEstimate): string {
  if (estimate.calibration === null && estimate.tokens > 0) {
    return `at least ${compactTokens(estimate.tokens)} input tokens, at least ${dollarsDown(estimate.dollars)}`;
  }
  const money =
    estimate.dollars > 0 && estimate.dollars < 0.01
      ? "less than $0.01"
      : `about $${estimate.dollars.toFixed(2)}`;
  return `about ${compactTokens(estimate.tokens)} input tokens, ${money}`;
}

/**
 * A positive amount rounded down, to the cent from a cent up and to its first digit below one:
 * "$0.67" for 0.6789, "$0.0006" for 0.00067. The small epsilon keeps 0.29 from reading as 0.28.
 */
function dollarsDown(amount: number): string {
  const digits = amount >= 0.01 ? 2 : -Math.floor(Math.log10(amount));
  const scale = 10 ** digits;
  return `$${(Math.floor(amount * scale + 1e-9) / scale).toFixed(digits)}`;
}
