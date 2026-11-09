import type { Clock } from "@facetdb/core";

// Up to 8 requests in flight per worker, fewer while TypeSafe says 429.
export const DEFAULT_IN_FLIGHT = 8;
export const MIN_IN_FLIGHT = 1;
/** A step of the limit comes back after this long without a 429. */
export const RECOVER_AFTER_MS = 60_000;

export type LimiterOptions = {
  /** The most requests in flight when nothing is wrong; default 8. */
  readonly max?: number;
  readonly recoverAfterMs?: number;
  readonly clock: Clock;
};

export type InFlightLimiter = {
  /** The limit right now, restored steps included. */
  readonly limit: number;
  readonly inFlight: number;
  /** Runs `task` once a slot is free and frees the slot when it settles, either way. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** A 429 came back: halve the limit (never below 1) and start the quiet minute again. */
  rateLimited(): void;
};

/**
 * Halves on a 429 and restores one step (a doubling, back to the maximum) for every full minute
 * without one. Nothing is scheduled: the restored limit is worked out from the injected clock
 * whenever it is read, so a test moves it by moving the clock.
 */
export function createInFlightLimiter(options: LimiterOptions): InFlightLimiter {
  const max = options.max ?? DEFAULT_IN_FLIGHT;
  const recoverAfterMs = options.recoverAfterMs ?? RECOVER_AFTER_MS;
  if (!Number.isInteger(max) || max < MIN_IN_FLIGHT) {
    throw new Error(`the in-flight limit is a whole number of at least 1, not ${max}`);
  }
  const { clock } = options;
  let limit = max;
  /** When the current quiet stretch began: the last 429, or the last restored step. */
  let quietSince = clock.now();
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  function restore(): void {
    while (limit < max && clock.now() - quietSince >= recoverAfterMs) {
      limit = Math.min(max, limit * 2);
      quietSince += recoverAfterMs;
    }
  }

  function admit(): void {
    restore();
    while (inFlight < limit) {
      const next = waiting.shift();
      if (next === undefined) {
        return;
      }
      inFlight += 1;
      next();
    }
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      admit();
    });
    try {
      return await task();
    } finally {
      inFlight -= 1;
      admit();
    }
  }

  return {
    get limit() {
      restore();
      return limit;
    },
    get inFlight() {
      return inFlight;
    },
    run,
    rateLimited() {
      restore();
      limit = Math.max(MIN_IN_FLIGHT, Math.floor(limit / 2));
      quietSince = clock.now();
    },
  };
}
