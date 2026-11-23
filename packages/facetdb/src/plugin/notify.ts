import {
  type ActionCondition,
  type ActionDecisions,
  type ActionRecord,
  ChannelFailed,
  type ChannelMessage,
  type Clock,
  chosenWords,
  conditionHolds,
  type Decision,
  likelyYes,
  percent,
  quietPeriodAt,
  RECORD_STATUSES,
  type RecordStatus,
} from "@facetdb/core";
import {
  type ActionClose,
  ActionFailed,
  DIGEST_AFTER,
  type DigestDelivery,
  type TimeSpan,
} from "@facetdb/server";
import { z } from "zod";
import {
  type ActionCall,
  formatPath,
  type JsonValue,
  type ProjectConfig,
} from "../config/index.ts";
import type { ActionSource } from "./action-host.ts";
import { WEBHOOK_PLUGIN } from "./builtin/webhook.ts";
import {
  ChannelRefused,
  channelsOf,
  deliverThrough,
  quietWindowFor,
  type ResolvedChannel,
  shownWords,
  valuesOf,
  type ZoneReader,
} from "./channel-host.ts";
import { shortName } from "./define.ts";
import { type HostedPlugin, type PluginHost, PluginHostError } from "./host.ts";
import type { ChannelDefinition } from "./kinds.ts";
import { printableKey } from "./source-connector.ts";

/**
 * Record notifications: every plugin that provides an alert channel has a `notify` action without
 * declaring one. Its settings are `channel` (or, the same, `to`): what follows the colon in that
 * plugin's alert channel address, checked by the channel's own schema, and its `check`, when the
 * config loads. Its step queues one outbox row as any action does, with a batch key of the source,
 * the action's place and the channel, and the condition it was queued under; the outbox's digest
 * rule runs the first 10 of a minute one by one through `sendNotification` and hands the rest of
 * that minute, or every row queued in the channel's quiet hours, to the digest's runner here, once.
 *
 * A notification says the source, the record's key (as `printableKey` shows it) and each question
 * its condition names with its decided value and how sure the model was, and links the record's
 * "why" page; never the record's state, never a secret, never what a plugin threw. A digest says how
 * many more records matched, on which source and which condition, and links the Decisions list of
 * that source over the time those records were decided.
 */

/** The settings of one notify as the file writes them, `when` and `else` left out. */
type Settings = { readonly [key: string]: JsonValue };

type Env = Readonly<Record<string, string | undefined>>;

/** The settings a notify takes besides `when`: the channel, under either name. */
const NOTIFY_SETTINGS = ["channel", "to"] as const;

/** The channel a notify's settings name, under `channel` or `to`; undefined when neither is text. */
export function channelOf(settings: { readonly [key: string]: unknown }): string | undefined {
  const named = settings["channel"] ?? settings["to"];
  return typeof named === "string" ? named : undefined;
}

/** The alert channel address a notify sends to: the plugin's short name, a colon, the channel. */
export function notifyAddress(plugin: string, channel: string): string {
  return `${shortName(plugin) ?? plugin}:${channel}`;
}

/**
 * The batch key of a notify's rows: the source, the action's place in its `actions` and the
 * channel's address, so a digest gathers one notification of one source to one channel, never
 * across sources or actions. JSON, so no name can run into the next.
 */
export function batchKeyOf(source: string, position: number, address: string): string {
  return JSON.stringify([source, position, address]);
}

const batchKeySchema = z.tuple([z.string(), z.number(), z.string()]);

/** The channel address of a batch key read back from the store: a database row, judged first. */
function batchAddress(batchKey: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(batchKey);
  } catch {
    return undefined;
  }
  const checked = batchKeySchema.safeParse(parsed);
  return checked.success ? checked.data[2] : undefined;
}

/** What a notify's step adds to its row: the batch key, and the condition it was queued under. */
export type NotifyQueueing = {
  readonly batchKey: string;
  readonly condition: ActionCondition;
  /** The action's settings and `when` as core's pipeline judges them: never an `else`. */
  readonly invocation: Settings & { readonly when?: ActionCondition };
};

