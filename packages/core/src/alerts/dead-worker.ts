import type { Clock } from "../contracts/index.ts";
import { whenUtc } from "../log/index.ts";
import type { AlertOutcome, AlertStore, WorkerBeat } from "./alerts.ts";
import type { AlertEvent } from "./events.ts";
import { HEARTBEAT_LOSS_MS, WORKER_BEAT_EVERY_MS, WORKER_CHECK_EVERY_MS } from "./events.ts";

/**
 * Every running worker keeps a heartbeat row of its own and watches the rows of the others: a
 * worker cannot alert on its own death, so the alert for a dead worker is raised by a worker that
 * is alive. A lone worker's death shows on Home only (Home reads the project's own heartbeat, which
 * this module leaves alone).
 *
 *  - `start` takes, without an alert, the rows older than 2 minutes (workers that died before this
 *    one existed) and saves this worker's first beat;
 *  - `run` saves the row every 15 seconds and, every 30 seconds, takes the rows older than 2
 *    minutes and raises `worker_not_running` once for each: one statement per check, on a clock of
 *    its own beside the passes, never inside one. A `--once` run runs it too, for as long as it
 *    answers, and ends it with the run;
 *  - `stop` removes the row: a clean stop raises nothing. A worker that dies with an error does
 *    not call it, and leaves its row for the others to find.
 *
 * The take deletes and returns the rows in one statement, so of two workers that look at once,
 * exactly one gets each dead worker; the alert is raised once and neither repeats nor resolves.
 * A save, a take or a raise that fails is reported and never stops the worker.
 *
 * Two clocks. The rows' times, the stamp of a beat and the age a take looks for, are the store's
 * (the database's), the one clock every worker of the project shares, so two machines whose own
 * clocks differ cannot make one worker look dead to the other. The 15 and 30 seconds and the sleeps
 * are the injected clock's, the process's own.
 *
 * A restart is not a death. A row that was already there when this worker started and has not
 * beaten since (its last beat is no later than this worker's first) is the worker it replaced,
 * or one that died as it came up: it is dropped without an alert once it is 2 minutes old. A row
 * that beat after this worker started and then went quiet is raised. A worker that was already
 * running when the row died still raises for it if its own take gets there first.
 */

/** What the watch was doing when it reported an error. */
export type WorkerWatchStep = "clean" | "save" | "remove" | "check" | "alert";

export type WorkerWatchDeps = {
  readonly store: Pick<AlertStore, "saveWorkerBeat" | "removeWorkerBeat" | "takeDeadWorkers">;
  /** Only `raise`: the alerts module the worker already built. */
  readonly alerts: { raise(event: AlertEvent): Promise<AlertOutcome> };
  readonly clock: Clock;
  readonly project: string;
  /** This worker's id, new at every start. */
  readonly worker: string;
  /**
   * The one page where a dead worker is fixed, read when the alert is raised: the address the
   * studio is served on is only known once it listens, after the watch is made.
   */
  readonly link: () => string;
  /** Where an error goes (a line on the terminal); the watch goes on after it. */
  readonly report: (error: unknown, step: WorkerWatchStep) => void;
};

export type WorkerWatch = {
  /** Cleans the rows of workers that died before this one, and saves its first beat. Never throws. */
  start(): Promise<void>;
  /** Saves this worker's row now. Never throws. */
  beat(): Promise<void>;
  /** Takes the dead workers' rows and raises an alert for each. Never throws. */
  check(): Promise<void>;
  /**
   * The row every 15 seconds and the check every 30, on the injected clock, until `signal` aborts:
   * the sleep ends with the signal, so no timer outlives the worker.
   */
  run(signal: AbortSignal): Promise<void>;
  /** Removes this worker's row, once, if `start` ran. Never throws. */
  stop(): Promise<void>;
};

/** An alert about a worker of the project names no source. */
const EVERY_SOURCE = "all sources";

function stillBeating(count: number): string {
  return count === 1
    ? "1 worker of the project still beats"
    : `${count} workers of the project still beat`;
}

