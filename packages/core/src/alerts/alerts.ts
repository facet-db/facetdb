import type { ChannelMessage, Clock } from "../contracts/index.ts";
import {
  ALERT_TITLES,
  ALERT_WINDOW_MS,
  type AlertEvent,
  type AlertKind,
  type AlertSeverity,
  alertMessage,
  eventKey,
  FAILURE_WINDOW_MS,
  resolvedMessage,
} from "./events.ts";
import { isQuiet, lastQuietPeriod, type QuietPeriod, type QuietWindow } from "./quiet-hours.ts";

/** An alert that has been raised and not yet resolved. */
export type ActiveAlert = {
  readonly event: AlertEvent;
  readonly raisedAt: number;
  /** When a channel last took the message; null while none has. */
  readonly lastSentAt: number | null;
  /**
   * When channels were last tried for this event and none has taken that message yet: written
   * before they are tried, cleared once one takes it. While it is less than `RETRY_EVERY_MS` old no
   * channel is tried again for the event, the raise or the resolved message alike, in this process
   * or another, and after a restart. Absent or null: nothing waits.
   */
  readonly lastTriedAt?: number | null;
};

/**
 * How often channels are tried again for an event no channel has taken: a raise or a resolved
 * message waiting on a channel that is down costs one attempt, one history line and one printed
 * line per this long, never one per model call. Five minutes: a channel back within it hears of the
 * event within five minutes, a down one is tried six times per 30-minute alert window, and the wait
 * is far longer than any delivery's bound, so attempts never overlap.
 */
export const RETRY_EVERY_MS = 5 * 60_000;

/**
 * One channel's outcome for one message: the channel's address, whether it took the message, and
 * when it did not, why in words the binder vouches for (`ChannelFailed`) or the fixed
 * `DELIVERY_ERROR_NOT_KEPT`, never what a channel plugin threw.
 */
export type AlertDelivery = {
  readonly channel: string;
  readonly ok: boolean;
  readonly error?: string;
};

/** One line of the alert history the dashboard reads; events are recorded in the store. */
export type AlertRecord = {
  readonly at: number;
  readonly key: string;
  readonly phase: "raised" | "resolved";
  readonly severity: AlertSeverity;
  readonly event: AlertEvent;
  /** False when every channel tried refused the message (and, until they answer, while they are tried). */
  readonly delivered: boolean;
  /**
   * Each channel tried, in the config's order. Absent when no channel was tried: none is
   * configured, or none sends this severity; a channel whose `sends` leaves the message out is not
   * a delivery and is not listed. Empty while the channels are being tried: the line is recorded
   * before any channel is, and settled with their outcomes once they answer.
   */
  readonly deliveries?: readonly AlertDelivery[];
  /**
   * The channels whose quiet hours held the message, in the config's order: not tried, not among
   * `deliveries`, and named in the summary each is sent when its hours end. Absent when none held
   * it. A message every channel held was tried on none, so it is `delivered`, as one with no
   * channel to try always was.
   */
  readonly held?: readonly string[];
  /**
   * True while the line's channels are being tried: written with the line, removed by `settle`. A
   * line that still says so was being delivered when it was read, or its worker stopped before the
   * channels answered: whether any took it is not known. Absent on every other line.
   */
  readonly pending?: true;
};

/** What the channels made of a recorded line: `settle` writes it into the line and drops `pending`. */
export type AlertSettlement = {
  readonly delivered: boolean;
  readonly deliveries: readonly AlertDelivery[];
};

/** One worker of a project and the time of its last beat on the store's clock (ms since the epoch). */
export type WorkerBeat = { readonly worker: string; readonly at: number };

/** What `takeDeadWorkers` answers: the rows it took, and how many workers of the project still beat. */
export type DeadWorkers = {
  /** The workers whose last beat is old enough, each given to exactly one caller. */
  readonly taken: readonly WorkerBeat[];
  /**
   * Workers of the project whose last beat is newer than the window, the caller's own among them.
   * Read by the statement that took the rows, so 0 when it took none (there is nothing to say yet).
   */
  readonly beating: number;
};

/**
 * A channel's quiet-hours summary as the store keeps it, under `quietKey`: the latest period whose
 * summary a worker claimed, and whether a channel took it. Two workers that read the same state and
 * claim it at once (`swapQuietState`) leave one claim: one summary is sent.
 */
