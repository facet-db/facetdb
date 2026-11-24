import { FakeAlertStore, FakeChannel, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type AlertScope, type BoundChannel, createAlerts, RETRY_EVERY_MS } from "./alerts.ts";
import {
  ALERT_KINDS,
  ALERT_SEVERITY,
  type AlertEvent,
  alertMessage,
  eventKey,
  RESOLVABLE_ALERT_KINDS,
  resolvedMessage,
} from "./events.ts";

const MINUTE = 60_000;

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
  const store = new FakeAlertStore(clock);
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

  it("tries again at the next raise past the retry interval when no channel took the message", async () => {
    const { alerts, channel, store, clock } = setup();
    channel.failNextWith(new Error("webhook 500"));
    const first = await alerts.raise(eventOf("worker_not_running"));
    expect(first.failures).toHaveLength(1);
    expect(store.history[0]?.delivered).toBe(false);

    // Paced: within the retry interval a raise tries no channel and records nothing.
    expect((await alerts.raise(eventOf("worker_not_running"))).status).toBe("suppressed");
    expect(channel.delivered).toHaveLength(1);
    clock.advance(RETRY_EVERY_MS);
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
    const { alerts, channel, clock } = setup();
    const event = eventOf("spending_paused");
    await alerts.raise(event);
    channel.failNextWith(new Error("slack 503"));
    const failed = await alerts.resolve(eventKey(event));
    expect(failed.failures).toHaveLength(1);
    // Paced: no channel is tried again until the retry interval has passed.
    expect(await alerts.resolve(eventKey(event))).toEqual({ status: "idle", failures: [] });
    expect(channel.delivered).toHaveLength(2);
    clock.advance(RETRY_EVERY_MS);
    expect((await alerts.resolve(eventKey(event))).status).toBe("resolved");
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

  it("reads the alert store once for a run of healthy calls, and again after a beat", async () => {
    const { clock, alerts, store } = setup();
    let reads = 0;
    const getActive = store.getActive.bind(store);
    store.getActive = (key) => {
      reads += 1;
      return getActive(key);
    };
    const signals = alerts.signals(scope);
    await calls(alerts, clock, 20, 0);
    expect(reads).toBe(1);

    // A beat (once per pass) forgets what it knew: an alert another process raised under the
    // same key is still resolved by the next healthy call. The beat reads its own key once.
    await store.setActive(eventKey(eventOf("model_failing")), {
      event: eventOf("model_failing"),
      raisedAt: clock.now(),
      lastSentAt: clock.now(),
    });
    await signals.beat();
    reads = 0;
    await calls(alerts, clock, 5, 0);
    expect(reads).toBe(1);
    expect(store.active.get(eventKey(eventOf("model_failing")))).toBeUndefined();
  });

  it("lets healthy calls made at once (the worker's lanes) share one read of the alert state", async () => {
    const { alerts, store } = setup();
    let reads = 0;
    const getActive = store.getActive.bind(store);
    store.getActive = (key) => {
      reads += 1;
      return getActive(key);
    };
    const signals = alerts.signals(scope);
    await Promise.all(Array.from({ length: 8 }, () => signals.modelCall(true)));
    expect(reads).toBe(1);
  });

  it("keeps resolving on healthy calls, once per retry interval, while no channel takes the resolved message", async () => {
    const { clock, alerts, channel } = setup();
    await calls(alerts, clock, 0, 3);
    expect(channel.delivered).toHaveLength(1);
    clock.advance(5 * MINUTE);
    channel.failNextWith(new Error("slack 503"));
    // The first healthy call's resolved message is refused, off the call's path; the next calls
    // within the retry interval try nothing.
    await calls(alerts, clock, 2, 0);
    await alerts.drain();
    await calls(alerts, clock, 2, 0);
    expect(
      channel.delivered.map((delivery) => delivery.message.text.startsWith("Resolved:")),
    ).toEqual([false, true]);
    // Past the interval, taken: the alert is resolved, and later healthy calls send nothing more.
    clock.advance(RETRY_EVERY_MS);
    await calls(alerts, clock, 1, 0);
    await alerts.drain();
    await calls(alerts, clock, 3, 0);
    await alerts.drain();
    expect(
      channel.delivered.map((delivery) => delivery.message.text.startsWith("Resolved:")),
    ).toEqual([false, true, true]);
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
    clock.advance(2 * MINUTE);
    await signals.modelCall(false);
    await signals.backfillFinished({ answered: 12, queued: 0, question: null });
    await signals.backfillFailed({ failed: 3, question: "scam" });
    expect(channel.delivered).toHaveLength(3);
    for (const { message } of channel.delivered) {
      expect(message.text).toContain("market");
      expect(message.text).toContain("listings");
      expect(message.text).toContain("FacetDB:");
      expect(message.link).toBe(scope.link);
    }
    expect(channel.delivered.map((delivery) => delivery.message.severity)).toEqual([
      "critical",
      "information",
      "warning",
    ]);
  });
});

