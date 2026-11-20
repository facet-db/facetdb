import type { Scheduler } from "../schedule.ts";

/**
 * The scheduler a studio test passes as `StudioDeps.schedule`: a clock that stands still until the
 * test moves it, and intervals that fire, in order, as `advance` passes their times. Nothing here
 * waits on a real timer.
 */
export type FakeScheduler = Scheduler & {
  /** Moves the clock forward, running every interval that falls due on the way, earliest first. */
  readonly advance: (ms: number) => void;
  /** How many intervals are running: a page that stopped its timers leaves none. */
  readonly running: () => number;
};

/** A fixed noon, UTC. */
export const FAKE_START = Date.UTC(2026, 10, 6, 12, 0, 0);

export function fakeScheduler(start: number = FAKE_START): FakeScheduler {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { every: number; due: number; run: () => void }>();
  return {
    now: () => now,
    every: (ms, run) => {
      nextId += 1;
      const id = nextId;
      timers.set(id, { every: ms, due: now + ms, run });
      return () => {
        timers.delete(id);
      };
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        let next: { id: number; due: number } | undefined;
        for (const [id, timer] of timers) {
          if (timer.due <= end && (next === undefined || timer.due < next.due)) {
            next = { id, due: timer.due };
          }
        }
        if (next === undefined) {
          break;
        }
        const timer = timers.get(next.id);
        if (timer === undefined) {
          break;
        }
        now = next.due;
        timer.due += timer.every;
        timer.run();
      }
      now = end;
    },
    running: () => timers.size,
  };
}
