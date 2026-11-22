import { FakeClock } from "@facetdb/core/testing";
import { connectPostgres, migrateStore, type SqlClient } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOutbox,
  type NewWebhook,
  type Outbox,
  QUEUE_DECISION,
  queueWebhook,
} from "./outbox.ts";
import { verify, WEBHOOK_SIGNATURE_HEADER } from "./sign.ts";

/**
 * A webhook a plugin queued (`WebhookOrigin`) on a real Postgres (`pnpm test:db`, DATABASE_URL
 * set): the row's typed columns bound by postgres.js and read back, the same decision queued twice
 * written once (the payloads compared as JSON, their delivery ids aside), and the row sent and
 * signed as a webhook, by a loop that runs its project's plugins and by no other.
 */

const START = 1_700_000_000_000;
const PROJECT = "p";
const SOURCE_ID = "p:tickets";
const HOOK = "https://hooks.example.com/facetdb";
const SECRET = "whsec_db-test-signing-value";

let scratch: ScratchDatabase;
const clients: SqlClient[] = [];

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
  const admin = open();
  await admin.query("drop schema if exists facetdb cascade");
  await admin.query("create schema facetdb");
  await migrateStore(admin);
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/** One decision's delivery as the built-in's step queues it; `decision` is what it carries. */
function decision(
  decision: Readonly<Record<string, unknown>>,
  place: { readonly position?: number; readonly endpoint?: string } = {},
): NewWebhook {
  return {
    projectId: PROJECT,
    endpoint: place.endpoint ?? HOOK,
    origin: {
      plugin: "@facetdb/webhook",
      entry: "send",
      record: { sourceId: SOURCE_ID, recordKey: "T-1", position: place.position ?? 0 },
    },
    payloadOf: (delivery) => ({ event: "record.decided", delivery, ...decision }),
  };
}

const DONE = { id: "T-1", status: "done", decidedAt: "2023-11-14T22:13:20.000Z" };

async function rows(client: SqlClient) {
  return client.query(
    `select id::text as id, endpoint, plugin, action, source_id, record_key, position,
            created_at::text as created_at, payload, delivered_at::text as delivered_at
       from facetdb.webhook_outbox order by id`,
  );
}

describe("a webhook a plugin queued, on a real Postgres", () => {
  it("binds its columns, and the same decision queued again is the first row, nothing written", async () => {
    const client = open();
    const clock = new FakeClock(START);
    const first = await queueWebhook(client, clock, decision(DONE));
    clock.advance(60_000);
    // The same decision, its fields in another order: the same JSON, so the same delivery.
    const again = await queueWebhook(
      client,
      clock,
      decision({ decidedAt: DONE.decidedAt, status: "done", id: "T-1" }),
    );

    expect(again).toBe(first);
    expect(await rows(client)).toEqual([
      {
        id: first,
        endpoint: HOOK,
        plugin: "@facetdb/webhook",
        action: "send",
        source_id: SOURCE_ID,
        record_key: "T-1",
        position: 0,
        created_at: String(START),
        payload: JSON.stringify({ event: "record.decided", delivery: first, ...DONE }),
        delivered_at: null,
      },
    ]);

    // Another decision, another place, another endpoint: each its own delivery.
    const human = await queueWebhook(client, clock, decision({ ...DONE, decidedAt: "x" }));
    const second = await queueWebhook(client, clock, decision(DONE, { position: 1 }));
    const audit = await queueWebhook(
      client,
      clock,
      decision(DONE, { endpoint: "https://audit.example.com/f" }),
    );
    expect(new Set([first, human, second, audit]).size).toBe(4);
    expect(await rows(client)).toHaveLength(4);
  });

  it("compares with the record's latest row only: a decision changed and changed back is queued again", async () => {
    const client = open();
    const clock = new FakeClock(START);
    const done = await queueWebhook(client, clock, decision(DONE));
    const review = await queueWebhook(client, clock, decision({ ...DONE, status: "needs_review" }));
    // The first payload again, the same decidedAt (a threshold moved back): the latest row is the
    // review's, so this is a delivery of its own.
    const back = await queueWebhook(client, clock, decision(DONE));
    // And again at once (a released job): now the latest row is this very delivery.
    expect(await queueWebhook(client, clock, decision(DONE))).toBe(back);

    expect(new Set([done, review, back]).size).toBe(3);
    expect((await rows(client)).map((row) => row["id"])).toEqual([done, review, back]);
    // A latest row given up on does not count.
    await client.query(
      "update facetdb.webhook_outbox set gave_up_at = $2::bigint where id = $1::bigint",
      [back, START],
    );
    expect(await queueWebhook(client, clock, decision(DONE))).not.toBe(back);
    expect(await rows(client)).toHaveLength(4);
  });

  it("reads the record's latest row through its index, never a scan of the whole outbox", async () => {
    // The statement queueWebhook runs, explained (never run) on one connection, so the setting
    // and the plan are the same session's. With sequential scans priced out, the plan names the
    // index when one serves the lookup: migration 9's partial index on `plugin`, which such a row
    // names, read newest first for one record and place. No store migration was needed for it.
    const client = connectPostgres(scratch.url, { max: 1 });
    clients.push(client);
    await client.query("set enable_seqscan = off");
    const plan = await client.query(`explain ${QUEUE_DECISION}`, [
      "1",
      PROJECT,
      HOOK,
      JSON.stringify({ event: "record.decided", delivery: "1", ...DONE }),
      START,
      SOURCE_ID,
      "T-1",
      "@facetdb/webhook",
      "send",
      0,
    ]);
    const text = plan.map((row) => String(row["QUERY PLAN"])).join("\n");
    expect(text).toContain("webhook_outbox_action");
    expect(text).not.toMatch(/Seq Scan on webhook_outbox/);
  });

  it("is sent signed to its endpoint by its project's loop, never handed to a runner, and left by another project's", async () => {
    const client = open();
    const clock = new FakeClock(START);
    const id = await queueWebhook(client, clock, decision(DONE));
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ran: string[] = [];
    const loop = (project: string): Outbox =>
      createOutbox({
        client: open(),
        clock,
        fetch: (url, init) => {
          sent.push({ url, headers: { ...init.headers }, body: init.body });
          return Promise.resolve({ status: 204 });
        },
        abortAfter: () => new AbortController().signal,
        secretFor: (projectId) =>
          projectId === project ? Promise.resolve(SECRET) : Promise.reject(new Error("not ours")),
        onGiveUp: () => Promise.resolve(),
        runAction: (row) => {
          ran.push(row.deliveryId);
          return Promise.resolve(undefined);
        },
        actionProject: project,
      });

    expect(await loop("q").deliverDue(START)).toMatchObject({ delivered: [], retrying: [] });
    expect(await loop(PROJECT).deliverDue(START)).toMatchObject({ delivered: [id] });

    expect(ran).toEqual([]);
    expect(sent.map((call) => call.url)).toEqual([HOOK]);
    expect(sent[0]?.headers["facetdb-delivery"]).toBe(id);
    expect(
      verify(SECRET, sent[0]?.headers[WEBHOOK_SIGNATURE_HEADER], sent[0]?.body ?? "", START),
    ).toEqual({ ok: true });
    // Delivered, it still holds back the same decision queued once more.
    expect(await queueWebhook(client, clock, decision(DONE))).toBe(id);
    expect(await rows(client)).toHaveLength(1);
  });
});