export type QuietSummaryState = {
  /** The end of the period whose summary was claimed, in ms: the summary names what was held before it. */
  readonly until: number;
  /** Where its held messages begin: the end of the last summary the channel took, or the period's start. */
  readonly since: number;
  /** When it was claimed to be sent; another try waits `RETRY_EVERY_MS` after it. */
  readonly triedAt: number;
  /** When the channel took it (or it was found to hold nothing); null while it has not. */
  readonly sentAt: number | null;
};

/** A message quiet hours held for a channel, as its summary names it. */
export type HeldMessage = {
  /** Its event's key: an event held twice is named once. */
  readonly key: string;
  readonly phase: "raised" | "resolved";
  readonly severity: AlertSeverity;
  readonly kind: AlertKind;
  readonly source: string;
};

/**
 * Where alert state survives a restart: the alerts awaiting resolution, the history, the last
 * heartbeat of each project (what Home reads) and one heartbeat row per running worker of a project
 * (what the other workers read).
 */
export type AlertStore = {
  getActive(key: string): Promise<ActiveAlert | undefined>;
  setActive(key: string, alert: ActiveAlert): Promise<void>;
  clearActive(key: string): Promise<void>;
  /** Records one history line; answers its id, which `settle` names. */
  append(record: AlertRecord): Promise<string>;
  /** Writes what the channels made of the line `append` answered `id` for. */
  settle(id: string, settlement: AlertSettlement): Promise<void>;
  lastHeartbeat(project: string): Promise<number | undefined>;
  saveHeartbeat(project: string, at: number): Promise<void>;
  /**
   * Saves the worker's own row, replacing its last beat, stamped with the store's clock (the
   * database's, the one every worker of the project shares: two machines whose own clocks differ
   * must not make one worker look dead to the other). Answers the time it stamped.
   */
  saveWorkerBeat(project: string, worker: string): Promise<number>;
  /** Removes the worker's own row: a clean stop. */
  removeWorkerBeat(project: string, worker: string): Promise<void>;
  /**
   * Takes, in one statement that deletes and returns them, every row of `project` other than
   * `except` whose last beat is `olderThanMs` or more behind the store's clock (the same clock
   * that stamped it): of two workers that look at once, exactly one gets each row.
   */
  takeDeadWorkers(project: string, except: string, olderThanMs: number): Promise<DeadWorkers>;
  /** The quiet-hours summary state kept under `key` (`quietKey`), or undefined. */
  quietState(key: string): Promise<QuietSummaryState | undefined>;
  /**
   * Writes `next` under `key` only while the state there is still `expected` (none, when
   * undefined), in one statement, and answers whether it wrote: of two workers that read the same
   * state and swap it at once, exactly one does.
   */
  swapQuietState(
    key: string,
    expected: QuietSummaryState | undefined,
    next: QuietSummaryState,
  ): Promise<boolean>;
  /**
   * The history lines of `project` whose message was held for `channel`, at or after `since` and
   * before `until` (ms, the line's `at`), in the order they were recorded.
   */
  heldFor(
    project: string,
    channel: string,
    since: number,
    until: number,
  ): Promise<readonly HeldMessage[]>;
};

/**
 * A channel with its configuration already bound; the composition root builds these (the facetdb
 * package's channel host). It bounds its own `deliver`: the host races each call against a fixed
 * bound and the worker's stop on the injected clock.
 */
export type BoundChannel = {
  /** Its address, `slack:#ops`: what a delivery and a failure name. */
  readonly name: string;
  /**
   * Whether the channel is sent an alert of this severity (its `sends`); absent, every one. A
   * message it is not sent is not delivered to it, and that is no failure and no delivery.
   */
  takes?(severity: AlertSeverity): boolean;
  /**
   * Its quiet hours, the zone already the channel's or the machine's; absent, it has none. Inside
   * them a warning or information message is held for it, and sent in one summary when they end; a
   * critical one is delivered.
   */
  readonly quiet?: QuietWindow;
  /**
   * Rejects when the channel did not take the message. Only a `ChannelFailed`'s words are kept;
   * anything else is recorded as `DELIVERY_ERROR_NOT_KEPT`.
   */
  deliver(message: ChannelMessage): Promise<void>;
};

/**
 * A delivery's failure in words the binder vouches for (the channel host's fixed words: the bound,
 * the stop, a plugin that failed): they are kept in the history, shown on the Alerts page and
 * printed. Any other error a channel rejects with is not kept, since a plugin's error may hold its
 * token or a URL.
 */
export class ChannelFailed extends Error {}

