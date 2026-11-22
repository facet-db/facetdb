import {
  type ActionInvocation,
  ActionNotQueued,
  type ActionStep,
  type ChannelMessage,
  configureAction,
} from "@facetdb/core";
import {
  createWebhookAction,
  isLoopbackHost,
  type Outbox,
  type WebhookConfig,
} from "@facetdb/server";
import type { ActionCall, ProjectConfig, SourceConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { definePlugin, type Plugin } from "../define.ts";
import type { HostedPlugin, PluginHost } from "../host.ts";
import { action, channel, type PluginContext } from "../kinds.ts";
import { type Infer, z } from "../zod.ts";

/**
 * The built-in webhook: a plugin declared with `definePlugin` like any other and registered in the
 * plugin host under `@facetdb/webhook` (`BUILTIN_PLUGINS`), so a config names it with nothing
 * installed. Its settings are the signing secret, always a variable's name, and `endpoints`, the
 * addresses an alert channel `webhook:<name>` names.
 *
 * - The action `send` (`webhook({ url })` in a source's `actions`) is the one built-in the action
 *   host queues directly (`webhookStep`): each decision is an endpoint row in the outbox, through
 *   `createWebhookAction` and its `record.decided` payload, never an action row, never superseded.
 *   A row names the decision it carries, and the same decision queued again while it is still the
 *   record's latest row (a released job, a lost ack, the same state queued again) is that row.
 * - The channel `webhook` queues `{ event, delivery, severity, text, link }` the same way.
 *
 * The outbox signs each attempt with this plugin's secret, read from the host by the worker
 * (`webhookSecret`), and retries for 24 hours; nothing here prints, and no word here holds the
 * secret or an endpoint's address. Only the project's own worker claims these rows: they name
 * their plugin, as an action row does, and no other project's worker holds this secret. It sends
 * a row only to an endpoint its config in force still names (`webhookRefusal`).
 *
 * Order. Every decision is delivered, and the order is in the signed body, never the arrival: two
 * decisions of one record queued close together are two rows, due at once and sent side by side in
 * one pass, and a failed one is retried after a later one went out. Each carries the time of the
 * log entry behind it (`decidedAt`: the answer, or a person's decision on it), and its `delivery`,
 * the outbox's sequence number, taken when it is queued. A threshold change re-decides a record
 * from the same answer, so two of its decisions can share a `decidedAt` (and one can come back to
 * an earlier one's payload, which is queued again, being no longer the latest). The receiver keeps,
 * per `id`, the payload with the latest `decidedAt`, and between equal ones the larger `delivery`
 * as a whole number. A job released and run again hands the actions the same logged decision with
 * the same time, which is the row already queued: nothing new goes out. Two processes queueing one
 * decision at the same instant can both write it, under two delivery ids with the same payload:
 * harmless to a receiver that keeps the latest.
 */

/** The package the built-in is registered under, and the name a config gives its plugin. */
export const WEBHOOK_PLUGIN = "@facetdb/webhook";
/** Its action: `webhook({ url })` writes `actionCall(WEBHOOK_PLUGIN, WEBHOOK_ACTION, { url })`. */
export const WEBHOOK_ACTION = "send";
/** Its alert channel: the kind of an address `webhook:<name>`. */
export const WEBHOOK_CHANNEL = "webhook";

/** The variable the docs and the receiver's snippet read the secret from; a refusal suggests it. */
export const WEBHOOK_SECRET_VARIABLE = "FACETDB_WEBHOOK_SECRET";

const SECRET_MISSING = `the webhook's signing secret is read from an environment variable: write secret: env("${WEBHOOK_SECRET_VARIABLE}") under plugins.webhook and set ${WEBHOOK_SECRET_VARIABLE} where the worker runs (your receiver verifies each delivery with the same value)`;

/** An endpoint's short name in `endpoints`, as `webhook:<name>` writes it: `ops`, `billing-alerts`. */
const ENDPOINT_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const ENDPOINT_NAME_RULE =
  'an endpoint is named in lowercase letters, digits, "-" and "_", starting with a letter, such as ops or billing-alerts';

/**
 * Why `text` cannot be an endpoint, or undefined when it can: an address with no username or
 * password and no `#` part, over https, or http to this machine alone (the receiver's own words
 * name what to write). The words never quote the address: one may carry a token in its query.
 */
export function endpointProblem(text: string): string | undefined {
  const example = '"https://hooks.example.com/facetdb"';
  // A backslash, a space, a control character and an invisible one are read differently by
  // different URL parsers, as studioUrl's rule says: the address must mean one thing.
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(text) || !URL.canParse(text)) {
    return `an endpoint is a full address written as plain text, such as ${example}: remove any space, backslash, control or invisible character`;
  }
  const url = new URL(text);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return `an endpoint is sent signed decisions and alerts over HTTPS: write it as ${example}; http:// is for a receiver on this machine only (localhost, 127.0.0.1 or [::1])`;
  }
  if (url.username !== "" || url.password !== "") {
    return 'an endpoint never carries a username or password, which this file and its JSON export never hold: remove the "user:password@" part; the receiver checks the facetdb-signature header instead';
  }
  if (text.includes("#")) {
    return 'an endpoint has no "#" part, which is never sent to the receiver: remove everything from the "#" on';
  }
  return undefined;
}

