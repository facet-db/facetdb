import { FakeClock } from "@facetdb/core/testing";
import { connectPostgres, type SqlClient } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutbox, DELIVERY_BATCH, type Outbox, type WebhookFetch } from "./outbox.ts";

/**
 * The outbox against a real Postgres (`pnpm test:db`, DATABASE_URL set). PGlite runs one connection,
 * so it serializes every statement and proves shape, never concurrency. What the outbox leans on the
 * database for is proven here, with separate connections: `claim` takes `for update skip locked`, so
 * two loops that claim at once get claims that never overlap, and a row another connection holds is
 * passed over instead of waited for or taken twice.
 */

const SECRET = "whsec-test-secret";
const ENDPOINT = "https://hooks.example.com/facetdb";
const START = 1_700_000_000_000;

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
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/** A loop on its own connection; `sent` records the delivery id of every request it makes. */
function loop(loopId: string) {
  const sent: string[] = [];
  const fetch: WebhookFetch = (_url, init) => {
    sent.push(init.headers["facetdb-delivery"] ?? "");
    return Promise.resolve({ status: 204 });
  };
  const outbox: Outbox = createOutbox({
    client: open(),
    clock: new FakeClock(START),
    fetch,
    loopId,
    secretFor: () => Promise.resolve(SECRET),
    onGiveUp: () => Promise.resolve(),
  });
  return { outbox, sent };
}

async function queue(outbox: Outbox, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    ids.push(await outbox.enqueue({ projectId: "p", endpoint: ENDPOINT, payload: { n } }));
  }
  return ids;
}

describe("webhook_outbox claims on a real Postgres", () => {
  it("never hands one row to two loops claiming at once", async () => {
    const a = loop("loop-a");
    const b = loop("loop-b");
    await a.outbox.install();
    // Installing from the other connection changes nothing.
    await b.outbox.install();
    const ids = await queue(a.outbox, DELIVERY_BATCH * 2);

    const [reportA, reportB] = await Promise.all([
      a.outbox.deliverDue(START),
      b.outbox.deliverDue(START),
    ]);

    // Each loop took a batch, the two batches share no row, and together they cover the queue.
    expect(a.sent).toHaveLength(DELIVERY_BATCH);
    expect(b.sent).toHaveLength(DELIVERY_BATCH);
    expect(a.sent.filter((id) => b.sent.includes(id))).toEqual([]);
    expect([...a.sent, ...b.sent].sort()).toEqual([...ids].sort());
    expect(reportA.delivered).toHaveLength(DELIVERY_BATCH);
    expect(reportB.delivered).toHaveLength(DELIVERY_BATCH);
    expect([...reportA.lost, ...reportB.lost]).toEqual([]);
  });

  it("passes over a row another connection holds instead of waiting for it", async () => {
    const a = loop("loop-a");
    await a.outbox.install();
    const [held, ...others] = await queue(a.outbox, 3);
    if (held === undefined) {
      throw new Error("nothing was queued");
    }

    const holder = open();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = holder.transaction(async (query) => {
      await query("select id from facetdb.webhook_outbox where id = $1::bigint for update", [held]);
      locked();
      await released;
    });
    await lockTaken;

    try {
      const b = loop("loop-b");
      const report = await b.outbox.deliverDue(START);
      expect([...report.delivered].sort()).toEqual([...others].sort());
      expect(b.sent).not.toContain(held);
    } finally {
      release();
      await holding;
    }

    // Free again, the row is delivered once, by whoever asks next.
    const c = loop("loop-c");
    expect((await c.outbox.deliverDue(START)).delivered).toEqual([held]);
  });
});
