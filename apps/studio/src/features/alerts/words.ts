import type { AlertChannel, AlertEvent } from "../../api/index.ts";

/**
 * The small wordings the Alerts page does itself, from what `GET /v1/alerts` carries. The worker
 * words every event; this file only names a channel and says where an event happened.
 */

/** "Slack #ops", "Email ops@example.com"; a channel whose name the worker withheld is its kind alone. */
export function channelTitle(channel: AlertChannel): string {
  const kind =
    channel.kind === "unknown"
      ? "A channel"
      : `${channel.kind.charAt(0).toUpperCase()}${channel.kind.slice(1)}`;
  return channel.name === null ? kind : `${kind} ${channel.name}`;
}

/** Where an event happened: its source, and the question when it is about one. */
export function whereOf(event: AlertEvent): string {
  return event.question === null ? event.source : `${event.source}, ${event.question}`;
}
