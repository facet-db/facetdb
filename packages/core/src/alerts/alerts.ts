import type { ChannelMessage, Clock } from "../contracts/index.ts";
import {
  ALERT_WINDOW_MS,
  type AlertEvent,
  type AlertSeverity,
  alertMessage,
  eventKey,
  FAILURE_WINDOW_MS,
  resolvedMessage,
} from "./events.ts";

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
};

type Call = { readonly at: number; readonly ok: boolean };

type Delivery = {
  readonly reached: boolean;
  readonly failures: readonly ChannelFailure[];
  readonly deliveries: readonly AlertDelivery[];
};

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

  /** The channels an event of `severity` is sent to, in the config's order (each one's `sends`). */
  function taking(severity: AlertSeverity): readonly BoundChannel[] {
    return channels.filter((channel) => channel.takes?.(severity) ?? true);
  }

  /**
   * Tries every channel side by side, never one after another. A channel that throws, rejects or is
   * cut off by its bound is a failed delivery, reported and returned, never thrown: the others are
   * delivered all the same.
   */
  async function deliver(to: readonly BoundChannel[], message: ChannelMessage): Promise<Delivery> {
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
   * With no channel to try, each raise runs as it always did.
   */
  function raise(event: AlertEvent): Promise<AlertOutcome> {
    const key = eventKey(event);
    knownClear.delete(key);
    raises.set(key, (raises.get(key) ?? 0) + 1);
    const message = alertMessage(event);
    const to = taking(message.severity);
    if (to.length === 0) {
      return raiseNow(key, event, message, to);
    }
    const inFlight = sending.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const attempt = raiseNow(key, event, message, to).finally(() => sending.delete(key));
    sending.set(key, attempt);
    return attempt;
  }

  async function raiseNow(
    key: string,
    event: AlertEvent,
    message: ChannelMessage,
    to: readonly BoundChannel[],
  ): Promise<AlertOutcome> {
    const now = clock.now();
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
   * someone hears that it is over. Paced like a raise: no attempt within `RETRY_EVERY_MS` of one
   * no channel took.
   */
  async function resolveActive(key: string, active: ActiveAlert): Promise<AlertOutcome> {
    // Who hears that it is over is who heard of it: the channels that send the event's own severity.
    const to = taking(alertMessage(active.event).severity);
    const now = clock.now();
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
      at: clock.now(),
      key,
      phase: "resolved",
      severity: "information",
      event: active.event,
      delivered: true,
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

  return { raise, resolve, signals, drain };
}
