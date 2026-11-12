import { connect as connectTcp, createServer, type Socket } from "node:net";
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

/**
 * What `pending` settled to, or "still waiting" once `ms` passed: a hang fails the assertion that
 * reads it, with a name, instead of the test's own timeout.
 */
async function within<T>(
  ms: number,
  pending: Promise<T>,
): Promise<{ value: T } | { error: unknown } | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The queued keys among `queuedKeys` another session can see, that is, committed. */
async function committed(queuedKeys: readonly string[]): Promise<number> {
  const rows = await admin.query(
    `select count(*)::int as n from facetdb.jobs where record_key = any($1::text[])`,
    [queuedKeys],
  );
  return Number(rows[0]?.["n"]);
}

/** A promise the test resolves by hand, to step concurrent transactions in a fixed order. */
function gate(): { opened: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** How many sessions other than the worker login's wait for a lock right now. */
async function applicationsWaiting(): Promise<number> {
  const rows = await admin.query(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename <> $1`,
    [WORKER_ROLE],
  );
  return Number(rows[0]?.["n"]);
}

/** The listing an application inserts; its trigger inserts and holds that record's job row. */
const INSERT_LISTING = `insert into public.listings (id, title, body) values ($1, 'app', 'body')`;

/**
 * A TCP relay between a client and the Postgres of `target`, counting round trips: each time a
 * connection's client speaks again after the server answered is one. Statements the client sends
 * without waiting for an answer (a pipeline) are one round trip however many they are. It connects
 * to the host and port `target` names, wherever that is; it listens on loopback because it runs in
 * this process. It relays bytes only, so TLS stays end to end.
 */
async function roundTripRelay(target: URL): Promise<{
  url(through: URL): string;
  roundTrips(): number;
  reset(): void;
  close(): Promise<void>;
}> {
  let roundTrips = 0;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connectTcp(target.port === "" ? 5432 : Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    let serverAnswered = true;
    client.on("data", (data) => {
      if (serverAnswered) {
        roundTrips++;
        serverAnswered = false;
      }
      upstream.write(data);
    });
    upstream.on("data", (data) => {
      serverAnswered = true;
      client.write(data);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the relay has no TCP address");
  }
  return {
    url(through) {
      const relayed = new URL(through.toString());
      relayed.hostname = "127.0.0.1";
      relayed.port = String(address.port);
      return relayed.toString();
    },
    roundTrips: () => roundTrips,
    reset: () => {
      roundTrips = 0;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

  it("a page enqueue meeting a job row an application transaction holds finishes after the commit, and never aborts the application", async () => {
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
      // One key per statement, each its own transaction: the 50 keys before the held one commit
      // while the statement for the held key still waits, holding nothing else. A multi-row
      // statement could never show them before it finished.
      await until("the keys before the held one never committed on their own", async () => {
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

  it("a page enqueue caught between two application transactions delays no application and aborts none", async () => {
    // Three sessions. The page is [x, w, y]; application C holds w's job
    // row, application A holds y's. A multi-row insert took x and waited on w; A's edit of record
    // x then waited on that uncommitted x; C committed and the insert met y, held by A: a cycle in
    // which A, the older waiter, was aborted (40P01 in every run under `lock_timeout = '1s'`).
    // One key per statement, x is committed on its own at once, so A's edit of x waits on nothing,
    // and only the worker's statements for w and y wait, each holding nothing else.
    await drainQueue();
    const [x, w, y] = ["cycle-x", "cycle-w", "cycle-y"];
    const page = worker("cycle-page");
    const appA = connectPostgres(scratch.url);
    const appC = connectPostgres(scratch.url);
    try {
      const aMayTouchX = gate();
      const aTouchedX = gate();
      const cMayCommit = gate();
      const aHoldsY = gate();
      const cHoldsW = gate();
      const cDone = appC.transaction(async (query) => {
        await query(INSERT_LISTING, [w]);
        cHoldsW.open();
        await cMayCommit.opened;
      });
      const aDone = appA.transaction(async (query) => {
        await query(INSERT_LISTING, [y]);
        aHoldsY.open();
        await aMayTouchX.opened;
        await query(INSERT_LISTING, [x]);
        aTouchedX.open();
      });
      await Promise.all([aHoldsY.opened, cHoldsW.opened]);
      const enqueued = page.enqueue([x, w, y]);
      await waitForALockWait(); // the worker's statement for w waits on C
      await until("the worker's statement for x never committed", async () => {
        return (await committed([`t:15:public.listings:${x}`])) === 1;
      });
      aMayTouchX.open();
      // A edits x and goes on while C is still open: the enqueue holds nothing A waits for.
      await aTouchedX.opened;
      expect(await applicationsWaiting()).toBe(0);
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

  it("a page enqueue joining a chain of application waits closes no cycle: both applications commit", async () => {
    // A second cycle: application C holds w's job row and then waits on application A
    // for an ordinary row lock of its own; the enqueue of [x, w] starts while C waits. A multi-row
    // insert took x and waited on C's w; A's edit of record x waited on that uncommitted x: a cycle
    // A -> enqueue -> C -> A, in which C had waited longest, so C's deadlock check fired first and
    // C was aborted, whatever timeout bounded the insert. One key per statement, x commits on its
    // own and the statement for w waits holding nothing: the waits form a chain, not a cycle.
    await drainQueue();
    const [x, w, lockRow] = ["chain-x", "chain-w", "chain-lock"];
    await admin.query(`insert into public.listings (id, title, body) values ($1, 'free', 'body')`, [
      lockRow,
    ]);
    const page = worker("chain-page");
    const appA = connectPostgres(scratch.url);
    const appC = connectPostgres(scratch.url);
    try {
      const aHoldsLockRow = gate();
      const aMayTouchX = gate();
      const cHoldsW = gate();
      const aDone = appA.transaction(async (query) => {
        await query(`update public.listings set title = 'A' where id = $1`, [lockRow]);
        aHoldsLockRow.open();
        await aMayTouchX.opened;
        await query(INSERT_LISTING, [x]);
      });
      await aHoldsLockRow.opened;
      const cDone = appC.transaction(async (query) => {
        await query(INSERT_LISTING, [w]);
        cHoldsW.open();
        await query(`update public.listings set title = 'C' where id = $1`, [lockRow]);
      });
      await cHoldsW.opened;
      await until("application C never waited on application A", async () => {
        return (await applicationsWaiting()) === 1;
      });
      const enqueued = page.enqueue([x, w]);
      await waitForALockWait(); // the worker's statement for w waits on C, which waits on A
      aMayTouchX.open();
      const [a, c] = await Promise.allSettled([aDone, cDone]);
      expect(a).toEqual({ status: "fulfilled", value: undefined });
      expect(c).toEqual({ status: "fulfilled", value: undefined });
      await enqueued;
      expect(await committed([x, w].map((key) => `t:15:public.listings:${key}`))).toBe(2);
      // Both applications' writes stand, in the order their locks allowed: A, then C.
      expect(
        await admin.query(
          `select id, title from public.listings where id = any($1::text[]) order by 1`,
          [[x, w, lockRow]],
        ),
      ).toEqual([
        { id: lockRow, title: "C" },
        { id: w, title: "app" },
        { id: x, title: "app" },
      ]);
    } finally {
      await appA.close();
      await appC.close();
    }
    await drainQueue();
  });

  it("a page enqueue is pipelined: 200 keys cost a few round trips, where one statement awaited per key costs one each", async () => {
    await drainQueue();
    const relay = await roundTripRelay(new URL(scratch.url));
    try {
      const page = createPostgresConnector({
        workerUrl: relay.url(new URL(scratch.as(WORKER_ROLE, PASSWORD))),
        source: { table: "listings", key: "id" },
        questionSet,
        clock: realClock,
        pollMs: POLL_MS,
        workerId: "pipeline",
      });
      open.push(page);
      const keys = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
      // Warm up: the connection opens, logs in and learns the statement (described once).
      await page.enqueue(keys("warm", 300));
      relay.reset();
      await page.enqueue(keys("pipe", 200));
      const pipelined = relay.roundTrips();
      relay.reset();
      for (const key of keys("one", 20)) {
        await page.enqueue([key]);
      }
      const oneByOne = relay.roundTrips();
      // The counter counts round trips: 20 statements awaited one by one are 20 of them.
      expect(oneByOne).toBeGreaterThanOrEqual(20);
      // 200 statements as one pipeline: the first alone, then bursts of 100 and 99 on one
      // connection, three round trips at best (a burst's tail can reach the server after its first
      // answers, and a loaded machine splits writes). Before the pipeline named its statement,
      // postgres.js described every run first: 400, two per key; a burst wider than postgres.js's
      // 100 in flight streamed one run per answer: 101.
      expect(pipelined).toBeLessThanOrEqual(8);
      expect(await committed(keys("pipe", 200).map((key) => `t:15:public.listings:${key}`))).toBe(
        200,
      );
    } finally {
      await relay.close();
    }
    await drainQueue();
  });

  it("a statement with parameters is prepared once per connection: on a warm one each run is one round trip", async () => {
    // `query` and `transaction` name every statement (`prepare: true`), so postgres.js describes it
    // once per connection and then only binds and runs it. Unnamed, it was described before every
    // run: two round trips each (measured 40 for these 20 runs, and 40 for the 10 transactions
    // below, before the change).
    const relay = await roundTripRelay(new URL(scratch.url));
    const client = connectPostgres(relay.url(new URL(scratch.as(WORKER_ROLE, PASSWORD))), {
      max: 1,
    });
    const READ = "select count(*)::text as n from public.listings where id = $1";
    const COUNT_JOB = "select count(*)::text as n from facetdb.jobs where record_key = $1";
    try {
      // Cold: the connection opens, logs in and describes each statement once.
      await client.query(READ, ["warm-up"]);
      await client.transaction((query) => query(COUNT_JOB, ["warm-up"]));
      relay.reset();
      for (let run = 0; run < 20; run++) {
        await client.query(READ, [`key-${run}`]);
      }
      expect(relay.roundTrips()).toBe(20);

      relay.reset();
      for (let run = 0; run < 10; run++) {
        await client.transaction((query) => query(COUNT_JOB, [`key-${run}`]));
      }
      // `begin`, the statement and `commit`: one round trip each.
      expect(relay.roundTrips()).toBe(30);
    } finally {
      await client.close();
      await relay.close();
    }
  });

  it.each(["cold", "warm"] as const)(
    "a pipeline whose connection is ended mid-way (%s) rejects at once, and the next statement gets a fresh connection",
    async (state) => {
      // The reserved connection's backend is found by its application_name and ended with
      // pg_terminate_backend while a run of the pipeline waits on a job row an application holds:
      // cold, the run sent alone first on a connection that never described the statement; warm,
      // a run in the second burst of a connection that has. Nothing may be left unsettled (the call
      // would hang), and the dead connection must not go back to the pool (the next statement
      // would be written to a socket that is gone).
      await drainQueue();
      const name = `facetdb-pipe-${state}`;
      const url = new URL(scratch.as(WORKER_ROLE, PASSWORD));
      url.searchParams.set("application_name", name);
      const page = createPostgresConnector({
        workerUrl: url.toString(),
        source: { table: "listings", key: "id" },
        questionSet,
        clock: realClock,
        pollMs: POLL_MS,
        workerId: name,
      });
      open.push(page);
      if (state === "warm") {
        await page.enqueue([`${state}-warm-up`, `${state}-warm-up-2`]);
      }
      const keys = Array.from({ length: 150 }, (_, i) => `${state}-${String(i).padStart(3, "0")}`);
      const held = (state === "cold" ? keys[0] : keys[120]) ?? "";
      const app = connectPostgres(scratch.url);
      try {
        const holds = gate();
        const mayCommit = gate();
        const appDone = app.transaction(async (query) => {
          await query(INSERT_LISTING, [held]);
          holds.open();
          await mayCommit.opened;
        });
        await holds.opened;
        const enqueued = page.enqueue(keys);
        let pid: unknown;
        await until("the pipeline never waited on the held key", async () => {
          const rows = await admin.query(
            `select pid from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`,
            [name],
          );
          pid = rows[0]?.["pid"];
          return pid !== undefined;
        });
        await admin.query(`select pg_terminate_backend($1)`, [pid]);
        const outcome = await within(5000, enqueued);
        expect(outcome).not.toBe("still waiting");
        expect(outcome).not.toHaveProperty("value");
        // A FATAL ends the session without a ReadyForQuery: postgres.js reports the closed socket.
        expect(String((outcome as { error: unknown }).error)).toMatch(
          /terminating connection|CONNECTION_/,
        );
        mayCommit.open();
        await appDone;
        // The same client, a fresh connection: a pipeline and a plain statement both go through.
        await page.enqueue([`${state}-after`]);
        expect(await committed([`t:15:public.listings:${state}-after`])).toBe(1);
        expect((await page.read([held])).rows.map((row) => row.key)).toEqual([held]);
        // The dead connection is never reused; closing must not wait for it forever.
        expect(await within(10_000, page.close())).toEqual({ value: undefined });
      } finally {
        await app.close();
      }
      await drainQueue();
    },
  );

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
