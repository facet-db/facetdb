import { PRICE_PER_MILLION_INPUT_TOKENS } from "@facetdb/core";

/**
 * How the Home and Sources pages word their figures: a count in words where the page writes one
 * ("Three sources"), thousands grouped ("12,480"), ages in whole units ("14 minutes"), money in
 * dollars at the model's price. A time of day is the page's to word, in the viewer's own zone: the
 * endpoints send those as ISO 8601.
 */

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A whole number with its thousands grouped: 12480 is "12,480". */
export function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

/** "One source", "Three sources", "12 sources": the words up to ten, grouped digits above. */
export function counted(value: number, singular: string, plural: string): string {
  const text = `${SMALL[value] ?? grouped(value)} ${value === 1 ? singular : plural}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "title", "title and price", "title, description, price and seller_age_days". */
export function listed(items: readonly string[]): string {
  const last = items.at(-1);
  return last === undefined || items.length === 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** A span of time in whole units, rounded down: "1 second", "90 seconds", "14 minutes", "3 hours". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 120) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) {
    return `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
}

/** A share in whole percent, to the nearest: $3.20 of $25 is 13%. */
export function percent(part: number, whole: number): number {
  return Math.round((part * 100) / whole);
}

/** Dollars for a count of input tokens, before any rounding. */
export function dollarsOf(inputTokens: number): number {
  return (inputTokens * PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000;
}

/** "$3.20"; "$25" for whole dollars; "less than $0.01" for a cost the cents cannot show. */
export function money(dollars: number): string {
  const cents = Math.round(dollars * 100);
  if (cents === 0 && dollars > 0) {
    return "less than $0.01";
  }
  return cents % 100 === 0 ? `$${grouped(cents / 100)}` : `$${(cents / 100).toFixed(2)}`;
}