/**
 * How a notify of `source` at `position` queues its rows. A notification has no `else` (the load
 * refuses one): it is sent when its condition holds, and nothing is queued otherwise, so a question
 * still waiting for a person never reaches a notification (the pipeline's rule).
 */
export function notifyQueueing(source: string, call: ActionCall, position: number): NotifyQueueing {
  const { when, else: _otherwise, ...settings } = call.config;
  // The config's schema judged `when` against the source's questions when the file loaded.
  const condition = (when ?? {}) as ActionCondition;
  return {
    batchKey: batchKeyOf(source, position, notifyAddress(call.plugin, channelOf(settings) ?? "")),
    condition,
    invocation: when === undefined ? settings : { ...settings, when: condition },
  };
}

/** Whether a plugin has a `notify`: it provides an alert channel, and is not the built-in webhook. */
export function providesChannel(hosted: HostedPlugin): boolean {
  return hosted.packageName !== WEBHOOK_PLUGIN && Object.keys(hosted.plugin.channels).length > 0;
}

/** The plugin's channel a notify sends through: the one named like the plugin, or its only one. */
function notifyEntry(hosted: HostedPlugin): ChannelDefinition<unknown> | undefined {
  const entries = hosted.plugin.channels;
  if (Object.hasOwn(entries, hosted.name)) {
    return entries[hosted.name] as ChannelDefinition<unknown>;
  }
  const names = Object.keys(entries);
  return names.length === 1
    ? (entries[names[0] as string] as ChannelDefinition<unknown>)
    : undefined;
}

/** A signal that never fires: a `check` is called once, at load, with nothing to stop. */
const NEVER = new AbortController().signal;

/**
 * A notify's channel resolved against its plugin, refused in words naming `where` and the fix: a
 * plugin with no channel (or several, none named like it), the built-in webhook (whose own
 * `webhook({ url, when })` sends each decision), `else`, a setting a notify does not take, no
 * channel or two, a channel the plugin's schema refuses, and, with `check`, one the plugin's
 * `check` says it can never deliver to.
 */