/** The alert for a worker whose row was taken: its id, its last beat and who still beats. */
function deadWorkerEvent(
  dead: WorkerBeat,
  beating: number,
  project: string,
  link: string,
): AlertEvent {
  return {
    kind: "worker_not_running",
    what: `Worker ${dead.worker} has sent no heartbeat for 2 minutes; its last beat was ${whenUtc(new Date(dead.at))}. ${stillBeating(beating)}.`,
    project,
    source: EVERY_SOURCE,
    question: null,
    did: "Records stay queued; the workers that still beat answer them.",
    link,
    worker: dead.worker,
  };
}

export function createWorkerWatch(deps: WorkerWatchDeps): WorkerWatch {
  const { store, alerts, clock, project, worker, link, report } = deps;
  let started = false;
  /**
   * The store's time of this worker's first saved beat: the line between the rows that were here
   * before it (dropped without an alert once dead) and the ones that beat after it began (raised).
   * Unknown until a save has gone through; with it unknown a check takes nothing.
   */
  let startedAt: number | undefined;
  /** A dead worker not yet raised, by worker: its row is gone, so a failed raise is tried again at the next check. */
  const unraised = new Map<string, { readonly dead: WorkerBeat; readonly beating: number }>();

  /** Reports an error; a `report` that throws must not stop the watch either. */
  function reported(error: unknown, step: WorkerWatchStep): void {
    try {
      report(error, step);
    } catch {
      // Nothing more can be said.
    }
  }

  async function take(step: "clean" | "check"): Promise<readonly [readonly WorkerBeat[], number]> {
    try {
      const { taken, beating } = await store.takeDeadWorkers(project, worker, HEARTBEAT_LOSS_MS);
      return [taken, beating];
    } catch (error) {
      reported(error, step);
      return [[], 0];
    }
  }

  async function beat(): Promise<void> {
    try {
      const at = await store.saveWorkerBeat(project, worker);
      startedAt ??= at;
    } catch (error) {
      reported(error, "save");
    }
  }

  async function check(): Promise<void> {
    if (startedAt !== undefined) {
      const [taken, beating] = await take("check");
      for (const dead of taken) {
        // A row no later than this worker's own start is its predecessor's (or a worker that died
        // as this one came up): gone, with no alert.
        if (dead.at > startedAt) {
          unraised.set(dead.worker, { dead, beating });
        }
      }
    }
    for (const [id, { dead, beating }] of unraised) {
      try {
        const outcome = await alerts.raise(deadWorkerEvent(dead, beating, project, link()));
        unraised.delete(id);
        for (const failure of outcome.failures) {
          reported(failure.error, "alert");
        }
      } catch (error) {
        reported(error, "alert");
      }
    }
  }

  return {
    async start() {
      started = true;
      // Rows of workers that died before this one existed: gone, with no alert (a restart after a
      // crash must not announce the death of the worker it replaces).
      await take("clean");
      await beat();
    },

    beat,
    check,

    async run(signal) {
      let beatDue = clock.now() + WORKER_BEAT_EVERY_MS;
      let checkDue = clock.now() + WORKER_CHECK_EVERY_MS;
      // A function, not the property: the sleep is where the signal changes, and a read of
      // `signal.aborted` after it must not be taken for the one the loop condition made.
      const stopped = () => signal.aborted;
      // The run ends with the signal whatever the clock does with it: a clock that did not wake
      // its sleep on the abort would hold the run (and `--once`'s exit) for good.
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      while (!stopped()) {
        await Promise.race([
          clock.sleep(Math.max(0, Math.min(beatDue, checkDue) - clock.now()), signal),
          aborted,
        ]);
        if (stopped()) {
          return;
        }
        if (clock.now() >= beatDue) {
          beatDue = clock.now() + WORKER_BEAT_EVERY_MS;
          await beat();
        }
        if (clock.now() >= checkDue) {
          checkDue = clock.now() + WORKER_CHECK_EVERY_MS;
          await check();
        }
      }
    },

    async stop() {
      if (!started) {
        return;
      }
      started = false;
      try {
        await store.removeWorkerBeat(project, worker);
      } catch (error) {
        reported(error, "remove");
      }
    },
  };
}
