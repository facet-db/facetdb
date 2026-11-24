import { FakeAlertStore, FakeChannel, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type BoundChannel, createAlerts } from "./alerts.ts";
import {
  ALERT_KINDS,
  ALERT_SEVERITY,
  ALERT_TITLES,
  type AlertEvent,
  eventKey,
  HELD_AFTER_RESOLVE_KINDS,
  QUOTED_WORDS_MAX,
  quotedWords,
  RESOLVABLE_ALERT_KINDS,
  sourceStoppedEvent,
  sourceStoppedWords,
} from "./events.ts";

/**
 * The Source stopped alert kind, its words on every channel (Home's for the stop, with no time that
 * can be stale), the failure's words quoted as a third-party channel may show them, its severity,
 * and its one raise per 30 minutes, across a resolve, through the alerts' fakes. Who raises and
 * resolves it is the facetdb package's (alert-raisers-source-stopped.test.ts).
 */

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-18T14:00:00Z");
const RETRY_AT = Date.parse("2026-11-18T14:07:00Z");
const WHERE = { project: "market", link: "https://studio.example.com/sources" };
const PLACE = "Project market, source orders, all questions.";

function setup() {
  const clock = new FakeClock(NOW);
  const store = new FakeAlertStore(clock);
  const channel = new FakeChannel<null>();
  const channels: BoundChannel[] = [
    { name: "slack:#ops", deliver: (message) => channel.deliver(message, null) },
  ];
  /** What the channel was sent: each message's severity and text. */
  const sent = () =>
    channel.delivered.map((delivery) => `${delivery.message.severity}: ${delivery.message.text}`);
  return { clock, store, channel, sent, alerts: createAlerts({ store, clock, channels }) };
}

const stopped = (why = "connection reset", retryAt: number | null = RETRY_AT) =>
  sourceStoppedEvent({ source: "orders", why, retryAt }, WHERE);

const KEY = eventKey({
  kind: "source_stopped",
  project: "market",
  source: "orders",
  question: null,
});

describe("the Source stopped kind", () => {
  it("comes after Action credential refused, critical, titled Source stopped, resolvable and held after its resolve", () => {
    const at = ALERT_KINDS.indexOf("source_stopped");
    expect(at).toBeGreaterThan(ALERT_KINDS.indexOf("action_credential_refused"));
    expect(ALERT_KINDS.indexOf("action_credential_refused")).toBeGreaterThanOrEqual(0);
    expect(ALERT_SEVERITY.source_stopped).toBe("critical");
    expect(ALERT_TITLES.source_stopped).toBe("Source stopped");
    expect(RESOLVABLE_ALERT_KINDS).toContain("source_stopped");
    expect(HELD_AFTER_RESOLVE_KINDS).toEqual(["source_stopped"]);
  });

  it("says the next try's time on Home, read live, and only that FacetDB keeps trying in an alert", () => {
    const stop = { source: "orders", why: "connection reset.", retryAt: RETRY_AT };
    expect(sourceStoppedWords(stop, true)).toEqual({
      what: "orders stopped: connection reset.",
      next: "Trying again at 2026-11-18 14:07 UTC.",
    });
    expect(sourceStoppedWords(stop, false)).toEqual({
      what: "orders stopped: connection reset.",
      next: "Retrying on its own.",
    });
    const refused =
      "Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.";
    for (const live of [true, false]) {
      expect(sourceStoppedWords({ ...stop, retryAt: null }, live).next).toBe(refused);
    }
  });

  it("tells every channel what stopped, why, and what FacetDB does, with no time, and one link", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    t.clock.advance(31 * MINUTE);
    await t.alerts.raise(
      sourceStoppedEvent(
        { source: "issues", why: "the plugin failed in watch", retryAt: null },
        WHERE,
      ),
    );

    expect(t.sent()).toEqual([
      `critical: orders stopped: connection reset. ${PLACE} FacetDB: Retrying on its own.`,
      "critical: issues stopped: the plugin failed in watch. Project market, source issues, all questions. FacetDB: Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.",
    ]);
    expect(t.channel.delivered.map((delivery) => delivery.message.link)).toEqual([
      WHERE.link,
      WHERE.link,
    ]);
  });

  it("says its end in its own short line, never its old cause", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    expect((await t.alerts.resolve(KEY)).status).toBe("resolved");
    expect(t.sent()[1]).toBe(`information: orders runs again. ${PLACE}`);
  });
});

