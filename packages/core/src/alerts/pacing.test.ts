import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "../contracts/index.ts";
import {
  type ActiveAlert,
  type AlertScope,
  type BoundChannel,
  ChannelFailed,
  type ChannelFailure,
  createAlerts,
  RETRY_EVERY_MS,
} from "./alerts.ts";
import { type AlertEvent, eventKey } from "./events.ts";

/**
 * A channel that does not take a message is tried again at a pace: at most one attempt per event
 * key per `RETRY_EVERY_MS`, for a raise and a resolved message alike, held across a restart through
 * the stored `lastTriedAt`; between attempts a raise or a healthy model call costs no channel call,
 * no history line and no printed line. A healthy model call never waits on a channel: the resolved
 * message goes out off its path, one per key at a time, and `drain` waits for it. All on the
 * injected clock.
 */

const START = Date.UTC(2026, 10, 14, 9, 0);
const SECOND = 1_000;

const scope: AlertScope = {
  project: "market",
  source: "listings",
  link: "https://app.facetdb.test/fix/model",
};

const MODEL_KEY = eventKey({ kind: "model_failing", ...scope, question: null });

type Mode = "ok" | "fail" | "hang";

/** A channel whose answer the test sets: takes the message, refuses it at once, or never answers until `release`. */
function controlled() {
  const state = {
    mode: "ok" as Mode,
    attempts: [] as ChannelMessage[],
    hanging: [] as ((outcome: "ok" | "fail") => void)[],
  };
  const channel: BoundChannel = {
    name: "slack:#ops",
    deliver: (message) => {
      state.attempts.push(message);
      if (state.mode === "fail") {
        return Promise.reject(new ChannelFailed("the channel refused it"));
      }
      if (state.mode === "hang") {
        return new Promise<void>((resolve, reject) => {
          state.hanging.push((outcome) =>
            outcome === "ok" ? resolve() : reject(new ChannelFailed("cut off")),
          );
        });
      }
      return Promise.resolve();
    },
  };
  const release = (outcome: "ok" | "fail") => {
    for (const end of state.hanging.splice(0)) {
      end(outcome);
    }
  };
  return { state, channel, release };
}

function world(store?: FakeAlertStore, clock = new FakeClock(START)) {
  const alertStore = store ?? new FakeAlertStore(clock);
  const { state, channel, release } = controlled();
  const printed: ChannelFailure[] = [];
  const alerts = createAlerts({
    store: alertStore,
    clock,
    channels: [channel],
    report: (failure) => printed.push(failure),
  });
  const signals = alerts.signals(scope);
  return { clock, store: alertStore, state, release, printed, alerts, signals };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const resolvedTexts = (attempts: readonly ChannelMessage[]) =>
  attempts.filter((message) => message.text.startsWith("Resolved:")).length;

/** Raises model_failing as the worker would: more than 5% of calls failing, the channel taking it. */
async function failing(w: ReturnType<typeof world>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await w.signals.modelCall(false);
  }
  expect(w.store.active.get(MODEL_KEY)?.lastSentAt).not.toBeNull();
  // Out of the 5-minute failure window: the next calls are healthy.
  w.clock.advance(5 * 60_000 + SECOND);
}

