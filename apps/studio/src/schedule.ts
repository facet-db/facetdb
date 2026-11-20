/**
 * Time as the studio's pages read it: the clock and a repeating call, passed in through
 * `StudioDeps` like the API and the media queries. The composition root passes the window's; a test
 * passes the fake of src/testing/fake-scheduler.ts and moves time by hand, so no test waits.
 */
export type Scheduler = {
  /** The time now, in milliseconds since the epoch. */
  readonly now: () => number;
  /** Calls `run` every `ms` until the returned function is called. */
  readonly every: (ms: number, run: () => void) => () => void;
  /** Calls `run` once, `ms` from now, unless the returned function is called first. */
  readonly after: (ms: number, run: () => void) => () => void;
};

/** The window's clock and intervals. */
export function browserScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    every: (ms, run) => {
      const id = window.setInterval(run, ms);
      return () => {
        window.clearInterval(id);
      };
    },
    after: (ms, run) => {
      const id = window.setTimeout(run, ms);
      return () => {
        window.clearTimeout(id);
      };
    },
  };
}
