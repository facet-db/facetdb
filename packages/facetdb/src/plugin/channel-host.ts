import {
  type AlertSeverity,
  type BoundChannel,
  ChannelFailed,
  type ChannelFailure,
  type ChannelMessage,
  type Clock,
  deliveryWords,
} from "@facetdb/core";
import {
  type AlertChannel,
  type AlertSends,
  channelAddressOf,
  channelSendsOf,
  type ProjectConfig,
  type QuietHours,
} from "../config/index.ts";
import { type HostedPlugin, type PluginHost, PluginHostError } from "./host.ts";
import type { ChannelDefinition } from "./kinds.ts";

/**
 * The channel host: every address `alerts.channels` names, bound when the config loads to its
 * plugin's channel through the plugin host. The kind before the colon is a plugin's short name
 * (`webhook` is the built-in once 142 registers it in `BUILTIN_PLUGINS`; until then it is refused
 * as any plugin not installed is); the channel entry is the one named like the kind, or the
 * plugin's only one; its settings are `{ where }`, parsed by the entry's own schema, then judged by
 * the entry's `check` when it has one. Each refusal says what to do, and stops the worker at load.
 *
 * A bound channel delivers through the plugin's `deliver` with the plugin's context, its signal
 * firing at `DELIVERY_BOUND_MS` or when the worker stops, the call raced against both on the
 * injected clock, so a channel that never settles cannot stall a pass, and no timer outlives the
 * call. A message below the channel's `sends` is not delivered to it, and is no failure.
 *
 * What a channel plugin says is a boundary. A delivery's error is never kept, printed or shown: the
 * host rejects with fixed words of its own (`ChannelFailed`), with no cause, as the plugin and
 * action hosts do for a plugin that holds secrets: a community plugin's message can hold its token
 * or a URL, in forms no search can rule out. The words a `check` returns are meant to be read at
 * load, so they are shown, cleaned and held to a length, unless they repeat any form of a secret
 * the plugin's settings read (`revealsSecret`): then only fixed words are.
 */

/**
 * How long one delivery may take before the host gives it up. A community plugin may set no bound
 * of its own: this is the one bound. 20 seconds: strictly shorter than every caller's own wait on a
 * raise, the outbox's 30 seconds for an "Action gave up" alert (`DEFAULT_FETCH_TIMEOUT_MS`), with
 * ten left for the store's writes around the delivery, so a hanging channel never turns a recorded
 * alert into a failed raise. Slack and Telegram end their own requests at 10 seconds; the email
 * plugin may wait up to 30 for an idle SMTP server, and a send that slow is cut here and recorded
 * as not delivered (it may still arrive).
 */
export const DELIVERY_BOUND_MS = 20_000;

/** The longest a `check`'s words are shown. */
const CHECK_WORDS_MAX = 300;

/** A delivery the bound cut off. */
export const DELIVERY_TIMED_OUT = `the channel did not answer within ${DELIVERY_BOUND_MS / 1000} seconds, so the delivery was given up (the alert may still arrive)`;

/** A delivery the worker's stop cut off, or one not started because the worker was stopping. */
export const DELIVERY_STOPPED =
  "the worker stopped before the channel answered; the alert may or may not have arrived";

/** A channel whose plugin rejected or threw: its own error is not kept. */
export function deliveryFailedWords(plugin: string): string {
  return `the channel plugin ${plugin} did not deliver the alert; its own error is not kept, as it may hold a secret`;
}

/** One channel of the config as the worker runs it: its address, what it sends, its quiet hours. */
export type ChannelBinding = {
  /** `slack:#ops`, as the file writes it. */
  readonly address: string;
  /** The plugin's short name: `slack`. */
  readonly kind: string;
  /** What the channel's `where` setting is given: `#ops`. */
  readonly where: string;
  readonly sends: AlertSends;
  /** Carried for 156; absent when the file gives none. */
  readonly quiet?: QuietHours;
};

/** The channels the config names, in its order, read from the file alone (no plugin is asked). */
export function channelsOf(config: ProjectConfig): readonly ChannelBinding[] {
  return (config.alerts?.channels ?? []).map(bindingOf);
}