function resolveNotify(
  host: PluginHost,
  hosted: HostedPlugin,
  call: ActionCall,
  where: string,
  env: Env,
  check: boolean,
): ResolvedChannel {
  const what = `${where} (${call.plugin} notify)`;
  if (hosted.packageName === WEBHOOK_PLUGIN) {
    throw new PluginHostError(
      "plugin-no-action",
      `${what}: the built-in webhook has no notify; it sends each decision through its own action`,
      `write webhook({ url: "https://hooks.example.com/facetdb", when: { ... } }) in ${where} instead`,
    );
  }
  const entry = notifyEntry(hosted);
  if (entry === undefined) {
    const names = Object.keys(hosted.plugin.channels);
    const actions = Object.keys(hosted.plugin.actions);
    throw names.length === 0
      ? new PluginHostError(
          "plugin-no-action",
          `${what}: notify sends a record notification through the plugin's alert channel, and the plugin "${hosted.packageName}" provides none${
            actions.length === 0 ? "" : ` (its actions are ${actions.join(", ")})`
          }`,
          actions.length === 0
            ? `take ${where} out of the config, or notify through a plugin that provides a channel, such as slack.notify({ channel: "#ops" })`
            : `change ${where}.action to one of ${actions.join(", ")}, or notify through a plugin that provides a channel`,
        )
      : new PluginHostError(
          "plugin-no-channel",
          `${what}: the plugin "${hosted.packageName}" has the channels ${names.join(", ")}, none named "${hosted.name}", so notify cannot tell which one to send through`,
          `take ${where} out of the config, or ask the plugin's author to name its alert channel "${hosted.name}"`,
        );
  }
  const { when: _when, else: otherwise, ...settings } = call.config;
  const lines: string[] = [];
  if (otherwise !== undefined) {
    lines.push(
      `${where}.else: a notification has no else: it is sent when its condition holds and nothing is sent otherwise (for another channel, add a second notify with a condition of its own)`,
    );
  }
  for (const key of Object.keys(settings)) {
    if (!(NOTIFY_SETTINGS as readonly string[]).includes(key)) {
      lines.push(
        `${formatPath([where, key])}: is not a setting of notify (its settings: channel, or the same under to, and when)`,
      );
    }
  }
  if (settings["channel"] !== undefined && settings["to"] !== undefined) {
    lines.push(`${where}: channel and to are the same setting; write one of them`);
  }
  const channel = channelOf(settings);
  if (channel === undefined || channel === "") {
    lines.push(
      `${where}.channel: is the channel to send to, as text: what follows "${hosted.name}:" in an alert channel address, such as channel: "${hosted.name === "slack" ? "#ops" : "..."}"`,
    );
  }
  if (lines.length > 0 || channel === undefined) {
    throw new PluginHostError(
      "action-settings",
      `the settings of ${what} are refused:\n${lines.map((line) => `  - ${line}`).join("\n")}`,
      `change ${where} in the config file as each line says`,
    );
  }

  const values = valuesOf(host, hosted, env);
  const address = notifyAddress(hosted.packageName, channel);
  let parsed: ReturnType<typeof entry.config.safeParse>;
  try {
    parsed = entry.config.safeParse({ where: channel });
  } catch {
    // A schema that throws is the plugin's fault; what it threw is not kept.
    throw new PluginHostError(
      "channel-where",
      `${what}: the schema of the plugin "${hosted.packageName}"'s channel failed while it read the channel "${channel}", instead of refusing it in words`,
      `check ${where}.channel against the plugin's documentation, or ask its author to make its channel schema refuse a value rather than fail`,
    );
  }
  if (!parsed.success) {
    throw new PluginHostError(
      "channel-where",
      `${what} sends to ${address}, which the plugin "${hosted.packageName}" refuses: ${parsed.error.issues
        .map((issue) => shownWords(issue.message, values, hosted.name))
        .join("; ")}`,
      `change ${where}.channel as the plugin says`,
    );
  }
  if (check && entry.check !== undefined) {
    let answer: unknown;
    try {
      answer = entry.check(host.contextFor(hosted.name, NEVER), parsed.data);
    } catch {
      throw new PluginHostError(
        "channel-where",
        `${what}: the plugin "${hosted.packageName}" failed while it checked the channel ${address}, instead of answering in words`,
        `check the plugin's settings and ${where}.channel against its documentation, or ask its author to make its check answer in words`,
      );
    }
    if (answer !== undefined) {
      if (answer instanceof Promise) {
        answer.catch(() => undefined);
      }
      throw new PluginHostError(
        "channel-where",
        typeof answer === "string"
          ? `${what} sends to ${address}, which cannot be delivered to: ${shownWords(answer, values, hosted.name)}`
          : `${what}: the plugin "${hosted.packageName}" answered its channel check with something other than words`,
        typeof answer === "string"
          ? `do what the plugin "${hosted.packageName}" says in its settings or in ${where}.channel`
          : "install a version of the plugin whose channel check answers in words, or ask its author to fix it",
      );
    }
  }
  return {
    binding: { address, kind: hosted.name, where: channel, sends: "everything" },
    hosted,
    entry,
    settings: parsed.data,
    values,
  };
}

/**
 * Checks one notify as the config names it, at load (`checkActions`): its plugin, loaded by the
 * host, provides an alert channel, and the channel its settings name passes that channel's schema
 * and `check`. Throws the refusal in words with its fix, never a secret's value.
 */
export function checkNotify(
  host: PluginHost,
  hosted: HostedPlugin,
  call: ActionCall,
  where: string,
  env: Env,
): void {
  resolveNotify(host, hosted, call, where, env, true);
}

/** What sending a notification needs besides the plugins: the bound's clock, the stop, the links. */
export type NotifyDeps = {
  readonly clock: Clock;
  /** Fires when the worker stops: a delivery in flight is given up then. */
  readonly stop: () => AbortSignal;
  /** A record's "why" page (links.ts); absent with no studio. */
  readonly recordLink: (source: string, key: string) => string | undefined;
  /** The Decisions list of a source over a range of decision times (links.ts); absent with no studio. */
  readonly listLink: (
    source: string,
    range: { readonly from: Date; readonly to: Date },
  ) => string | undefined;
};

