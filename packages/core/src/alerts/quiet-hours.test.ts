import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../contracts/index.ts";
import {
  type AlertRecord,
  type AlertsPage,
  type BoundChannel,
  ChannelFailed,
  createAlerts,
  DELIVERY_ERROR_NOT_KEPT,
  type QuietSummaryState,
  quietKey,
  RETRY_EVERY_MS,
  SUMMARY_GRACE_MS,
  SUMMARY_NAMES_MAX,
  type SummaryReport,
  summaryMessage,
} from "./alerts.ts";
import { type AlertEvent, eventKey } from "./events.ts";
import {
  isQuiet,
  knownZone,
  lastQuietPeriod,
  machineZone,
  processZone,
  type QuietWindow,
  quietPeriodAt,
} from "./quiet-hours.ts";

/**
 * A channel's quiet hours: the window read on the wall clock of the channel's zone, across midnight
 * and across a daylight-saving change; a warning or information message inside it is held for the
 * channel and recorded as held, a critical one is delivered; once the hours have ended, the
 * worker's tick sends the channel one summary of what was held (claimed in the store, so two
 * workers send one and a restart none twice), and nothing when nothing was held. The Alerts page's
 * test message goes through one channel at once and is never recorded.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An instant in UTC from its parts (months from 1). */
const utc = (year: number, month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute);

const night = (zone: string, from = "22:00", to = "07:00"): QuietWindow => ({ from, to, zone });