/** The words of a failed delivery whose error was not a `ChannelFailed`. */
export const DELIVERY_ERROR_NOT_KEPT =
  "the channel did not take the alert; its error is not kept, as a channel plugin's error may hold a secret";

/** The longest a delivery's words are kept. */
export const DELIVERY_WORDS_MAX = 300;

/**
 * A delivery's words as they may be kept and shown: control and invisible format characters
 * replaced by a space, held to `DELIVERY_WORDS_MAX`. The history's reader applies it again: a
 * database row is a boundary.
 */
export function deliveryWords(text: string): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  return plain.length <= DELIVERY_WORDS_MAX ? plain : `${plain.slice(0, DELIVERY_WORDS_MAX - 1)}…`;
}

export type AlertsDeps = {
  readonly store: AlertStore;
  readonly clock: Clock;
  readonly channels: readonly BoundChannel[];
  /**
   * Told of every delivery that failed, as it fails (the worker prints a line). A failed delivery
   * never stops a raise: it is recorded with the event's history line.
   */
  readonly report?: (failure: ChannelFailure) => void;
};

/** A channel that did not take a message, and why in words that may be kept (`AlertDelivery.error`). */
export type ChannelFailure = { readonly channel: string; readonly error: string };

export type AlertOutcome = {
  /**
   * `sent`: raised (or raised again after 30 minutes) and recorded. `suppressed`: the same event
   * was sent less than 30 minutes ago, or channels were tried for it less than `RETRY_EVERY_MS` ago
   * and none took it (it was recorded then). `resolved`: the resolved message went out. `idle`:
   * nothing was active under that key (or no channel took the resolved message, or the pace holds,
   * so it stays active).
   */
  readonly status: "sent" | "suppressed" | "resolved" | "idle";
  /** Channels that refused the message; a failed delivery is reported, never swallowed. */
  readonly failures: readonly ChannelFailure[];
};

/** Where an event happened and the page that fixes it; the detectors build their events from it. */
export type AlertScope = {
  readonly project: string;
  readonly source: string;
  readonly link: string;
};

/** What the worker and the backfill tell the alerts module, bound to one scope. */
export type AlertSignals = {
  /** One model call finished, well or badly; judges the failure rate over the last 5 minutes. */
  modelCall(ok: boolean): Promise<void>;
  /** The worker is alive. */
  beat(): Promise<void>;
  backfillFinished(summary: {
    /** Asked and written by the run itself (an added-question run). */
    readonly answered: number;
    /** Put in the worker's queue (a whole-set run); the worker answers them. */
    readonly queued: number;
    readonly question: string | null;
  }): Promise<void>;
  backfillFailed(summary: {
    readonly failed: number;
    readonly question: string | null;
  }): Promise<void>;
};

export type Alerts = {
  /** One alert per event key per 30 minutes until `resolve`. */
  raise(event: AlertEvent): Promise<AlertOutcome>;
  /**
   * Sends the resolved message once a channel takes it, and waits for it; later calls find nothing
   * active. A healthy model call does not wait: it starts the same delivery off its path.
   */
  resolve(key: string): Promise<AlertOutcome>;
  signals(scope: AlertScope): AlertSignals;
  /**
   * Waits for every resolved message still on its way (never rejects): what the worker awaits at
   * its stop, once the channel host's stop signal has ended any delivery in flight.
   */
  drain(): Promise<void>;
  /**
   * The worker's tick: sends each channel whose quiet period has ended one summary of what it held
   * then, the channels side by side, claimed once across every worker of the store and every
   * restart, and delivered at least once (`SummaryReport.unmarked`). Costs no store round trip
   * until a period has ended that this process has not seen summarized. Never rejects: what went
   * wrong is in the report.
   */
  summarize(page: AlertsPage): Promise<SummaryReport>;
  /**
   * The Alerts page's test button: one information message marked as a test, through the channel at
   * `address`, now, whatever its quiet hours and `sends`. Never recorded in the history.
   */
  test(address: string, page: AlertsPage): Promise<ChannelTest>;
};

/** The project a summary or a test message speaks for, and the link to its Alerts page. */
export type AlertsPage = { readonly project: string; readonly link: string };

/** What one tick of the quiet-hours summaries came to: the worker prints each part. */
export type SummaryReport = {
  /** Channels that did not take their summary: any worker tries again `RETRY_EVERY_MS` later. */
  readonly failures: readonly ChannelFailure[];
  /**
   * Channels that took their summary when it could not be marked sent in the store (the mark lost
   * its swap, or the store failed): the claim's time stands, so a worker may send it again
   * `RETRY_EVERY_MS` later. A summary is delivered at least once, not exactly once.
   */
  readonly unmarked: readonly string[];
  /** True when the store failed for one channel or more: their summaries wait for the next tick. */
  readonly storeFailed: boolean;
};