/** "a, b and c". */
function listed(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1) as string}`;
}

/** How sure the model was of a decided value: "97% likely yes" for a noul, "91% sure" otherwise. */
function sureWords(decision: Extract<Decision, { readonly kind: "decided" }>): string {
  return typeof decision.value === "boolean"
    ? likelyYes(decision.probabilityOrConfidence)
    : `${percent(decision.probabilityOrConfidence)} sure`;
}

/**
 * A condition in words: "urgency is high and wants_refund's probability is at least 90%", "every
 * decision" when it has no term.
 */
export function conditionWords(condition: ActionCondition): string {
  const terms = Object.entries(condition).map(([term, expected]) => {
    if (typeof expected === "object") {
      const dot = term.lastIndexOf(".");
      return `${term.slice(0, dot)}'s ${term.slice(dot + 1)} is at least ${percent(expected.atLeast)}`;
    }
    return term === "status"
      ? `the status is ${String(expected)}`
      : `${term} is ${chosenWords(expected)}`;
  });
  return terms.length === 0 ? "every decision" : listed(terms);
}

/** The questions a condition names, each once, in its order: `urgency` for `urgency.confidence` too. */
function namedQuestions(condition: ActionCondition): readonly string[] {
  const names = Object.keys(condition)
    .filter((term) => term !== "status")
    .map((term) =>
      term.endsWith(".probability") || term.endsWith(".confidence")
        ? term.slice(0, term.lastIndexOf("."))
        : term,
    );
  return [...new Set(names)];
}

/**
 * A record notification's words: the source, the record's key as `printableKey` shows it, and each
 * question the condition names with its decided value and how sure the model was; the status when
 * the condition names it. Never the record's state.
 */
export function notificationText(
  source: string,
  key: string,
  status: RecordStatus,
  decisions: ActionDecisions,
  condition: ActionCondition,
): string {
  const head = `Record ${printableKey(key)} on ${source}`;
  const parts = namedQuestions(condition).flatMap((name) => {
    const decision = decisions[name];
    return decision?.kind === "decided"
      ? [`${name} is ${chosenWords(decision.value)} (${sureWords(decision)})`]
      : [];
  });
  if (Object.hasOwn(condition, "status")) {
    parts.push(`its status is ${status}`);
  }
  if (parts.length > 0) {
    return `${head} matched: ${listed(parts)}.`;
  }
  // No condition: every decision of the source is sent, a record left for a person's review too.
  return status === "needs_review"
    ? `${head} waits for a person's review: the model was not sure enough to decide it.`
    : `${head} was decided (its status is ${status}).`;
}

/**
 * A digest's words: how many more records matched, on which source and which condition; for a
 * quiet period's digest, which channel's quiet hours held them. The records are not read again (a
 * person may have decided one since, or it may wait for review now), so the words say the count
 * is as each was decided at the time; the list shows each record as it is now.
 */
export function digestText(digest: {
  readonly source: string;
  readonly records: number;
  readonly condition: ActionCondition;
  readonly window: DigestDelivery["window"];
  readonly address: string;
}): string {
  const { records, source, condition } = digest;
  const counted = `${records} ${records === 1 ? "record" : "records"} on ${source}`;
  const matched =
    Object.keys(condition).length === 0
      ? `${records === 1 ? "was" : "were"} decided or left for a person's review`
      : `matched ${conditionWords(condition)}`;
  const asDecided = "the count is as each was decided at the time";
  return digest.window.kind === "quiet"
    ? `While ${digest.address} was in quiet hours, ${counted} ${matched}; ${asDecided}.`
    : `${records} more ${records === 1 ? "record" : "records"} on ${source} ${matched} within the same minute, after the first ${DIGEST_AFTER} were sent one by one; ${asDecided}.`;
}

