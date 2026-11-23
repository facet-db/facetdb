import type { AlertEvent } from "@facetdb/core";
import { sourceIdOf } from "@facetdb/postgres";
import type { WebhookGaveUp } from "./outbox.ts";

/** What FacetDB did about a row it stopped trying. */
export const GAVE_UP_DID = "stopped trying after 24 hours; the decision is in the log";

/**
 * The same for an action refused for good, given up at once: its plugin marked the refusal so, or
 * FacetDB read it from the service's 4xx; the words are true of both.
 */
export const GAVE_UP_REFUSED_DID =
  "stopped trying at once, as FacetDB reads this refusal as one that comes back on every try (its plugin marked it so, or the service answered a 4xx other than 408, 425 and 429); the decision is in the log";

/** Whether a row was given up at once, refused for good: only an action's can be. */
function refusedForGood(event: WebhookGaveUp): boolean {
  return !("host" in event) && event.refused === true;
}

/**
 * When a row was given up, in words that follow "was given up": `after 31 attempts in 24 hours`,
 * or, refused for good, `at once, refused for good after 1 attempt`.
 */
export function gaveUpHow(event: WebhookGaveUp): string {
  const attempts = `${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`;
  return refusedForGood(event)
    ? `at once, refused for good after ${attempts}`
    : `after ${attempts} in 24 hours`;
}

/**
 * The page of a given-up alert, by what gave up. The worker supplies it: every link FacetDB sends
 * is built in the CLI's `links.ts`, which this package cannot import.
 */
export type GaveUpLink = (kind: "action" | "webhook") => string;

/** A webhook has no source in its row: its give-up concerns the whole project, as the spending cap does. */
const EVERY_SOURCE = "all sources";

/**
 * The source's name inside its store id (`sourceIdOf(project, name)`); the id itself if it is not
 * one. The credential alert names its source by it too.
 */
export function sourceName(event: {
  readonly projectId: string;
  readonly sourceId: string;
}): string {
  const prefix = sourceIdOf(event.projectId, "");
  return event.sourceId.startsWith(prefix) ? event.sourceId.slice(prefix.length) : event.sourceId;
}

/** What gave up, in words: `webhook to hooks.example.com`, or `action label of plugin github for source issues`. */
export function gaveUpSubject(event: WebhookGaveUp): string {
  return "host" in event
    ? `webhook to ${event.host}`
    : `action ${event.action} of plugin ${event.plugin} for source ${sourceName(event)}`;
}

/**
 * The `action_gave_up` alert for a row the outbox stopped trying: the source, the action or the
 * webhook's host, the attempts and the last error, which the outbox keeps in words that carry no
 * secret. Never the URL's path (it may be a secret) or the record's state. An action refused for
 * good is said so, with the plugin's own words (its fix among them) as the error, raised at its
 * first refusal rather than after 24 hours.
 */
export function gaveUpAlert(event: WebhookGaveUp, lastError: string, link: GaveUpLink): AlertEvent {
  const attempts = `${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`;
  const where =
    "host" in event
      ? { source: EVERY_SOURCE, link: link("webhook") }
      : { source: sourceName(event), link: link("action") };
  const words = lastError.replace(/\.$/, "");
  const refused = refusedForGood(event);
  return {
    kind: "action_gave_up",
    what: refused
      ? `The ${gaveUpSubject(event)} was given up ${gaveUpHow(event)} (delivery ${event.deliveryId}), as FacetDB reads this refusal as one that comes back on every try: ${words}.`
      : `The ${gaveUpSubject(event)} did not succeed after ${attempts} in 24 hours (delivery ${event.deliveryId}); the last error: ${words}.`,
    project: event.projectId,
    source: where.source,
    question: null,
    did: refused ? GAVE_UP_REFUSED_DID : GAVE_UP_DID,
    link: where.link,
  };
}