function bindingOf(channel: AlertChannel): ChannelBinding {
  const address = channelAddressOf(channel);
  const colon = address.indexOf(":");
  return {
    address,
    kind: address.slice(0, colon),
    where: address.slice(colon + 1),
    sends: channelSendsOf(channel),
    ...(typeof channel === "string" || channel.quiet === undefined ? {} : { quiet: channel.quiet }),
  };
}

/** Whether a channel that sends `sends` is sent an alert of `severity`. */
export function sendsSeverity(sends: AlertSends, severity: AlertSeverity): boolean {
  if (sends === "critical") {
    return severity === "critical";
  }
  if (sends === "warnings") {
    return severity === "critical" || severity === "warning";
  }
  return true;
}

/** A channel resolved against its plugin: what binding it needs. */
type Resolved = {
  readonly binding: ChannelBinding;
  readonly hosted: HostedPlugin;
  readonly entry: ChannelDefinition<unknown>;
  /** `{ where }` as the entry's schema made it. */
  readonly settings: unknown;
};

type Env = Readonly<Record<string, string | undefined>>;

/** A signal that never fires: a `check` is called once, at load, with nothing to stop. */
const NEVER = new AbortController().signal;

/** Every value a hosted plugin was handed from the environment: its secrets and its other variables. */
function valuesOf(host: PluginHost, hosted: HostedPlugin, env: Env): readonly string[] {
  const secrets = Object.values(host.contextFor(hosted.name, NEVER).secrets);
  const variables = hosted.variables.map(({ variable }) => env[variable]);
  return [...secrets, ...variables].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/** The 8-character pieces of `text` (or `text` itself when shorter): one of them in words is enough. */
function piecesOf(text: string): readonly string[] {
  if (text.length <= 8) {
    return text === "" ? [] : [text];
  }
  const pieces: string[] = [];
  for (let at = 0; at + 8 <= text.length; at += 1) {
    pieces.push(text.slice(at, at + 8));
  }
  return pieces;
}

/**
 * The forms a secret is written in when a plugin repeats it: as it is, percent-encoded, as a JSON
 * string's inside, and in base64 and base64url at each of the three byte alignments (the stable
 * middle of each, which is what an encoded secret inside longer text shares).
 */
function formsOf(secret: string): readonly string[] {
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  const bytes = Buffer.from(secret, "utf8");
  for (let offset = 0; offset < 3; offset += 1) {
    const shifted = Buffer.concat([Buffer.alloc(offset, 0), bytes]);
    for (const encoding of ["base64", "base64url"] as const) {
      const encoded = shifted.toString(encoding).replace(/=+$/, "");
      // The first group mixes in the padding bytes, the last one the end: neither is the secret's own.
      const middle = encoded.slice(offset === 0 ? 0 : 4, -4);
      if (middle.length > 0) {
        forms.push(middle);
      }
    }
  }
  return forms;
}

/** Text with every space, control, format (zero-width, bidi) and line-separator character taken out. */
function squeezed(text: string): string {
  return text.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

/**
 * Whether `words` repeat any form of any value: the whole value when it is 8 characters or fewer,
 * or any 8 characters in a row of a longer one, as written, percent-encoded or in base64. The
 * words are searched as written, as they would be shown (cleaned), and with every invisible or
 * space character taken out, so a secret broken up by zero-width characters or spaces is still
 * found; every comparison ignores case. Out of reach, said plainly: a secret written in hex,
 * reversed, or in any other encoding a plugin invents; only these forms are searched for.
 */
export function revealsSecret(words: string, values: readonly string[]): boolean {
  const readings = [words, deliveryWords(words), squeezed(words)].map((text) => text.toLowerCase());
  return values.some((value) =>
    formsOf(value).some((form) =>
      piecesOf(squeezed(form).toLowerCase()).some((piece) =>
        readings.some((reading) => reading.includes(piece)),
      ),
    ),
  );
}

/** A plugin's words for a refusal, cleaned and held to a length; fixed words when they repeat a secret. */
function shownWords(words: string, values: readonly string[], kind: string): string {
  if (revealsSecret(words, values)) {
    return `the ${kind} plugin's reason is not shown, as it repeats a value its settings read from the environment`;
  }
  const plain = deliveryWords(words);
  return plain.length <= CHECK_WORDS_MAX ? plain : `${plain.slice(0, CHECK_WORDS_MAX - 1)}…`;
}

/** The plugin's channel entry for a kind: the one named like it, or its only one. */
function entryOf(
  hosted: HostedPlugin,
  binding: ChannelBinding,
  at: string,
): ChannelDefinition<unknown> {
  const entries = hosted.plugin.channels;
  const names = Object.keys(entries);
  if (Object.hasOwn(entries, binding.kind)) {
    return entries[binding.kind] as ChannelDefinition<unknown>;
  }
  if (names.length === 1) {
    return entries[names[0] as string] as ChannelDefinition<unknown>;
  }
  throw new PluginHostError(
    "plugin-no-channel",
    names.length === 0
      ? `${at} (${binding.address}) names the plugin "${hosted.packageName}", which provides no alert channel`
      : `${at} (${binding.address}) names the plugin "${hosted.packageName}", whose channels are ${names.join(", ")}, none of them named "${binding.kind}"`,
    names.length === 0
      ? `take ${binding.address} out of alerts.channels, or install a plugin that provides a channel named "${binding.kind}"`
      : `take ${binding.address} out of alerts.channels, or ask the plugin's author to name its alert channel "${binding.kind}"`,
  );
}

/**
 * One channel of the config resolved against the plugins the host loaded: its plugin is hosted,
 * provides a channel for the kind, the entry's schema takes `{ where }`, and its `check` (when it
 * has one) finds nothing to refuse. Throws the refusal in words with its fix.
 */
function resolve(host: PluginHost, binding: ChannelBinding, index: number, env: Env): Resolved {
  const at = `alerts.channels[${index}]`;
  const hosted = host.plugin(binding.kind);
  if (hosted === undefined) {
    // The host loads every plugin the config names when the worker starts, and refuses one that
    // is not installed then; a channel named only since (a reload) was never loaded.
    throw new PluginHostError(
      "plugin-not-installed",
      `${at} (${binding.address}) names the channel "${binding.kind}", and no plugin of that name was loaded when this worker started`,
      `run facetdb add ${binding.kind} in the project, then start facetdb worker again; or take ${binding.address} out of alerts.channels`,
    );
  }
  const entry = entryOf(hosted, binding, at);
  const values = valuesOf(host, hosted, env);

  let parsed: ReturnType<typeof entry.config.safeParse>;
  try {
    parsed = entry.config.safeParse({ where: binding.where });
  } catch {
    // A schema that throws is the plugin's fault; what it threw is not kept.
    throw new PluginHostError(
      "channel-where",
      `${at} (${binding.address}): the schema of the plugin "${hosted.packageName}"'s channel failed while it read where "${binding.where}", instead of refusing it in words`,
      `check the part of ${binding.address} after the colon against the plugin's documentation, or ask its author to make its channel schema refuse a value rather than fail`,
    );
  }
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) =>
      shownWords(issue.message, values, binding.kind),
    );
    throw new PluginHostError(
      "channel-where",
      `${at} (${binding.address}) is refused by the plugin "${hosted.packageName}": ${lines.join("; ")}`,
      `change the part of ${binding.address} after the colon as the plugin says, or take it out of alerts.channels`,
    );
  }

  if (entry.check !== undefined) {
    let answer: unknown;
    try {
      answer = entry.check(host.contextFor(hosted.name, NEVER), parsed.data);
    } catch {
      throw new PluginHostError(
        "channel-where",
        `${at} (${binding.address}): the plugin "${hosted.packageName}" failed while it checked the channel, instead of answering in words`,
        `check the plugin's settings and ${binding.address} against its documentation, or ask its author to make its check answer in words`,
      );
    }
    if (answer !== undefined) {
      if (typeof answer !== "string") {
        // A check typed to answer words that answered a promise or another value: refused, and a
        // promise is given a handler so its later rejection stops nothing.
        if (answer instanceof Promise) {
          answer.catch(() => undefined);
        }
        throw new PluginHostError(
          "channel-where",
          `${at} (${binding.address}): the plugin "${hosted.packageName}" answered its channel check with something other than words`,
          "install a version of the plugin whose channel check answers in words, or ask its author to fix it",
        );
      }
      throw new PluginHostError(
        "channel-where",
        `${at} (${binding.address}) cannot be delivered to: ${shownWords(answer, values, binding.kind)}`,
        `do what the plugin "${hosted.packageName}" says in its settings or in ${binding.address}, or take it out of alerts.channels`,
      );
    }
  }
  return { binding, hosted, entry, settings: parsed.data };
}