describe("a driver's words quoted as a third-party channel may show them", () => {
  it("defangs addresses and links, drops control characters and markup, and keeps the sentence", () => {
    expect(
      quotedWords(
        "connect ECONNREFUSED 10.0.0.7:5432\n<https://evil.example/x|click> *now* `rm` #ops & more",
      ),
    ).toBe(
      "connect ECONNREFUSED 10[.]0[.]0[.]7:5432 https[:]//evil[.]example/xclick now rm ops more",
    );
    expect(quotedWords('database "shop.db" is locked, try again.')).toBe(
      'database "shop[.]db" is locked, try again.',
    );
    expect(quotedWords("<>*~`")).toBe("its error has nothing printable");
  });

  it("keeps the characters that carry meaning: _, @ and the [hidden] marker", () => {
    expect(
      quotedWords(
        "ER_ACCESS_DENIED_ERROR on facetdb_jobs for [hidden]; the plugin @facetdb/tracker failed",
      ),
    ).toBe(
      "ER_ACCESS_DENIED_ERROR on facetdb_jobs for [hidden]; the plugin @facetdb/tracker failed",
    );
  });

  it("keeps no other brackets, so no Markdown link survives, not even one made of the marker", () => {
    expect(quotedWords("see [click](example.com) for [hidden] and [x]")).toBe(
      "see click(example[.]com) for [hidden] and x",
    );
    expect(quotedWords("[hidden](evil.example)")).toBe("[hidden] (evil[.]example)");
  });

  it("is cut at its length, never inside a character", () => {
    const words = quotedWords("é".repeat(QUOTED_WORDS_MAX + 10));
    expect([...words]).toHaveLength(QUOTED_WORDS_MAX);
    expect(words.endsWith("…")).toBe(true);
  });

  it("quotes the failure in the alert, as every channel receives it", async () => {
    const t = setup();
    await t.alerts.raise(stopped("connect ECONNREFUSED 10.0.0.7:5432 <http://x.example>"));
    expect(t.sent()[0]).toBe(
      `critical: orders stopped: connect ECONNREFUSED 10[.]0[.]0[.]7:5432 http[:]//x[.]example. ${PLACE} FacetDB: Retrying on its own.`,
    );
    expect(t.sent()[0]).not.toContain("10.0.0.7");
  });
});

