/**
 * `retry-after` as milliseconds: whole or fractional seconds, or an HTTP date measured from `nowMs`.
 * An absent or unreadable header is `undefined` (the retry policy picks its own wait); a date in
 * the past is zero.
 */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const text = header.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.round(Number(text) * 1000);
  }
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