describe("the quiet window", () => {
  it("is read on each zone's own wall clock: Berlin, New York and Kolkata, 22:00 to 07:00", () => {
    // 15 January 2026: Berlin is UTC+1, New York UTC-5, Kolkata UTC+5:30 all year.
    const cases = [
      { zone: "Europe/Berlin", ten: utc(2026, 1, 15, 21, 0), seven: utc(2026, 1, 16, 6, 0) },
      { zone: "America/New_York", ten: utc(2026, 1, 16, 3, 0), seven: utc(2026, 1, 16, 12, 0) },
      { zone: "Asia/Kolkata", ten: utc(2026, 1, 15, 16, 30), seven: utc(2026, 1, 16, 1, 30) },
    ];
    for (const { zone, ten, seven } of cases) {
      const window = night(zone);
      expect(isQuiet(window, ten - MINUTE), `${zone} 21:59`).toBe(false);
      expect(isQuiet(window, ten), `${zone} 22:00`).toBe(true);
      expect(isQuiet(window, ten + 5 * HOUR), `${zone} 03:00`).toBe(true);
      expect(isQuiet(window, seven - MINUTE), `${zone} 06:59`).toBe(true);
      expect(isQuiet(window, seven), `${zone} 07:00`).toBe(false);
      expect(quietPeriodAt(window, ten + HOUR), zone).toEqual({ start: ten, end: seven });
    }
  });

  it("crosses midnight as one period, and a window that does not cross it stays within its day", () => {
    const window = night("UTC");
    const midnight = utc(2026, 11, 14, 0, 0);
    const period = { start: utc(2026, 11, 13, 22, 0), end: utc(2026, 11, 14, 7, 0) };
    expect(quietPeriodAt(window, midnight - MINUTE)).toEqual(period);
    expect(quietPeriodAt(window, midnight)).toEqual(period);
    expect(quietPeriodAt(window, midnight + MINUTE)).toEqual(period);
    // The present period ends at 07:00, whenever in it the question is asked.
    expect(quietPeriodAt(window, utc(2026, 11, 13, 23, 30))?.end).toBe(utc(2026, 11, 14, 7, 0));

    const day: QuietWindow = { from: "09:00", to: "17:00", zone: "UTC" };
    expect(isQuiet(day, utc(2026, 11, 14, 8, 59))).toBe(false);
    expect(quietPeriodAt(day, utc(2026, 11, 14, 12, 0))).toEqual({
      start: utc(2026, 11, 14, 9, 0),
      end: utc(2026, 11, 14, 17, 0),
    });
    expect(isQuiet(day, utc(2026, 11, 14, 17, 0))).toBe(false);
    expect(isQuiet(day, utc(2026, 11, 14, 23, 0))).toBe(false);
  });

  it("is as long as the clocks make it the nights they change: eight hours in spring, ten in autumn", () => {
    const berlin = night("Europe/Berlin");
    // 29 March 2026, 02:00 CET becomes 03:00 CEST (01:00Z): 22:00 CET is 21:00Z, 07:00 CEST 05:00Z.
    expect(quietPeriodAt(berlin, utc(2026, 3, 29, 0, 0))).toEqual({
      start: utc(2026, 3, 28, 21, 0),
      end: utc(2026, 3, 29, 5, 0),
    });
    // 25 October 2026, 03:00 CEST becomes 02:00 CET (01:00Z): 22:00 CEST is 20:00Z, 07:00 CET 06:00Z.
    expect(quietPeriodAt(berlin, utc(2026, 10, 25, 0, 0))).toEqual({
      start: utc(2026, 10, 24, 20, 0),
      end: utc(2026, 10, 25, 6, 0),
    });
    // 8 March 2026 in New York, 02:00 EST becomes 03:00 EDT (07:00Z): 22:00 EST is 03:00Z, 07:00 EDT 11:00Z.
    expect(quietPeriodAt(night("America/New_York"), utc(2026, 3, 8, 6, 0))).toEqual({
      start: utc(2026, 3, 8, 3, 0),
      end: utc(2026, 3, 8, 11, 0),
    });
  });

  it("ends at the change when it ends at a time the clocks skip, and the first time it ends at a time they repeat", () => {
    const skipped = night("Europe/Berlin", "22:00", "02:30");
    // 02:30 does not exist on 29 March: the hours end when 02:00 CET jumps to 03:00 CEST, 01:00Z.
    expect(quietPeriodAt(skipped, utc(2026, 3, 29, 0, 59))?.end).toBe(utc(2026, 3, 29, 1, 0));
    expect(isQuiet(skipped, utc(2026, 3, 29, 1, 0))).toBe(false);
    // 02:30 comes twice on 25 October, at 00:30Z (CEST) and 01:30Z (CET): the first ends them,
    // and the hour the clocks repeat is not quiet again.
    expect(quietPeriodAt(skipped, utc(2026, 10, 25, 0, 0))?.end).toBe(utc(2026, 10, 25, 0, 30));
    expect(isQuiet(skipped, utc(2026, 10, 25, 1, 15))).toBe(false);
  });

  it("names the last period that ended: this morning's after 07:00, yesterday's while one runs", () => {
    const window = night("UTC");
    expect(lastQuietPeriod(window, utc(2026, 11, 14, 8, 0))).toEqual({
      start: utc(2026, 11, 13, 22, 0),
      end: utc(2026, 11, 14, 7, 0),
    });
    expect(lastQuietPeriod(window, utc(2026, 11, 14, 3, 0))).toEqual({
      start: utc(2026, 11, 12, 22, 0),
      end: utc(2026, 11, 13, 7, 0),
    });
    expect(lastQuietPeriod(window, utc(2026, 11, 14, 7, 0))?.end).toBe(utc(2026, 11, 14, 7, 0));
  });

  it("knows a zone Node reads, and none for an empty TZ (Etc/Unknown), an unknown one, or no zone at all", () => {
    expect(knownZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(knownZone("UTC")).toBe("UTC");
    // TZ="" makes Node name Etc/Unknown; TZ=Foo/Bar makes it name no zone, whatever its type says.
    for (const zone of ["Etc/Unknown", "Foo/Bar", "", undefined]) {
      expect(knownZone(zone), String(zone)).toBeUndefined();
    }
    // The machine's zone is the process's, judged the same way: a string only when Node reads it.
    expect(machineZone()).toBe(knownZone(processZone()));
    const machine = machineZone();
    if (machine !== undefined) {
      expect(() => isQuiet(night(machine), Date.now())).not.toThrow();
    }
  });
});

const PROJECT = "market";
const PAGE: AlertsPage = { project: PROJECT, link: "https://studio.facetdb.test/alerts" };
/** A tick that had nothing to say. */
const NOTHING: SummaryReport = { failures: [], unmarked: [], storeFailed: false };
/** 22:00 to 07:00 UTC, the approved mockup's hours. */
const QUIET = night("UTC");

function eventOf(kind: AlertEvent["kind"], source = "listings"): AlertEvent {
  return {
    kind,
    what: "Something happened.",
    project: PROJECT,
    source,
    question: null,
    did: "Nothing yet.",
    link: "https://studio.facetdb.test/fix",
  };
}

/** A channel that keeps what it was sent and refuses while `failing` is set; `null`: no quiet hours. */
function recording(name: string, quiet: QuietWindow | null = QUIET) {
  const sent: ChannelMessage[] = [];
  const state = { failing: false };
  const channel: BoundChannel = {
    name,
    ...(quiet === null ? {} : { quiet }),
    deliver: (message) => {
      sent.push(message);
      return state.failing
        ? Promise.reject(new ChannelFailed("the channel refused it"))
        : Promise.resolve();
    },
  };
  return { channel, sent, state };
}

function rig(channels: readonly BoundChannel[], start: number) {
  const clock = new FakeClock(start);
  const store = new FakeAlertStore(clock);
  const worker = () => createAlerts({ store, clock, channels });
  return { clock, store, alerts: worker(), worker };
}

/** A warning held for `held` at 03:00Z on 14 November, inside the hours that end at 07:00. */
function heldLine(held: readonly string[]): AlertRecord {
  const event = eventOf("backfill_failed");
  return {
    at: utc(2026, 11, 14, 3, 0),
    key: eventKey(event),
    phase: "raised",
    severity: "warning",
    event,
    delivered: true,
    held,
  };
}

/** The alert store whose read of one key's quiet-hours state fails: the database is down for it. */
class FailingFor extends FakeAlertStore {
  readonly #key: string;

  constructor(database: { now(): number }, key: string) {
    super(database);
    this.#key = key;
  }

  override quietState(key: string): Promise<QuietSummaryState | undefined> {
    return key === this.#key
      ? Promise.reject(new Error("the database is unreachable"))
      : super.quietState(key);
  }
}

/** The alert store whose mark of a summary as sent loses its swap (`lose`) or fails (`fail`). */
class LosingMarks extends FakeAlertStore {
  readonly #mode: "lose" | "fail";

  constructor(database: { now(): number }, mode: "lose" | "fail") {
    super(database);
    this.#mode = mode;
  }

  override swapQuietState(
    key: string,
    expected: QuietSummaryState | undefined,
    next: QuietSummaryState,
  ): Promise<boolean> {
    if (next.sentAt === null) {
      return super.swapQuietState(key, expected, next);
    }
    return this.#mode === "lose"
      ? Promise.resolve(false)
      : Promise.reject(new Error("the database is unreachable"));
  }
}

describe("a message raised inside a channel's quiet hours", () => {
  it("delivers a critical alert at 03:00 inside 22:00 to 07:00 at once", async () => {
    const ops = recording("slack:#ops");
    const { store, alerts } = rig([ops.channel], utc(2026, 11, 14, 3, 0));
    await alerts.raise(eventOf("model_failing"));
    expect(ops.sent).toEqual([expect.objectContaining({ severity: "critical" })]);
    expect(store.history).toEqual([
      expect.objectContaining({
        severity: "critical",
        delivered: true,
        deliveries: [{ channel: "slack:#ops", ok: true }],
      }),
    ]);
    expect(store.history[0]).not.toHaveProperty("held");
  });

  it("holds a warning and an information message for the quiet channel, recording that it held them", async () => {
    const ops = recording("slack:#ops");
    const { store, alerts } = rig([ops.channel], utc(2026, 11, 14, 3, 0));
    await alerts.raise(eventOf("backfill_failed"));
    await alerts.raise(eventOf("backfill_finished"));
    expect(ops.sent).toEqual([]);
    expect(store.history).toEqual([
      expect.objectContaining({ severity: "warning", delivered: true, held: ["slack:#ops"] }),
      expect.objectContaining({ severity: "information", delivered: true, held: ["slack:#ops"] }),
    ]);
    // Tried on no channel: no deliveries, nothing pending.
    expect(store.history[0]).not.toHaveProperty("deliveries");
    expect(store.history[0]).not.toHaveProperty("pending");
    // Held counts as sent: the same event is not recorded again within 30 minutes.
    expect((await alerts.raise(eventOf("backfill_failed"))).status).toBe("suppressed");
    expect(store.history).toHaveLength(2);
  });

  it("delivers to a channel outside its hours and holds for the one inside them, each in the line", async () => {
    const ops = recording("slack:#ops");
    const away = recording("email:oncall@example.com", night("Asia/Kolkata", "09:00", "17:00"));
    const plain = recording("telegram:ops", null);
    const { store, alerts } = rig(
      [ops.channel, away.channel, plain.channel],
      utc(2026, 11, 14, 3, 0),
    );
    await alerts.raise(eventOf("action_gave_up"));
    expect(ops.sent).toEqual([]);
    expect(away.sent).toHaveLength(1);
    expect(plain.sent).toHaveLength(1);
    expect(store.history).toEqual([
      expect.objectContaining({
        delivered: true,
        held: ["slack:#ops"],
        deliveries: [
          { channel: "email:oncall@example.com", ok: true },
          { channel: "telegram:ops", ok: true },
        ],
      }),
    ]);
  });

  it("holds nothing for a channel that does not take the message, and delivers a warning outside the hours", async () => {
    const ops = recording("slack:#ops");
    const pager = recording("pager:ops");
    const critical: BoundChannel = {
      ...pager.channel,
      takes: (severity) => severity === "critical",
    };
    const { clock, store, alerts } = rig([ops.channel, critical], utc(2026, 11, 14, 3, 0));
    await alerts.raise(eventOf("backfill_failed"));
    expect(store.history[0]?.held).toEqual(["slack:#ops"]);
    clock.advance(9 * HOUR);
    await alerts.raise(eventOf("backfill_failed", "noon"));
    expect(ops.sent).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(pager.sent).toEqual([]);
    expect(store.history[1]).not.toHaveProperty("held");
  });

  it("holds the resolved message of an alert that was held, and lets a critical alert's through", async () => {
    const ops = recording("slack:#ops");
    const { clock, store, alerts } = rig([ops.channel], utc(2026, 11, 13, 23, 0));
    const warning = eventOf("backfill_failed");
    await alerts.raise(warning);
    clock.advance(3 * HOUR);
    expect((await alerts.resolve(eventKey(warning))).status).toBe("resolved");
    expect(store.history.map(({ phase, held }) => ({ phase, held }))).toEqual([
      { phase: "raised", held: ["slack:#ops"] },
      { phase: "resolved", held: ["slack:#ops"] },
    ]);

    // A critical alert's resolved message goes to whoever heard of it, quiet hours or not.
    const critical = eventOf("connector_lost_access");
    await alerts.raise(critical);
    await alerts.resolve(eventKey(critical));
    expect(ops.sent.map((message) => message.text.split(":")[0])).toEqual([
      expect.not.stringMatching(/^Resolved/),
      "Resolved",
    ]);
    expect(store.history.at(-1)).not.toHaveProperty("held");
  });
});

describe("the summary when a channel's quiet hours end", () => {
  /** 07:00 plus the grace, the morning after the hours. */
  const MORNING = utc(2026, 11, 14, 7, 0) + SUMMARY_GRACE_MS;

  it("@timing sends one summary of what was held, the resolved message included, with the Alerts page's link", async () => {
    const ops = recording("slack:#ops");
    const { clock, alerts } = rig([ops.channel], utc(2026, 11, 13, 23, 0));
    const warning = eventOf("backfill_failed");
    await alerts.raise(warning);
    await alerts.raise(eventOf("spending_80", "all sources"));
    clock.advance(2 * HOUR);
    await alerts.resolve(eventKey(warning));
    // Still inside the hours, and then within the grace after them: nothing yet.
    expect(await alerts.summarize(PAGE)).toEqual(NOTHING);
    clock.advance(utc(2026, 11, 14, 7, 0) - clock.now() + SUMMARY_GRACE_MS - 1);
    expect(await alerts.summarize(PAGE)).toEqual(NOTHING);
    expect(ops.sent).toEqual([]);

    clock.advance(1);
    expect(await alerts.summarize(PAGE)).toEqual(NOTHING);
    expect(ops.sent).toEqual([
      {
        kind: "system-alert",
        severity: "warning",
        text: "Quiet hours are over. 3 alerts were held for this channel while they lasted, in project market: Backfill failed (listings); Spending at 80% of the cap (all sources); Resolved: Backfill failed (listings). Each is on the Alerts page.",
        link: PAGE.link,
      },
    ]);
  });

  it("@timing two workers that look at once send one summary, a restart none, and a tick after costs the store nothing", async () => {
    const ops = recording("slack:#ops");
    const { clock, store, alerts, worker } = rig([ops.channel], utc(2026, 11, 14, 2, 0));
    await alerts.raise(eventOf("backfill_failed"));
    clock.advance(MORNING - clock.now());

    const other = worker();
    expect(await Promise.all([alerts.summarize(PAGE), other.summarize(PAGE)])).toEqual([
      NOTHING,
      NOTHING,
    ]);
    expect(ops.sent).toHaveLength(1);
    expect(store.quiet.get(quietKey(PROJECT, "slack:#ops"))).toEqual({
      until: utc(2026, 11, 14, 7, 0),
      since: utc(2026, 11, 13, 22, 0),
      triedAt: MORNING,
      sentAt: MORNING,
    });

    const restarted = worker();
    clock.advance(10 * MINUTE);
    await restarted.summarize(PAGE);
    await other.summarize(PAGE);
    expect(ops.sent).toHaveLength(1);

    const calls = store.quietCalls;
    for (let tick = 0; tick < 100; tick += 1) {
      clock.advance(2_000);
      await alerts.summarize(PAGE);
      await restarted.summarize(PAGE);
    }
    expect(store.quietCalls).toBe(calls);
    expect(ops.sent).toHaveLength(1);
  });

  it("sends nothing when nothing was held, and marks the period done", async () => {
    const ops = recording("slack:#ops");
    const { store, alerts } = rig([ops.channel], MORNING);
    expect(await alerts.summarize(PAGE)).toEqual(NOTHING);
    expect(ops.sent).toEqual([]);
    expect(store.quiet.get(quietKey(PROJECT, "slack:#ops"))?.sentAt).toBe(MORNING);
  });

  it("names only what was held for that channel, of that project, in that period", async () => {
    const ops = recording("slack:#ops");
    const other = recording("slack:#data");
    const { clock, store, alerts } = rig([ops.channel, other.channel], utc(2026, 11, 13, 20, 0));
    // Before the hours: delivered, not held.
    await alerts.raise(eventOf("backfill_failed", "early"));
    clock.advance(4 * HOUR);
    await alerts.raise(eventOf("backfill_failed", "inside"));
    // Another project's line held for a channel of the same address.
    store.history.push({
      at: clock.now(),
      key: "x",
      phase: "raised",
      severity: "warning",
      event: { ...eventOf("backfill_failed", "elsewhere"), project: "another" },
      delivered: true,
      held: ["slack:#ops"],
    });
    clock.advance(MORNING - clock.now());
    await alerts.summarize(PAGE);
    expect(ops.sent.map((message) => message.text)).toEqual([
      expect.stringContaining("source early"),
      expect.stringMatching(
        /^Quiet hours are over\. 1 alert was held .*: Backfill failed \(inside\)\./,
      ),
    ]);
    expect(other.sent.at(-1)?.text).toMatch(/: Backfill failed \(inside\)\./);
  });

  it("@timing tries a summary the channel did not take again after 5 minutes, and carries it into the next one if it never does", async () => {
    const ops = recording("slack:#ops");
    const { clock, store, alerts } = rig([ops.channel], utc(2026, 11, 14, 1, 0));
    await alerts.raise(eventOf("backfill_failed", "first-night"));
    clock.advance(MORNING - clock.now());
    ops.state.failing = true;
    expect(await alerts.summarize(PAGE)).toEqual({
      ...NOTHING,
      failures: [{ channel: "slack:#ops", error: "the channel refused it" }],
    });
    const calls = store.quietCalls;
    clock.advance(RETRY_EVERY_MS - 1);
    expect(await alerts.summarize(PAGE)).toEqual(NOTHING);
    expect(ops.sent).toHaveLength(1);
    expect(store.quietCalls).toBe(calls);
    // A restarted worker waits out the stored try too.
    expect(await createAlerts({ store, clock, channels: [ops.channel] }).summarize(PAGE)).toEqual(
      NOTHING,
    );
    expect(ops.sent).toHaveLength(1);

    // It stays down all day; the next night holds another; the next summary names both.
    for (let at = clock.now(); at < utc(2026, 11, 14, 23, 0); at += RETRY_EVERY_MS) {
      clock.advance(RETRY_EVERY_MS);
      await alerts.summarize(PAGE);
    }
    await alerts.raise(eventOf("backfill_failed", "second-night"));
    ops.state.failing = false;
    clock.advance(utc(2026, 11, 15, 7, 0) + SUMMARY_GRACE_MS - clock.now());
    await alerts.summarize(PAGE);
    expect(ops.sent.at(-1)?.text).toContain(
      "2 alerts were held for this channel while they lasted, in project market: Backfill failed (first-night); Backfill failed (second-night).",
    );
    const sent = ops.sent.length;
    clock.advance(RETRY_EVERY_MS);
    await alerts.summarize(PAGE);
    expect(ops.sent).toHaveLength(sent);
    // The history holds the alerts alone: a summary is not an alert.
    expect(store.history.map((line) => line.event.source)).toEqual(["first-night", "second-night"]);
  });

  it("delivers to a channel whose zone cannot be read as to one not quiet, loses the alert on no other channel, and blames no store", async () => {
    // As if the channel host had not judged the zone at load: an empty TZ makes Node name
    // Etc/Unknown, and Intl refuses a name it does not know.
    for (const zone of ["Etc/Unknown", "Foo/Bar"]) {
      const unread = recording("pager:unread", night(zone));
      const ops = recording("slack:#ops");
      const plain = recording("telegram:ops", null);
      const { clock, store, alerts } = rig(
        [unread.channel, ops.channel, plain.channel],
        utc(2026, 11, 14, 3, 0),
      );
      await alerts.raise(eventOf("backfill_failed"));
      expect(unread.sent, zone).toHaveLength(1);
      expect(plain.sent, zone).toHaveLength(1);
      expect(ops.sent, zone).toEqual([]);
      expect(store.history, zone).toEqual([
        expect.objectContaining({
          held: ["slack:#ops"],
          deliveries: [
            { channel: "pager:unread", ok: true },
            { channel: "telegram:ops", ok: true },
          ],
        }),
      ]);
      clock.advance(MORNING - clock.now());
      expect(await alerts.summarize(PAGE), zone).toEqual(NOTHING);
      expect(unread.sent, zone).toHaveLength(1);
      expect(
        ops.sent.map((message) => message.text),
        zone,
      ).toEqual([expect.stringMatching(/^Quiet hours are over\. 1 alert was held/)]);
    }
  });

  it("sends each channel's summary side by side: one that hangs holds no other, and a store that fails for one stops no other", async () => {
    let release: () => void = () => undefined;
    const hanging: BoundChannel = {
      name: "pager:hangs",
      quiet: QUIET,
      deliver: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const ops = recording("slack:#ops");
    const { clock, alerts } = rig([hanging, ops.channel], utc(2026, 11, 14, 2, 0));
    await alerts.raise(eventOf("backfill_failed"));
    clock.advance(MORNING - clock.now());
    const tick = alerts.summarize(PAGE);
    await vi.waitFor(() => expect(ops.sent).toHaveLength(1));
    release();
    expect(await tick).toEqual(NOTHING);

    const data = recording("slack:#data");
    const failing = new FailingFor(clock, quietKey(PROJECT, "slack:#ops"));
    const both = createAlerts({ store: failing, clock, channels: [ops.channel, data.channel] });
    failing.history.push(heldLine(["slack:#ops", "slack:#data"]));
    expect(await both.summarize(PAGE)).toEqual({ ...NOTHING, storeFailed: true });
    expect(data.sent).toHaveLength(1);
  });

  it("says a summary the channel took but the store could not mark sent, which may come once more: at least once", async () => {
    for (const mode of ["lose", "fail"] as const) {
      const ops = recording("slack:#ops");
      const clock = new FakeClock(MORNING);
      const store = new LosingMarks(clock, mode);
      store.history.push(heldLine(["slack:#ops"]));
      const alerts = createAlerts({ store, clock, channels: [ops.channel] });
      expect(await alerts.summarize(PAGE), mode).toEqual({ ...NOTHING, unmarked: ["slack:#ops"] });
      expect(ops.sent, mode).toHaveLength(1);
      // The claim stands, unmarked: this process does not send it again, a worker may in 5 minutes.
      expect(store.quiet.get(quietKey(PROJECT, "slack:#ops"))?.sentAt, mode).toBeNull();
      clock.advance(RETRY_EVERY_MS);
      expect(await alerts.summarize(PAGE), mode).toEqual(NOTHING);
      expect(ops.sent, mode).toHaveLength(1);
      await createAlerts({ store, clock, channels: [ops.channel] }).summarize(PAGE);
      expect(ops.sent, mode).toHaveLength(2);
    }
  });

  it("names an event held twice once, and counts what is past the first 20", () => {
    const held = Array.from({ length: SUMMARY_NAMES_MAX + 3 }, (_, index) => ({
      key: `k${index}`,
      phase: "raised" as const,
      severity: "information" as const,
      kind: "backfill_finished" as const,
      source: `s${index}`,
    }));
    const message = summaryMessage(PAGE, [held[0] as (typeof held)[number], ...held]);
    expect(message.severity).toBe("information");
    expect(message.text).toMatch(/^Quiet hours are over\. 23 alerts were held/);
    expect(message.text).toContain("Backfill finished (s19); and 3 more.");
    expect(message.text.match(/\(s0\)/g)).toHaveLength(1);
  });
});

describe("the test message", () => {
  it("goes through one channel now, whatever its quiet hours and sends, and is never recorded", async () => {
    const ops = recording("slack:#ops");
    const other = recording("slack:#data");
    const channel: BoundChannel = { ...ops.channel, takes: (severity) => severity === "critical" };
    const { store, alerts } = rig([channel, other.channel], utc(2026, 11, 14, 3, 0));
    expect(await alerts.test("slack:#ops", PAGE)).toEqual({ kind: "sent" });
    expect(ops.sent).toEqual([
      {
        kind: "system-alert",
        severity: "information",
        text: "Test message from FacetDB, sent from the Alerts page: this channel receives the alerts of project market. Nothing happened, and nothing needs doing.",
        link: PAGE.link,
      },
    ]);
    expect(other.sent).toEqual([]);
    expect(store.history).toEqual([]);
    expect(store.active.size).toBe(0);
  });

  it("answers an address the config does not name, and a failure in the words the history keeps", async () => {
    const leaky: BoundChannel = {
      name: "pager:ops",
      deliver: () => Promise.reject(new Error("token sk_live_9d8c7b6a5f4e3d2c refused")),
    };
    const refusing = recording("slack:#ops");
    refusing.state.failing = true;
    const reported: unknown[] = [];
    const clock = new FakeClock(utc(2026, 11, 14, 12, 0));
    const store = new FakeAlertStore(clock);
    const alerts = createAlerts({
      store,
      clock,
      channels: [leaky, refusing.channel],
      report: (failure) => reported.push(failure),
    });
    expect(await alerts.test("slack:#elsewhere", PAGE)).toEqual({ kind: "unknown_channel" });
    expect(await alerts.test("pager:ops", PAGE)).toEqual({
      kind: "failed",
      error: DELIVERY_ERROR_NOT_KEPT,
    });
    expect(await alerts.test("slack:#ops", PAGE)).toEqual({
      kind: "failed",
      error: "the channel refused it",
    });
    expect(reported).toEqual([]);
    expect(store.history).toEqual([]);
  });
});
