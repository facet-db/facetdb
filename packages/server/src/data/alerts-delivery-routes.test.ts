import {
  type AlertEvent,
  type AlertRecord,
  createAlerts,
  DELIVERY_ERROR_NOT_KEPT,
  eventKey,
  RETRY_EVERY_MS,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { pgliteClient } from "@facetdb/postgres";
import {
  createMemoryStore,
  freshPglite,
  type PGlite,
  resetPglite,
} from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { createAccessService } from "./access.ts";
import { type ConfiguredChannel, createAlertsService, type RunningChannel } from "./alerts.ts";
import { createDashboardReads } from "./reads.ts";

/**
 * `GET /v1/alerts` with the channels' deliveries, on the real store schema on PGlite: each channel
 * answered with its address, kind, name, what it sends, its quiet hours, whether it was bound and
 * delivering, and its newest delivery (when, which event, ok or the words the history keeps), read
 * from the history line that holds it; a line written before deliveries existed reads as before;
 * nothing of a channel plugin's settings, and no stored word unclean, leaves the route.
 */

const PROJECT = "marketplace";
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: () => Promise.resolve(undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => {
    throw new Error("these tests read no config");
  },
  validate: () => {
    throw new Error("these tests validate no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test nothing")),
  diff: () => Promise.reject(new Error("these tests apply nothing")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
};

const STUDIO: StudioAccess = {
  sessions: {
    signIn: () => Promise.reject(new Error("these tests sign nobody in")),
    reviewerFor: ({ local }) =>
      Promise.resolve(
        local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
      ),
  },
  reviewers: {
    list: () => Promise.reject(new Error("these tests list no reviewers")),
    add: () => Promise.reject(new Error("these tests add no reviewer")),
    canAdd: () => Promise.resolve(false),
  },
  projectId: PROJECT,
};

let pglite: PGlite;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

function event(kind: AlertEvent["kind"], overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    kind,
    what: "Something happened.",
    project: PROJECT,
    source: "listings",
    question: null,
    did: "Nothing yet.",
    link: "https://docs.facetdb.dev/fix/worker",
    ...overrides,
  };
}

const running = (address: string, extra: Partial<RunningChannel> = {}): RunningChannel => ({
  address,
  sends: "everything",
  bound: true,
  ...extra,
});

async function rig(
  channels: readonly RunningChannel[],
  fileChannels: readonly ConfiguredChannel[] = channels,
  machineZone: () => string | undefined = () => "Africa/Addis_Ababa",
) {
  const clock = new FakeClock(NOW);
  const memory = await createMemoryStore(clock, pglite);
  closers.push(() => memory.close());
  const client = pgliteClient(pglite);
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: {
      runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
      decisions: {
        search: () => Promise.reject(new Error("these tests search no decisions")),
        why: () => Promise.reject(new Error("these tests explain no record")),
      },
      home: { home: () => Promise.reject(new Error("these tests read no home")) },
      sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
      alerts: createAlertsService({
        projectId: PROJECT,
        channels: () => channels,
        fileChannels: () => fileChannels,
        machineZone,
        reads: createDashboardReads(client),
      }),
      access: createAccessService({
        host: "127.0.0.1",
        reviewers: { list: () => Promise.resolve([]), canAdd: () => Promise.resolve(false) },
      }),
    },
    studio: STUDIO,
    review: NO_REVIEW,
    newRequestId: () => "req-1",
  });
  const get = async (from = THIS_MACHINE) => {
    const response = await app.request("/v1/alerts", {}, from);
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { clock, store: memory.store, client, get };
}

type Body = {
  readonly channels: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly fileChannelsDiffer: boolean;
  readonly workerZone: string | null;
};

