import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  type BoundChannel,
  ChannelFailed,
  type ChannelFailure,
  createAlerts,
  DELIVERY_ERROR_NOT_KEPT,
  deliveryWords,
} from "./alerts.ts";
import { type AlertEvent, eventKey } from "./events.ts";

/**
 * Each channel's outcome kept with the event's history line: the line is recorded before any
 * channel is tried and settled once they answer; a channel's `takes` leaves a message out for it
 * (not a delivery, not a failure); only a `ChannelFailed`'s words are kept, cleaned, and any other
 * error is the fixed `DELIVERY_ERROR_NOT_KEPT`; every failure is reported once.
 */

const SECRET = "sk_live_9d8c7b6a5f4e3d2c";

function eventOf(kind: AlertEvent["kind"]): AlertEvent {
  return {
    kind,
    what: "Something happened.",
    project: "market",
    source: "listings",
    question: null,
    did: "Nothing yet.",
    link: "https://app.facetdb.test/fix",
  };
}

function setup(channels: readonly BoundChannel[]) {
  const clock = new FakeClock(1_000_000);
  const store = new FakeAlertStore(clock);
  const reported: ChannelFailure[] = [];
  const alerts = createAlerts({
    store,
    clock,
    channels,
    report: (failure) => reported.push(failure),
  });
  return { store, alerts, reported };
}

describe("a delivery's outcome in the history", () => {
  it("records the line before any channel is tried, then settles it with each channel's outcome", async () => {
    const seen: unknown[] = [];
    const { store, alerts } = setup([
      {
        name: "slack:#ops",
        deliver: () => {
          seen.push(structuredClone(store.history));
          return Promise.resolve();
        },
      },
    ]);
    await alerts.raise(eventOf("model_failing"));
    expect(seen).toEqual([
      [expect.objectContaining({ delivered: false, deliveries: [], pending: true })],
    ]);
    expect(store.history).toEqual([
      expect.objectContaining({
        delivered: true,
        deliveries: [{ channel: "slack:#ops", ok: true }],
      }),
    ]);
  });

  it("keeps a ChannelFailed's words, cleaned, and no other error's words, cause or properties", async () => {
    const leaky = Object.assign(new Error(`token ${SECRET}`, { cause: new Error(SECRET) }), {
      secret: SECRET,
    });
    const { store, alerts, reported } = setup([
      {
        name: "a:1",
        deliver: () => Promise.reject(new ChannelFailed("no answer\nwithin\u0007 30 s")),
      },
      { name: "b:2", deliver: () => Promise.reject(leaky) },
      {
        name: "c:3",
        deliver: () => {
          throw leaky;
        },
      },
      { name: "d:4", deliver: () => Promise.reject(new ChannelFailed("")) },
    ]);
    const outcome = await alerts.raise(eventOf("model_failing"));
    expect(outcome.failures).toEqual([
      { channel: "a:1", error: "no answer within  30 s" },
      { channel: "b:2", error: DELIVERY_ERROR_NOT_KEPT },
      { channel: "c:3", error: DELIVERY_ERROR_NOT_KEPT },
      { channel: "d:4", error: DELIVERY_ERROR_NOT_KEPT },
    ]);
    expect(reported).toEqual(outcome.failures);
    expect(store.history[0]?.delivered).toBe(false);
    expect(JSON.stringify(store.history)).not.toContain(SECRET.slice(0, 8));
    expect(JSON.stringify(store.history)).not.toContain(SECRET.slice(-8));
  });

  it("leaves a message out for a channel that does not take its severity, listing only the channels tried", async () => {
    const { store, alerts, reported } = setup([
      {
        name: "critical:only",
        takes: (severity) => severity === "critical",
        deliver: () => Promise.resolve(),
      },
      { name: "all:of-it", deliver: () => Promise.resolve() },
    ]);
    await alerts.raise(eventOf("backfill_finished"));
    expect(store.history[0]?.deliveries).toEqual([{ channel: "all:of-it", ok: true }]);
    expect(reported).toEqual([]);
  });

  it("writes no deliveries at all when no channel takes the message, as before channels existed", async () => {
    const { store, alerts } = setup([
      {
        name: "critical:only",
        takes: (severity) => severity === "critical",
        deliver: () => Promise.resolve(),
      },
    ]);
    await alerts.raise(eventOf("backfill_finished"));
    expect(Object.keys(store.history[0] ?? {}).sort()).toEqual([
      "at",
      "delivered",
      "event",
      "key",
      "phase",
      "severity",
    ]);
    expect(store.history[0]?.delivered).toBe(true);
  });

  it("goes on when the report itself throws: the failure is recorded all the same", async () => {
    const clock = new FakeClock(0);
    const store = new FakeAlertStore(clock);
    const alerts = createAlerts({
      store,
      clock,
      channels: [{ name: "a:1", deliver: () => Promise.reject(new Error("down")) }],
      report: () => {
        throw new Error("the terminal is gone");
      },
    });
    const outcome = await alerts.raise(eventOf("spending_80"));
    expect(outcome.status).toBe("sent");
    expect(store.history[0]?.deliveries).toEqual([
      { channel: "a:1", ok: false, error: DELIVERY_ERROR_NOT_KEPT },
    ]);
    expect(store.active.get(eventKey(eventOf("spending_80")))?.lastSentAt).toBeNull();
  });

  it("sends an event once when it is raised again while its channels are still being tried", async () => {
    const ends: (() => void)[] = [];
    let calls = 0;
    const { store, alerts } = setup([
      {
        name: "slow:1",
        deliver: () =>
          new Promise<void>((resolve) => {
            calls += 1;
            ends.push(resolve);
          }),
      },
    ]);
    const first = alerts.raise(eventOf("model_failing"));
    await new Promise((resolve) => setImmediate(resolve));
    // Another lane's failure, while the first raise still waits on the channel: it shares that
    // raise, and gets its outcome.
    const second = alerts.raise(eventOf("model_failing"));
    expect(second).toBe(first);
    for (const end of ends) {
      end();
    }
    expect((await first).status).toBe("sent");
    expect((await second).status).toBe("sent");
    expect(calls).toBe(1);
    expect(store.history).toHaveLength(1);
    // Once sent, the 30-minute rule holds it back as before.
    expect((await alerts.raise(eventOf("model_failing"))).status).toBe("suppressed");
  });

  it("cleans words of control and format characters and holds them to 300 characters", () => {
    expect(deliveryWords("a\u0000b\u001b[31mc​d‮e")).toBe("a b [31mc d e");
    expect(deliveryWords("x".repeat(1000))).toHaveLength(300);
  });
});