describe("one raise per 30 minutes, across a resolve", () => {
  it("@timing records a stop again inside 30 minutes of the last raise sent, open, and sends neither it nor its end", async () => {
    const t = setup();
    expect((await t.alerts.raise(stopped())).status).toBe("sent");
    t.clock.advance(5 * MINUTE);
    expect((await t.alerts.resolve(KEY)).status).toBe("resolved");

    // Stops again 10 minutes after the raise sent: recorded and open, sent to no channel.
    t.clock.advance(5 * MINUTE);
    expect((await t.alerts.raise(stopped())).status).toBe("suppressed");
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved", "raised"]);
    expect(t.store.active.get(KEY)).toMatchObject({ unsent: true, lastSentAt: NOW });
    // Raised again while it stays stopped: the same open alert, nothing more recorded or sent.
    t.clock.advance(5 * MINUTE);
    expect((await t.alerts.raise(stopped())).status).toBe("suppressed");
    expect(t.store.history).toHaveLength(3);
    // Runs again: its end is recorded, and sent to no one, who never heard it stopped again.
    t.clock.advance(5 * MINUTE);
    expect((await t.alerts.resolve(KEY)).status).toBe("resolved");
    expect(t.store.history.map((line) => line.phase)).toEqual([
      "raised",
      "resolved",
      "raised",
      "resolved",
    ]);
    // Recorded as they were: the held raise and its end reached no channel, on purpose.
    expect(
      t.store.history.map((line) => [line.delivered, line.withheld ?? false, line.held ?? []]),
    ).toEqual([
      [true, false, []],
      [true, false, []],
      [false, true, []],
      [false, true, []],
    ]);
    expect(t.sent()).toEqual([
      `critical: orders stopped: connection reset. ${PLACE} FacetDB: Retrying on its own.`,
      `information: orders runs again. ${PLACE}`,
    ]);

    // 30 minutes after the last raise sent, a stop is sent again, and so is its end.
    t.clock.advance(NOW + 30 * MINUTE - t.clock.now());
    expect((await t.alerts.raise(stopped())).status).toBe("sent");
    expect((await t.alerts.resolve(KEY)).status).toBe("resolved");
    expect(t.sent()).toHaveLength(4);
    expect(t.sent()[3]).toBe(`information: orders runs again. ${PLACE}`);
  });

  it("@timing sends a stop held open once the 30 minutes are over, and then its end", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    await t.alerts.resolve(KEY);
    t.clock.advance(10 * MINUTE);
    await t.alerts.raise(stopped());
    expect(t.sent()).toHaveLength(2);

    // Still stopped when the 30 minutes since the last raise sent are over: its next raise is sent.
    t.clock.advance(20 * MINUTE);
    expect((await t.alerts.raise(stopped())).status).toBe("sent");
    expect(t.store.active.get(KEY)?.unsent).toBeUndefined();
    expect((await t.alerts.resolve(KEY)).status).toBe("resolved");
    expect(t.sent().map((line) => line.split(":")[0])).toEqual([
      "critical",
      "information",
      "critical",
      "information",
    ]);
  });

  it("leaves every other kind as it was: its resolve clears it, and a raise after it is sent at once", async () => {
    const t = setup();
    const lost: AlertEvent = { ...stopped(), kind: "connector_lost_access" };
    const key = eventKey(lost);
    await t.alerts.raise(lost);
    await t.alerts.resolve(key);
    expect(t.store.active.has(key)).toBe(false);
    t.clock.advance(MINUTE);
    expect((await t.alerts.raise(lost)).status).toBe("sent");
    expect(t.sent()).toHaveLength(3);
  });

  it("@timing never holds a stop no wait mends: 02:00 sent, 02:05 runs again, 02:10 refused is sent at once", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    t.clock.advance(5 * MINUTE);
    await t.alerts.resolve(KEY);
    t.clock.advance(5 * MINUTE);
    const refused = stopped("SQLite allows one worker", null);
    expect((await t.alerts.raise(refused, { atOnce: true })).status).toBe("sent");
    expect(t.sent()).toEqual([
      `critical: orders stopped: connection reset. ${PLACE} FacetDB: Retrying on its own.`,
      `information: orders runs again. ${PLACE}`,
      `critical: orders stopped: SQLite allows one worker. ${PLACE} FacetDB: Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.`,
    ]);
    // Its end is sent too: people heard it stop.
    await t.alerts.resolve(KEY);
    expect(t.sent()[3]).toBe(`information: orders runs again. ${PLACE}`);
  });

  it("@timing sends a stop no wait mends that comes while a raise that will be held is in flight", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    t.clock.advance(5 * MINUTE);
    await t.alerts.resolve(KEY);
    t.clock.advance(5 * MINUTE);
    // The store answers slowly: the plain stop's raise is still reading it when the refusal comes.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = t.store.getActive.bind(t.store);
    t.store.getActive = async (key) => {
      await gate;
      return read(key);
    };
    const plain = t.alerts.raise(stopped());
    const refused = t.alerts.raise(stopped("locked", null), { atOnce: true });
    release();
    expect((await plain).status).toBe("suppressed");
    expect((await refused).status).toBe("sent");
    expect(t.sent()[2]).toBe(
      `critical: orders stopped: locked. ${PLACE} FacetDB: Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.`,
    );
  });

  it("@timing sends a stop no wait mends over an open raise that was held", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    await t.alerts.resolve(KEY);
    t.clock.advance(5 * MINUTE);
    await t.alerts.raise(stopped());
    expect(t.sent()).toHaveLength(2);
    t.clock.advance(MINUTE);
    expect((await t.alerts.raise(stopped("locked", null), { atOnce: true })).status).toBe("sent");
    expect(t.sent()).toHaveLength(3);
    expect(t.store.active.get(KEY)?.unsent).toBeUndefined();
  });

  it("@timing deletes the row a resolve kept once its 30 minutes are over, or at once when told, never an open one", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    // Open: never deleted.
    await t.alerts.dropKept(KEY, { anyTime: true });
    expect(t.store.active.has(KEY)).toBe(true);
    await t.alerts.resolve(KEY);
    t.clock.advance(29 * MINUTE);
    await t.alerts.dropKept(KEY);
    expect(t.store.active.has(KEY)).toBe(true);
    t.clock.advance(MINUTE);
    await t.alerts.dropKept(KEY);
    expect(t.store.active.has(KEY)).toBe(false);

    // Its source left the config: deleted at once.
    await t.alerts.raise(stopped());
    await t.alerts.resolve(KEY);
    await t.alerts.dropKept(KEY, { anyTime: true });
    expect(t.store.active.has(KEY)).toBe(false);
  });

  it("is not open once resolved: a second resolve finds nothing", async () => {
    const t = setup();
    await t.alerts.raise(stopped());
    await t.alerts.resolve(KEY);
    expect(t.store.active.get(KEY)?.resolvedAt).toBe(NOW);
    expect((await t.alerts.resolve(KEY)).status).toBe("idle");
    await t.alerts.resolveOpen(KEY);
    expect(t.sent()).toHaveLength(2);
  });
});
