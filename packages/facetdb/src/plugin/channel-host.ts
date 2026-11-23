import {
  type AlertSeverity,
  type BoundChannel,
  ChannelFailed,
  type ChannelFailure,
  type ChannelMessage,
  type Clock,
  DELIVERY_WORDS_MAX,
  deliveryWords,
  knownZone,
  processZone,
  type QuietWindow,
} from "@facetdb/core";
import { CREDENTIAL_WORDS_WITHHELD } from "@facetdb/server";
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
 * (`webhook` is the built-in registered in `BUILTIN_PLUGINS`, whose channel queues a signed
 * delivery in the outbox once a process hands it one through `withOutbox`); the channel entry is
 * the one named like the kind, or the plugin's only one; its settings are `{ where }`, parsed by
 * the entry's own schema, then judged by the entry's `check` when it has one. Each refusal says
 * what to do, and stops the worker at load.
 *
 * A bound channel delivers through the plugin's `deliver` with the plugin's context, its signal
 * firing at `DELIVERY_BOUND_MS` or when the worker stops, the call raced against both on the
 * injected clock, so a channel that never settles cannot stall a pass, and no timer outlives the
 * call. A message below the channel's `sends` is not delivered to it, and is no failure.
 *
 * What a channel plugin says is a boundary. A delivery's error is never kept, printed or shown: the
 * host rejects with fixed words of its own (`ChannelFailed`), with no cause, as the plugin and
 * action hosts do for a plugin that holds secrets: a community plugin's message can hold its token
 * or a URL, in forms no search can rule out. One exception (so a test message's failure says what
 * to fix): a first-party plugin's own delivery error (`FIRST_PARTY_DELIVERY_ERRORS`), whose words
 * the plugin builds from fixed words, a reason code and its settings that are not secret, is kept,
 * cleaned, unless it repeats a secret its settings read. The words a `check` returns are meant to
 * be read at load, so they are shown, cleaned and held to a length, unless they repeat any form of
 * a secret the plugin's settings read (`revealsSecret`): then only fixed words are. That rule and
 * its table are shared with the action host (`firstPartyFailure`), and a kept error's wait and
 * refusal for good go with its words (`ChannelRefused`) to a notify action's outbox row.
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

/** What a delivery carries, as its failure's words name it: an alert, or a record notification. */
export type Carried = "alert" | "notification";

function carriedBy(message: ChannelMessage): Carried {
  return message.kind === "record-notification" ? "notification" : "alert";
}

/** A delivery the bound cut off. */
export function deliveryTimedOutWords(carried: Carried): string {
  return `the channel did not answer within ${DELIVERY_BOUND_MS / 1000} seconds, so the delivery was given up (the ${carried} may still arrive)`;
}

export const DELIVERY_TIMED_OUT = deliveryTimedOutWords("alert");

/** A delivery the worker's stop cut off, or one not started because the worker was stopping. */
export function deliveryStoppedWords(carried: Carried): string {
  return `the worker stopped before the channel answered; the ${carried} may or may not have arrived`;
}

export const DELIVERY_STOPPED = deliveryStoppedWords("alert");

/** A channel whose plugin rejected or threw: its own error is not kept. */
export function deliveryFailedWords(plugin: string, carried: Carried = "alert"): string {
  return `the channel plugin ${plugin} did not deliver the ${carried}; its own error is not kept, as it may hold a secret`;
}

/**
 * The delivery errors of FacetDB's own plugins, by package, its channels' and,, its actions' (the
 * action host keeps them by the same rule, from this one table): each is built fresh from fixed
 * words, the address or the issue, the service's reason code or reply, and no cause, and the plugin
 * leaves out a reply that repeats its secret (Telegram's token, the SMTP password). Only an error
 * of this name thrown by that package is kept, and only while its words repeat no secret the
 * plugin's settings read; every other error is the fixed words above.
 */
export const FIRST_PARTY_DELIVERY_ERRORS: Readonly<Record<string, string>> = {
  "@facetdb/slack": "SlackDeliveryError",
  "@facetdb/telegram": "TelegramDeliveryError",
  "@facetdb/email": "EmailDeliveryError",
  "@facetdb/github": "GithubActionError",
};

/**
 * The 4xx statuses worth trying again unchanged: 408 Request Timeout, 425 Too Early and 429 Too
 * Many Requests. Any other 4xx says the request itself is refused, and will be on every try.
 */
const TRIED_AGAIN_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

