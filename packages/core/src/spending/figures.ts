/**
 * Token counts as a person reads them at a glance: "3M", "1.5M", "850k", "12.5k", "8,500". One form
 * for the dashboard's figures, the alerts' words and the CLI's estimates, since a count written out
 * ("3000134 of 3000000 input tokens", a real run) is not read, only skipped. Under ten thousand the
 * digits are grouped; from there thousands, millions or billions, with one decimal while the figure
 * is under a hundred units and the decimal says something. The exact count is never lost where it
 * matters: `tokensOfCap` writes it after the compact pair when they differ.
 */

const UNITS = [
  { from: 999_500_000, per: 1_000_000_000, mark: "B" },
  { from: 999_500, per: 1_000_000, mark: "M" },
  { from: 10_000, per: 1_000, mark: "k" },
] as const;

/** "3,000,134": the whole count with its thousands grouped. */
export function groupedTokens(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}

/** "3M", "1.5M", "850k", "12.5k", "8,500": the count as a person reads it at a glance. */
export function compactTokens(tokens: number): string {
  const whole = Math.max(0, Math.round(tokens));
  for (const unit of UNITS) {
    if (whole >= unit.from) {
      const value = whole / unit.per;
      const text =
        value < 100
          ? (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "")
          : String(Math.round(value));
      return `${text}${unit.mark}`;
    }
  }
  return whole.toLocaleString("en-US");
}

/**
 * "3M of 3M input tokens (3,000,134 of 3,000,000)": a count against a cap, at a glance first and
 * exact after, where the compact pair hides a figure; "800 of 1,000 input tokens" where it hides none.
 */
export function tokensOfCap(total: number, cap: number): string {
  const glance = `${compactTokens(total)} of ${compactTokens(cap)} input tokens`;
  const exact = `${groupedTokens(total)} of ${groupedTokens(cap)}`;
  return `${compactTokens(total)} of ${compactTokens(cap)}` === exact
    ? glance
    : `${glance} (${exact})`;
}

/**
 * Alert text written by an earlier version carries the pair as bare digits ("3000134 of 3000000
 * input tokens"); the stored row stays as written, and this rewrites it on read into
 * `tokensOfCap`'s form, so the Alerts page reads the same for old and new rows.
 */
export function readableTokenCounts(text: string): string {
  // Bare digits only: a grouped or compact pair ("2.4M of 3M", "2,400,097 of 3,000,000") has a
  // comma, a point or a letter between its digits and " input tokens", so the pattern skips it.
  return text.replace(/\b(\d+) of (\d+) input tokens\b/g, (_whole, total: string, cap: string) =>
    tokensOfCap(Number(total), Number(cap)),
  );
}
