import type { ReviewOpenQuestion } from "../../api/index.ts";

/**
 * The Review page's words: the sentences and figures the card says, kept apart from the markup so
 * each can be read (and tested) as text. Plain words only: a number always travels with its words.
 */

/** The hold on a card lasts ten minutes; the strip draws the share left. */
export const LOCK_MS = 600_000;

/** The page asks to keep its card every minute while it is open. */
export const RENEW_EVERY_MS = 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, one: string) => `${String(count)} ${one}${count === 1 ? "" : "s"}`;

/** How long the oldest card has waited: "less than a minute", "14 minutes", "3 hours", "5 days". */
export function waitWords(ms: number): string {
  if (ms < MINUTE) {
    return "less than a minute";
  }
  if (ms < HOUR) {
    return plural(Math.floor(ms / MINUTE), "minute");
  }
  if (ms < 2 * DAY) {
    return plural(Math.floor(ms / HOUR), "hour");
  }
  return plural(Math.floor(ms / DAY), "day");
}

/** The count line's first sentence: "37 to review." */
export function countWords(count: number): string {
  return count === 0 ? "Nothing to review." : `${count.toLocaleString("en-US")} to review.`;
}

/** The question types as a person reads them. */
export function typeWords(type: ReviewOpenQuestion["type"]): string {
  switch (type) {
    case "noul":
      return "Yes or no";
    case "choice":
      return "Pick one";
    case "score":
      return "Rate on a scale";
  }
}

/** The legend a screen reader hears on a group of answers. */
export function pickWords(type: ReviewOpenQuestion["type"]): string {
  switch (type) {
    case "noul":
      return "Yes or no";
    case "choice":
      return "Pick an option";
    case "score":
      return "Pick a level";
  }
}

/** A probability as a whole percent: "62%". */
export function percent(probability: number): string {
  return `${String(Math.round(probability * 100))}%`;
}

/** The model's answer as a sentence: "The model says 84% likely yes." / "The model's pick is high, 62% sure." */
export function modelSays(question: ReviewOpenQuestion): string {
  return question.type === "noul"
    ? `The model says ${question.said}.`
    : `The model's pick is ${question.said}.`;
}

/** What a person chose, in words: "yes", "no", or the option or level name. */
export function valueWords(value: boolean | string): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return value;
}

/** The time left on the hold: "9:41". */
export function clockWords(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const rest = seconds % 60;
  return `${String(Math.floor(seconds / 60))}:${String(rest).padStart(2, "0")}`;
}

/** The minutes left in a sentence for a screen reader, which reads no clock face. */
export function minutesLeftWords(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE));
  return minutes <= 1 ? "less than a minute" : `${String(minutes)} minutes`;
}

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A moment today as a person reads it: "2:46 PM". */
export function timeWords(ms: number): string {
  return timeOfDay.format(new Date(ms));
}

const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/** The surface's sentences carry times as ISO stamps ("until <ISO time>"); a person reads "12:10 PM". */
export function plainTimes(text: string): string {
  return text.replace(TIMESTAMP, (stamp) => timeOfDay.format(new Date(stamp)));
}

/** When a record began waiting: the time today, the day and time before that. */
export function sinceWords(since: string, nowMs: number): string {
  const at = new Date(since);
  const today = new Date(nowMs);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return (sameDay ? timeOfDay : dayAndTime).format(at);
}