/** An endpoint's address, judged at load by `endpointProblem`. */
function endpointUrl(missing: string) {
  return z.string({ error: missing }).superRefine((text, context) => {
    const problem = endpointProblem(text);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", message: problem });
    }
  });
}

/** The plugin's settings, `plugins: { webhook: { secret, endpoints } }`: one schema for the file and the form. */
const settings = z.strictObject({
  secret: z.secret({ error: SECRET_MISSING }),
  endpoints: z
    .record(
      z.string().regex(ENDPOINT_NAME, ENDPOINT_NAME_RULE),
      endpointUrl(
        'an endpoint is an address in quotes, such as "https://hooks.example.com/facetdb"',
      ),
      { error: (issue) => (issue.code === "invalid_key" ? ENDPOINT_NAME_RULE : undefined) },
    )
    .default({}),
});

type Settings = Infer<typeof settings>;

/** The settings of one `webhook({ url })`: where its decisions go. */
const sendSettings = z.strictObject({
  url: endpointUrl(
    'url is where each decision is sent, written as the address itself: webhook({ url: "https://hooks.example.com/facetdb" })',
  ),
});

/** The settings of one `webhook:<name>` address: the endpoint it names. */
const channelSettings = z.object({ where: z.string().regex(ENDPOINT_NAME, ENDPOINT_NAME_RULE) });

/** What the channel sends: an alert, or a record notification, and its one link. */
export type WebhookAlertPayload = {
  readonly event: "alert" | "notification";
  /** The delivery id: the same on every retry, and in the `facetdb-delivery` header. */
  readonly delivery: string;
  readonly severity: ChannelMessage["severity"];
  /** Plain words: what happened, which project, source and question, and what FacetDB did. */
  readonly text: string;
  /** The one page where it is fixed, or null when the alert has none. */
  readonly link: string | null;
};

/** The store's outbox as one project queues its built-in webhook's deliveries into it. */
export type WebhookOutbox = {
  readonly projectId: string;
  readonly outbox: Pick<Outbox, "enqueue">;
};

/** A built-in that was handed no outbox (`checkChannels` at load, a command that queues none). */
const NO_OUTBOX =
  "this command queues no webhook delivery: the running facetdb worker queues and delivers them";

/**
 * The built-in, its channel queueing into `outbox` when it is given one. The host loads the one
 * with none (`BUILTIN_WEBHOOK`), whose schema and `check` bind an address at load; a process that
 * delivers alerts hands its own outbox through `withOutbox`.
 */
