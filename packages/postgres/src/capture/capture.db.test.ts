import type { Clock, QuestionSet, RecordKey } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENQUEUE_ROLE, migrate, WORKER_ROLE } from "../install/index.ts";
import { CLAIM_LEASE_MS, connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
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
  await admin.close();
  await scratch.drop();
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

/** Returns once the worker login waits for a lock, as its one-key statement does behind the open transaction. */
async function waitForALockWait(): Promise<void> {
  await until("the worker never waited for the application's transaction", async () => {
    const waiting = await admin.query(
      `select 1 from pg_stat_activity where datname = current_database() and usename = $1 and wait_event_type = 'Lock'`,
      [WORKER_ROLE],
    );
    return waiting.length > 0;
  });
}

/** Polls `holds` every 25 ms, for up to 5 seconds, and fails with `never` if it never does. */
async function until(never: string, holds: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await holds()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(never);
}

/** The queued keys among `queuedKeys` another session can see, that is, committed. */
/** A promise the test resolves by hand, to step concurrent transactions in a fixed order. */
function gate(): { opened: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** How many sessions on the scratch database wait for a lock right now, any role. */
async function lockWaiters(): Promise<number> {
  const rows = await admin.query(
    `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return Number(rows[0]?.["n"]);
}

async function committed(queuedKeys: readonly string[]): Promise<number> {
  const rows = await admin.query(
    `select count(*)::int as n from facetdb.jobs where record_key = any($1::text[])`,
    [queuedKeys],
  );
  return Number(rows[0]?.["n"]);
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

  it("an ack meeting an application transaction that edits the keys in the other order finishes, with no deadlock", async () => {
    await drainQueue();
    const [a, b] = await seed("order", 2);
    const w = worker("order-w");
    expect([...(await w.claim(10))].sort()).toEqual([a, b]);
    let acked: Promise<void> | undefined;
    // The application edits B first, then A, in one transaction; its trigger holds each job row
    // until the commit. The worker acks A, then B, while the transaction is open: the batch takes A
    // and skips B, and B's own ack must wait for the application alone, holding nothing the
    // application needs next.
    await admin.transaction(async (query) => {
      await query(`update public.listings set title = 'edited' where id = $1`, [b]);
      acked = w.ack([a ?? "", b ?? ""]);
      await waitForALockWait();
      expect(await committed([`t:15:public.listings:${a}`])).toBe(0);
      await query(`update public.listings set title = 'edited' where id = $1`, [a]);
    });
    await acked;
    // Both edits queued their keys again; the worker's claims were cleared by the triggers.
    expect(
      await admin.query(
        `select record_key, claimed_by from facetdb.jobs where starts_with(record_key, 't:15:public.listings:order-') order by 1`,
      ),
    ).toEqual([
      { record_key: `t:15:public.listings:${a}`, claimed_by: null },
      { record_key: `t:15:public.listings:${b}`, claimed_by: null },
    ]);
    await drainQueue();
  });

  it("a page enqueue meeting a job row an application transaction holds finishes after the commit, by the one-key fallback, and never aborts the application", async () => {
    await drainQueue();
    const keys = Array.from({ length: 100 }, (_, i) => `page-${String(i).padStart(3, "0")}`);
    const held = keys[50] ?? "";
    const before = keys.slice(0, 50).map((key) => `t:15:public.listings:${key}`);
    const w = worker("page-w");
    let enqueued: Promise<void> | undefined;
    let finished = false;
    // The application inserts a record in an open transaction; its trigger inserts that record's
    // job row and holds it until the commit. The worker enqueues a page with that key in the middle.
    await admin.transaction(async (query) => {
      await query(`insert into public.listings (id, title, body) values ($1, 'held', 'body')`, [
        held,
      ]);
      enqueued = w.enqueue(keys).then(() => {
        finished = true;
      });
      // The batch waits on the held row, holding the 50 rows before it, until its statement
      // timeout; rolled back, it queues key by key, and each of those 50 commits on its own while the
      // call still waits on the held key. A batch could never show them before it finished.
      await until("the enqueue never fell back to one key per statement", async () => {
        return (await committed(before)) === before.length;
      });
      await waitForALockWait();
      expect(finished).toBe(false);
      // The application goes on in the same transaction and commits.
      await query(`update public.listings set body = 'still the application''s' where id = $1`, [
        held,
      ]);
    });
    await enqueued;
    expect(finished).toBe(true);
    expect(await committed(keys.map((key) => `t:15:public.listings:${key}`))).toBe(100);
    expect(
      await admin.query(`select title, body from public.listings where id = $1`, [held]),
    ).toEqual([{ title: "held", body: "still the application's" }]);
    await drainQueue();
  });

  it("a page enqueue caught between two application transactions ends itself, never the application", async () => {
    // Three sessions. The page is [x, w, y]. Application C holds w's job row and
    // application A holds y's. The batch inserts x and waits on w; A then edits record x, so its
    // trigger waits on the batch's uncommitted x, and A is now the older waiter. C commits, the
    // batch moves on to y, held by A: a cycle in which A has waited longer. Postgres aborts the
    // session whose deadlock check fires first. A batch bounded per wait (`lock_timeout = '1s'`,
    // equal to the default deadlock_timeout) lost that race in every run: A got 40P01. Bounded as
    // a whole statement to half the deadlock_timeout, the batch rolls back first and A commits.
    await drainQueue();
    const [x, w, y] = ["cycle-x", "cycle-w", "cycle-y"];
    const page = worker("cycle-w");
    const appA = connectPostgres(scratch.url);
    const appC = connectPostgres(scratch.url);
    try {
      const aMayTouchX = gate();
      const cMayCommit = gate();
      const aHoldsY = gate();
      const cHoldsW = gate();
      const insertListing = `insert into public.listings (id, title, body) values ($1, 'app', 'body')`;
      const cDone = appC.transaction(async (query) => {
        await query(insertListing, [w]);
        cHoldsW.open();
        await cMayCommit.opened;
      });
      const aDone = appA.transaction(async (query) => {
        await query(insertListing, [y]);
        aHoldsY.open();
        await aMayTouchX.opened;
        await query(insertListing, [x]);
      });
      await Promise.all([aHoldsY.opened, cHoldsW.opened]);
      const enqueued = page.enqueue([x, w, y]);
      await waitForALockWait(); // the batch inserted x and waits on C's w
      aMayTouchX.open();
      await until("the application never waited on the batch's x", async () => {
        return (await lockWaiters()) >= 2;
      });
      // Let A's wait be clearly the older one before the batch begins its wait on y.
      await new Promise((resolve) => setTimeout(resolve, 200));
      cMayCommit.open();
      const [a, c] = await Promise.allSettled([aDone, cDone]);
      expect(a).toEqual({ status: "fulfilled", value: undefined });
      expect(c).toEqual({ status: "fulfilled", value: undefined });
      await enqueued;
      expect(await committed([x, w, y].map((key) => `t:15:public.listings:${key}`))).toBe(3);
      expect(
        await admin.query(`select id from public.listings where id = any($1::text[]) order by 1`, [
          [x, w, y],
        ]),
      ).toEqual([{ id: w }, { id: x }, { id: y }]);
    } finally {
      await appA.close();
      await appC.close();
    }
    await drainQueue();
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

// The connector hands keys around as text; the server infers the key column's type for every
// parameter that is compared with it (`id = $1`, `id = any($1)`). Text keys alone would never show
// a cast that goes wrong, so an integer and a uuid key take the same path here.
describe.each([
  { table: "items_serial", definition: "id serial primary key", key: (n: number) => String(n) },
  {
    table: "items_uuid",
    definition: "id uuid primary key default gen_random_uuid()",
    key: undefined,
  },
])("a $table key through install, watch, read, write and ack", ({ table, definition, key }) => {
  it("is queued, read, written under the hash guard and acked as text", async () => {
    await admin.query(`create table public.${table} (${definition}, title text, body text)`);
    const installed = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table },
        questionSet,
        project: { id: "proj_listings", name: "Listings" },
      },
    });
    if (!installed.ok) {
      throw new Error(installed.reason);
    }
    const inserted = await admin.query(
      `insert into public.${table} (title, body) values ('a', 'b') returning id::text as id`,
    );
    const id = String(inserted[0]?.["id"]);
    if (key !== undefined) {
      expect(id).toBe(key(1));
    } else {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    const w = createPostgresConnector({
      workerUrl: scratch.as(WORKER_ROLE, PASSWORD),
      source: { table, key: "id" },
      questionSet,
      clock: realClock,
      pollMs: POLL_MS,
      workerId: `typed-${table}`,
    });
    open.push(w);
    const iterator = w.watch()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual([id]);
    await iterator.return?.();
    expect(await w.claim(10)).toEqual([id]);
    const { rows, missing } = await w.read([id]);
    expect(missing).toEqual([]);
    expect(rows[0]?.key).toBe(id);
    expect(
      await w.write(
        id,
        {
          decisions: {
            not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.9 },
          },
          status: "done",
        },
        rows[0]?.hash ?? "",
      ),
    ).toEqual({ written: true });
    expect(await w.write(id, { decisions: {}, status: "pending" }, "stale")).toEqual({
      written: false,
    });
    await w.ack([id]);
    expect(
      await admin.query(`select record_key from facetdb.jobs where record_key like $1`, [
        `t:%:public.${table}:%`,
      ]),
    ).toEqual([]);
    expect(await admin.query(`select not_priority, facetdb_status from public.${table}`)).toEqual([
      { not_priority: true, facetdb_status: "done" },
    ]);
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
