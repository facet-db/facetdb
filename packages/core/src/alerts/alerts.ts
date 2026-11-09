import type { ChannelMessage, Clock } from "../contracts/index.ts";
import {
  ALERT_WINDOW_MS,
  type AlertEvent,
  type AlertSeverity,
  alertMessage,
  eventKey,
  FAILURE_WINDOW_MS,
  HEARTBEAT_LOSS_MS,
  resolvedMessage,
} from "./events.ts";

/** An alert that has been raised and not yet resolved. */
export type ActiveAlert = {
  readonly event: AlertEvent;
  readonly raisedAt: number;
  /** When a channel last took the message; null while none has. */
  readonly lastSentAt: number | null;
};

/** One line of the alert history the dashboard reads; events are recorded in the store. */
export type AlertRecord = {
  readonly at: number;
  readonly key: string;
  readonly phase: "raised" | "resolved";
  readonly severity: AlertSeverity;
  readonly event: AlertEvent;
  /** False when every channel refused the message. */
  readonly delivered: boolean;
};

/**
 * Where alert state survives a restart: the alerts awaiting resolution, the history, and the last
 * heartbeat of each project's worker (a watcher in another process reads it).
 */
export type AlertStore = {
  getActive(key: string): Promise<ActiveAlert | undefined>;
  setActive(key: string, alert: ActiveAlert): Promise<void>;
  clearActive(key: string): Promise<void>;
  append(record: AlertRecord): Promise<void>;
  lastHeartbeat(project: string): Promise<number | undefined>;
  saveHeartbeat(project: string, at: number): Promise<void>;
};

/** A channel with its configuration already bound; the composition root builds these. */
export type BoundChannel = {
  readonly name: string;
  deliver(message: ChannelMessage): Promise<void>;
};

export type AlertsDeps = {
  readonly store: AlertStore;
  readonly clock: Clock;
  readonly channels: readonly BoundChannel[];
};

export type ChannelFailure = { readonly channel: string; readonly error: unknown };

export type AlertOutcome = {
  /**
   * `sent`: raised (or raised again after 30 minutes) and recorded. `suppressed`: the same event
   * was sent less than 30 minutes ago. `resolved`: the resolved message went out. `idle`: nothing
   * was active under that key (or no channel took the resolved message, so it stays active).
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
  /** Sends the resolved message once; later calls find nothing active. */
  resolve(key: string): Promise<AlertOutcome>;
  /** The heartbeat watcher: raises `worker_not_running` after 2 minutes without a beat, resolves on the next. */
  checkHeartbeat(scope: AlertScope): Promise<AlertOutcome>;
  signals(scope: AlertScope): AlertSignals;
};

type Call = { readonly at: number; readonly ok: boolean };

type Delivery = { readonly reached: boolean; readonly failures: readonly ChannelFailure[] };

export function createAlerts(deps: AlertsDeps): Alerts {
  const { store, clock, channels } = deps;
  /** The sliding window of model calls this process made, oldest first. */
  let calls: Call[] = [];

  async function deliver(message: ChannelMessage): Promise<Delivery> {
    const results = await Promise.allSettled(channels.map((channel) => channel.deliver(message)));
    const failures: ChannelFailure[] = [];
    results.forEach((result, index) => {
      const channel = channels[index];
      if (result.status === "rejected" && channel !== undefined) {
        failures.push({ channel: channel.name, error: result.reason });
      }
    });
    // With no channel configured the event is only recorded, and that counts as sent.
    return { reached: channels.length === 0 || failures.length < channels.length, failures };
  }

  async function raise(event: AlertEvent): Promise<AlertOutcome> {
    const key = eventKey(event);
    const now = clock.now();
    const active = await store.getActive(key);
    if (active?.lastSentAt != null && now - active.lastSentAt < ALERT_WINDOW_MS) {
      return { status: "suppressed", failures: [] };
    }
    const message = alertMessage(event);
    const { reached, failures } = await deliver(message);
    await store.setActive(key, {
      event,
      raisedAt: active?.raisedAt ?? now,
      lastSentAt: reached ? now : (active?.lastSentAt ?? null),
    });
    await store.append({
      at: now,
      key,
      phase: "raised",
      severity: message.severity,
      event,
      delivered: reached,
    });
    return { status: "sent", failures };
  }

  async function resolve(key: string): Promise<AlertOutcome> {
    const active = await store.getActive(key);
    if (active === undefined) {
      return { status: "idle", failures: [] };
    }
    const { reached, failures } = await deliver(resolvedMessage(active.event));
    if (!reached) {
      // Stays active so the next resolve tries again; the message goes out once, when it can.
      return { status: "idle", failures };
    }
    await store.clearActive(key);
    await store.append({
      at: clock.now(),
      key,
      phase: "resolved",
      severity: "information",
      event: active.event,
      delivered: true,
    });
    return { status: "resolved", failures };
  }

  function workerKey(scope: AlertScope): string {
    return eventKey({ kind: "worker_not_running", ...scope, question: null });
  }

  async function checkHeartbeat(scope: AlertScope): Promise<AlertOutcome> {
    const last = await store.lastHeartbeat(scope.project);
    if (last === undefined) {
      // No worker has ever reported for this project: there is nothing to have lost.
      return { status: "idle", failures: [] };
    }
    if (clock.now() - last >= HEARTBEAT_LOSS_MS) {
      return raise({
        kind: "worker_not_running",
        what: "The worker has sent no heartbeat for 2 minutes.",
        ...scope,
        question: null,
        did: "Records stay queued and are answered when the worker is back.",
      });
    }
    return resolve(workerKey(scope));
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
      await resolve(eventKey({ kind: "model_failing", ...scope, question: null }));
    }
  }

  function signals(scope: AlertScope): AlertSignals {
    return {
      async modelCall(ok) {
        calls.push({ at: clock.now(), ok });
        await checkModel(scope);
      },
      async beat() {
        await store.saveHeartbeat(scope.project, clock.now());
        await resolve(workerKey(scope));
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

  return { raise, resolve, checkHeartbeat, signals };
}
