import { FakeAlertStore, FakeChannel, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type AlertScope, createAlerts } from "./alerts.ts";
import { createWorkerWatch, type WorkerWatch, type WorkerWatchStep } from "./dead-worker.ts";
import {
  type AlertEvent,
  eventKey,
  HEARTBEAT_LOSS_MS,
  RESOLVABLE_ALERT_KINDS,
  WORKER_BEAT_EVERY_MS,
  WORKER_CHECK_EVERY_MS,
} from "./events.ts";

/**
 * Worker not running, raised by another worker: every running worker keeps a row of its own and
 * takes the rows of the workers that stopped beating, so the alert for a death comes from a worker
 * that is alive, once.
 */

const PROJECT = "market";
const LINK = "https://docs.facetdb.test/fix/worker";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const START = Date.UTC(2026, 10, 13, 9, 0, 0);

type Reported = { readonly step: WorkerWatchStep; readonly error: unknown };

function setup() {
  const clock = new FakeClock(START);
  // The database's clock is `clock`, which is also each worker's unless a test gives one of its own.
  const store = new FakeAlertStore(clock);
  const channel = new FakeChannel<null>();
  const alerts = createAlerts({
    store,
    clock,
    channels: [{ name: "fake", deliver: (message) => channel.deliver(message, null) }],
  });
  const reported: Reported[] = [];
  function watch(worker: string, over: { readonly clock?: FakeClock } = {}): WorkerWatch {
    return createWorkerWatch({
      store,
      alerts,
      clock: over.clock ?? clock,
      project: PROJECT,
      worker,
      link: () => LINK,
      report: (error, step) => reported.push({ step, error }),
    });
  }
  /** Every live watch beats and looks, every 30 seconds, for `span` ms (the loops' own cadence). */
  async function pass(live: readonly WorkerWatch[], span: number): Promise<void> {
    for (let spent = 0; spent < span; spent += WORKER_CHECK_EVERY_MS) {
      clock.advance(WORKER_CHECK_EVERY_MS);
      for (const one of live) {
        await one.beat();
        await one.check();
      }
    }
  }
  const messages = () => channel.delivered.map((delivery) => delivery.message);
  return { clock, store, channel, alerts, reported, watch, pass, messages };
}

