import { FakeChannel, FakeClock, FakeStore } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  type ActiveAlert,
  type AlertRecord,
  type AlertScope,
  type AlertStore,
  type BoundChannel,
  createAlerts,
} from "./alerts.ts";
import {
  ALERT_KINDS,
  ALERT_SEVERITY,
  type AlertEvent,
  alertMessage,
  eventKey,
  resolvedMessage,
} from "./events.ts";

const MINUTE = 60_000;

class MemoryAlertStore implements AlertStore {
  readonly active = new FakeStore<ActiveAlert>();
  readonly history: AlertRecord[] = [];
  readonly #beats = new Map<string, number>();

  getActive(key: string): Promise<ActiveAlert | undefined> {
    return Promise.resolve(this.active.get(key));
  }
  setActive(key: string, alert: ActiveAlert): Promise<void> {
    this.active.set(key, alert);
    return Promise.resolve();
  }
  clearActive(key: string): Promise<void> {
    this.active.delete(key);
    return Promise.resolve();
  }
  append(record: AlertRecord): Promise<void> {
    this.history.push(record);
    return Promise.resolve();
  }
  lastHeartbeat(project: string): Promise<number | undefined> {
    return Promise.resolve(this.#beats.get(project));
  }
  saveHeartbeat(project: string, at: number): Promise<void> {
    this.#beats.set(project, at);
    return Promise.resolve();
  }
}

const scope: AlertScope = {
  project: "market",
  source: "listings",
  link: "https://app.facetdb.test/projects/market/health",
};

function eventOf(kind: AlertEvent["kind"], question: string | null = null): AlertEvent {
  return {
    kind,
    what: `Something happened (${kind}).`,
    project: "market",
    source: "listings",
    question,
    did: "Paused the source and kept every record queued.",
    link: "https://app.facetdb.test/projects/market/fix",
  };
}

function setup(channelCount = 1) {
  const clock = new FakeClock(1_000_000);
  const store = new MemoryAlertStore();
  const fakes = Array.from({ length: channelCount }, () => new FakeChannel<null>());
  const channels: BoundChannel[] = fakes.map((fake, index) => ({
    name: `fake-${index}`,
    deliver: (message) => fake.deliver(message, null),
  }));
  const alerts = createAlerts({ store, clock, channels });
  // With no channel configured the first fake below exists only so tests can read an empty list.
  return { clock, store, alerts, fakes, channel: fakes[0] ?? new FakeChannel<null>() };
}

describe("one alert per event per 30 minutes", () => {
  it("@timing sends the first alert, holds back repeats for 30 minutes, then sends again", async () => {
    const { clock, alerts, channel } = setup();
    const event = eventOf("spending_paused");

    expect((await alerts.raise(event)).status).toBe("sent");
    clock.advance(29 * MINUTE + 59_999);
    expect((await alerts.raise(event)).status).toBe("suppressed");
    expect(channel.delivered).toHaveLength(1);

    clock.advance(1);
    expect((await alerts.raise(event)).status).toBe("sent");
    expect(channel.delivered).toHaveLength(2);
    // The window restarts from the second send.
    clock.advance(10 * MINUTE);
    expect((await alerts.raise(event)).status).toBe("suppressed");
  });

  it("treats other questions, sources and kinds as other events", async () => {
    const { alerts, channel } = setup();
    await alerts.raise(eventOf("backfill_failed", "scam"));
    await alerts.raise(eventOf("backfill_failed", "spam"));
    await alerts.raise({ ...eventOf("backfill_failed", "scam"), source: "orders" });
    await alerts.raise(eventOf("backfill_finished", "scam"));
    expect(channel.delivered).toHaveLength(4);
  });

  it("records every raise in the store with its severity", async () => {
    const { store, alerts } = setup();
    await alerts.raise(eventOf("spending_80"));
    expect(store.history).toMatchObject([
      {
        phase: "raised",
        severity: "warning",
        delivered: true,
        key: eventKey(eventOf("spending_80")),
      },
    ]);
  });

  it("records the event and counts it sent when no channel is configured", async () => {
    const { alerts, store } = setup(0);
    expect((await alerts.raise(eventOf("model_failing"))).status).toBe("sent");
    expect((await alerts.raise(eventOf("model_failing"))).status).toBe("suppressed");
    expect(store.history).toHaveLength(1);
  });

  it("reports a refusing channel and still reaches the others", async () => {
    const { alerts, fakes } = setup(2);
    const [broken, working] = fakes;
    broken?.failNextWith(new Error("smtp down"));
    const outcome = await alerts.raise(eventOf("connector_lost_access"));
    expect(outcome.status).toBe("sent");
    expect(outcome.failures).toMatchObject([{ channel: "fake-0" }]);
    expect(working?.delivered).toHaveLength(1);
  });

  it("tries again at the next raise when no channel took the message", async () => {
    const { alerts, channel, store } = setup();
    channel.failNextWith(new Error("webhook 500"));
    const first = await alerts.raise(eventOf("worker_not_running"));
    expect(first.failures).toHaveLength(1);
    expect(store.history[0]?.delivered).toBe(false);

    expect((await alerts.raise(eventOf("worker_not_running"))).status).toBe("sent");
    expect(channel.delivered).toHaveLength(2);
    expect((await alerts.raise(eventOf("worker_not_running"))).status).toBe("suppressed");
  });
});

describe("resolution", () => {
  it("sends the resolved message once, then lets the event be raised afresh", async () => {
    const { alerts, channel, store } = setup();
    const event = eventOf("model_failing");
    const key = eventKey(event);
    await alerts.raise(event);

    expect((await alerts.resolve(key)).status).toBe("resolved");
    expect((await alerts.resolve(key)).status).toBe("idle");
    expect(channel.delivered).toHaveLength(2);
    expect(channel.delivered[1]?.message).toEqual(resolvedMessage(event));
    expect(channel.delivered[1]?.message.text.startsWith("Resolved:")).toBe(true);
    expect(store.history.map((record) => record.phase)).toEqual(["raised", "resolved"]);

    // Resolved means the 30-minute window no longer applies: the next failure alerts at once.
    expect((await alerts.raise(event)).status).toBe("sent");
  });

  it("sends nothing for a key that was never raised", async () => {
    const { alerts, channel } = setup();
    expect((await alerts.resolve("nothing")).status).toBe("idle");
    expect(channel.delivered).toEqual([]);
  });

  it("keeps the alert active when no channel took the resolved message", async () => {
    const { alerts, channel } = setup();
    const event = eventOf("spending_paused");
    await alerts.raise(event);
    channel.failNextWith(new Error("slack 503"));
    const failed = await alerts.resolve(eventKey(event));
    expect(failed.failures).toHaveLength(1);
    expect((await alerts.resolve(eventKey(event))).status).toBe("resolved");
  });
});

describe("the heartbeat watcher", () => {
  it("@timing raises worker_not_running at 2 minutes without a beat, not before", async () => {
    const { clock, alerts, channel } = setup();
    const signals = alerts.signals(scope);
    await signals.beat();

    clock.advance(2 * MINUTE - 1);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("idle");
    expect(channel.delivered).toEqual([]);

    clock.advance(1);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("sent");
    expect(channel.delivered[0]?.message).toMatchObject({ severity: "critical" });
  });

  it("@timing repeats at most every 30 minutes while the worker stays away", async () => {
    const { clock, alerts, channel } = setup();
    await alerts.signals(scope).beat();
    clock.advance(3 * MINUTE);
    await alerts.checkHeartbeat(scope);
    clock.advance(10 * MINUTE);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("suppressed");
    clock.advance(20 * MINUTE);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("sent");
    expect(channel.delivered).toHaveLength(2);
  });

  it("resolves when the worker beats again, with the resolved message once", async () => {
    const { clock, alerts, channel } = setup();
    const signals = alerts.signals(scope);
    await signals.beat();
    clock.advance(5 * MINUTE);
    await alerts.checkHeartbeat(scope);

    await signals.beat();
    await signals.beat();
    expect(
      channel.delivered.map((delivery) => delivery.message.text.startsWith("Resolved:")),
    ).toEqual([false, true]);
  });

  it("says nothing about a project whose worker never reported", async () => {
    const { clock, alerts, channel } = setup();
    clock.advance(60 * MINUTE);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("idle");
    expect(channel.delivered).toEqual([]);
  });

  it("watches each project by its own beat", async () => {
    const { clock, alerts, channel } = setup();
    const other: AlertScope = { ...scope, project: "blog" };
    await alerts.signals(scope).beat();
    await alerts.signals(other).beat();
    clock.advance(90_000);
    await alerts.signals(other).beat();
    clock.advance(60_000);
    expect((await alerts.checkHeartbeat(scope)).status).toBe("sent");
    expect((await alerts.checkHeartbeat(other)).status).toBe("idle");
    expect(channel.delivered).toHaveLength(1);
  });
});

describe("the failure-rate window", () => {
  async function calls(
    alerts: ReturnType<typeof setup>["alerts"],
    clock: FakeClock,
    ok: number,
    failed: number,
  ): Promise<void> {
    const signals = alerts.signals(scope);
    for (let i = 0; i < ok; i += 1) {
      await signals.modelCall(true);
      clock.advance(100);
    }
    for (let i = 0; i < failed; i += 1) {
      await signals.modelCall(false);
      clock.advance(100);
    }
  }

  it("does not alert at exactly 5% failing", async () => {
    const { clock, alerts, channel } = setup();
    await calls(alerts, clock, 19, 1);
    expect(channel.delivered).toEqual([]);
  });

  it("alerts when more than 5% fail", async () => {
    const { clock, alerts, channel } = setup();
    await calls(alerts, clock, 19, 1);
    expect(channel.delivered).toEqual([]);
    await calls(alerts, clock, 0, 1);
    expect(channel.delivered).toHaveLength(1);
    expect(channel.delivered[0]?.message).toMatchObject({ severity: "critical" });
    expect(channel.delivered[0]?.message.text).toContain("2 of 21");
  });

  it("@timing forgets calls older than 5 minutes", async () => {
    const { clock, alerts, channel } = setup();
    // A burst of failures raises the alert...
    await calls(alerts, clock, 0, 3);
    expect(channel.delivered).toHaveLength(1);
    // ...and 5 minutes of healthy calls push it out of the window and resolve it.
    clock.advance(5 * MINUTE);
    await calls(alerts, clock, 20, 0);
    const texts = channel.delivered.map((delivery) => delivery.message.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]?.startsWith("Resolved:")).toBe(true);
  });

  it("@timing counts a call until the window closes on it, exactly 5 minutes later", async () => {
    // 19 healthy calls and 1 failure, all at one instant: exactly 5%, so quiet.
    async function seeded() {
      const world = setup();
      const signals = world.alerts.signals(scope);
      for (let i = 0; i < 19; i += 1) {
        await signals.modelCall(true);
      }
      await signals.modelCall(false);
      expect(world.channel.delivered).toEqual([]);
      return { ...world, signals };
    }

    // One millisecond before the seeded calls leave the window, a second failure still sees all 21.
    const inside = await seeded();
    inside.clock.advance(5 * MINUTE - 1);
    await inside.signals.modelCall(false);
    expect(inside.channel.delivered[0]?.message.text).toContain("2 of 21");

    // At exactly 5 minutes they are gone and only the new failure counts.
    const outside = await seeded();
    outside.clock.advance(5 * MINUTE);
    await outside.signals.modelCall(false);
    expect(outside.channel.delivered[0]?.message.text).toContain("1 of 1");
  });

  it("stays quiet while every call succeeds", async () => {
    const { clock, alerts, channel } = setup();
    await calls(alerts, clock, 50, 0);
    expect(channel.delivered).toEqual([]);
  });
});

