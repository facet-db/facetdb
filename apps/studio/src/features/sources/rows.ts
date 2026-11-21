/**
 * A table's size as the database estimates it, in words: "about 4,100 rows". The figure comes from
 * the database's statistics, not a count, so it is rounded to two significant figures: four digits
 * would claim a precision the estimate does not have.
 */
export function aboutRows(estimate: number): string {
  if (estimate === 0) {
    return "no rows";
  }
  const rounded = Number(estimate.toPrecision(2));
  return `about ${rounded.toLocaleString("en-US")} ${rounded === 1 ? "row" : "rows"}`;
}