describe("a worker that died is noticed by the others", () => {
  it("@timing two workers, one stops beating: the survivor raises one critical alert, once", async () => {
    const { clock, store, watch, pass, messages } = setup();
    const survivor = watch("worker-b");
    const dying = watch("worker-a");
    await dying.start();
    await survivor.start();
    expect(store.workers.size).toBe(2);

    // Both beat for a minute; then worker-a stops (a crash: no `stop`).
    await pass([survivor, dying], MINUTE);
    const lastBeat = clock.now();

    // Just short of 2 minutes after its last beat: nothing yet.
    await pass([survivor], 90 * SECOND);
    expect(messages()).toEqual([]);
    clock.advance(HEARTBEAT_LOSS_MS - 90 * SECOND - 1);
    await survivor.beat();
    await survivor.check();
    expect(messages()).toEqual([]);

    // Exactly 2 minutes: the survivor takes the row and raises.
    clock.advance(1);
    await survivor.check();
    expect(messages()).toHaveLength(1);
    const [alert] = messages();
    expect(alert).toMatchObject({ kind: "system-alert", severity: "critical", link: LINK });
    expect(alert?.text).toContain("worker-a");
    expect(alert?.text).toContain("2026-11-13 09:01 UTC");
    expect(alert?.text).toContain("1 worker of the project still beats");
    expect(lastBeat).toBe(START + MINUTE);
    expect(store.workers.has(`${PROJECT}|worker-a`)).toBe(false);

    // It never repeats: 40 minutes later, still the one.
    await pass([survivor], 40 * MINUTE);
    expect(messages()).toHaveLength(1);
    expect(store.history.map((line) => line.phase)).toEqual(["raised"]);
  });

  it("@timing reads the alert's link when it is raised, not when the watch is made (the studio's address is known only once it listens)", async () => {
    const clock = new FakeClock(START);
    const store = new FakeAlertStore(clock);
    const channel = new FakeChannel<null>();
    const alerts = createAlerts({
      store,
      clock,
      channels: [{ name: "fake", deliver: (message) => channel.deliver(message, null) }],
    });
    let served: string | undefined;
    const survivor = createWorkerWatch({
      store,
      alerts,
      clock,
      project: PROJECT,
      worker: "worker-s",
      link: () => (served === undefined ? LINK : `${served}/`),
      report: (error) => {
        throw error;
      },
    });
    await survivor.start();
    clock.advance(SECOND);
    await store.saveWorkerBeat(PROJECT, "worker-gone");
    clock.advance(HEARTBEAT_LOSS_MS);
    // The studio starts listening after the watch was made and before the alert.
    served = "http://127.0.0.1:4040";

    await survivor.check();

    expect(channel.delivered.map((delivery) => delivery.message.link)).toEqual([
      "http://127.0.0.1:4040/",
    ]);
  });

  it("@timing a clean stop raises nothing", async () => {
    const { store, watch, pass, messages, reported } = setup();
    const staying = watch("worker-b");
    const leaving = watch("worker-a");
    await leaving.start();
    await staying.start();
    await pass([staying, leaving], 5 * MINUTE);

    await leaving.stop();
    expect(store.workers.has(`${PROJECT}|worker-a`)).toBe(false);
    await pass([staying], 30 * MINUTE);

    expect(messages()).toEqual([]);
    expect(store.history).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("@timing a start after a crash raises nothing for rows older than 2 minutes, and removes them", async () => {
    const { clock, store, watch, pass, messages } = setup();
    await watch("worker-1").start();
    await watch("worker-2").start();
    expect(store.workers.size).toBe(2);

    // Both died; a worker comes up later, finds both rows past 2 minutes and sweeps them.
    clock.advance(HEARTBEAT_LOSS_MS);
    const restarted = watch("worker-3");
    await restarted.start();
    expect([...store.workers.keys()]).toEqual([`${PROJECT}|worker-3`]);
    await pass([restarted], 30 * MINUTE);

    expect(messages()).toEqual([]);
    expect(store.history).toEqual([]);
  });

  it("@timing a lone worker restarted after a clean stop, or after a crash once its row is 2 minutes old, raises nothing", async () => {
    const { clock, store, watch, pass, messages } = setup();
    // A clean stop and a start: the row left nothing behind.
    const first = watch("worker-1");
    await first.start();
    await pass([first], 10 * MINUTE);
    await first.stop();
    const second = watch("worker-2");
    await second.start();
    await pass([second], 10 * MINUTE);

    // A crash, and a start 5 minutes later: the old row is past 2 minutes and goes unannounced.
    clock.advance(5 * MINUTE);
    const third = watch("worker-3");
    await third.start();
    await pass([third], 30 * MINUTE);

    expect(messages()).toEqual([]);
    expect(store.history).toEqual([]);
  });

  it("@timing a lone worker that crashes and is restarted inside the 2 minutes (a supervisor) raises nothing for its predecessor", async () => {
    const { clock, store, watch, pass, messages } = setup();
    const crashed = watch("worker-1");
    await crashed.start();
    await pass([crashed], MINUTE);
    // It dies without a stop; the supervisor starts the next one 30 seconds after the last beat.
    clock.advance(30 * SECOND);
    const restarted = watch("worker-2");
    await restarted.start();
    // The dead row is 30 seconds old, a worker like any other, until it ages past 2 minutes.
    expect(store.workers.size).toBe(2);

    await pass([restarted], 10 * MINUTE);

    expect(messages()).toEqual([]);
    expect(store.history).toEqual([]);
    expect([...store.workers.keys()]).toEqual([`${PROJECT}|worker-2`]);
  });

  it("@timing a worker that was already running still raises for that predecessor when its look gets there first", async () => {
    const { clock, watch, pass, messages } = setup();
    const peer = watch("worker-peer");
    const crashed = watch("worker-1");
    await peer.start();
    await crashed.start();
    await pass([peer, crashed], MINUTE);
    clock.advance(30 * SECOND);
    const restarted = watch("worker-2");
    await restarted.start();

    // The peer saw it die: it raises, once, and the newcomer's look then finds nothing.
    await pass([peer, restarted], 10 * MINUTE);

    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain("worker-1");
    expect(messages()[0]?.text).toContain("2 workers of the project still beat");
  });

  it("@timing the newcomer that looks first drops that row silently, which an older peer would have raised", async () => {
    const { clock, watch, pass, messages } = setup();
    const peer = watch("worker-peer");
    const crashed = watch("worker-1");
    await peer.start();
    await crashed.start();
    await pass([peer, crashed], MINUTE);
    clock.advance(30 * SECOND);
    const restarted = watch("worker-2");
    await restarted.start();

    // The loss of the rule, named: the newcomer's take wins the race against the peer's.
    await pass([restarted, peer], 10 * MINUTE);

    expect(messages()).toEqual([]);
  });

  it("@timing a worker that beat after this one started and then went quiet is raised, whoever started first", async () => {
    const { clock, watch, pass, messages } = setup();
    const newcomer = watch("worker-new");
    await newcomer.start();
    clock.advance(SECOND);
    const later = watch("worker-later");
    await later.start();
    await pass([newcomer, later], MINUTE);

    await pass([newcomer], 5 * MINUTE);

    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain("worker-later");
  });

  it("@timing the clock that ages a row is the database's, not the worker's: a worker whose own clock runs 105 seconds ahead takes nothing live", async () => {
    const { clock, store, watch, messages } = setup();
    const ahead = new FakeClock(START + 105 * SECOND);
    const fast = watch("worker-fast", { clock: ahead });
    const slow = watch("worker-slow");
    await slow.start();
    await fast.start();
    // Each beat is stamped by the database, whatever the worker's own clock says.
    expect(store.workers.get(`${PROJECT}|worker-fast`)).toBe(START);

    for (let seconds = 0; seconds < 10 * 60; seconds += 15) {
      clock.advance(15 * SECOND);
      ahead.advance(15 * SECOND);
      await slow.beat();
      await fast.beat();
      if (seconds % 30 === 15) {
        await slow.check();
        await fast.check();
      }
    }

    expect(messages()).toEqual([]);
    expect(store.workers.size).toBe(2);
  });

  it("@timing three workers, one dead, two looking: one alert, whichever looks first", async () => {
    const { store, watch, pass, messages } = setup();
    const a = watch("worker-a");
    const b = watch("worker-b");
    const dead = watch("worker-dead");
    await dead.start();
    await a.start();
    await b.start();
    await pass([a, b, dead], MINUTE);

    // Both look at once after the third's last beat is 2 minutes old.
    await pass([a, b], 3 * MINUTE);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain("worker-dead");
    expect(messages()[0]?.text).toContain("2 workers of the project still beat");
    expect(store.history).toHaveLength(1);
  });

  it("@timing two workers dead within 30 minutes are two alerts, each once", async () => {
    const { store, watch, pass, messages } = setup();
    const survivor = watch("worker-s");
    const early = watch("worker-early");
    const late = watch("worker-late");
    for (const one of [survivor, early, late]) {
      await one.start();
    }
    await pass([survivor, early, late], MINUTE);
    await pass([survivor, late], 5 * MINUTE);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain("worker-early");

    await pass([survivor], 5 * MINUTE);
    expect(messages()).toHaveLength(2);
    expect(messages()[1]?.text).toContain("worker-late");
    expect(store.history.map((line) => line.event.worker)).toEqual(["worker-early", "worker-late"]);
    expect(new Set(store.history.map((line) => line.key)).size).toBe(2);
  });

  it("@timing never resolves: not at the next beat, and not when the dead worker comes back", async () => {
    const { store, watch, pass, messages } = setup();
    const survivor = watch("worker-s");
    const gone = watch("worker-gone");
    await gone.start();
    await survivor.start();
    await pass([survivor, gone], 30 * SECOND);
    await pass([survivor], 5 * MINUTE);
    expect(messages()).toHaveLength(1);

    // It beats again (a stalled process that woke up), and the survivor's passes go on.
    await gone.beat();
    await pass([survivor, gone], 5 * MINUTE);
    expect(messages()).toHaveLength(1);
    expect(store.history.map((line) => line.phase)).toEqual(["raised"]);
    expect(RESOLVABLE_ALERT_KINDS).not.toContain("worker_not_running");
  });

  it("@timing the pass's own beat resolves nothing and looks at nothing", async () => {
    const { clock, store, alerts, watch, pass, messages } = setup();
    const survivor = watch("worker-s");
    const gone = watch("worker-gone");
    await gone.start();
    await survivor.start();
    await pass([survivor, gone], 30 * SECOND);
    await pass([survivor], 5 * MINUTE);
    const key = eventKey({
      kind: "worker_not_running",
      project: PROJECT,
      source: "all sources",
      question: null,
      worker: "worker-gone",
    });
    expect(store.active.has(key)).toBe(true);

    const takes = store.takes;
    await alerts
      .signals({ project: PROJECT, source: "listings", link: LINK } satisfies AlertScope)
      .beat();
    clock.advance(MINUTE);
    await alerts.signals({ project: PROJECT, source: "listings", link: LINK }).beat();

    expect(store.takes).toBe(takes);
    expect(store.active.has(key)).toBe(true);
    expect(messages()).toHaveLength(1);
  });
});

describe("the watch's clock and its cost", () => {
  it("@timing saves its row every 15 seconds and takes every 30, one statement each, until aborted", async () => {
    const { clock, store, watch, messages } = setup();
    const only = watch("worker-only");
    const stop = new AbortController();
    const saves: number[] = [];
    const takes: number[] = [];
    store.after = (operation) => {
      if (operation === "save") {
        saves.push(clock.now() - START);
      }
      if (operation === "take") {
        takes.push(clock.now() - START);
        if (takes.length === 5) {
          stop.abort();
        }
      }
    };

    await only.start();
    await only.run(stop.signal);

    // The first beat at the start, then every 15 seconds; the start's sweep, then a look every 30.
    expect(takes).toEqual([0, 30, 60, 90, 120].map((seconds) => seconds * SECOND));
    expect(saves).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120].map((seconds) => seconds * SECOND));
    expect(store.takes).toBe(5);
    expect(WORKER_BEAT_EVERY_MS).toBe(15 * SECOND);
    expect(WORKER_CHECK_EVERY_MS).toBe(30 * SECOND);
    expect(messages()).toEqual([]);
    // The loop ended on the abort and slept no more.
    const slept = clock.sleeps.length;
    await only.run(stop.signal);
    expect(clock.sleeps).toHaveLength(slept);
  });

  it("@timing two running workers: the survivor's own loop raises the alert for the one that stopped", async () => {
    const { clock, store, watch, messages } = setup();
    const survivor = watch("worker-s");
    const dying = watch("worker-d");
    await dying.start();
    await survivor.start();
    // It beats once after the survivor began, and then no more.
    clock.advance(SECOND);
    await dying.beat();
    const stop = new AbortController();
    store.after = (operation) => {
      if (operation === "take" && clock.now() - START >= 4 * MINUTE) {
        stop.abort();
      }
    };

    await survivor.run(stop.signal);

    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toContain("worker-d");
  });
});

