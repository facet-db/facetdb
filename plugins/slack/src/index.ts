/**
 * @facetdb/slack: system alerts and record notifications to a Slack channel.
 *
 * ```ts
 * // facetdb.config.ts
 * import { slack } from "@facetdb/slack";
 * plugins: { slack: { token: env("SLACK_BOT_TOKEN") } },        // posts to any channel the app is in
 * // or, with no token, one incoming webhook per channel:
 * plugins: { slack: { webhooks: { "#ops": env("SLACK_WEBHOOK_OPS") } } },
 * alerts: { channels: ["slack:#ops"] },
 * actions: [slack.notify({ channel: "#support-urgent", when: { urgency: "high" } })],
 * ```
 */
import { type ActionCall, actionCall } from "facetdb";
import { channel, definePlugin, type PluginContext } from "facetdb/plugin";
import { checkChannel, deliverMessage, type Fetch } from "./deliver.ts";
import { channelSettings, pluginConfig, type SlackConfig } from "./settings.ts";

export type { Fetch } from "./deliver.ts";
export { SlackDeliveryError } from "./deliver.ts";
export type { ChannelSettings, SlackConfig } from "./settings.ts";

export type SlackPluginOptions = {
  /** Every request the plugin makes goes through it: the global `fetch` in the process. */
  readonly fetch: Fetch;
};

/** The plugin, posting through the `fetch` it is given. */
export function createSlackPlugin(options: SlackPluginOptions) {
  return definePlugin({
    name: "slack",
    version: "0.0.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: pluginConfig,
    channels: {
      slack: channel<SlackConfig, typeof channelSettings>({
        config: channelSettings,
        check: (ctx: PluginContext<SlackConfig>, settings) => checkChannel(ctx.config, settings),
        deliver: (ctx, message, settings) => deliverMessage(options.fetch, ctx, message, settings),
      }),
    },
  });
}

/** The plugin the worker loads: the one place the real `fetch` is wired. */
export default createSlackPlugin({ fetch: (url, init) => globalThis.fetch(url, init) });

/** A `when` term, as `facetdb` reads it: a decision value, a status, or `{ atLeast }` on a number. */
type Condition = { readonly [term: string]: boolean | string | { readonly atLeast: number } };

/** `slack.notify(...)` in a config file: a record notification to a channel (its action is not built yet). */
export const slack = {
  notify(options: { readonly channel: string; readonly when?: Condition }): ActionCall {
    return actionCall("@facetdb/slack", "notify", {
      channel: options.channel,
      ...(options.when === undefined ? {} : { when: options.when }),
    });
  },
};