describe("GET /v1/alerts with deliveries (alerts-delivery)", () => {
  it("answers each channel with its address, what it sends, its quiet hours, and its newest delivery", async () => {
    const t = await rig([
      running("slack:#ops", { sends: "warnings", quiet: { from: "22:00", to: "07:00" } }),
      running("email:ops@example.com", {
        sends: "critical",
        quiet: { from: "23:00", to: "06:00", zone: "Europe/Berlin" },
      }),
      running("telegram:-100123"),
    ]);
    const alerts = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [
        { name: "slack:#ops", deliver: () => Promise.resolve() },
        { name: "email:ops@example.com", deliver: () => Promise.reject(new Error("smtp down")) },
      ],
    });
    await alerts.raise(event("model_failing"));
    t.clock.advance(60_000);
    // The newer line holds only slack: email's newest delivery is still the failed one.
    const later = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [{ name: "slack:#ops", deliver: () => Promise.resolve() }],
    });
    await later.raise(event("backfill_finished"));

    const { status, json } = await t.get();
    expect(status).toBe(200);
    const body = json as unknown as Body;
    expect(body.channels).toEqual([
      {
        kind: "slack",
        name: "#ops",
        address: "slack:#ops",
        sends: "warnings",
        quiet: { from: "22:00", to: "07:00", zone: null },
        bound: true,
        delivering: true,
        last: {
          at: new Date(NOW + 60_000).toISOString(),
          kind: "backfill_finished",
          title: "Backfill finished",
          phase: "raised",
          ok: true,
          error: null,
        },
        summary: null,
      },
      {
        kind: "email",
        name: "ops@example.com",
        address: "email:ops@example.com",
        sends: "critical",
        quiet: { from: "23:00", to: "06:00", zone: "Europe/Berlin" },
        bound: true,
        delivering: false,
        last: {
          at: new Date(NOW).toISOString(),
          kind: "model_failing",
          title: "Model failing",
          phase: "raised",
          ok: false,
          error: DELIVERY_ERROR_NOT_KEPT,
        },
        summary: null,
      },
      {
        kind: "telegram",
        name: "-100123",
        address: "telegram:-100123",
        sends: "everything",
        quiet: null,
        bound: true,
        delivering: null,
        last: null,
        summary: null,
      },
    ]);
    expect(body.events.map((entry) => entry["delivered"])).toEqual([true, true]);
  });

  it("names a resolved message as the last delivery of the channels that took it", async () => {
    const t = await rig([running("slack:#ops")]);
    const alerts = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [{ name: "slack:#ops", deliver: () => Promise.resolve() }],
    });
    const failing = event("model_failing");
    await alerts.raise(failing);
    t.clock.advance(7 * 60_000);
    await alerts.resolve(eventKey(failing));
    const body = (await t.get()).json as unknown as Body;
    expect(body.channels[0]?.["last"]).toMatchObject({
      kind: "model_failing",
      phase: "resolved",
      ok: true,
      at: new Date(NOW + 7 * 60_000).toISOString(),
    });
  });

  it("answers which channels' quiet hours held a line, read from the store, none of them a delivery", async () => {
    const t = await rig([running("slack:#ops"), running("slack:#data")]);
    // 03:00Z, inside slack:#ops's quiet hours of 22:00 to 07:00.
    t.clock.advance(Date.UTC(2026, 10, 15, 3, 0) - NOW);
    const alerts = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [
        {
          name: "slack:#ops",
          quiet: { from: "22:00", to: "07:00", zone: "UTC" },
          deliver: () => Promise.resolve(),
        },
        { name: "slack:#data", deliver: () => Promise.resolve() },
      ],
    });
    await alerts.raise(event("backfill_failed"));
    const body = (await t.get()).json as unknown as Body;
    expect(body.events).toEqual([
      expect.objectContaining({
        kind: "backfill_failed",
        delivered: true,
        pending: false,
        held: [{ kind: "slack", name: "#ops", address: "slack:#ops" }],
      }),
    ]);
    // Held is not a delivery: the quiet channel has none, the other its own.
    expect(body.channels.map((channel) => channel["delivering"])).toEqual([null, true]);
  });

  it("reads a line written before deliveries existed as before, and finds no delivery in it", async () => {
    const t = await rig([running("slack:#ops")]);
    const old: AlertRecord = {
      at: NOW,
      key: "backfill_failed|marketplace|listings|",
      phase: "raised",
      severity: "warning",
      event: event("backfill_failed"),
      delivered: false,
    };
    await t.client.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
      JSON.stringify(old),
    ]);
    // A line whose channels are still being tried (or whose worker stopped before they answered):
    // recorded, its list empty, marked pending.
    await t.client.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
      JSON.stringify({ ...old, at: NOW + 1, deliveries: [], pending: true }),
    ]);
    const { status, json } = await t.get();
    expect(status).toBe(200);
    const body = json as unknown as Body;
    expect(body.events).toHaveLength(2);
    // The pending line says it is not known; the old line reads as before, "no channel took it".
    expect(body.events[0]).toMatchObject({ delivered: false, pending: true });
    expect(body.events[1]).toMatchObject({
      kind: "backfill_failed",
      delivered: false,
      pending: false,
      standing: { phase: "raised" },
    });
    expect(body.channels[0]).toMatchObject({ delivering: null, last: null });
  });

  it("cleans a stored delivery's words again and holds them to a length: a database row is a boundary", async () => {
    const t = await rig([running("slack:#ops")]);
    const record: AlertRecord = {
      at: NOW,
      key: "model_failing|marketplace|listings|",
      phase: "raised",
      severity: "critical",
      event: event("model_failing"),
      delivered: false,
      deliveries: [
        // jsonb holds no NUL; every other control character can be stored.
        { channel: "slack:#ops", ok: false, error: `bad\u0007\u001b[2Jwords‮${"x".repeat(900)}` },
      ],
    };
    await t.client.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
      JSON.stringify(record),
    ]);
    const body = (await t.get()).json as unknown as Body;
    const last = body.channels[0]?.["last"] as { error: string };
    expect(last.error).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(last.error.startsWith("bad")).toBe(true);
    expect(last.error.length).toBeLessThanOrEqual(300);
  });

  it("answers no address and no delivery words beyond the config's own for a where that reads as a URL", async () => {
    const secret = "s3cretPathValue";
    const t = await rig([running(`webhook:https://hooks.example.com/services/T0/${secret}`)]);
    const { text, json } = await t.get();
    expect((json as unknown as Body).channels[0]).toMatchObject({
      kind: "webhook",
      name: null,
      address: null,
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("hooks.example.com");
  });

  it("says the file differs when a channel's sends or quiet hours changed, naming none of them", async () => {
    const same = await rig(
      [running("slack:#ops")],
      [{ address: "slack:#ops", sends: "everything" }],
    );
    expect(((await same.get()).json as unknown as Body).fileChannelsDiffer).toBe(false);
    await closers.splice(0)[0]?.();
    await resetPglite(pglite);

    const sends = await rig(
      [running("slack:#ops")],
      [{ address: "slack:#ops", sends: "critical" }],
    );
    expect(((await sends.get()).json as unknown as Body).fileChannelsDiffer).toBe(true);
    await closers.splice(0)[0]?.();
    await resetPglite(pglite);

    const quiet = await rig(
      [running("slack:#ops")],
      [{ address: "slack:#ops", sends: "everything", quiet: { from: "22:00", to: "07:00" } }],
    );
    const { json, text } = await quiet.get();
    expect((json as unknown as Body).fileChannelsDiffer).toBe(true);
    expect(text).not.toContain("22:00");
  });

  it("stays behind the reviewer check: a stranger elsewhere is asked to sign in", async () => {
    const t = await rig([running("slack:#ops")]);
    const { status, json } = await t.get(ELSEWHERE);
    expect(status).toBe(401);
    expect(json["error"]).toMatchObject({ code: "sign-in" });
  });

  it("reads each channel's newest delivery of this project alone", async () => {
    const t = await rig([running("slack:#ops")]);
    const other = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [{ name: "slack:#ops", deliver: () => Promise.reject(new Error("down")) }],
    });
    await other.raise(event("model_failing", { project: "another" }));
    const body = (await t.get()).json as unknown as Body;
    expect(body.channels[0]).toMatchObject({ delivering: null, last: null });
  });
});