describe("a resolved message no channel takes (the record path never waits)", () => {
  it("@timing eight lanes of healthy calls with a hanging channel finish at once, one attempt per interval", async () => {
    const w = world();
    await failing(w);
    w.state.mode = "hang";

    // Eight lanes at once: every call returns while the delivery hangs.
    await Promise.all(Array.from({ length: 8 }, () => w.signals.modelCall(true)));
    for (let i = 0; i < 20; i += 1) {
      await w.signals.modelCall(true);
    }
    expect(resolvedTexts(w.state.attempts)).toBe(1);
    expect(w.state.hanging).toHaveLength(1);

    // The bound cuts it off (the channel host's, here the channel itself): the alert stays active.
    w.release("fail");
    await w.alerts.drain();
    expect(w.store.active.get(MODEL_KEY)?.lastTriedAt).toBe(START + 5 * 60_000 + SECOND);
    for (let i = 0; i < 20; i += 1) {
      await w.signals.modelCall(true);
      w.clock.advance(SECOND);
    }
    expect(resolvedTexts(w.state.attempts)).toBe(1);

    // Past the interval, the next healthy call starts one more, and returns at once again.
    w.clock.advance(RETRY_EVERY_MS);
    await Promise.all(Array.from({ length: 8 }, () => w.signals.modelCall(true)));
    expect(resolvedTexts(w.state.attempts)).toBe(2);
    w.release("fail");
    await w.alerts.drain();
  });

  it("@timing a channel failing fast under 100 healthy calls: one attempt and one printed line per interval", async () => {
    const w = world();
    await failing(w);
    w.state.mode = "fail";
    const before = w.state.attempts.length;
    for (let i = 0; i < 100; i += 1) {
      await w.signals.modelCall(true);
      w.clock.advance(SECOND);
    }
    await w.alerts.drain();
    expect(w.state.attempts.length - before).toBe(1);
    expect(w.printed).toHaveLength(1);
    // No resolved line while no channel took it: the history keeps the alert open.
    expect(w.store.history.map((line) => line.phase)).toEqual(["raised"]);
    expect(w.store.active.has(MODEL_KEY)).toBe(true);

    w.clock.advance(RETRY_EVERY_MS);
    for (let i = 0; i < 100; i += 1) {
      await w.signals.modelCall(true);
    }
    await w.alerts.drain();
    expect(w.state.attempts.length - before).toBe(2);
    expect(w.printed).toHaveLength(2);
  });

  it("@timing the channel coming back: the next paced attempt delivers, the alert resolves, nothing is sent twice", async () => {
    const w = world();
    await failing(w);
    w.state.mode = "fail";
    await w.signals.modelCall(true);
    await w.alerts.drain();
    w.state.mode = "ok";
    // Back, but within the interval: nothing is tried yet.
    await w.signals.modelCall(true);
    await w.alerts.drain();
    expect(resolvedTexts(w.state.attempts)).toBe(1);

    w.clock.advance(RETRY_EVERY_MS);
    await w.signals.modelCall(true);
    await w.alerts.drain();
    expect(resolvedTexts(w.state.attempts)).toBe(2);
    expect(w.store.active.has(MODEL_KEY)).toBe(false);
    expect(w.store.history.map((line) => [line.phase, line.delivered])).toEqual([
      ["raised", true],
      ["resolved", true],
    ]);
    expect(w.store.history[1]?.deliveries).toEqual([{ channel: "slack:#ops", ok: true }]);

    // Resolved and known clear: later healthy calls send nothing and read nothing.
    for (let i = 0; i < 10; i += 1) {
      w.clock.advance(RETRY_EVERY_MS);
      await w.signals.modelCall(true);
    }
    await w.alerts.drain();
    expect(w.state.attempts).toHaveLength(2 + 1);
  });

  it("@timing a stop while the resolved message is on its way: drain waits for it, the alert stays active and paced", async () => {
    const w = world();
    await failing(w);
    w.state.mode = "hang";
    await w.signals.modelCall(true);
    let drained = false;
    const draining = w.alerts.drain().then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    // The worker's stop ends the delivery (the channel host's stop signal; here, the channel).
    w.release("fail");
    await draining;
    expect(w.store.active.get(MODEL_KEY)?.lastTriedAt).not.toBeNull();
    expect(w.store.history.map((line) => line.phase)).toEqual(["raised"]);
  });

  it("@timing holds the pace across a restart: a new process reads the stored attempt and waits it out", async () => {
    const clock = new FakeClock(START);
    const store = new FakeAlertStore(clock);
    const first = world(store, clock);
    await failing(first);
    first.state.mode = "fail";
    await first.signals.modelCall(true);
    await first.alerts.drain();

    // A restart: a new alerts module over the same store, its channel down too.
    const second = world(store, clock);
    second.state.mode = "fail";
    for (let i = 0; i < 30; i += 1) {
      await second.signals.modelCall(true);
      clock.advance(SECOND);
    }
    await second.alerts.drain();
    expect(second.state.attempts).toEqual([]);
    expect(second.printed).toEqual([]);

    clock.advance(RETRY_EVERY_MS);
    await second.signals.modelCall(true);
    await second.alerts.drain();
    expect(second.state.attempts).toHaveLength(1);
  });

  it("says a store failure around the delivery at the next model call, as before", async () => {
    class FailingStore extends FakeAlertStore {
      failClear = false;
      override clearActive(key: string): Promise<void> {
        return this.failClear
          ? Promise.reject(new Error("the store is unreachable"))
          : super.clearActive(key);
      }
    }
    const clock = new FakeClock(START);
    const store = new FailingStore(clock);
    const w = world(store, clock);
    await failing(w);
    store.failClear = true;
    await w.signals.modelCall(true);
    await w.alerts.drain();
    await expect(w.signals.modelCall(true)).rejects.toThrow("the store is unreachable");
  });
});

