import type { ChannelMessage } from "../contracts/index.ts";

/**
 * The system alerts FacetDB can observe. The review-queue and answer-drift alerts are FacetDB
 * Cloud's and have no kind here.
 */
export const ALERT_KINDS = [
  "worker_not_running",
  "model_failing",
  "connector_lost_access",
  "spending_80",
  "spending_paused",
  "backfill_finished",
  "backfill_failed",
  "question_set_changed",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = ChannelMessage["severity"];

/** The severity of each alert kind. */
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = {
  worker_not_running: "critical",
  model_failing: "critical",
  connector_lost_access: "critical",
  spending_80: "warning",
  spending_paused: "critical",
  backfill_finished: "information",
  backfill_failed: "warning",
  question_set_changed: "information",
};

/** No heartbeat for this long and the worker is not running. */
export const HEARTBEAT_LOSS_MS = 2 * 60_000;

/** One alert per event per this long until it resolves. */
export const ALERT_WINDOW_MS = 30 * 60_000;

/** Calls are counted over this long when judging whether the model is failing. */
export const FAILURE_WINDOW_MS = 5 * 60_000;

/**
 * An event with the five things every alert says: what happened, which project, source and question,
 * what FacetDB did about it, and one link to the page where it is fixed.
 */
export type AlertEvent = {
  readonly kind: AlertKind;
  /** What happened, in a sentence. */
  readonly what: string;
  readonly project: string;
  readonly source: string;
  /** The question concerned; null when the event concerns every question of the source. */
  readonly question: string | null;
  /** What FacetDB did about it: paused, retrying, holding records. */
  readonly did: string;
  /** The one page where it is fixed. */
  readonly link: string;
};

/** What makes two events "the same event": one alert is sent per key per 30 minutes. */
export function eventKey(
  event: Pick<AlertEvent, "kind" | "project" | "source" | "question">,
): string {
  return [event.kind, event.project, event.source, event.question ?? ""].join("|");
}

function placeOf(event: AlertEvent): string {
  const question = event.question === null ? "all questions" : `question ${event.question}`;
  return `Project ${event.project}, source ${event.source}, ${question}.`;
}

/** The message a channel delivers when the event is raised. */
export function alertMessage(event: AlertEvent): ChannelMessage {
  return {
    kind: "system-alert",
    severity: ALERT_SEVERITY[event.kind],
    text: `${event.what} ${placeOf(event)} FacetDB: ${event.did}`,
    link: event.link,
  };
}

/** The message a channel delivers, once, when the event is over. */
export function resolvedMessage(event: AlertEvent): ChannelMessage {
  return {
    kind: "system-alert",
    severity: "information",
    text: `Resolved: ${event.what} ${placeOf(event)}`,
    link: event.link,
  };
}