describe("an error in the watch is reported and never stops it", () => {
  it("@timing a failed save, take or removal is reported, and the next one is tried", async () => {
    const { store, watch, reported } = setup();
    const one = watch("worker-1");
    await one.start();

    store.failing = "save";
    await expect(one.beat()).resolves.toBeUndefined();
    store.failing = "take";
    await expect(one.check()).resolves.toBeUndefined();
    store.failing = "remove";
    await expect(one.stop()).resolves.toBeUndefined();

    expect(reported.map((line) => line.step)).toEqual(["save", "check", "remove"]);
    expect(reported.every((line) => line.error instanceof Error)).toBe(true);

    store.failing = undefined;
    await one.beat();
    expect(store.workers.has(`${PROJECT}|worker-1`)).toBe(true);
  });

  it("@timing an alert that could not be raised is raised at the next look: its row is already gone", async () => {
    const clock = new FakeClock(START);
    const store = new FakeAlertStore(clock);
    const raised: AlertEvent[] = [];
    let failures = 1;
    const reported: Reported[] = [];
    const watcher = createWorkerWatch({
      store,
      alerts: {
        raise: (event) => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("the alert store is down"));
          }
          raised.push(event);
          return Promise.resolve({ status: "sent", failures: [] });
        },
      },
      clock,
      project: PROJECT,
      worker: "worker-s",
      link: () => LINK,
      report: (error, step) => reported.push({ step, error }),
    });
    await watcher.start();
    // The other worker beats after this one began, and then no more.
    clock.advance(SECOND);
    await store.saveWorkerBeat(PROJECT, "worker-gone");
    clock.advance(HEARTBEAT_LOSS_MS);

    await watcher.check();
    expect(raised).toEqual([]);
    expect(reported.map((line) => line.step)).toEqual(["alert"]);

    await watcher.check();
    expect(raised).toMatchObject([{ kind: "worker_not_running", worker: "worker-gone" }]);
    // Raised once: a third look finds nothing left to say.
    await watcher.check();
    expect(raised).toHaveLength(1);
  });

  it("@timing a channel that refused the message is reported, and the alert is recorded", async () => {
    const clock = new FakeClock(START);
    const store = new FakeAlertStore(clock);
    const alerts = createAlerts({
      store,
      clock,
      channels: [{ name: "slack", deliver: () => Promise.reject(new Error("channel is down")) }],
    });
    const reported: Reported[] = [];
    const watcher = createWorkerWatch({
      store,
      alerts,
      clock,
      project: PROJECT,
      worker: "worker-s",
      link: () => LINK,
      report: (error, step) => reported.push({ step, error }),
    });
    await watcher.start();
    clock.advance(SECOND);
    await store.saveWorkerBeat(PROJECT, "worker-gone");
    clock.advance(HEARTBEAT_LOSS_MS);
    await watcher.check();

    expect(reported.map((line) => line.step)).toEqual(["alert"]);
    expect(store.history).toMatchObject([{ phase: "raised", delivered: false }]);
  });

  it("does not take its own row when its saves have been failing", async () => {
    const { clock, store, watch, messages } = setup();
    const one = watch("worker-1");
    await one.start();
    store.failing = "save";
    clock.advance(10 * MINUTE);
    await one.beat();
    store.failing = undefined;
    await one.check();
    expect(messages()).toEqual([]);
    expect(store.workers.has(`${PROJECT}|worker-1`)).toBe(true);
  });
});
