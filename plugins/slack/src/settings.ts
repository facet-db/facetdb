import { type Infer, z } from "facetdb/plugin";

/**
 * The Slack plugin's settings: one config, two forms. A bot token posts to any channel an address
 * names; without one, each channel has its own incoming-webhook URL. Both are secrets: a webhook
 * URL posts to its channel with nothing else, so it is a credential too. Everything here is checked
 * when the config loads, and the host never prints a reason for a value it read from a variable, so
 * no rule below needs to keep the value out of its words.
 */

/** The one host an incoming-webhook URL may name; see `webhookUrlProblem`. */
export const WEBHOOK_HOST = "hooks.slack.com";

/**
 * A channel as an address names it after `slack:`: `#name` as Slack writes it (lowercase letters,
 * digits, `-`, `_` and the letters of other scripts, up to 80), or a channel ID such as C0123ABCD.
 */
const CHANNEL = /^(?:#[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}_-]{1,80}|[CGD][A-Z0-9]{8,20})$/u;

const CHANNEL_RULE =
  "a Slack channel is written #name, in lowercase as Slack shows it (slack:#ops), or as its channel ID (slack:C0123ABCD)";

const channelName = z.string().regex(CHANNEL, CHANNEL_RULE);

/** A token goes into a header: only the visible ASCII a Slack token is made of. */
const TOKEN = /^xox[a-z]-[\x21-\x7e]+$/;

/**
 * Why a webhook URL is refused, or undefined when it holds. Only an https address on
 * `hooks.slack.com`, on its standard port, under `/services/` (an incoming webhook), written as
 * plain text with nothing a parser could read two ways: a URL anywhere else is a typo or would send
 * a credential and the alert's words to a host that is not Slack's. FacetDB's own `webhook` channel
 * is the door for any other receiver.
 */
function webhookUrlProblem(text: string): string | undefined {
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(text) || !URL.canParse(text)) {
    return "is not a URL written as plain text";
  }
  const url = new URL(text);
  if (url.protocol !== "https:") {
    return "must start with https://";
  }
  if (
    url.hostname !== WEBHOOK_HOST ||
    url.port !== "" ||
    !text.startsWith(`https://${WEBHOOK_HOST}/`)
  ) {
    return `must be a Slack incoming webhook on https://${WEBHOOK_HOST}/services/`;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return "must be the webhook's URL as Slack gives it, with no user, query or fragment";
  }
  if (!url.pathname.startsWith("/services/")) {
    return `must be an incoming webhook, under https://${WEBHOOK_HOST}/services/`;
  }
  return undefined;
}

const webhookUrl = z.secret().superRefine((text, context) => {
  const problem = webhookUrlProblem(text);
  if (problem !== undefined) {
    context.addIssue({ code: "custom", message: `an incoming-webhook URL ${problem}` });
  }
});

/** The plugin's settings: `plugins: { slack: { token: env("…"), webhooks: { "#ops": env("…") } } }`. */
export const pluginConfig = z.object({
  /** A bot token (xoxb-…) with the chat:write scope; it posts to every channel the bot is in. */
  token: z
    .secret()
    .regex(TOKEN, "a Slack bot token starts with xoxb- and holds no space")
    .optional(),
  /** Each channel's incoming-webhook URL, by the channel as its address names it. */
  webhooks: z.record(channelName, webhookUrl).optional(),
});

export type SlackConfig = Infer<typeof pluginConfig>;

/** The settings of one address, `slack:<where>`. */
export const channelSettings = z.object({ where: channelName });

export type ChannelSettings = Infer<typeof channelSettings>;

/** How a message reaches one channel: the Web API with the token, or the channel's webhook. */
export type Route =
  | { readonly kind: "api"; readonly token: string }
  | { readonly kind: "webhook"; readonly url: string };

/** The token when there is one (it reaches any channel), else the channel's own webhook. */
export function routeFor(config: SlackConfig, where: string): Route | undefined {
  if (config.token !== undefined) {
    return { kind: "api", token: config.token };
  }
  const webhooks = config.webhooks ?? {};
  const url = Object.hasOwn(webhooks, where) ? webhooks[where] : undefined;
  return url === undefined ? undefined : { kind: "webhook", url };
}

/** `#support-urgent` → `SLACK_WEBHOOK_SUPPORT_URGENT`, the variable the refusal suggests. */
function webhookVariable(where: string): string {
  const word = where
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return word === "" ? "SLACK_WEBHOOK" : `SLACK_WEBHOOK_${word}`;
}

/** The words for a channel neither form reaches: the channel, and the two ways to give it one. */
export function noRouteWords(where: string): string {
  return `slack:${where} has no way to reach Slack: give the plugin a bot token, plugins: { slack: { token: env("SLACK_BOT_TOKEN") } }, or the incoming-webhook URL of ${where}, plugins: { slack: { webhooks: { ${JSON.stringify(where)}: env("${webhookVariable(where)}") } } }, and set the variable where the worker runs`;
}