/**
 * A test message's outcome: the channel took it; no channel of the config has that address; or it
 * did not take it, why in the words a delivery's failure is kept in (never what a plugin threw).
 */
export type ChannelTest =
  | { readonly kind: "sent" }
  | { readonly kind: "unknown_channel" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * How long after a quiet period ends its summary waits: a message judged held just before the end
 * is recorded before the summary reads the history, and a worker whose clock is a little behind
 * holds nothing the summary has already gone without.
 */
export const SUMMARY_GRACE_MS = 60_000;

/** The most held events a summary names one by one; the rest are counted. */
export const SUMMARY_NAMES_MAX = 20;

/** Where a channel's quiet-hours summary state is kept in the store (a key no event has). */
export function quietKey(project: string, channel: string): string {
  return ["quiet", project, channel].join("|");
}

/** The summary a channel is sent when its quiet hours end: how many were held, and each by name. */
export function summaryMessage(page: AlertsPage, held: readonly HeldMessage[]): ChannelMessage {
  // One entry per event and phase, in the order first held: an event held twice is named once.
  const entries = new Map<string, HeldMessage>();
  for (const message of held) {
    const id = `${message.phase}|${message.key}`;
    if (!entries.has(id)) {
      entries.set(id, message);
    }
  }
  const listed = [...entries.values()];
  const names = listed
    .slice(0, SUMMARY_NAMES_MAX)
    .map(
      (message) =>
        `${message.phase === "resolved" ? "Resolved: " : ""}${ALERT_TITLES[message.kind]} (${message.source})`,
    );
  const more = listed.length - names.length;
  const count = listed.length === 1 ? "1 alert was" : `${listed.length} alerts were`;
  return {
    kind: "system-alert",
    severity: listed.some((message) => message.severity === "warning") ? "warning" : "information",
    text: `Quiet hours are over. ${count} held for this channel while they lasted, in project ${page.project}: ${names.join("; ")}${more > 0 ? `; and ${more} more` : ""}. Each is on the Alerts page.`,
    link: page.link,
  };
}

/** The test message the Alerts page sends through a channel: information, and marked as a test. */
export function testMessage(page: AlertsPage): ChannelMessage {
  return {
    kind: "system-alert",
    severity: "information",
    text: `Test message from FacetDB, sent from the Alerts page: this channel receives the alerts of project ${page.project}. Nothing happened, and nothing needs doing.`,
    link: page.link,
  };
}

type Call = { readonly at: number; readonly ok: boolean };

type Delivery = {
  readonly reached: boolean;
  readonly failures: readonly ChannelFailure[];
  readonly deliveries: readonly AlertDelivery[];
};

/** Where one message goes: the channels tried now, and the addresses whose quiet hours hold it. */
type Route = { readonly to: readonly BoundChannel[]; readonly held: readonly string[] };

/** One channel's summary this tick: nothing to say, a refusal, or a delivery not marked sent. */
type SummaryOutcome =
  | undefined
  | { readonly kind: "failed"; readonly failure: ChannelFailure }
  | { readonly kind: "unmarked"; readonly channel: string };

/**
 * Whether quiet hours hold a message of `severity` for `channel` at `at`: never a critical one. A
 * window whose zone cannot be read (the channel host refuses one at load) holds nothing: the message
 * is delivered, and no failure of the arithmetic ever takes a raise, or another channel, down.
 */
function holds(channel: BoundChannel, severity: AlertSeverity, at: number): boolean {
  if (severity === "critical" || channel.quiet === undefined) {
    return false;
  }
  try {
    return isQuiet(channel.quiet, at);
  } catch {
    return false;
  }
}

/** The latest ended period of a window, or undefined when there is none or its zone cannot be read. */
function endedPeriod(window: QuietWindow, at: number): QuietPeriod | undefined {
  try {
    return lastQuietPeriod(window, at);
  } catch {
    return undefined;
  }
}

/** The words a failed delivery is kept with: a `ChannelFailed`'s, cleaned, or the fixed ones. */
function failureWords(error: unknown): string {
  if (error instanceof ChannelFailed) {
    const words = deliveryWords(error.message);
    return words === "" ? DELIVERY_ERROR_NOT_KEPT : words;
  }
  return DELIVERY_ERROR_NOT_KEPT;
}

export function createAlerts(deps: AlertsDeps): Alerts {
  const { store, clock, channels, report } = deps;
  /** The sliding window of model calls this process made, oldest first. */
  let calls: Call[] = [];
  /**
   * Event keys this process knows hold no active alert: it resolved them, or found none to resolve.
   * A healthy model call resolves `model_failing` only while its key is not known clear, so a run
   * of healthy calls reads the alert store once instead of once per call (a round trip per answered
   * record). A raise forgets its key, and so does each heartbeat (once per pass), so an alert
   * another process raised under the same key is still resolved within a pass.
   */
  const knownClear = new Set<string>();
  /** The check in flight per key, which concurrent healthy calls (the worker's lanes) all wait on. */
  const clearing = new Map<string, Promise<void>>();
  /** Raises per key, so a check that a raise overtook does not mark the key clear. */
  const raises = new Map<string, number>();
  /** The raise per event key that is trying channels now; a raise of the same key meanwhile shares it. */
  const sending = new Map<string, Promise<AlertOutcome>>();
  /** The resolved message per key on its way to the channels, off the record path. */
  const resolving = new Map<string, Promise<void>>();
  /**
   * Per key, the time before which no channel is tried again (an attempt no channel took): this
   * process's copy of the stored `lastTriedAt`, so a healthy call reads no store while it holds.
   */
  const pacedUntil = new Map<string, number>();
  /** A store failure around a resolved message delivered off the path, said at the next model call. */
  let storeError: { readonly error: unknown } | undefined;
  /**
   * Per channel of a project (`quietKey`), the end of the latest quiet period this process knows
   * was summarized: a tick costs nothing more until the next period has ended.
   */
  const summarized = new Map<string, number>();
  /** Per channel of a project, the time before which its summary is not looked at again. */
  const summaryPacedUntil = new Map<string, number>();

  /** The channels an event of `severity` is sent to, in the config's order (each one's `sends`). */
  function taking(severity: AlertSeverity): readonly BoundChannel[] {
    return channels.filter((channel) => channel.takes?.(severity) ?? true);
  }

  /**
   * Of the channels an event of `severity` is sent to, the ones tried at `at` and the addresses of
   * the ones whose quiet hours hold it then: a warning or information message only, never a
   * critical one, which always goes through.
   */
  function routeOf(severity: AlertSeverity, at: number): Route {
    const to: BoundChannel[] = [];
    const held: string[] = [];
    for (const channel of taking(severity)) {
      if (holds(channel, severity, at)) {
        held.push(channel.name);
      } else {
        to.push(channel);
      }
    }
    return { to, held };
  }

  /**
   * Tries every channel side by side, never one after another. A channel that throws, rejects or is
   * cut off by its bound is a failed delivery, reported (unless `reporting` is false: the caller
   * says it) and returned, never thrown: the others are delivered all the same.
   */
  async function deliver(
    to: readonly BoundChannel[],
    message: ChannelMessage,
    reporting = true,
  ): Promise<Delivery> {
    const results = await Promise.allSettled(
      // A `deliver` that throws before it returns a promise is a rejection like any other.
      to.map((channel) => Promise.resolve().then(() => channel.deliver(message))),
    );
    const failures: ChannelFailure[] = [];
    const deliveries: AlertDelivery[] = [];
    results.forEach((result, index) => {
      const channel = to[index] as BoundChannel;
      if (result.status === "fulfilled") {
        deliveries.push({ channel: channel.name, ok: true });
        return;
      }
      const failure = { channel: channel.name, error: failureWords(result.reason) };
      failures.push(failure);
      deliveries.push({ channel: channel.name, ok: false, error: failure.error });
      if (!reporting) {
        return;
      }
      try {
        report?.(failure);
      } catch {
        // Reporting is a courtesy: the failure is recorded with the event either way.
      }
    });
    // With no channel to send it to the event is only recorded, and that counts as sent.
    return { reached: to.length === 0 || failures.length < to.length, failures, deliveries };
  }

  /** Whether channels were tried for this event less than `RETRY_EVERY_MS` ago and none took it. */
  function waiting(active: ActiveAlert | undefined, now: number): boolean {
    return active?.lastTriedAt != null && now - active.lastTriedAt < RETRY_EVERY_MS;
  }

  /**
   * One alert per event key: the same event raised again while its channels are still being tried
   * (the worker's lanes failing at once) shares that raise and its outcome or its failure, so it is
   * posted once (a delivery takes up to its bound, where it took no time before channels existed).
   * With no channel to try (none, or quiet hours hold it for each), each raise runs as it always
   * did.
   */
  function raise(event: AlertEvent): Promise<AlertOutcome> {
    const key = eventKey(event);
    knownClear.delete(key);
    raises.set(key, (raises.get(key) ?? 0) + 1);
    const message = alertMessage(event);
    const now = clock.now();
    const route = routeOf(message.severity, now);
    if (route.to.length === 0) {
      return raiseNow(key, event, message, route, now);
    }
    const inFlight = sending.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const attempt = raiseNow(key, event, message, route, now).finally(() => sending.delete(key));
    sending.set(key, attempt);
    return attempt;
  }

  /**
   * A message held for every channel it goes to is recorded, with the channels that held it, and
   * counts as sent, as one with no channel to try always did: the same event is not recorded again
   * for 30 minutes, and the summary names it once the hours end.
   */
  async function raiseNow(
    key: string,
    event: AlertEvent,
    message: ChannelMessage,
    { to, held }: Route,
    now: number,
  ): Promise<AlertOutcome> {
    const active = await store.getActive(key);
    if (active?.lastSentAt != null && now - active.lastSentAt < ALERT_WINDOW_MS) {
      return { status: "suppressed", failures: [] };
    }
    // Tried less than 5 minutes ago and no channel took it: recorded then; nothing is tried, written
    // or printed until the pace allows the next attempt.
    if (to.length > 0 && waiting(active, now)) {
      return { status: "suppressed", failures: [] };
    }
    // Recorded before any channel is tried: a channel that hangs, or a worker that dies while one
    // is tried, never loses the alert. With no channel to try the line is the one it always was.
    const id = await store.append({
      at: now,
      key,
      phase: "raised",
      severity: message.severity,
      event,
      delivered: to.length === 0,
      ...(held.length === 0 ? {} : { held }),
      ...(to.length === 0 ? {} : { deliveries: [], pending: true as const }),
    });
    const raisedAt = active?.raisedAt ?? now;
    const lastSentAt = active?.lastSentAt ?? null;
    if (to.length > 0) {
      // The attempt is written before it is made: a worker that dies or restarts mid-delivery
      // finds it, and waits out the pace instead of trying again at once.
      await store.setActive(key, { event, raisedAt, lastSentAt, lastTriedAt: now });
    }
    const { reached, failures, deliveries } = await deliver(to, message);
    await store.setActive(key, {
      event,
      raisedAt,
      lastSentAt: reached ? now : lastSentAt,
      ...(to.length === 0 ? {} : { lastTriedAt: reached ? null : now }),
    });
    if (to.length > 0) {
      if (reached) {
        pacedUntil.delete(key);
      } else {
        pacedUntil.set(key, now + RETRY_EVERY_MS);
      }
      await store.settle(id, { delivered: reached, deliveries });
    }
    return { status: "sent", failures };
  }

  async function resolve(key: string): Promise<AlertOutcome> {
    const active = await store.getActive(key);
    if (active === undefined) {
      return { status: "idle", failures: [] };
    }
    return resolveActive(key, active);
  }

  /**
   * Sends the resolved message of an active alert once a channel takes it, then clears the alert
   * and records the resolved line. Until one does the alert stays active, its `lastTriedAt` the
   * last attempt, and no resolved line is written: the history keeps it open, as it is until
   * someone hears that it is over. Paced like a raise: no attempt within `RETRY_EVERY_MS` of one no
   * channel took. Quiet hours judge it by the event's own severity: a warning's resolved message is
   * held as the warning was, a critical alert's goes through as it did.
   */
  async function resolveActive(key: string, active: ActiveAlert): Promise<AlertOutcome> {
    // Who hears that it is over is who heard of it: the channels that send the event's own severity.
    const now = clock.now();
    const { to, held } = routeOf(alertMessage(active.event).severity, now);
    if (to.length > 0) {
      if (waiting(active, now)) {
        pacedUntil.set(key, (active.lastTriedAt as number) + RETRY_EVERY_MS);
        return { status: "idle", failures: [] };
      }
      await store.setActive(key, { ...active, lastTriedAt: now });
    }
    const { reached, failures, deliveries } = await deliver(to, resolvedMessage(active.event));
    if (!reached) {
      // Stays active, the attempt written: the next one waits out the pace.
      pacedUntil.set(key, now + RETRY_EVERY_MS);
      return { status: "idle", failures };
    }
    pacedUntil.delete(key);
    await store.clearActive(key);
    await store.append({
      // A held line keeps the time it was held at, inside the quiet period its summary covers.
      at: held.length === 0 ? clock.now() : now,
      key,
      phase: "resolved",
      severity: "information",
      event: active.event,
      delivered: true,
      ...(held.length === 0 ? {} : { held }),
      ...(to.length === 0 ? {} : { deliveries }),
    });
    return { status: "resolved", failures };
  }

  async function checkModel(scope: AlertScope): Promise<void> {
    const now = clock.now();
    calls = calls.filter((call) => call.at > now - FAILURE_WINDOW_MS);
    const failed = calls.filter((call) => !call.ok).length;
    // More than 5%, compared in integers so no rounding decides it.
    if (failed * 100 > calls.length * 5) {
      await raise({
        kind: "model_failing",
        what: `${failed} of ${calls.length} model calls failed in the last 5 minutes.`,
        ...scope,
        question: null,
        did: "Retrying with backoff; a record that cannot be answered is marked error and asked again.",
      });
    } else {
      const key = modelKey(scope);
      if (knownClear.has(key)) {
        return;
      }
      let pending = clearing.get(key);
      if (pending === undefined) {
        pending = clear(key).finally(() => clearing.delete(key));
        clearing.set(key, pending);
      }
      await pending;
    }
  }

  /**
   * Resolves `key`, and remembers it is clear unless the alert stayed active or was raised
   * meanwhile. A healthy model call waits for the store's answer, never for a channel: the resolved
   * message is delivered off the record path, one delivery per key at a time, tracked in
   * `resolving` and awaited by `drain`; while it is on its way, or while the pace holds after one
   * no channel took, a healthy call costs nothing, not even a read of the store. With no channel to
   * send it to, the resolve runs here, as it always did.
   */
  async function clear(key: string): Promise<void> {
    const paced = pacedUntil.get(key);
    if (resolving.has(key) || (paced !== undefined && clock.now() < paced)) {
      return;
    }
    const raisedBefore = raises.get(key) ?? 0;
    const markClear = (outcome: AlertOutcome) => {
      if (outcome.status === "resolved" && (raises.get(key) ?? 0) === raisedBefore) {
        knownClear.add(key);
      }
    };
    const active = await store.getActive(key);
    if (active === undefined) {
      if ((raises.get(key) ?? 0) === raisedBefore) {
        knownClear.add(key);
      }
      return;
    }
    if (taking(alertMessage(active.event).severity).length === 0) {
      markClear(await resolveActive(key, active));
      return;
    }
    const delivery = resolveActive(key, active)
      .then(markClear, (error: unknown) => {
        // The store failed around the delivery: said at the next model call, as before.
        storeError ??= { error };
      })
      .finally(() => resolving.delete(key));
    resolving.set(key, delivery);
  }

  function modelKey(scope: AlertScope): string {
    return eventKey({ kind: "model_failing", ...scope, question: null });
  }

  function signals(scope: AlertScope): AlertSignals {
    return {
      async modelCall(ok) {
        calls.push({ at: clock.now(), ok });
        await checkModel(scope);
        const failed = storeError;
        if (failed !== undefined) {
          storeError = undefined;
          throw failed.error;
        }
      },
      async beat() {
        knownClear.delete(modelKey(scope));
        // The project's own row, which Home reads. No alert resolves here: a worker that died is
        // alerted once by another worker and the alert never resolves.
        await store.saveHeartbeat(scope.project, clock.now());
      },
      async backfillFinished({ answered, queued, question }) {
        await raise({
          kind: "backfill_finished",
          what:
            queued > 0
              ? `The backfill finished: ${queued} records queued for the worker, ${answered} answered.`
              : `The backfill finished: ${answered} records answered.`,
          ...scope,
          question,
          did: "Every page was settled; the cursor is cleared.",
        });
      },
      async backfillFailed({ failed, question }) {
        await raise({
          kind: "backfill_failed",
          what: `The backfill stopped: ${failed} records could not be answered.`,
          ...scope,
          question,
          did: "Stopped at the failing page; the next run resumes there and asks only what is unanswered.",
        });
      },
    };
  }

  async function drain(): Promise<void> {
    while (resolving.size > 0) {
      await Promise.all([...resolving.values()]);
    }
  }

  /** Every quiet channel's summary side by side: a channel that hangs to its bound holds no other. */
  async function summarize(page: AlertsPage): Promise<SummaryReport> {
    const quiet = channels.flatMap((channel) =>
      channel.quiet === undefined ? [] : [{ channel, window: channel.quiet }],
    );
    const outcomes = await Promise.allSettled(
      quiet.map(({ channel, window }) => summarizeFor(channel, window, page)),
    );
    const failures: ChannelFailure[] = [];
    const unmarked: string[] = [];
    let storeFailed = false;
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        storeFailed = true;
      } else if (outcome.value?.kind === "failed") {
        failures.push(outcome.value.failure);
      } else if (outcome.value?.kind === "unmarked") {
        unmarked.push(outcome.value.channel);
      }
    }
    return { failures, unmarked, storeFailed };
  }

  /**
   * One channel's summary of its latest ended quiet period, claimed before it is sent: the claim is
   * a swap of the stored state that only one worker wins, written with the time of the try, and
   * marked sent once the channel takes it (or once the history shows nothing was held, when nothing
   * is sent). A try no channel took, or a claim another worker holds, waits `RETRY_EVERY_MS` from
   * its time, in this process and any other. A summary whose channel never took it is carried into
   * the next one: its `since` stays where it was. At least once, not exactly once: a worker that
   * stops, or a store that fails, between the send and the mark leaves the claim standing, and a
   * worker sends it again `RETRY_EVERY_MS` after the claim; a mark that fails is said (`unmarked`).
   * Rejects only when the store fails before the channel was sent anything.
   */
  async function summarizeFor(
    channel: BoundChannel,
    window: QuietWindow,
    page: AlertsPage,
  ): Promise<SummaryOutcome> {
    const now = clock.now();
    const key = quietKey(page.project, channel.name);
    // A window whose zone cannot be read held nothing (`holds`), so it has nothing to summarize.
    const period = endedPeriod(window, now - SUMMARY_GRACE_MS);
    if (period === undefined || (summarized.get(key) ?? Number.NEGATIVE_INFINITY) >= period.end) {
      return undefined;
    }
    if (now < (summaryPacedUntil.get(key) ?? Number.NEGATIVE_INFINITY)) {
      return undefined;
    }
    const state = await store.quietState(key);
    if (state !== undefined && state.until >= period.end) {
      if (state.until > period.end || state.sentAt !== null) {
        summarized.set(key, state.until);
        return undefined;
      }
      if (now - state.triedAt < RETRY_EVERY_MS) {
        summaryPacedUntil.set(key, state.triedAt + RETRY_EVERY_MS);
        return undefined;
      }
    }
    const since =
      state === undefined ? period.start : state.sentAt === null ? state.since : state.until;
    const claim: QuietSummaryState = { until: period.end, since, triedAt: now, sentAt: null };
    if (!(await store.swapQuietState(key, state, claim))) {
      // Another worker claimed it between the read and the swap: that worker sends it.
      summaryPacedUntil.set(key, now + RETRY_EVERY_MS);
      return undefined;
    }
    const held = await store.heldFor(page.project, channel.name, since, period.end);
    const sent: QuietSummaryState = { ...claim, sentAt: now };
    if (held.length === 0) {
      // Nothing was sent: a mark that fails only lets a later claim find nothing again.
      await store.swapQuietState(key, claim, sent);
      summarized.set(key, period.end);
      summaryPacedUntil.delete(key);
      return undefined;
    }
    const [failure] = (await deliver([channel], summaryMessage(page, held), false)).failures;
    if (failure !== undefined) {
      summaryPacedUntil.set(key, now + RETRY_EVERY_MS);
      return { kind: "failed", failure };
    }
    // This process never sends it again; another worker may, once the claim is 5 minutes old.
    summarized.set(key, period.end);
    summaryPacedUntil.delete(key);
    const marked = await store
      .swapQuietState(key, claim, { ...sent, sentAt: clock.now() })
      .catch(() => false);
    return marked ? undefined : { kind: "unmarked", channel: channel.name };
  }

  async function test(address: string, page: AlertsPage): Promise<ChannelTest> {
    const channel = channels.find((each) => each.name === address);
    if (channel === undefined) {
      return { kind: "unknown_channel" };
    }
    const [failure] = (await deliver([channel], testMessage(page), false)).failures;
    return failure === undefined ? { kind: "sent" } : { kind: "failed", error: failure.error };
  }

  return { raise, resolve, signals, drain, summarize, test };
}