function webhookPlugin(outbox: WebhookOutbox | undefined): Plugin<Settings> {
  return definePlugin({
    name: WEBHOOK_PLUGIN,
    // Shipped inside facetdb, so it is this facetdb's version and runs on any core that ships it.
    version: VERSION,
    facetdb: "*",
    config: settings,
    actions: {
      [WEBHOOK_ACTION]: action({
        config: sendSettings,
        // Never called: the action host queues this action's endpoint rows itself (`webhookStep`),
        // so no action row of it exists for a runner to hand here.
        run: () =>
          Promise.reject(
            new Error(
              "the built-in webhook is queued as a signed delivery, never run as an action",
            ),
          ),
      }),
    },
    channels: {
      [WEBHOOK_CHANNEL]: channel({
        config: channelSettings,
        // A name `endpoints` does not have is refused when the address is bound, not at its first alert.
        check: (ctx: PluginContext<Settings>, chosen: Infer<typeof channelSettings>) => {
          if (Object.hasOwn(ctx.config.endpoints, chosen.where)) {
            return undefined;
          }
          const names = Object.keys(ctx.config.endpoints);
          return `plugins.webhook.endpoints has no endpoint named ${chosen.where}: add ${chosen.where}: "https://…" to it${names.length === 0 ? "" : `, or name one of ${names.join(", ")}`}`;
        },
        // Queueing is the delivery: one insert, so it is quick and well inside the channel host's
        // 20 seconds; a row the store refuses is a failed delivery, which the host keeps in fixed words.
        deliver: async (
          ctx: PluginContext<Settings>,
          message: ChannelMessage,
          chosen: Infer<typeof channelSettings>,
        ) => {
          if (outbox === undefined) {
            throw new Error(NO_OUTBOX);
          }
          const endpoint = ctx.config.endpoints[chosen.where];
          if (endpoint === undefined) {
            throw new Error(`plugins.webhook.endpoints has no endpoint named ${chosen.where}`);
          }
          await outbox.outbox.enqueue({
            projectId: outbox.projectId,
            endpoint,
            origin: { plugin: WEBHOOK_PLUGIN, entry: WEBHOOK_CHANNEL },
            payloadOf: (delivery): WebhookAlertPayload => ({
              event: message.kind === "system-alert" ? "alert" : "notification",
              delivery,
              severity: message.severity,
              text: message.text,
              link: message.link ?? null,
            }),
          });
        },
      }),
    },
  });
}

/** The built-in as the plugin host loads it (`BUILTIN_PLUGINS`): it binds addresses, and queues nothing. */
export const BUILTIN_WEBHOOK: Plugin = webhookPlugin(undefined);

/**
 * `host` with the built-in webhook's channel queueing into `outbox`: what a process that delivers
 * alerts binds its channels with (`bindChannels`). Every other plugin, every setting and every
 * context is the host's own; the built-in's settings were parsed by the same schema.
 */
export function withOutbox(host: PluginHost, outbox: WebhookOutbox): PluginHost {
  const bound = webhookPlugin(outbox);
  const swap = (hosted: HostedPlugin): HostedPlugin =>
    hosted.plugin === BUILTIN_WEBHOOK ? { ...hosted, plugin: bound } : hosted;
  return {
    plugin: (name) => {
      const hosted = host.plugin(name);
      return hosted === undefined ? undefined : swap(hosted);
    },
    all: () => host.all().map(swap),
    contextFor: (name, signal) => host.contextFor(name, signal),
  };
}

/** A signal that never fires: the secret is read, nothing is run. */
const NEVER = new AbortController().signal;

/**
 * The signing secret the built-in's settings read from their variable, or undefined when the
 * config names no webhook. Only the outbox's `secretFor` asks for it; it is never printed.
 */
export function webhookSecret(host: PluginHost): string | undefined {
  const hosted = host.plugin(WEBHOOK_PLUGIN);
  if (hosted === undefined || hosted.plugin !== BUILTIN_WEBHOOK) {
    return undefined;
  }
  return host.contextFor(WEBHOOK_PLUGIN, NEVER).secrets["secret"];
}

/** Whether an action the config names is the built-in webhook's `send`. */
export function isWebhookSend(call: ActionCall): boolean {
  return call.plugin === WEBHOOK_PLUGIN && call.action === WEBHOOK_ACTION;
}

/** Where one source's webhook steps queue: the project's outbox, and the source's store id. */
export type SourceWebhooks = WebhookOutbox & {
  /** The store's id of the source: `sourceIdOf(project, name)`. */
  readonly sourceId: string;
};

