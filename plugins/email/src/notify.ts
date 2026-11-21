import { type ActionCall, actionCall, type JsonValue } from "facetdb";

/** The settings of `email.notify`: the one address to send to, and the condition on the decisions. */
export type EmailNotify = {
  /** One email address, the remainder of an `email:` channel: `ops@example.com`. */
  readonly channel: string;
  readonly when?: { readonly [key: string]: JsonValue };
};

/**
 * `email.notify({ channel: "ops@example.com", when: { urgency: "high" } })` in a config file: a
 * record notification sent by email. It only writes the action down, as every action of the config
 * DSL does; the address is checked by the channel's schema when the config loads, and the action is
 * run by the worker.
 */
export const email = {
  notify: ({ channel, when }: EmailNotify): ActionCall =>
    actionCall("@facetdb/email", "notify", { channel, ...(when === undefined ? {} : { when }) }),
};
