import { type AlertEvent, createAlerts, DELIVERY_ERROR_NOT_KEPT } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { connectPostgres, createStore, type SqlClient, type Store } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAlertsService } from "./alerts.ts";
import { createDashboardReads } from "./reads.ts";

/**
 * The alert history's deliveries against a real Postgres (`pnpm test:db`, DATABASE_URL set): the
 * worker's store writes each line through postgres.js's jsonb binding, recorded before its channels
 * are tried and settled after, and the Alerts endpoint's reads (the newest lines, and each
 * channel's newest delivery through `jsonb_array_elements`) read them back, a line written before
 * deliveries existed among them. PGlite applies no serializer, so only this proves the column holds
 * an object the SQL can walk.
 */

const PROJECT = "marketplace";
const START = 1_700_000_000_000;
const SECRET = "a-long-random-secret-for-tests-only";

let scratch: ScratchDatabase;
const clients: SqlClient[] = [];
const stores: Store[] = [];

function open(): SqlClient {
  const client = connectPostgres(scratch.url);
  clients.push(client);
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
});

afterAll(async () => {
  await scratch.drop();
});

beforeEach(async () => {
  await open().query("drop schema if exists facetdb cascade");
});

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

function event(kind: AlertEvent["kind"]): AlertEvent {
  return {
    kind,
    what: "Something happened.",
    project: PROJECT,
    source: "listings",
    question: null,
    did: "Nothing yet.",
    link: "https://docs.facetdb.dev/fix/worker",
  };
}

describe("the alert history's deliveries on a real Postgres (alerts-delivery)", () => {
  it("are written by the store and read back by the Alerts endpoint, an old line among them", async () => {
    const clock = new FakeClock(START);
    const store = await createStore({
      url: scratch.url,
      pgHost: undefined,
      secret: SECRET,
      clock,
      allowInsecure: true,
    });
    stores.push(store);
    const admin = open();
    // A line as an earlier worker wrote it: no deliveries.
    await admin.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
      JSON.stringify({
        at: START - 1,
        key: "backfill_failed|marketplace|listings|",
        phase: "raised",
        severity: "warning",
        event: event("backfill_failed"),
        delivered: false,
      }),
    ]);
    const alerts = createAlerts({
      store: store.alerts,
      clock,
      channels: [
        { name: "slack:#ops", deliver: () => Promise.resolve() },
        { name: "email:ops@example.com", deliver: () => Promise.reject(new Error("down")) },
      ],
    });
    await alerts.raise(event("model_failing"));
    // Another project's newer line, holding deliveries to the same addresses: never this one's.
    await admin.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
      JSON.stringify({
        at: START + 60_000,
        key: "model_failing|another|listings|",
        phase: "raised",
        severity: "critical",
        event: { ...event("model_failing"), project: "another" },
        delivered: true,
        deliveries: [
          { channel: "email:ops@example.com", ok: true },
          { channel: "telegram:-100123", ok: false, error: "another project's words" },
        ],
      }),
    ]);

    const service = createAlertsService({
      projectId: PROJECT,
      channels: () => [
        { address: "slack:#ops", sends: "everything", bound: true },
        { address: "email:ops@example.com", sends: "critical", bound: true },
        { address: "telegram:-100123", sends: "everything", bound: true },
      ],
      fileChannels: () => [],
      machineZone: () => "UTC",
      reads: createDashboardReads(admin),
    });
    const outcome = await service.alerts(PROJECT);
    if (outcome.kind !== "alerts") {
      throw new Error("expected the project's alerts");
    }
    expect(outcome.alerts.events.map((entry) => [entry.kind, entry.delivered])).toEqual([
      ["model_failing", true],
      ["backfill_failed", false],
    ]);
    expect(
      outcome.alerts.channels.map(({ address, delivering, last }) => ({
        address,
        delivering,
        error: last?.error ?? null,
      })),
    ).toEqual([
      { address: "slack:#ops", delivering: true, error: null },
      { address: "email:ops@example.com", delivering: false, error: DELIVERY_ERROR_NOT_KEPT },
      { address: "telegram:-100123", delivering: null, error: null },
    ]);
    const types = await admin.query(
      "select jsonb_typeof(record->'deliveries') as type, record ? 'pending' as pending from facetdb.alert_history order by id",
    );
    // The settled line holds its list and no longer says it is pending.
    expect(types.map((row) => [row["type"], row["pending"]])).toEqual([
      [null, false],
      ["array", false],
      ["array", false],
    ]);
  });

  it("reads each channel's quiet-hours summary state as the store writes it", async () => {
    const quiet = { from: "22:00", to: "07:00", zone: "UTC" } as const;
    // 03:00Z on a day: inside the quiet hours.
    const night = Date.UTC(2026, 10, 15, 3, 0);
    const clock = new FakeClock(night);
    const store = await createStore({
      url: scratch.url,
      pgHost: undefined,
      secret: SECRET,
      clock,
      allowInsecure: true,
    });
    stores.push(store);
    const alerts = createAlerts({
      store: store.alerts,
      clock,
      channels: [
        { name: "slack:#ops", quiet, deliver: () => Promise.resolve() },
        { name: "email:ops@example.com", quiet, deliver: () => Promise.reject(new Error("down")) },
        // Sent critical alerts alone, and a critical one is never held: it has nothing to sum up.
        {
          name: "telegram:-100123",
          quiet,
          takes: (severity) => severity === "critical",
          deliver: () => Promise.resolve(),
        },
      ],
    });
    await alerts.raise(event("backfill_failed"));
    // 07:02Z: the hours are over and the summary's minute of grace has passed.
    clock.advance(Date.UTC(2026, 10, 15, 7, 2) - night);
    await alerts.summarize({ project: PROJECT, link: "http://127.0.0.1:4040/alerts" });

    const service = createAlertsService({
      projectId: PROJECT,
      channels: () =>
        ["slack:#ops", "email:ops@example.com", "telegram:-100123"].map((address) => ({
          address,
          sends: "everything" as const,
          quiet,
          bound: true,
        })),
      fileChannels: () => [],
      machineZone: () => "UTC",
      reads: createDashboardReads(open()),
    });
    const outcome = await service.alerts(PROJECT);
    if (outcome.kind !== "alerts") {
      throw new Error("expected the project's alerts");
    }
    const at = new Date(clock.now()).toISOString();
    expect(outcome.alerts.channels.map((channel) => channel.summary)).toEqual([
      { at, sent: true, failing: false },
      { at, sent: false, failing: false },
      null,
    ]);
  });
});
