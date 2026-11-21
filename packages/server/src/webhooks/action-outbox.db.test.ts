import { FakeClock } from "@facetdb/core/testing";
import { connectPostgres, migrateStore, type SqlClient } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionDelivery,
  createOutbox,
  DELIVERY_BATCH,
  GIVE_UP_AFTER_MS,
  type Outbox,
} from "./outbox.ts";

/**
 * Plugin actions through the outbox on a real Postgres (`pnpm test:db`, DATABASE_URL set). PGlite
 * applies no serializer and runs one connection: here the action row's typed columns (`position`
 * integer, `superseded_at` and the times bigint) are bound by postgres.js and read back, and two
 * loops on two connections claim at once without ever running one row twice.
 */

const START = 1_700_000_000_000;
const PROJECT = "p";
const SOURCE_ID = "p:issues";

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
  // The outbox's columns are the store's (migrations 2 and 9); the outbox creates nothing.
  await migrateStore(admin);
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/** A loop on its own connection; `ran` records every row its runner was handed. */
function loop(loopId: string) {
  const ran: ActionDelivery[] = [];
  const outbox: Outbox = createOutbox({
    client: open(),
    clock: new FakeClock(START),
    fetch: () => Promise.reject(new Error("these loops send no webhook")),
    // Runners answer at once here: no timeout is ever reached, and no real timer is armed.
    abortAfter: () => new AbortController().signal,
    loopId,
    secretFor: () => Promise.reject(new Error("these loops read no secret")),
    onGiveUp: () => Promise.resolve(),
    runAction: (row) => {
      ran.push(row);
      return Promise.resolve(undefined);
    },
  });
  return { outbox, ran };
}

describe("action rows on a real Postgres", () => {
  it("binds the action's columns and reads them back, and closes a superseded row with its time", async () => {
    const a = loop("loop-a");
    const first = await a.outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "42",
      plugin: "github",
      action: "label",
      position: 2,
      payload: { status: "done", settings: { label: "bug" } },
      batchKey: "issues:digest",
    });
    const later = await a.outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "42",
      plugin: "github",
      action: "label",
      position: 2,
      payload: { status: "needs_review" },
    });

    const [stored] = await open().query(
      `select endpoint, source_id, record_key, plugin, action, position, batch_key, superseded_at,
              created_at::text as created_at, payload
         from facetdb.webhook_outbox where id = $1::bigint`,
      [first],
    );
    expect(stored).toEqual({
      endpoint: null,
      source_id: SOURCE_ID,
      record_key: "42",
      plugin: "github",
      action: "label",
      position: 2,
      batch_key: "issues:digest",
      superseded_at: null,
      created_at: String(START),
      payload: JSON.stringify({ status: "done", settings: { label: "bug" } }),
    });

    const report = await a.outbox.deliverDue(START + GIVE_UP_AFTER_MS - 1);
    expect(report).toMatchObject({ superseded: [first], delivered: [later], lost: [] });
    expect(a.ran).toEqual([
      {
        deliveryId: later,
        projectId: PROJECT,
        sourceId: SOURCE_ID,
        recordKey: "42",
        plugin: "github",
        action: "label",
        position: 2,
        payload: { status: "needs_review" },
        batchKey: undefined,
        attempt: 1,
        queuedAt: START,
      },
    ]);
    const [closed] = await open().query(
      `select superseded_at::text as superseded_at, gave_up_at::text as gave_up_at, last_error
         from facetdb.webhook_outbox where id = $1::bigint`,
      [first],
    );
    expect(closed).toEqual({
      superseded_at: String(START + GIVE_UP_AFTER_MS - 1),
      gave_up_at: String(START + GIVE_UP_AFTER_MS - 1),
      last_error: `superseded by delivery ${later}: a later decision queued the same action for this record`,
    });
  });

  it("never runs one action row in two loops claiming at once on two connections", async () => {
    const a = loop("loop-a");
    const b = loop("loop-b");
    const ids: string[] = [];
    for (let n = 0; n < DELIVERY_BATCH * 2; n += 1) {
      ids.push(
        await a.outbox.enqueue({
          projectId: PROJECT,
          sourceId: SOURCE_ID,
          recordKey: String(n),
          plugin: "github",
          action: "label",
          position: 0,
          payload: { n },
        }),
      );
    }

    const [reportA, reportB] = await Promise.all([
      a.outbox.deliverDue(START),
      b.outbox.deliverDue(START),
    ]);

    // Each loop took a batch, the two batches share no row, and together they cover the queue.
    const ranA = a.ran.map((row) => row.deliveryId);
    const ranB = b.ran.map((row) => row.deliveryId);
    expect(ranA).toHaveLength(DELIVERY_BATCH);
    expect(ranB).toHaveLength(DELIVERY_BATCH);
    expect(ranA.filter((id) => ranB.includes(id))).toEqual([]);
    expect([...ranA, ...ranB].sort()).toEqual([...ids].sort());
    expect([...reportA.delivered, ...reportB.delivered].sort()).toEqual([...ids].sort());
    expect([...reportA.lost, ...reportB.lost]).toEqual([]);
  });
});
