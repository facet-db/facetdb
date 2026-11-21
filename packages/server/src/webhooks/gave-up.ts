import type { AlertEvent } from "@facetdb/core";
import { sourceIdOf } from "@facetdb/postgres";
import type { WebhookGaveUp } from "./outbox.ts";

/** What FacetDB did about a row it stopped trying. */
export const GAVE_UP_DID = "stopped trying after 24 hours; the decision is in the log";

/** The page that fixes an action that gave up, and the one for a webhook. */
export const ACTION_GAVE_UP_LINK = "https://docs.facetdb.dev/fix/actions";
export const WEBHOOK_GAVE_UP_LINK = "https://docs.facetdb.dev/fix/webhooks";

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
export function gaveUpAlert(event: WebhookGaveUp, lastError: string): AlertEvent {
  const attempts = `${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`;
  const where =
    "host" in event
      ? { source: EVERY_SOURCE, link: WEBHOOK_GAVE_UP_LINK }
      : { source: sourceName(event), link: ACTION_GAVE_UP_LINK };
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