/**
 * Why a webhook a plugin queued must not be sent by a worker whose config in force is `config`
 * and whose plugins `host` loaded, or undefined to send it: its endpoint must still be one that
 * config names, a `webhook({ url })` (or its `else`) of any source, or an `endpoints` address of
 * the built-in's settings. A row queued under an older config, or by a `facetdb review` run from a
 * stale copy of it, is closed untried in these fixed words (the outbox's `refuseWebhook`).
 */
export function webhookRefusal(
  config: ProjectConfig,
  host: PluginHost,
  row: { readonly plugin: string; readonly endpoint: string },
): string | undefined {
  if (row.plugin !== WEBHOOK_PLUGIN) {
    return "the webhook was queued by a plugin other than the built-in webhook, so this worker does not send it";
  }
  const named = new Set<string>();
  for (const source of config.sources) {
    for (const call of source.actions.filter(isWebhookSend)) {
      const { url, else: otherwise } = call.config;
      for (const address of [url, (otherwise as { readonly url?: unknown } | undefined)?.url]) {
        if (typeof address === "string") {
          named.add(address);
        }
      }
    }
  }
  if (host.plugin(WEBHOOK_PLUGIN)?.plugin === BUILTIN_WEBHOOK) {
    const settings = host.contextFor(WEBHOOK_PLUGIN, NEVER).config as Settings;
    for (const address of Object.values(settings.endpoints)) {
      named.add(address);
    }
  }
  return named.has(row.endpoint) ? undefined : WEBHOOK_ENDPOINT_GONE;
}

/** Why a webhook row is closed unsent: its endpoint is no longer configured. No address in it. */
export const WEBHOOK_ENDPOINT_GONE =
  "the webhook's endpoint is no longer one the config names (a webhook action's url or plugins.webhook.endpoints), so it is not sent";

/**
 * The step of one `webhook({ url })` (the action host's one rule for a built-in): at the decision,
 * it queues the endpoint row itself through `createWebhookAction`, with today's payload, never an
 * action row. A row names the decision's record and the action's place, so the same decision
 * queued again is the delivery it already has (`WebhookOrigin` in the outbox). The address is
 * checked first, by the rule the plugin's schema applies at load: `facetdb review` queues these
 * rows from its own copy of the config with no plugin loaded, so an address that rule refuses is
 * never queued (a failed action in fixed words, never retried). A row the store does not take is
 * core's `ActionNotQueued`: the job is released and its next pass queues it again.
 */
export function webhookStep(
  source: SourceConfig,
  call: ActionCall,
  position: number,
  webhooks: SourceWebhooks,
): ActionStep {
  const queue = createWebhookAction({
    outbox: webhooks.outbox,
    projectId: webhooks.projectId,
    source: source.name,
    queuedBy: {
      plugin: call.plugin,
      action: call.action,
      sourceId: webhooks.sourceId,
      position,
    },
  });
  return configureAction<WebhookConfig>(
    `${WEBHOOK_CHANNEL}.${WEBHOOK_ACTION}`,
    {
      async run(record, decisions, config) {
        // The file's JSON, as `facetdb review` reads it unchecked: an address is text that the
        // load-time rule takes, or nothing is queued.
        const address: unknown = config.url;
        const problem =
          typeof address === "string"
            ? endpointProblem(address)
            : "url is not written as an address in the config file";
        if (problem !== undefined) {
          throw new Error(`the webhook was not queued, as its url is refused: ${problem}`);
        }
        try {
          await queue.run(record, decisions, config);
        } catch (error) {
          throw new ActionNotQueued(
            `the webhook was not queued, as the store did not take it (${error instanceof Error ? error.message : String(error)}); it is queued again when the worker next writes the record's decision, or a person decides it again`,
            { cause: error },
          );
        }
      },
    },
    // The action host checked `url` and `else` against the action's schema at load, the url
    // written as text (never a variable): this is the invocation core's pipeline reads.
    call.config as ActionInvocation<WebhookConfig>,
  );
}
