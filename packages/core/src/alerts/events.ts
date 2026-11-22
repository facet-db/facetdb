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
  // A plugin action, or a webhook, the outbox stopped trying after 24 hours.
  "action_gave_up",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = ChannelMessage["severity"];

/**
 * The kinds the code resolves: a healthy call resolves `model_failing`, and the worker resolves
 * `connector_lost_access` once the source reads well again (its doctor's verdict passes at the
 * worker's 5-minute reading, or a plugin source's read answers). Every other kind is raised and
 * never resolved, so a page must not say it is "not resolved". A kind that gains a resolve path is
 * added here. `worker_not_running` is not one: it is raised once for a worker that is gone, whose
 * row is taken as it is raised, and nothing later says it is back.
 */
export const RESOLVABLE_ALERT_KINDS: readonly AlertKind[] = [
  "model_failing",
  "connector_lost_access",
];

/** The Severity column of the system alerts. */
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = {
  worker_not_running: "critical",
  model_failing: "critical",
  connector_lost_access: "critical",
  spending_80: "warning",
  spending_paused: "critical",
  backfill_finished: "information",
  backfill_failed: "warning",
  question_set_changed: "information",
  action_gave_up: "warning",
};

/** No heartbeat for this long and the worker is not running. */
export const HEARTBEAT_LOSS_MS = 2 * 60_000;

/** How often a running worker saves its own heartbeat row. */
export const WORKER_BEAT_EVERY_MS = 15_000;

/** How often a running worker takes the rows of the workers that stopped beating. */
export const WORKER_CHECK_EVERY_MS = 30_000;

/**
 * What the dashboard's health says when the project's own heartbeat is older than
 * `HEARTBEAT_LOSS_MS`. The alert for a worker that died is worded by the worker watch
 * (`dead-worker.ts`), which names the worker.
 */
export const WORKER_NOT_RUNNING_WHAT = "The worker has sent no heartbeat for 2 minutes.";

/**
 * What each kind is called where a person reads it (the dashboard's Home and its recent alerts).
 * The spending cap is one event in two steps.
 */
export const ALERT_TITLES: Readonly<Record<AlertKind, string>> = {
  worker_not_running: "Worker not running",
  model_failing: "Model failing",
  connector_lost_access: "Connector lost access",
  spending_80: "Spending at 80% of the cap",
  spending_paused: "Spending cap reached",
  backfill_finished: "Backfill finished",
  backfill_failed: "Backfill failed",
  question_set_changed: "Question set changed",
  action_gave_up: "Action gave up",
};

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
  /**
   * The worker the event is about, for an event that is one per worker (`worker_not_running`);
   * absent for every other event. It is part of the event's key, so two dead workers within 30
   * minutes are two alerts.
   */
  readonly worker?: string;
  /**
   * The question-set version an event is about (`question_set_changed`); absent for every other
   * event. It is part of the event's key, so a second change within 30 minutes is an alert of its
   * own, while one version is one alert.
   */
  readonly version?: number;
  /**
   * What raised a Connector lost access alert: its source's doctor at the worker's 5-minute look,
   * or a refusal its loop met (a refused login, right or credential). Kept with the active alert,
   * so every worker reading it knows: a look resolves only what a doctor raised, and a refusal's
   * alert waits for a write or a read through the source made after it began. Absent for every
   * other event; not part of the key.
   */
  readonly cause?: "doctor" | "refusal";
};

/** What makes two events "the same event": one alert is sent per key per 30 minutes. */
export function eventKey(
  event: Pick<AlertEvent, "kind" | "project" | "source" | "question" | "worker" | "version">,
): string {
  const key = [event.kind, event.project, event.source, event.question ?? ""];
  return [
    ...key,
    ...(event.worker === undefined ? [] : [event.worker]),
    ...(event.version === undefined ? [] : [`v${event.version}`]),
  ].join("|");
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
