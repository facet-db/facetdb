import { type AlertEvent, eventKey } from "@facetdb/core";
import { sourceName } from "./gave-up.ts";
import type { ActionCredentialRefused, ActionDelivered } from "./outbox.ts";

/**
 * Action credential refused: a plugin's action whose service answered 401. A rotated credential
 * comes back where a deleted issue does not, so the row keeps its 24 hours of retries (it gives up
 * with Action gave up at their end, as any row), and the alert is raised at once, one per plugin of
 * a source (the plugin is in its key), until that plugin's next delivered try on that source
 * resolves it.
 */

/** What FacetDB does about a refused credential, and the fix. */
export const CREDENTIAL_REFUSED_DID =
  "Each action is retried for 24 hours from when it was queued. Put a valid credential in place and restart the worker; this clears when the next action goes through.";

/**
 * A try's failure words when the service refused the credential and the plugin's own words were
 * withheld (they repeat a value its settings read): the row's `last_error`, which the alert leaves
 * out, so it names no words of the plugin at all.
 */
export const CREDENTIAL_WORDS_WITHHELD =
  "the service refused the plugin's credential; the plugin's own words are not kept, as they repeat a value its settings read";

/** The page that fixes a refused credential: the Alerts page, else the docs fix page. */
export type CredentialLink = () => string;

/**
 * The `action_credential_refused` alert for a try the outbox reports (`onCredentialRefused`): the
 * plugin, the source and the action, and the plugin's own words (its fix among them), which the
 * action host kept only because they repeat no value the plugin was handed (`firstPartyFailure`);
 * withheld (`CREDENTIAL_WORDS_WITHHELD`), none. Never the credential, the record's state or a URL.
 */
export function credentialRefusedAlert(
  event: ActionCredentialRefused,
  lastError: string,
  link: CredentialLink,
): AlertEvent {
  const source = sourceName(event);
  const refused = `${event.plugin} was refused its credential (source ${source}, action ${event.action})`;
  return {
    kind: "action_credential_refused",
    what:
      lastError === CREDENTIAL_WORDS_WITHHELD
        ? `${refused}.`
        : `${refused}: ${lastError.replace(/\.$/, "")}.`,
    project: event.projectId,
    source,
    question: null,
    did: CREDENTIAL_REFUSED_DID,
    link: link(),
    plugin: event.plugin,
  };
}

/** Whose credential, in words: `plugin @facetdb/github on source issues`. */
export function credentialSubject(event: ActionDelivered): string {
  return `plugin ${event.plugin} on source ${sourceName(event)}`;
}

/**
 * The key of a plugin's credential alert on a source: what a delivered try of that plugin there
 * (`onActionDelivered`) resolves. The same key `credentialRefusedAlert`'s event has.
 */
export function credentialRefusedKey(event: ActionDelivered): string {
  return eventKey({
    kind: "action_credential_refused",
    project: event.projectId,
    source: sourceName(event),
    question: null,
    plugin: event.plugin,
  });
}