describe("GET /v1/alerts with quiet-hours summaries and the worker's zone", () => {
  const QUIET = { from: "22:00", to: "07:00", zone: "UTC" } as const;
  const PAGE = { project: PROJECT, link: "http://127.0.0.1:4040/alerts" };

  it("answers each channel's latest summary: sent, tried and not taken yet, or none when it held nothing", async () => {
    const t = await rig([
      running("slack:#ops", { quiet: QUIET }),
      running("email:ops@example.com", { quiet: QUIET }),
      running("slack:#data", { quiet: QUIET }),
      running("telegram:-100123"),
    ]);
    // 03:00Z: inside the quiet hours of the three quiet channels.
    t.clock.advance(Date.UTC(2026, 10, 15, 3, 0) - NOW);
    const alerts = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [
        { name: "slack:#ops", quiet: QUIET, deliver: () => Promise.resolve() },
        {
          name: "email:ops@example.com",
          quiet: QUIET,
          deliver: () => Promise.reject(new Error("smtp down")),
        },
        // Sent warnings alone: an information message is never held for it, so it has nothing to say.
        {
          name: "slack:#data",
          quiet: QUIET,
          takes: (severity) => severity !== "information",
          deliver: () => Promise.resolve(),
        },
        { name: "telegram:-100123", deliver: () => Promise.resolve() },
      ],
    });
    await alerts.raise(event("backfill_finished"));
    // 07:02Z: the hours ended, and the summary's minute of grace has passed.
    t.clock.advance(Date.UTC(2026, 10, 15, 7, 2) - t.clock.now());
    const report = await alerts.summarize(PAGE);
    expect(report.failures.map((failure) => failure.channel)).toEqual(["email:ops@example.com"]);
    const at = new Date(t.clock.now()).toISOString();

    const body = (await t.get()).json as unknown as Body;
    expect(body.channels.map((channel) => channel["summary"])).toEqual([
      { at, sent: true, failing: false },
      { at, sent: false, failing: false },
      null,
      null,
    ]);
    // The summary is no history line: the last delivery stays the alert's, which was held.
    expect(body.channels[0]?.["last"]).toBeNull();
    expect(body.events).toHaveLength(1);
  });

  it("answers the latest summary of this project alone", async () => {
    const t = await rig([running("slack:#ops", { quiet: QUIET })]);
    t.clock.advance(Date.UTC(2026, 10, 15, 3, 0) - NOW);
    const other = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [{ name: "slack:#ops", quiet: QUIET, deliver: () => Promise.resolve() }],
    });
    await other.raise(event("backfill_finished", { project: "another" }));
    t.clock.advance(Date.UTC(2026, 10, 15, 7, 2) - t.clock.now());
    await other.summarize({ ...PAGE, project: "another" });
    const body = (await t.get()).json as unknown as Body;
    expect(body.channels[0]?.["summary"]).toBeNull();
  });

  it("says a summary the channel did not take on its try again is failing, not on its first try", async () => {
    const t = await rig([running("slack:#ops", { quiet: QUIET })]);
    t.clock.advance(Date.UTC(2026, 10, 15, 3, 0) - NOW);
    const alerts = createAlerts({
      store: t.store.alerts,
      clock: t.clock,
      channels: [
        {
          name: "slack:#ops",
          quiet: QUIET,
          deliver: () => Promise.reject(new Error("slack down")),
        },
      ],
    });
    await alerts.raise(event("backfill_finished"));
    t.clock.advance(Date.UTC(2026, 10, 15, 7, 2) - t.clock.now());
    await alerts.summarize(PAGE);
    const first = new Date(t.clock.now()).toISOString();
    expect(((await t.get()).json as unknown as Body).channels[0]?.["summary"]).toEqual({
      at: first,
      sent: false,
      failing: false,
    });
    t.clock.advance(RETRY_EVERY_MS);
    await alerts.summarize(PAGE);
    expect(((await t.get()).json as unknown as Body).channels[0]?.["summary"]).toEqual({
      at: new Date(t.clock.now()).toISOString(),
      sent: false,
      failing: true,
    });
  });

  it("reads a state written before the worker recorded what it held as no summary", async () => {
    const t = await rig([running("slack:#ops", { quiet: QUIET })]);
    const until = Date.UTC(2026, 10, 15, 7, 0);
    await t.store.alerts.swapQuietState(`quiet|${PROJECT}|slack:#ops`, undefined, {
      until,
      since: Date.UTC(2026, 10, 14, 22, 0),
      triedAt: until + 60_000,
      sentAt: until + 61_000,
    });
    const body = (await t.get()).json as unknown as Body;
    expect(body.channels[0]?.["summary"]).toBeNull();
  });

  it("names the worker machine's zone, and none when it cannot be read", async () => {
    const t = await rig([running("slack:#ops", { quiet: { from: "22:00", to: "07:00" } })]);
    expect(((await t.get()).json as unknown as Body).workerZone).toBe("Africa/Addis_Ababa");
    await closers.splice(0)[0]?.();
    await resetPglite(pglite);

    const unread = await rig([running("slack:#ops")], undefined, () => undefined);
    expect(((await unread.get()).json as unknown as Body).workerZone).toBeNull();
  });
});
