import type { Clock } from "@facetdb/core";
import { RetryableError } from "../errors.ts";

// TypeSafe's rules (https://docs.typesafe.ai/api/errors.md): only 429 and 529 are retried. 400, 401,
// 413, 415 and 422 are `RequestRejectedError`s, and retrying the same request cannot change them.
export const DEFAULT_BASE_MS = 500;
export const DEFAULT_FACTOR = 2;
export const DEFAULT_MAX_MS = 30_000;
/** A call gives up after this many attempts; the retry window (outage policy) judges the record from there. */
export const DEFAULT_MAX_ATTEMPTS = 6;
/** The share of a delay that jitter may take off it: a delay lands in [delay * (1 - jitter), delay]. */
export const DEFAULT_JITTER = 0.2;

export type BackoffOptions = {
  readonly baseMs?: number;
  readonly factor?: number;
  readonly maxMs?: number;
  /** 0 to 1: the largest share of a delay that random jitter removes. */
  readonly jitter?: number;
  /** Attempts per call, the first included; the last failure is thrown as it came. */
  readonly maxAttempts?: number;
  readonly clock: Clock;
  /** A number in [0, 1), as `Math.random`; injected so tests are exact. */
  readonly random: () => number;
};

export type Backoff = {
  /**
   * The wait before the retry that follows failed attempt number `attempt` (0 for the first
   * attempt), or `undefined` when the error is not worth retrying or the attempts are used up.
   * A `retry-after` from the server is honoured exactly: it is neither capped nor jittered.
   */
  delayMs(attempt: number, error: unknown): number | undefined;
  /** Runs `attempt` until it succeeds, sleeping on the clock between tries; throws the last error as it came. */
  run<T>(attempt: () => Promise<T>, onRetryable?: (error: RetryableError) => void): Promise<T>;
};

export function createBackoff(options: BackoffOptions): Backoff {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const factor = options.factor ?? DEFAULT_FACTOR;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const jitter = options.jitter ?? DEFAULT_JITTER;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!(baseMs > 0) || !(factor >= 1) || !(maxMs >= baseMs)) {
    throw new Error(
      `backoff needs 0 < baseMs <= maxMs and factor >= 1, got ${baseMs}, ${maxMs}, ${factor}`,
    );
  }
  if (!(jitter >= 0 && jitter <= 1)) {
    throw new Error(`backoff jitter is a share between 0 and 1, not ${jitter}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`a call has at least one attempt, not ${maxAttempts}`);
  }
  const { clock, random } = options;

  function delayMs(attempt: number, error: unknown): number | undefined {
    if (!(error instanceof RetryableError) || attempt + 1 >= maxAttempts) {
      return undefined;
    }
    if (error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }
    const grown = Math.min(maxMs, baseMs * factor ** attempt);
    return Math.round(grown * (1 - jitter * random()));
  }

  async function run<T>(
    attempt: () => Promise<T>,
    onRetryable?: (error: RetryableError) => void,
  ): Promise<T> {
    for (let tried = 0; ; tried += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof RetryableError) {
          onRetryable?.(error);
        }
        const wait = delayMs(tried, error);
        if (wait === undefined) {
          throw error;
        }
        await clock.sleep(wait);
      }
    }
  }

  return { delayMs, run };
}