/**
 * Delivers a message through a resolved channel; the channel host's words are the failure, with,
 * for a first-party plugin's own error (`ChannelRefused`), the wait it asked for and whether its
 * refusal is for good, which the outbox follows for the row or the whole digest.
 */
async function deliver(
  host: PluginHost,
  deps: NotifyDeps,
  resolved: ResolvedChannel,
  message: ChannelMessage,
  signal: AbortSignal,
): Promise<void> {
  try {
    await deliverThrough(
      { host, clock: deps.clock, stop: () => AbortSignal.any([deps.stop(), signal]) },
      resolved,
      message,
    );
  } catch (error) {
    // The host's words carry no secret and nothing the plugin threw (channel-host.ts).
    if (error instanceof ChannelRefused) {
      throw new ActionFailed(error.message, {
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        permanent: error.permanent,
        // The channel's service refused the plugin's credential (a 401).
        ...(error.credentialRefused ? { credentialRefused: true } : {}),
      });
    }
    throw error instanceof ChannelFailed ? new ActionFailed(error.message) : error;
  }
}

/** A channel resolved at delivery: a refusal there is a failure in the host's own words. */
function resolvedAtDelivery(
  host: PluginHost,
  hosted: HostedPlugin,
  call: ActionCall,
  where: string,
  env: Env,
): ResolvedChannel {
  try {
    return resolveNotify(host, hosted, call, where, env, false);
  } catch (error) {
    // Words built here, a plugin's own shown only when they repeat no secret (`shownWords`).
    throw error instanceof PluginHostError
      ? new ActionFailed(`the notification cannot be sent now: ${error.message}`)
      : error;
  }
}

/** One notification as the action runner hands it on, the record read and the decision still its. */
export type Notification = {
  readonly host: PluginHost;
  readonly hosted: HostedPlugin;
  readonly env: Env;
  readonly deps: NotifyDeps;
  readonly signal: AbortSignal;
  /** The source's name in the config. */
  readonly source: string;
  readonly position: number;
  /** The record as the runner read it: its key and status are said, its state never is. */
  readonly record: ActionRecord;
  readonly decisions: ActionDecisions;
  /** As queued: the channel, under `channel` or `to`. */
  readonly settings: Settings;
  readonly condition: ActionCondition;
};

/**
 * Sends one record notification through its plugin's channel: run alone, one of the first 10 of
 * its minute (the outbox's digest rule). A condition that does not hold for the decision closes
 * the row (a process that checks no plugin, `facetdb review`, may have queued an `else`).
 */
export async function sendNotification(
  notification: Notification,
): Promise<ActionClose | undefined> {
  const { record, decisions, condition, source } = notification;
  if (!conditionHolds(condition, record, decisions)) {
    return {
      close:
        "the notification's condition does not hold for this decision, so it is not sent (a notification has no else)",
    };
  }
  const call: ActionCall = {
    plugin: notification.hosted.packageName,
    action: "notify",
    config: notification.settings,
  };
  const resolved = resolvedAtDelivery(
    notification.host,
    notification.hosted,
    call,
    `${source}'s actions[${notification.position}]`,
    notification.env,
  );
  const link = notification.deps.recordLink(source, record.key);
  await deliver(
    notification.host,
    notification.deps,
    resolved,
    {
      kind: "record-notification",
      severity: "information",
      text: notificationText(source, record.key, record.status, decisions, condition),
      ...(link === undefined ? {} : { link }),
    },
    notification.signal,
  );
  return undefined;
}

/** A notify row's payload as the store gives it back, for a digest: judged before it is used. */
const conditionSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.string(), z.strictObject({ atLeast: z.number() })]),
);

const digestPayloadSchema = z.object({
  status: z.enum(RECORD_STATUSES),
  decidedAt: z.iso.datetime(),
  settings: z.record(z.string(), z.json()),
  condition: conditionSchema,
});

/** The condition a notify row was queued under, read back from its payload; `{}` when it has none. */
export function payloadCondition(payload: unknown): ActionCondition | undefined {
  const parsed = z.object({ condition: conditionSchema.optional() }).safeParse(payload);
  return parsed.success ? (parsed.data.condition ?? {}) : undefined;
}