describe("a raise no channel takes", () => {
  it("@timing 50 failed calls with the channel down: one history line, one attempt, one printed line per interval", async () => {
    const w = world();
    w.state.mode = "fail";
    for (let i = 0; i < 50; i += 1) {
      await w.signals.modelCall(false);
      w.clock.advance(SECOND);
    }
    expect(w.state.attempts).toHaveLength(1);
    expect(w.printed).toHaveLength(1);
    expect(w.store.history).toHaveLength(1);
    expect(w.store.history[0]).toMatchObject({ phase: "raised", delivered: false });
    expect("pending" in (w.store.history[0] ?? {})).toBe(false);

    w.clock.advance(RETRY_EVERY_MS);
    for (let i = 0; i < 50; i += 1) {
      await w.signals.modelCall(false);
      w.clock.advance(SECOND);
    }
    expect(w.state.attempts).toHaveLength(2);
    expect(w.printed).toHaveLength(2);
    expect(w.store.history).toHaveLength(2);
  });

  it("writes the attempt before it is made, so a worker that dies mid-delivery leaves the pace behind", async () => {
    const w = world();
    w.state.mode = "hang";
    const raising = w.alerts.raise({
      kind: "connector_lost_access",
      what: "Permission revoked.",
      ...scope,
      question: null,
      did: "Paused the source.",
    });
    await settle();
    const key = eventKey({ kind: "connector_lost_access", ...scope, question: null });
    const active = w.store.active.get(key) as ActiveAlert;
    expect(active).toMatchObject({ lastSentAt: null, lastTriedAt: START });
    // The line, recorded first, says it is being delivered.
    expect(w.store.history[0]).toMatchObject({ pending: true, deliveries: [], delivered: false });
    w.release("ok");
    await raising;
    expect(w.store.active.get(key)).toMatchObject({ lastSentAt: START, lastTriedAt: null });
    expect(w.store.history[0]).toMatchObject({ delivered: true });
    expect("pending" in (w.store.history[0] ?? {})).toBe(false);
  });

  it("shares a raise in flight with a second caller, its failure included", async () => {
    class SlowStore extends FakeAlertStore {
      fail: (() => void) | undefined;
      override getActive(key: string): Promise<ActiveAlert | undefined> {
        return new Promise((resolve, reject) => {
          this.fail = () => reject(new Error("the store is unreachable"));
          void key;
          void resolve;
        });
      }
    }
    const clock = new FakeClock(START);
    const store = new SlowStore(clock);
    const w = world(store, clock);
    const event: AlertEvent = {
      kind: "action_gave_up",
      what: "An action gave up.",
      ...scope,
      question: null,
      did: "Stopped trying.",
    };
    const first = w.alerts.raise(event);
    const second = w.alerts.raise({ ...event, what: "Another action gave up." });
    store.fail?.();
    await expect(first).rejects.toThrow("the store is unreachable");
    // The second caller (another give-up, a spending claim) is not told it was raised.
    await expect(second).rejects.toThrow("the store is unreachable");
    expect(w.state.attempts).toEqual([]);
  });
});
