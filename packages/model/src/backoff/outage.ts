import type { Clock, OutagePolicy, OutageVerdict, RecordKey } from "@facetdb/core";
import { RequestRejectedError } from "../errors.ts";

// A record is retried for 10 minutes, then marked error (or unchecked) and asked again every
// 5 minutes. An outage is every call failing for a minute.
export const DEFAULT_RETRY_WINDOW_MS = 600_000;
export const DEFAULT_RETRY_EVERY_MS = 300_000;
/** An outage is declared when every call in this long failed. */
export const OUTAGE_WINDOW_MS = 60_000;

/** What the source's `onOutage` setting says to do with a record once the retry window is spent. */
export type OnOutage = "hold" | "release";

/** What the alerts module consumes: the model went down for every call, or came back. */
export type OutageEvent = {
  readonly type: "outage";
  readonly state: "declared" | "cleared";
  /** Milliseconds since the epoch, on the injected clock. */
  readonly at: number;
};

export type OutageOptions = {
  readonly retryWindowMs?: number;
  readonly retryEveryMs?: number;
  readonly onOutage: OnOutage;
  readonly clock: Clock;
  /** Told once when an outage begins and once when it ends. */
  readonly onEvent?: (event: OutageEvent) => void;
};

/** The policy as the worker sees it, plus what a test or the dashboard reads. */
export type OutagePolicyHandle = OutagePolicy & {
  readonly declared: boolean;
  /** Records currently held (error or unchecked) and waiting for their next retry or for recovery. */
  readonly held: readonly RecordKey[];
};

type Call = { readonly at: number; readonly ok: boolean };

export function createOutagePolicy(options: OutageOptions): OutagePolicyHandle {
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const retryEveryMs = options.retryEveryMs ?? DEFAULT_RETRY_EVERY_MS;
  const { onOutage, clock, onEvent } = options;
  if (!(retryWindowMs >= 0) || !(retryEveryMs > 0)) {
    throw new Error(
      `the retry window must be 0 or more and the retry cadence above 0, got ${retryWindowMs} and ${retryEveryMs}`,
    );
  }

  /** When each failing record first failed; cleared by its first success. */
  const firstFailure = new Map<RecordKey, number>();
  /** Held records and when each is asked again; recovery re-queues all of them. */
  const held = new Map<RecordKey, number>();
  let calls: Call[] = [];
  let declared = false;

  function note(ok: boolean): void {
    const now = clock.now();
    calls = calls.filter((call) => now - call.at < OUTAGE_WINDOW_MS);
    calls.push({ at: now, ok });
    const everyCallFailed = calls.every((call) => !call.ok);
    if (everyCallFailed && !declared) {
      declared = true;
      onEvent?.({ type: "outage", state: "declared", at: now });
    } else if (ok && declared) {
      declared = false;
      onEvent?.({ type: "outage", state: "cleared", at: now });
    }
  }

  function failed(key: RecordKey, error: unknown): OutageVerdict {
    const now = clock.now();
    // A request TypeSafe rejected says nothing about the model being up: it is no part of an
    // outage, and no window will cure it, so the record is an error at once (the 5-minute retry
    // picks it up again after whoever owns the state or the question has fixed it).
    if (error instanceof RequestRejectedError) {
      held.set(key, now + retryEveryMs);
      return "error";
    }
    note(false);
    const since = firstFailure.get(key) ?? now;
    firstFailure.set(key, since);
    if (now - since < retryWindowMs) {
      return "retry";
    }
    held.set(key, now + retryEveryMs);
    return onOutage === "release" ? "unchecked" : "error";
  }

  function succeeded(key: RecordKey): readonly RecordKey[] {
    firstFailure.delete(key);
    held.delete(key);
    const wasDeclared = declared;
    note(true);
    if (!wasDeclared && !heldIsStale()) {
      return [];
    }
    // The first success ends the outage: every held record is asked again, now.
    const all = [...held.keys()];
    held.clear();
    for (const heldKey of all) {
      firstFailure.delete(heldKey);
    }
    return all;
  }

  /** Records can be held without an outage (a rejected request); a success then still frees them. */
  function heldIsStale(): boolean {
    return held.size > 0;
  }

  /** The worker could not queue these: held again, for the next retry. */
  function hold(keys: readonly RecordKey[]): void {
    const retryAt = clock.now() + retryEveryMs;
    for (const key of keys) {
      held.set(key, retryAt);
    }
  }

  function due(): readonly RecordKey[] {
    const now = clock.now();
    const ready: RecordKey[] = [];
    for (const [key, retryAt] of held) {
      if (retryAt <= now) {
        ready.push(key);
      }
    }
    for (const key of ready) {
      held.delete(key);
    }
    return ready;
  }

  return {
    failed,
    succeeded,
    due,
    hold,
    get declared() {
      return declared;
    },
    get held() {
      return [...held.keys()];
    },
  };
}
