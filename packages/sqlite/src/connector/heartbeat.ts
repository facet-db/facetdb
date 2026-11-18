/**
 * The one-worker lock's own heartbeat. A worker renews its lock on every poll and every claim, and
 * between them on this beat, so a pass that waits on the model (its backoff runs for minutes when
 * the model is down) keeps the lock: no second worker takes it while the first still holds claims.
 */

/**
 * How often a worker renews its lock on its own: four beats to the 2-minute freshness
 * (`LOCK_FRESH_MS`), so three may fail in a row (a busy file, a slow server) before the lock goes
 * stale.
 */
export const LOCK_HEARTBEAT_MS = 30_000;

/**
 * Runs `beat` every `ms` until the returned function stops it. A beat never rejects: it says
 * nothing and leaves the next beat, poll or claim to renew.
 */
export type Repeat = (ms: number, beat: () => Promise<void>) => () => void;

/**
 * Real timers, for the worker's process. A beat that is still running when the next is due is not
 * doubled. The timer is unref'd: a connector never keeps a process alive for its lock's sake, since
 * the worker's own loop does.
 */
export const repeatEvery: Repeat = (ms, beat) => {
  let running = false;
  const done = () => {
    running = false;
  };
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    beat().then(done, done);
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
};