describe("what every alert says", () => {
  it.each(ALERT_KINDS)(
    "%s carries what happened, project, source, question, what FacetDB did and a link",
    (kind) => {
      const event = eventOf(kind, "scam");
      const message = alertMessage(event);
      expect(message.kind).toBe("system-alert");
      expect(message.text).toContain(event.what);
      expect(message.text).toContain(event.project);
      expect(message.text).toContain(event.source);
      expect(message.text).toContain("scam");
      expect(message.text).toContain(event.did);
      expect(message.link).toBe(event.link);
      expect(message.severity).toBe(ALERT_SEVERITY[kind]);
    },
  );

  it("names every question when the event concerns none in particular", () => {
    expect(alertMessage(eventOf("worker_not_running")).text).toContain("all questions");
  });

  it("carries the same parts in the resolved message", () => {
    const event = eventOf("spending_paused", "scam");
    const message = resolvedMessage(event);
    expect(message.text).toContain(event.what);
    expect(message.text).toContain("market");
    expect(message.text).toContain("listings");
    expect(message.text).toContain("scam");
    expect(message.link).toBe(event.link);
  });

  it("builds the messages its detectors send from the scope they were given", async () => {
    const { clock, alerts, channel } = setup();
    const signals = alerts.signals(scope);
    await signals.beat();
    clock.advance(2 * MINUTE);
    await alerts.checkHeartbeat(scope);
    await signals.modelCall(false);
    await signals.backfillFinished({ answered: 12, queued: 0, question: null });
    await signals.backfillFailed({ failed: 3, question: "scam" });
    expect(channel.delivered).toHaveLength(4);
    for (const { message } of channel.delivered) {
      expect(message.text).toContain("market");
      expect(message.text).toContain("listings");
      expect(message.text).toContain("FacetDB:");
      expect(message.link).toBe(scope.link);
    }
    expect(channel.delivered.map((delivery) => delivery.message.severity)).toEqual([
      "critical",
      "critical",
      "information",
      "warning",
    ]);
  });
});

describe("severities", () => {
  it("lists every kind with its severity", () => {
    expect(ALERT_SEVERITY).toEqual({
      worker_not_running: "critical",
      model_failing: "critical",
      connector_lost_access: "critical",
      spending_80: "warning",
      spending_paused: "critical",
      backfill_finished: "information",
      backfill_failed: "warning",
      question_set_changed: "information",
    });
  });
});