/** A first-party plugin's own error, its words kept, and what it says of the next try. */
export type FirstPartyFailure = {
  /** Cleaned (control and invisible characters made spaces) and held to the caller's length. */
  readonly words: string;
  /** The wait the service asked for, in milliseconds (`retryAfterMs`, a rate limit's). */
  readonly retryAfterMs?: number;
  /**
   * The same refusal comes back on every try: the error says so (`temporary: false`), or, saying
   * neither way, it carries an HTTP 4xx `status` other than 401, 408, 425 and 429. Never with a
   * wait, never with `credentialRefused`.
   */
  readonly permanent: boolean;
  /**
   * The service refused the plugin's credential: its `status` is 401 and its `temporary` is not
   * `false`. Not permanent, as a rotated credential comes back: the outbox keeps the row on its 24
   * hours of retries and raises Action credential refused at once.
   */
  readonly credentialRefused?: true;
};

/** Text with control and invisible format characters made spaces, held to `max` characters. */
function heldTo(text: string, max: number): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/**
 * Whether a first-party error is refused for good. Its own `temporary` decides when it has one
 * (the email plugin's, whose `status` is an SMTP reply code; GitHub's for a rate limit GitHub
 * answers 403 to); otherwise its `status`, read as HTTP's. Each field is read only as the type it
 * should be: anything else is as if absent.
 */
function refusedForGood(error: Error): boolean {
  const { temporary, status } = error as {
    readonly temporary?: unknown;
    readonly status?: unknown;
  };
  if (typeof temporary === "boolean") {
    return !temporary;
  }
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    !TRIED_AGAIN_4XX.has(status)
  );
}

/**
 * Whether a first-party error says the service refused its credential: an HTTP 401 `status` that
 * its own `temporary` does not mark for good. A 401 marked `temporary: false` is the plugin's word
 * that this refusal comes back on every try, and is refused for good as before.
 */
function credentialRefused(error: Error): boolean {
  const { temporary, status } = error as {
    readonly temporary?: unknown;
    readonly status?: unknown;
  };
  return status === 401 && temporary !== false;
}

/** The wait a first-party error asks for: a whole, finite number of milliseconds from 0, else none. */
function waitAskedFor(error: Error): number | undefined {
  const { retryAfterMs } = error as { readonly retryAfterMs?: unknown };
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined;
}

/**
 * A first-party plugin's own delivery error (`FIRST_PARTY_DELIVERY_ERRORS`: of the class the table
 * names, thrown by that package) with its words, cleaned and held to `max`, and what it says of the
 * next try; undefined for anything else, for empty words, and for words that repeat any form of a
 * value the plugin's settings read (`revealsSecret` over `values`). A community plugin's error is
 * never one, whatever it is named. The channel host keeps these words for a delivery's outcome, and
 * the action host for an outbox row and its give-up alert, with the wait and the refusal for good;
 * an error whose words are not kept says nothing of the next try either.
 */
export function firstPartyFailure(
  packageName: string,
  error: unknown,
  values: readonly string[],
  max: number,
): FirstPartyFailure | undefined {
  const name = FIRST_PARTY_DELIVERY_ERRORS[packageName];
  if (name === undefined || !(error instanceof Error) || error.name !== name) {
    return undefined;
  }
  // Read once: the words kept are the very words searched for a secret, even from a getter.
  const { message } = error;
  const words = heldTo(message, max);
  if (words === "" || revealsSecret(message, values)) {
    return undefined;
  }
  const retryAfterMs = waitAskedFor(error);
  // A refused credential is tried again for its 24 hours, never refused for good.
  const credential = credentialRefused(error);
  return {
    words,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    permanent: retryAfterMs === undefined && !credential && refusedForGood(error),
    ...(credential ? { credentialRefused: true as const } : {}),
  };
}

/**
 * Whether a first-party plugin's own error (`FIRST_PARTY_DELIVERY_ERRORS`) says its credential was
 * refused (a 401, `temporary` not `false`), read whether or not its words are kept: a status is no
 * secret, so a 401 whose words repeat a handed value, or are empty, still raises Action credential
 * refused, in fixed words. A community plugin's error never says it.
 */
export function firstPartyCredentialRefused(packageName: string, error: unknown): boolean {
  const name = FIRST_PARTY_DELIVERY_ERRORS[packageName];
  return (
    name !== undefined && error instanceof Error && error.name === name && credentialRefused(error)
  );
}

