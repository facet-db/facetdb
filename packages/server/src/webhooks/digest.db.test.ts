import { FakeClock } from "@facetdb/core/testing";
import { connectPostgres, migrateStore, type SqlClient } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionDelivery,
  createOutbox,
  DIGEST_MINUTE_MS,
  type DigestDelivery,
  type Outbox,
} from "./outbox.ts";

/**
 * The digest rule on a real Postgres (`pnpm test:db`, DATABASE_URL set). PGlite applies no
 * serializer and runs one connection: here postgres.js binds the lists of ids and attempts the
 * digest gathers and writes by, and two loops on two connections at the minute's end send each row
 * of the digest once.
 */

const MINUTE = 1_700_000_040_000;
const PROJECT = "p";
const BATCH = JSON.stringify(["support", 0, "slack:#urgent"]);

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

function loop(loopId: string, clock: FakeClock) {
  const alone: ActionDelivery[] = [];
  const digests: DigestDelivery[] = [];
  const outbox: Outbox = createOutbox({
    client: open(),
    clock,
    fetch: () => Promise.reject(new Error("these loops send no webhook")),
    abortAfter: () => new AbortController().signal,
    loopId,
    secretFor: () => Promise.reject(new Error("these loops read no secret")),
    onGiveUp: () => Promise.resolve(),
    runAction: (row) => {
      alone.push(row);
      return Promise.resolve(undefined);
    },
    runDigest: (digest) => {
      digests.push(digest);
      return Promise.resolve(undefined);
    },
  });
  return { outbox, alone, digests };
}

describe("the digest rule on a real Postgres", () => {
  it("runs the first 10 alone and sends the rest once, with two loops at the minute's end", async () => {
    const clock = new FakeClock(MINUTE);
    const a = loop("loop-a", clock);
    const b = loop("loop-b", clock);
    const ids: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      ids.push(
        await a.outbox.enqueue({
          projectId: PROJECT,
          sourceId: "p:support",
          recordKey: `T-${index}`,
          plugin: "@facetdb/slack",
          action: "notify",
          position: 0,
          payload: { index },
          batchKey: BATCH,
        }),
      );
      clock.advance(100);
    }

    await a.outbox.deliverDue(clock.now());
    // Run side by side, so in any order.
    expect(a.alone.map((row) => row.deliveryId).sort()).toEqual(ids.slice(0, 10).sort());

    const end = MINUTE + DIGEST_MINUTE_MS;
    const [first, second] = await Promise.all([a.outbox.deliverDue(end), b.outbox.deliverDue(end)]);
    const third = await a.outbox.deliverDue(end);
    const delivered = [...first.delivered, ...second.delivered, ...third.delivered];
    // Each of the 35 once, in one digest or, when the loops split it, in two that share no row.
    expect([...delivered].sort()).toEqual([...ids.slice(10)].sort());
    const sent = [...a.digests, ...b.digests].flatMap((digest) =>
      digest.rows.map((row) => row.deliveryId),
    );
    expect([...sent].sort()).toEqual([...ids.slice(10)].sort());
    expect([...a.alone, ...b.alone]).toHaveLength(10);
    const [open_] = await open().query(
      `select count(*)::int as n from facetdb.webhook_outbox where delivered_at is null`,
    );
    expect(open_?.["n"]).toBe(0);
  });
});