describe("the kinds the code resolves", () => {
  it("are the ones the detectors' signals clear, and the list says so", async () => {
    const { alerts, store } = setup();
    for (const kind of ALERT_KINDS) {
      await alerts.raise(eventOf(kind));
    }
    const signals = alerts.signals(scope);
    // The paths that resolve in code: a healthy model call, and a response naming the model its
    // version is held to. A beat resolves nothing.
    await signals.beat();
    await signals.modelCall(true);
    await signals.modelChecked(null);
    // The resolved message goes out off the call's path.
    await alerts.drain();

    const stillActive = ALERT_KINDS.filter((kind) => store.active.has(eventKey(eventOf(kind))));
    // Connector lost access is resolved by the worker's own reading of its sources (the facetdb
    // package), through `resolve`, which this module's signals never call.
    expect(stillActive).toEqual(
      ALERT_KINDS.filter((kind) => kind !== "model_failing" && kind !== "model_changed"),
    );
    expect([...RESOLVABLE_ALERT_KINDS]).toEqual([
      "model_failing",
      "model_changed",
      "connector_lost_access",
      "action_credential_refused",
      "source_stopped",
    ]);
    const lost = eventKey(eventOf("connector_lost_access"));
    expect((await alerts.resolve(lost)).status).toBe("resolved");
    expect(store.active.has(lost)).toBe(false);
    // The outbox's next delivered try of the plugin resolves it, through `resolve` too.
    const refused = eventKey(eventOf("action_credential_refused"));
    expect((await alerts.resolve(refused)).status).toBe("resolved");
    expect(store.active.has(refused)).toBe(false);
  });

  it("keys a refused credential by its plugin: one alert per plugin of a source", async () => {
    const { alerts, store } = setup();
    const refused = (plugin: string) => ({ ...eventOf("action_credential_refused"), plugin });
    expect((await alerts.raise(refused("@facetdb/github"))).status).toBe("sent");
    expect((await alerts.raise(refused("@facetdb/github"))).status).toBe("suppressed");
    expect((await alerts.raise(refused("@facetdb/telegram"))).status).toBe("sent");
    expect(eventKey(refused("@facetdb/github"))).toBe(
      `${eventKey(eventOf("action_credential_refused"))}|plugin:@facetdb/github`,
    );
    expect(store.history.map((line) => line.event.plugin)).toEqual([
      "@facetdb/github",
      "@facetdb/telegram",
    ]);
  });

  it("keys a question-set change by its version: one version is one alert, the next is another", async () => {
    const { alerts, store } = setup();
    const changed = (version: number) => ({ ...eventOf("question_set_changed"), version });
    expect((await alerts.raise(changed(2))).status).toBe("sent");
    expect((await alerts.raise(changed(2))).status).toBe("suppressed");
    expect((await alerts.raise(changed(3))).status).toBe("sent");
    expect(eventKey(changed(3))).toBe(`${eventKey(eventOf("question_set_changed"))}|v3`);
    expect(store.history.map((line) => line.event.version)).toEqual([2, 3]);
  });
});