export type DigestRunnerDeps = {
  readonly host: PluginHost;
  readonly env: Env;
  readonly notify: NotifyDeps;
  /** The source a digest names, by its store id, as the action runner finds it. */
  readonly source: (sourceId: string) => ActionSource;
};

/**
 * The runner the outbox calls for a digest: the rest of a minute's notifications of one source,
 * action and channel, or every one its channel's quiet hours held, sent as one message: how many
 * records, which condition, and the Decisions list of that source from the first of their decisions
 * to the last. The records are not read again: the digest counts what matched when it was decided,
 * and the list shows each record as it is now. A source no longer in the config, or a plugin no
 * longer loaded, closes the digest's rows untried.
 */
export function createDigestRunner(
  deps: DigestRunnerDeps,
): (digest: DigestDelivery, signal: AbortSignal) => Promise<ActionClose | undefined> {
  return async (digest, signal) => {
    const source = deps.source(digest.sourceId);
    if (source.kind === "gone") {
      return { close: "the source is no longer in the config, so the digest is not sent" };
    }
    const hosted = deps.host.plugin(digest.plugin);
    if (hosted === undefined) {
      return {
        close: `the plugin ${digest.plugin} is no longer one this worker runs, so the digest is not sent`,
      };
    }
    const payloads = digest.rows.map((row) => digestPayloadSchema.safeParse(row.payload));
    const read = payloads.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    const [first] = read;
    if (first === undefined || read.length < payloads.length) {
      throw new ActionFailed("a notification of the digest could not be read back from the store");
    }
    const call: ActionCall = {
      plugin: hosted.packageName,
      action: "notify",
      config: first.settings as Settings,
    };
    const resolved = resolvedAtDelivery(
      deps.host,
      hosted,
      call,
      `${source.name}'s actions[${digest.position}]`,
      deps.env,
    );
    const decided = read.map((payload) => Date.parse(payload.decidedAt));
    const link = deps.notify.listLink(source.name, {
      from: new Date(Math.min(...decided)),
      // `to` is not included: one past the last decision.
      to: new Date(Math.max(...decided) + 1),
    });
    const condition = first.condition as ActionCondition;
    await deliver(
      deps.host,
      deps.notify,
      resolved,
      {
        kind: "record-notification",
        severity: "information",
        text: digestText({
          source: source.name,
          records: new Set(digest.rows.map((row) => row.recordKey)).size,
          condition,
          window: digest.window,
          address: resolved.binding.address,
        }),
        ...(link === undefined ? {} : { link }),
      },
      signal,
    );
    return undefined;
  };
}

/**
 * The quiet period of a batch's channel at an instant (the outbox's `quietPeriod`): the quiet hours
 * of the alert channel in `alerts.channels` with the same plugin and the same channel as the
 * notify's, read in their zone as the channel host reads them; none for a channel `alerts.channels`
 * does not name, or names without quiet hours. A batch key that cannot be read has none: its row is
 * run, and its runner fails it in words.
 */
export function notifyQuiet(
  config: ProjectConfig,
  host: PluginHost,
  machine: ZoneReader,
): (batchKey: string, at: number) => TimeSpan | undefined {
  // The channel host refused unreadable quiet hours when the config loaded.
  const windows = channelsOf(config).flatMap((binding, index) => {
    const window = quietWindowFor(binding, index, machine);
    const packageName = host.plugin(binding.kind)?.packageName;
    return window === undefined || packageName === undefined
      ? []
      : [{ packageName, where: binding.where, window }];
  });
  return (batchKey, at) => {
    if (windows.length === 0) {
      return undefined;
    }
    const address = batchAddress(batchKey);
    const colon = address?.indexOf(":") ?? -1;
    if (address === undefined || colon < 0) {
      return undefined;
    }
    const packageName = host.plugin(address.slice(0, colon))?.packageName;
    const where = address.slice(colon + 1);
    const found = windows.find(
      (entry) => entry.packageName === packageName && entry.where === where,
    );
    return found === undefined ? undefined : quietPeriodAt(found.window, at);
  };
}
