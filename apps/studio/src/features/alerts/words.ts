import type { StatusKind } from "@facetdb/ui";
import type { AlertChannel, AlertEvent, ChannelSends } from "../../api/index.ts";
import { whenWords } from "../decisions/index.ts";

/**
 * The small wordings the Alerts page does itself, from what `GET /v1/alerts` carries. The worker
 * words every event; this file names a channel, says where an event happened, and puts a channel's
 * state, settings and last delivery in the mockup's words.
 */

/** "Slack", "Email": a channel's kind (its plugin's short name) as a word. */
export function kindTitle(kind: string): string {
  return kind === "unknown" ? "A channel" : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** "Slack #ops", "Email ops@example.com"; a channel whose name the worker withheld is its kind alone. */
export function channelTitle(channel: Pick<AlertChannel, "kind" | "name">): string {
  const kind = kindTitle(channel.kind);
  return channel.name === null ? kind : `${kind} ${channel.name}`;
}

/** Where an event happened: its source, and the question when it is about one. */
export function whereOf(event: AlertEvent): string {
  return event.question === null ? event.source : `${event.source}, ${event.question}`;
}

/** What a channel is sent, as the form's choices name it. */
export const SENDS_WORDS: Readonly<Record<ChannelSends, string>> = {
  critical: "Critical only",
  warnings: "Critical and warnings",
  everything: "Everything",
};

/**
 * A channel's quiet hours: "22:00 to 07:00, Europe/Berlin", or in the worker's zone, named when it
 * can be read: "22:00 to 07:00, the worker's zone (Africa/Addis_Ababa)".
 */
export function quietWords(
  quiet: NonNullable<AlertChannel["quiet"]>,
  workerZone: string | null,
): string {
  const zone =
    quiet.zone ?? (workerZone === null ? "the worker's zone" : `the worker's zone (${workerZone})`);
  return `${quiet.from} to ${quiet.to}, ${zone}`;
}

/** The channel's quiet-hours summary when it is the newest thing it was sent; null otherwise. */
function newerSummary(channel: AlertChannel): AlertChannel["summary"] {
  const { last, summary } = channel;
  return summary !== null && (last === null || Date.parse(summary.at) > Date.parse(last.at))
    ? summary
    : null;
}

/**
 * A channel's state as a status badge: delivering, failing, nothing sent yet, or not running (a
 * channel the worker did not bind). A summary newer than its last alert counts: one the channel
 * took makes it delivering, one it did not take on the try again past its retry makes it failing.
 * A first try not taken yet changes nothing: it may still be on its way.
 */
export function channelState(channel: AlertChannel): {
  readonly status: StatusKind;
  readonly label: string;
} {
  if (!channel.bound) {
    return { status: "error", label: "Not running" };
  }
  const summary = newerSummary(channel);
  const delivering =
    summary?.sent === true ? true : summary?.failing === true ? false : channel.delivering;
  if (delivering === null) {
    return { status: "pending", label: "Nothing sent yet" };
  }
  return delivering
    ? { status: "done", label: "Delivering" }
    : { status: "error", label: "Failing" };
}

/** A sentence's end: a full stop unless it has one. */
function ended(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The channel's own words for a failure, without what the row already says: a first-party plugin
 * begins with the address (`slack:#ops was not delivered: …`), and the test route with its own
 * lead (`The channel did not take the test message: …`).
 */
export function channelWords(text: string, address: string | null): string {
  let words = text.replace(/^The channel did not take the test message: /, "");
  if (address !== null && words.startsWith(`${address} was not delivered: `)) {
    words = words.slice(`${address} was not delivered: `.length);
  }
  return ended(words.replace(/;\s+(\S)/, (_match, first: string) => `. ${first.toUpperCase()}`));
}

/**
 * The newest thing the channel was sent, in one line: "Backfill finished, 2:10 pm, delivered", or
 * when it failed the channel's own words after a colon; a quiet-hours summary when it is newer.
 * Null when it was sent nothing yet.
 */
export function lastWords(channel: AlertChannel, now: Date): string | null {
  const { last } = channel;
  const summary = newerSummary(channel);
  if (summary !== null) {
    const when = whenWords(new Date(summary.at), now);
    const outcome = summary.sent
      ? "delivered"
      : summary.failing
        ? "not delivered"
        : "not delivered yet";
    return `Quiet-hours summary, ${when}, ${outcome}`;
  }
  if (last === null) {
    return null;
  }
  const what = last.phase === "resolved" ? `${last.title} resolved` : last.title;
  const when = whenWords(new Date(last.at), now);
  return last.ok
    ? `${what}, ${when}, delivered`
    : `${what}, ${when}: ${channelWords(last.error ?? "not delivered", channel.address)}`;
}

/** The channels whose quiet hours held an event: "held for Slack #ops (quiet hours)". */
export function heldWords(held: AlertEvent["held"]): string | null {
  if (held.length === 0) {
    return null;
  }
  const names = held.map((channel) => channelTitle(channel));
  const list =
    names.length === 1
      ? names.join("")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
  return `held for ${list} (quiet hours)`;
}
