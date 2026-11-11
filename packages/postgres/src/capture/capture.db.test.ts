import type { Clock, QuestionSet, RecordKey } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENQUEUE_ROLE, migrate, WORKER_ROLE } from "../install/index.ts";
import { CLAIM_LEASE_MS, connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/postgres.ts";
import { createPostgresConnector, type PostgresConnector } from "./connector.ts";

/**
 * The capture runtime against a real Postgres, for what PGlite's single connection cannot prove:
 * two workers claiming at once never share a key, a worker that dies mid-batch leaves its jobs
 * claimable once its lease ends, and a NOTIFY from one connection wakes a watch on another before
 * the poll would.
 */

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const PASSWORD = "a-long-random-password-for-tests";
const POLL_MS = 10_000;

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let scratch: ScratchDatabase;
let admin: SqlClient;
const open: PostgresConnector[] = [];

function worker(workerId: string, clock: Clock = realClock): PostgresConnector {
  const connector = createPostgresConnector({
    workerUrl: scratch.as(WORKER_ROLE, PASSWORD),
    source: { table: "listings", key: "id" },
    questionSet,
    clock,
    pollMs: POLL_MS,
    workerId,
  });
  open.push(connector);
  return connector;
}

async function dropRoles(): Promise<void> {
  await scratch.admin(`drop role if exists ${WORKER_ROLE}`).catch(() => undefined);
  await scratch.admin(`drop role if exists ${ENQUEUE_ROLE}`).catch(() => undefined);
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await dropRoles();
  admin = connectPostgres(scratch.url);
  await admin.query(`create table public.listings (id text primary key, title text, body text)`);
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet,
      project: { id: "proj_listings", name: "Listings" },
      workerPassword: PASSWORD,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
});

afterAll(async () => {
  for (const connector of open.splice(0)) {
    await connector.close();
  }
  await admin?.close();
  await scratch?.drop();
  await dropRoles();
});

async function seed(prefix: string, count: number): Promise<RecordKey[]> {
  const keys = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
  for (const key of keys) {
    await admin.query(`insert into public.listings (id, title, body) values ($1, $2, $3)`, [
      key,
      `title ${key}`,
      "body",
    ]);
  }
  return keys;
}

async function drainQueue(): Promise<void> {
  await admin.query(`delete from facetdb.jobs`);
}

describe("two workers on one queue", () => {
  it("never claim the same key, and together take them all", async () => {
    await drainQueue();
    const keys = await seed("race", 40);
    const a = worker("race-a");
    const b = worker("race-b");
    const [fromA, fromB] = await Promise.all([a.claim(20), b.claim(20)]);
    expect(fromA.filter((key) => fromB.includes(key))).toEqual([]);
    expect([...fromA, ...fromB].sort()).toEqual([...keys].sort());
    await a.ack(fromA);
    await b.ack(fromB);
  });

  it("a worker that dies mid-batch leaves its jobs claimable once its lease ends", async () => {
    await drainQueue();
    const keys = await seed("dead", 5);
    const dying = worker("dead-a");
    const taken = await dying.claim(10);
    expect([...taken].sort()).toEqual(keys);
    await dying.close(); // the connection goes away; nothing acked or released

    const now = worker("now");
    expect(await now.claim(10)).toEqual([]);
    const later = worker("later", {
      now: () => Date.now() + CLAIM_LEASE_MS + 1000,
      sleep: realClock.sleep,
    });
    expect([...(await later.claim(10))].sort()).toEqual(keys);
    await later.ack(keys);
  });

  it("@timing LISTEN across connections wakes a watch long before its poll", async () => {
    await drainQueue();
    const watching = worker("listen");
    const iterator = watching.watch()[Symbol.asyncIterator]();
    const first = iterator.next();
    // Give the LISTEN a moment to be registered on its own connection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await seed("notify", 1);
    const batch = await Promise.race([
      first,
      new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), POLL_MS - 1000)),
    ]);
    const elapsed = Date.now() - started;
    expect(batch).not.toBe("quiet");
    if (batch !== "quiet") {
      expect(batch.done).toBe(false);
      expect(batch.value).toEqual(["notify-000"]);
    }
    expect(elapsed).toBeLessThan(POLL_MS - 1000);
    await iterator.return?.();
  });
});

describe("the worker login on a side-table source", () => {
  it("inserts and updates the side row under the hash guard, with the side table's grants and RLS", async () => {
    await admin.query(`create table public.notes (id text primary key, title text, body text)`);
    const installed = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table: "notes", storage: "side-table" },
        questionSet,
        project: { id: "proj_listings", name: "Listings" },
      },
    });
    if (!installed.ok) {
      throw new Error(installed.reason);
    }
    await admin.query(`insert into public.notes (id, title, body) values ('n1', 'a note', 'b')`);
    const w = createPostgresConnector({
      workerUrl: scratch.as(WORKER_ROLE, PASSWORD),
      source: { table: "notes", key: "id", storage: "side-table" },
      questionSet,
      clock: realClock,
      pollMs: POLL_MS,
      workerId: "side-writer",
    });
    open.push(w);
    const hash = (await w.read(["n1"])).rows[0]?.hash ?? "";
    const decision = {
      decisions: {
        not_priority: { kind: "decided" as const, value: true, probabilityOrConfidence: 0.8 },
      },
      status: "done" as const,
    };
    expect(await w.write("n1", decision, hash)).toEqual({ written: true });
    expect(await w.write("n1", { ...decision, status: "needs_review" }, hash)).toEqual({
      written: true,
    });
    expect(await w.write("n1", decision, "stale")).toEqual({ written: false });
    expect(
      await admin.query(
        `select not_priority, facetdb_status, facetdb_reviewed from facetdb.notes_answers where id = 'n1'`,
      ),
    ).toEqual([{ not_priority: true, facetdb_status: "needs_review", facetdb_reviewed: false }]);
    expect(
      await admin.query(
        `select title, facetdb_status from public.notes_with_answers where id = 'n1'`,
      ),
    ).toEqual([{ title: "a note", facetdb_status: "needs_review" }]);
  });
});

describe("the worker login's write", () => {
  it("stores a decision under the hash guard and touches nothing of the application's", async () => {
    await drainQueue();
    const [key] = await seed("write", 1);
    const w = worker("writer");
    const { rows } = await w.read([key ?? ""]);
    const hash = rows[0]?.hash ?? "";
    expect(
      await w.write(
        key ?? "",
        {
          decisions: {
            not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.2 },
          },
          status: "done",
        },
        hash,
      ),
    ).toEqual({ written: true });
    expect(await w.write(key ?? "", { decisions: {}, status: "pending" }, "stale")).toEqual({
      written: false,
    });
    const stored = await admin.query(
      `select title, not_priority, not_priority_probability, facetdb_status from public.listings where id = $1`,
      [key],
    );
    expect(stored).toEqual([
      {
        title: `title ${key}`,
        not_priority: false,
        not_priority_probability: 0.2,
        facetdb_status: "done",
      },
    ]);
  });
});