/**
 * Checks every channel the config names against the plugins the host loaded, as `facetdb worker`,
 * `studio`, `dev` and doctor load the config: the first refusal is thrown, in words with its fix,
 * never a secret's value. Answers the channels as bound.
 */
export function checkChannels(
  config: ProjectConfig,
  host: PluginHost,
  env: Env,
): readonly ChannelBinding[] {
  return channelsOf(config).map((binding, index) => resolve(host, binding, index, env).binding);
}

export type ChannelHostDeps = {
  readonly config: ProjectConfig;
  /** The plugins the config names, loaded when it loaded. */
  readonly host: PluginHost;
  /** The worker's environment: a `check`'s words never repeat a value it read from it. */
  readonly env: Env;
  /** The injected clock the bound runs on. */
  readonly clock: Clock;
  /**
   * Fires when the worker stops: every delivery in flight is given up then. Read at each delivery,
   * as the provider reads it, so a command that never delivers never asks for it.
   */
  readonly stop: () => AbortSignal;
};

/** A cut-off delivery, told apart from what a plugin rejected with. */
type Cut = { readonly cut: string };

/** Delivers one message through a resolved channel, raced against the bound and the stop. */
async function deliverThrough(
  deps: ChannelHostDeps,
  resolved: Resolved,
  message: ChannelMessage,
): Promise<void> {
  const { clock } = deps;
  const stop = deps.stop();
  if (stop.aborted) {
    throw new ChannelFailed(DELIVERY_STOPPED);
  }
  // The plugin's signal: it fires at the bound or at the stop, whichever comes first.
  const ended = new AbortController();
  // Ends the bound's wait once the call settles, so no timer is left behind.
  const settled = new AbortController();
  let why: string | undefined;
  const end = (words: string) => {
    why ??= words;
    ended.abort();
  };
  const onStop = () => end(DELIVERY_STOPPED);
  stop.addEventListener("abort", onStop, { once: true });
  const cut = new Promise<Cut>((resolveCut) => {
    ended.signal.addEventListener("abort", () => resolveCut({ cut: why ?? DELIVERY_STOPPED }), {
      once: true,
    });
  });
  void clock.sleep(DELIVERY_BOUND_MS, settled.signal).then(
    () => {
      if (!settled.signal.aborted) {
        end(DELIVERY_TIMED_OUT);
      }
    },
    // A clock that cannot wait leaves the stop as the only end: nothing to report from here.
    () => undefined,
  );
  const call = Promise.resolve().then(() =>
    resolved.entry.deliver(
      deps.host.contextFor(resolved.hosted.name, ended.signal),
      message,
      resolved.settings,
    ),
  );
  // A call given up on may still reject later: that rejection is nobody's to hear.
  call.catch(() => undefined);
  let outcome: Cut | undefined;
  try {
    outcome = await Promise.race([call.then(() => undefined), cut]);
  } catch {
    // Whatever the plugin threw (a `ChannelFailed` of its own included), its words, cause and
    // properties go nowhere.
    throw new ChannelFailed(deliveryFailedWords(resolved.hosted.packageName));
  } finally {
    settled.abort();
    stop.removeEventListener("abort", onStop);
  }
  if (outcome !== undefined) {
    throw new ChannelFailed(outcome.cut);
  }
}

/**
 * The line a command prints for a delivery that failed (core's `report`): the channel's address,
 * as the file writes it, and the words the history keeps, never what the plugin threw.
 */
export function deliveryFailureLine(failure: ChannelFailure): string {
  return `alert channel ${failure.channel}: ${failure.error}. The alert is recorded, with this delivery's outcome, on the Alerts page.`;
}

/**
 * The channels the config names, bound to their plugins: what each `createAlerts` of the process is
 * given. Throws the same refusals as `checkChannels`. A config with no `alerts` binds none.
 */
export function bindChannels(deps: ChannelHostDeps): readonly BoundChannel[] {
  return channelsOf(deps.config).map((binding, index) => {
    const resolved = resolve(deps.host, binding, index, deps.env);
    return {
      name: binding.address,
      takes: (severity: AlertSeverity) => sendsSeverity(binding.sends, severity),
      deliver: (message: ChannelMessage) => deliverThrough(deps, resolved, message),
    };
  });
}