describe("severities", () => {
  it("lists the first kinds with their severities", () => {
    expect(ALERT_SEVERITY).toEqual({
      worker_not_running: "critical",
      model_failing: "critical",
      model_changed: "critical",
      connector_lost_access: "critical",
      spending_80: "warning",
      spending_paused: "critical",
      backfill_finished: "information",
      backfill_failed: "warning",
      question_set_changed: "information",
      action_gave_up: "warning",
      action_credential_refused: "warning",
      source_stopped: "critical",
    });
  });
});

/** The fake store, each read of the alerts held while the gate is closed, every read counted. */
class GatedAlertStore extends FakeAlertStore {
  readonly reads: string[] = [];
  /** Every read fails, as an alert store that is down. */
  failReads = false;
  #open: (() => void) | undefined;
  #gate: Promise<void> | undefined;

  close(): void {
    this.#gate = new Promise((open) => {
      this.#open = open;
    });
  }

  open(): void {
    this.#open?.();
    this.#gate = undefined;
  }

  override async getActive(key: string) {
    this.reads.push(key);
    await this.#gate;
    if (this.failReads) {
      throw new Error("the alerts table is unreachable");
    }
    return super.getActive(key);
  }
}

describe("resolveOpen: an alert something healthy resolves again and again", () => {
  const refused = { ...eventOf("action_credential_refused"), plugin: "@facetdb/github" };
  const key = eventKey(refused);

  function gated() {
    const clock = new FakeClock(1_000_000);
    const store = new GatedAlertStore(clock);
    const channel = new FakeChannel<null>();
    const alerts = createAlerts({
      store,
      clock,
      channels: [{ name: "fake", deliver: (message) => channel.deliver(message, null) }],
    });
    const resolvedSent = () =>
      channel.delivered.filter((delivery) => delivery.message.text.startsWith("Resolved:"));
    return { clock, store, alerts, resolvedSent };
  }

  it("shares one read and one resolved message among callers whose calls overlap", async () => {
    const { store, alerts, resolvedSent } = gated();
    await alerts.raise(refused);
    const before = store.reads.length;
    store.close();
    const calls = Array.from({ length: 20 }, () => alerts.resolveOpen(key));
    store.open();
    await Promise.all(calls);

    expect(store.reads.slice(before)).toEqual([key]);
    expect(resolvedSent()).toHaveLength(1);
    expect(store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("reads nothing while the key is known clear; a raise, or its source's heartbeat, reads again", async () => {
    const { store, alerts, resolvedSent } = gated();
    await alerts.resolveOpen(key);
    await alerts.resolveOpen(key);
    expect(store.reads).toEqual([key]);

    // Its own raise makes the key open again: the next call reads and resolves it.
    await alerts.raise(refused);
    const before = store.reads.length;
    await alerts.resolveOpen(key);
    expect(resolvedSent()).toHaveLength(1);
    expect(store.reads.slice(before)).toEqual([key]);

    // Another process's raise is unseen until the source's heartbeat forgets what this one knew.
    const other = createAlerts({
      store,
      clock: new FakeClock(1_000_000 + 31 * MINUTE),
      channels: [],
    });
    await other.raise(refused);
    await alerts.resolveOpen(key);
    expect(store.active.has(key)).toBe(true);
    await alerts.signals(scope).beat();
    await alerts.resolveOpen(key);
    expect(store.active.has(key)).toBe(false);
  });

  it("resolves an alert an earlier run left open at its first call", async () => {
    const { store, clock } = gated();
    await createAlerts({ store, clock, channels: [] }).raise(refused);
    const restarted = createAlerts({ store, clock, channels: [] });
    await restarted.resolveOpen(key);
    expect(store.active.has(key)).toBe(false);
    expect(store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("rejects when the store fails, and learns nothing from it", async () => {
    const { store, alerts } = gated();
    await alerts.raise(refused);
    store.failReads = true;
    await expect(alerts.resolveOpen(key)).rejects.toThrow("unreachable");
    store.failReads = false;
    await alerts.resolveOpen(key);
    expect(store.active.has(key)).toBe(false);
  });
});
