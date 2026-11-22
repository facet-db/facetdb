import { type ActionCall, type NotifyOptions, notifyCall } from "facetdb";

/**
 * The settings of `email.notify`: the one address to send to under `channel` (or `to`), the
 * remainder of an `email:` channel such as `ops@example.com`, and the condition on the decisions.
 */
export type EmailNotify = NotifyOptions;

/**
 * `email.notify({ channel: "ops@example.com", when: { urgency: "high" } })` in a config file: a
 * record notification sent by email. It only writes the action down, as every action of the config
 * DSL does; the address is checked by the channel's schema when the config loads, and the action is
 * FacetDB's own, run by the worker.
 */
export const email = {
  notify: (options: EmailNotify): ActionCall => notifyCall("@facetdb/email", options),
};
