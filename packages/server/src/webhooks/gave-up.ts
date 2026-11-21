import type { AlertEvent } from "@facetdb/core";
import { sourceIdOf } from "@facetdb/postgres";
import type { WebhookGaveUp } from "./outbox.ts";

/** What FacetDB did about a row it stopped trying. */
export const GAVE_UP_DID = "stopped trying after 24 hours; the decision is in the log";

/**
 * The page of a given-up alert, by what gave up. The worker supplies it: every link FacetDB sends
 * is built in the CLI's `links.ts`, which this package cannot import.
 */
export type GaveUpLink = (kind: "action" | "webhook") => string;

/** A webhook has no source in its row: its give-up concerns the whole project, as the spending cap does. */
const EVERY_SOURCE = "all sources";

/** The source's name inside its store id (`sourceIdOf(project, name)`); the id itself if it is not one. */
function sourceName(event: { readonly projectId: string; readonly sourceId: string }): string {
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
 * secret. Never the URL's path (it may be a secret) or the record's state.
 */
export function gaveUpAlert(event: WebhookGaveUp, lastError: string, link: GaveUpLink): AlertEvent {
  const attempts = `${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`;
  const where =
    "host" in event
      ? { source: EVERY_SOURCE, link: link("webhook") }
      : { source: sourceName(event), link: link("action") };
  return {
    kind: "action_gave_up",
    what: `The ${gaveUpSubject(event)} did not succeed after ${attempts} in 24 hours (delivery ${event.deliveryId}); the last error: ${lastError.replace(/\.$/, "")}.`,
    project: event.projectId,
    source: where.source,
    question: null,
    did: GAVE_UP_DID,
    link: where.link,
  };
}
