/**
 * The clock every time-dependent part of core reads: the worker's wake-ups, retry backoff, the
 * heartbeat, the spending window and the batching of notifications. Core never reads the system
 * clock itself; tests pass a `FakeClock` through this parameter.
 */
export type Clock = {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `ms` milliseconds have passed on this clock. */
  sleep(ms: number): Promise<void>;
};
