import type { Clock } from "../contracts/index.ts";

/**
 * A clock that moves only when told to. `sleep` advances time by its duration and resolves at once,
 * so a worker's backoff or wait runs instantly and deterministically. `sleeps` records every
 * duration asked for, so a test can assert the backoff sequence exactly.
 */
export class FakeClock implements Clock {
  #time: number;
  readonly sleeps: number[] = [];

  constructor(start = 0) {
    this.#time = start;
  }

  now(): number {
    return this.#time;
  }

  /** A sleep whose `signal` has already aborted ends at once without moving time. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new Error(`a sleep needs a finite, non-negative duration, not ${ms}`));
    }
    if (signal?.aborted === true) {
      return Promise.resolve();
    }
    this.sleeps.push(ms);
    this.#time += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`a clock only moves forward, not by ${ms}`);
    }
    this.#time += ms;
  }
}
