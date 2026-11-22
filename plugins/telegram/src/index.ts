/**
 * @facetdb/telegram: system alerts and record notifications to a Telegram chat, through the Bot
 * API's `sendMessage`.
 *
 * ```ts
 * plugins: { telegram: { token: env("TELEGRAM_BOT_TOKEN") } },
 * alerts: { channels: ["telegram:-1001234567890"] },
 * actions: [telegram.notify({ channel: "@acme_ops", when: { urgent: true } })],
 * ```
 *
 * The address is `telegram:<chat id>`: a chat's number (negative for a group or a channel, the
 * `-100…` form) or a public channel's `@name`. The bot token is a secret read from a variable; it
 * sits in the request's path, so the URL is never put in an error or a log line (bot-api.ts).
 */
import { type ActionCall, type NotifyOptions, notifyCall } from "facetdb";
import {
  channel,
  definePlugin,
  type Infer,
  type Plugin,
  type PluginContext,
  z,
} from "facetdb/plugin";
import { sendMessage, TelegramDeliveryError, type TelegramFetch } from "./bot-api.ts";
import { MESSAGE_MAX, messageText } from "./message.ts";

export type { TelegramFetch } from "./bot-api.ts";
export {
  RETRY_AFTER_MAX_S,
  TELEGRAM_API,
  TelegramDeliveryError,
  TIMEOUT_MS,
} from "./bot-api.ts";
export { CUT_MARKER, MESSAGE_MAX } from "./message.ts";

/**
 * A bot token as @BotFather gives it: the bot's number, a colon, then letters, digits, `_` and `-`.
 * Nothing else may pass, so a token can never change the request's path or host (`/`, `?`, `#`,
 * `@`, `%`, `.`, whitespace). The words never quote the value; the plugin host does not print them
 * either for a value read from a variable, and names the setting and the variable instead.
 */
const BOT_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{1,200}$/;

/** A chat's number (negative for a group or a channel: `-1001234567890`) or a public `@channel`. */
const CHAT_ID = /^(-?[1-9][0-9]{0,15}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

/** The plugin's settings: `plugins: { telegram: { token: env("TELEGRAM_BOT_TOKEN") } }`. */
const settings = z.object({
  token: z.secret().regex(BOT_TOKEN, {
    error:
      "must be the bot token @BotFather gave the bot: its number, a colon, then letters, digits, _ and - (nothing else, no spaces)",
  }),
});

type TelegramSettings = Infer<typeof settings>;

/** One address's settings: `where` is what follows `telegram:` in it. */
const address = z.object({
  where: z.string().regex(CHAT_ID, {
    error:
      "a Telegram address is \"telegram:<chat id>\": the chat's number (negative for a group or a channel, such as -1001234567890) or a public channel's @name",
  }),
});

export type TelegramPluginOptions = {
  /** The real `fetch` in the process (the default export); a fake in tests. */
  readonly fetch: TelegramFetch;
};

/** The plugin, with its one side effect, `fetch`, passed in. */
export function telegramPlugin(options: TelegramPluginOptions): Plugin<TelegramSettings> {
  return definePlugin({
    name: "telegram",
    version: "0.0.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: settings,
    channels: {
      telegram: channel({
        config: address,
        async deliver(ctx: PluginContext<TelegramSettings>, message, { where }) {
          const text = messageText(message);
          if (text === undefined) {
            throw new TelegramDeliveryError(
              `the message's link is longer than one Telegram message holds (${MESSAGE_MAX} characters), and a link is never cut`,
              "set studioUrl to a shorter address",
              undefined,
            );
          }
          // Every call sends: a channel does not remember what it delivered before.
          await sendMessage(options.fetch, ctx.config.token, { chatId: where, text }, ctx.signal);
        },
      }),
    },
  });
}

// The one place the real `fetch` is wired in: the plugin the host imports.
export default telegramPlugin({ fetch: (url, init) => fetch(url, init) });

/**
 * A record notification to a Telegram chat, as a source's action: the chat under `channel` (or
 * `to`), its number (`-1001234567890`) or a public channel's `@name`, and the condition on the
 * decisions, `{ urgent: true }` or `{ status: "needs_review" }`.
 */
export type TelegramNotify = NotifyOptions;

export const telegram = {
  /** `telegram.notify({ channel: "@acme_ops", when: { urgent: true } })`, written into `actions`. */
  notify(options: TelegramNotify): ActionCall {
    return notifyCall("@facetdb/telegram", options);
  },
};