/**
 * A delivery a first-party plugin failed in words it may keep (`firstPartyFailure`), as the channel
 * host rejects with it: a `ChannelFailed` to core's alerts as any other, carrying what the error
 * said of the next try for a notify action's row, which the outbox follows.
 */
export class ChannelRefused extends ChannelFailed {
  readonly retryAfterMs: number | undefined;
  readonly permanent: boolean;
  /** The channel's service refused the plugin's credential: a notify row's outbox raises its alert. */
  readonly credentialRefused: boolean;

  constructor(failure: FirstPartyFailure) {
    super(failure.words);
    this.retryAfterMs = failure.retryAfterMs;
    this.permanent = failure.permanent;
    this.credentialRefused = failure.credentialRefused === true;
  }
}

/** Reads the machine's time zone as Node names it, unjudged (core's `processZone`); a test passes its own. */
export type ZoneReader = () => string | undefined;

/**
 * A channel's quiet hours as the worker runs them: in the zone the file names, else this machine's;
 * undefined when it has none. The machine's zone comes from the environment (`TZ`), a boundary, so
 * it is judged here, at load: when Node cannot read it (an empty `TZ` reads as `Etc/Unknown`, one
 * it does not know as no zone at all), the channel is refused in words with the fix. A fall back to
 * UTC was not taken: hours read in a zone nobody chose would hold alerts by day and send them by
 * night, with nothing but a line in a long log to say so.
 */
export function quietWindowFor(
  binding: ChannelBinding,
  index: number,
  machine: ZoneReader,
): QuietWindow | undefined {
  const { quiet } = binding;
  if (quiet === undefined) {
    return undefined;
  }
  const zone = knownZone(quiet.zone ?? machine());
  if (zone !== undefined) {
    return { from: quiet.from, to: quiet.to, zone };
  }
  const at = `alerts.channels[${index}] (${binding.address})`;
  throw quiet.zone === undefined
    ? new PluginHostError(
        "channel-quiet-zone",
        `${at} has quiet hours with no zone, and the time zone of this machine cannot be read (TZ is empty, or names a zone Node does not know), so FacetDB cannot tell when they start and end`,
        `give its quiet hours a zone, such as quiet: { from: "${quiet.from}", to: "${quiet.to}", zone: "Europe/Berlin" }, or start FacetDB with TZ set to an IANA time zone name such as "Europe/Berlin" or "UTC"`,
      )
    : new PluginHostError(
        "channel-quiet-zone",
        `${at} has quiet hours in the zone "${quiet.zone}", which this machine does not know`,
        'write an IANA time zone name this machine knows in quiet.zone, such as "Europe/Berlin" or "UTC"',
      );
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
  /** Its quiet hours as the file writes them (messages are held in them); absent when it gives none. */
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

/**
 * A channel resolved against its plugin: what binding it needs. A notify action's channel is
 * resolved in its own words and delivered through `deliverTo`.
 */
export type ResolvedChannel = {
  readonly binding: ChannelBinding;
  readonly hosted: HostedPlugin;
  readonly entry: ChannelDefinition<unknown>;
  /** `{ where }` as the entry's schema made it. */
  readonly settings: unknown;
  /** Every value the plugin was handed from the environment: no words kept may repeat one. */
  readonly values: readonly string[];
};

type Resolved = ResolvedChannel;

type Env = Readonly<Record<string, string | undefined>>;

/** A signal that never fires: a `check` is called once, at load, with nothing to stop. */
const NEVER = new AbortController().signal;

/** Every value a hosted plugin was handed from the environment: its secrets and its other variables. */
export function valuesOf(host: PluginHost, hosted: HostedPlugin, env: Env): readonly string[] {
  return handedValues(
    host.contextFor(hosted.name, NEVER).secrets,
    hosted.variables.map(({ variable }) => variable),
    env,
  );
}

/**
 * The values a plugin was handed: the secrets of the context it was given, and each named variable
 * read from `env`, none empty. The action host reads them with the context it hands an action, so a
 * reload that puts other settings in force while the action runs changes none of them.
 */
export function handedValues(
  secrets: Readonly<Record<string, string>>,
  variables: readonly string[],
  env: Env,
): readonly string[] {
  return [...Object.values(secrets), ...variables.map((variable) => env[variable])].filter(
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
export function shownWords(words: string, values: readonly string[], kind: string): string {
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
  return { binding, hosted, entry, settings: parsed.data, values };
}

/**
 * Checks every channel the config names against the plugins the host loaded, as `facetdb worker`,
 * `studio`, `dev` and doctor load the config, and its quiet hours against the zone they are read in
 * (`quietWindowFor`; `machine` reads this machine's, a test passes its own): the first refusal is
 * thrown, in words with its fix, never a secret's value. Answers the channels as bound.
 */
export function checkChannels(
  config: ProjectConfig,
  host: PluginHost,
  env: Env,
  machine: ZoneReader = processZone,
): readonly ChannelBinding[] {
  return channelsOf(config).map((binding, index) => {
    const resolved = resolve(host, binding, index, env).binding;
    quietWindowFor(binding, index, machine);
    return resolved;
  });
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
  /**
   * Reads this machine's time zone, which quiet hours with no `zone` are read in; absent, the
   * process's own (`processZone`). Judged at binding, as `checkChannels` judges it.
   */
  readonly machineZone?: ZoneReader;
};

/** A cut-off delivery, told apart from what a plugin rejected with. */
type Cut = { readonly cut: string };

/**
 * Delivers one message through a resolved channel, raced against the bound and the stop; its
 * failure's words name what it carried (an alert, or a record notification, whose notify action
 * delivers through it too).
 */
export async function deliverThrough(
  deps: Pick<ChannelHostDeps, "host" | "clock" | "stop">,
  resolved: Resolved,
  message: ChannelMessage,
): Promise<void> {
  const { clock } = deps;
  const carried = carriedBy(message);
  const stopped = deliveryStoppedWords(carried);
  const stop = deps.stop();
  if (stop.aborted) {
    throw new ChannelFailed(stopped);
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
  const onStop = () => end(stopped);
  stop.addEventListener("abort", onStop, { once: true });
  const cut = new Promise<Cut>((resolveCut) => {
    ended.signal.addEventListener("abort", () => resolveCut({ cut: why ?? stopped }), {
      once: true,
    });
  });
  void clock.sleep(DELIVERY_BOUND_MS, settled.signal).then(
    () => {
      if (!settled.signal.aborted) {
        end(deliveryTimedOutWords(carried));
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
  } catch (error) {
    // Whatever the plugin threw (a `ChannelFailed` of its own included), its cause and properties
    // go nowhere, and its words too unless it is a first-party plugin's own delivery error, whose
    // wait and refusal for good go with them (a notify row's outbox follows them).
    const vouched = firstPartyFailure(
      resolved.hosted.packageName,
      error,
      resolved.values,
      DELIVERY_WORDS_MAX,
    );
    if (vouched !== undefined) {
      throw new ChannelRefused(vouched);
    }
    // Words withheld, a refused credential is still said, in fixed words.
    throw firstPartyCredentialRefused(resolved.hosted.packageName, error)
      ? new ChannelRefused({
          words: CREDENTIAL_WORDS_WITHHELD,
          permanent: false,
          credentialRefused: true,
        })
      : new ChannelFailed(deliveryFailedWords(resolved.hosted.packageName, carried));
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
 * The line the worker prints for a quiet-hours summary a channel did not take: the address and the
 * kept words, and what happens next.
 */
export function summaryFailureLine(failure: ChannelFailure): string {
  return `alert channel ${failure.channel}: ${failure.error}. Its summary of the alerts quiet hours held was not sent; FacetDB tries again in 5 minutes, and each alert is on the Alerts page.`;
}

/**
 * The line the worker prints for a quiet-hours summary a channel took that could not be marked sent
 * in the store: a summary is delivered at least once, and this one may come twice.
 */
export function summaryUnmarkedLine(channel: string): string {
  return `alert channel ${channel}: its summary of the alerts quiet hours held was sent, but could not be marked sent in the store, so a worker may send it again in 5 minutes.`;
}

/**
 * The channels the config names, bound to their plugins: what each `createAlerts` of the process is
 * given. Throws the same refusals as `checkChannels`. A config with no `alerts` binds none.
 */
export function bindChannels(deps: ChannelHostDeps): readonly BoundChannel[] {
  return channelsOf(deps.config).map((binding, index) => {
    const resolved = resolve(deps.host, binding, index, deps.env);
    const quiet = quietWindowFor(binding, index, deps.machineZone ?? processZone);
    return {
      name: binding.address,
      takes: (severity: AlertSeverity) => sendsSeverity(binding.sends, severity),
      ...(quiet === undefined ? {} : { quiet }),
      deliver: (message: ChannelMessage) => deliverThrough(deps, resolved, message),
    };
  });
}
