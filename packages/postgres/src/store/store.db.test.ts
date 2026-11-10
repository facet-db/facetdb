import { randomBytes } from "node:crypto";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { queuePrefix } from "./connector.ts";
import { createStore, type Store } from "./store.ts";

/**
 * The store against a real Postgres. PGlite runs one connection, so it serializes every statement and
 * proves shape, never concurrency. The two things the store leans on the
 * database for are proven here, with separate connections:
 *  - `reserve` locks the month's `usage` row, so reservations that arrive together cannot all see the
 *    same count (operations.ts);
 *  - `claim` takes `for update skip locked`, so a worker passes over a job another connection holds
 *    instead of waiting for it or taking it twice (sql/jobs.ts).
 * DATABASE_URL names a server, never the database the tests run in: they create a scratch database of
 * their own (`facetdb_test_<random>`) on that server and drop it at the end, so a database that holds a
 * FacetDB install or store is never touched. The role needs `createdb` (the CI one is a superuser).
 */

const SECRET = "a-long-random-secret-for-tests-only";
const MONTH = "2026-11";
const FIELDS = ["title"];

function serverUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "environment, not code: DATABASE_URL is unset (point it at a Postgres 13+; the CI workflow starts one)",
    );
  }
  return url;
}

const scratchName = `facetdb_test_${randomBytes(6).toString("hex")}`;

/** The URL of the scratch database: the server of DATABASE_URL with only the database name replaced. */
function databaseUrl(): string {
  const url = new URL(serverUrl());
  url.pathname = `/${scratchName}`;
  return url.toString();
}

type Deferred = { readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const clients: SqlClient[] = [];
const stores: Store[] = [];

function open(): SqlClient {
  const client = connectPostgres(databaseUrl());
  clients.push(client);
  return client;
}

/** A store on its own connections: two of them are two processes as far as the database can tell. */
async function newStore(): Promise<Store> {
  // The test database is on a private network of the CI, so a remote host without TLS is allowed here.
  const store = await createStore({
    url: databaseUrl(),
    secret: SECRET,
    clock: new FakeClock(1_700_000_000_000),
    allowInsecure: true,
  });
  stores.push(store);
  return store;
}

beforeAll(async () => {
  const server = connectPostgres(serverUrl());
  try {
    await server.query(`create database ${scratchName}`);
  } finally {
    await server.close();
  }
});

afterAll(async () => {
  const server = connectPostgres(serverUrl());
  try {
    await server.query(`drop database if exists ${scratchName} with (force)`);
  } finally {
    await server.close();
  }
});

// The schema is dropped in the scratch database only, so every test starts from an empty install.
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

/**
 * Resolves once some backend of this database is waiting for a lock. This polls the server for a
 * state, it does not time anything: the bound only keeps a broken test from hanging.
 */
async function untilSomeoneWaitsForALock(admin: SqlClient): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = await admin.query(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (Number(rows[0]?.["n"]) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "no backend ever waited for a lock: the statement did not take the lock under test",
  );
}

/**
 * Holds `statement` (a `select … for update`) in an open transaction on its own connection until
 * `release` is called, and resolves `holding` once the lock is taken.
 */
function holdLock(statement: string, params: readonly unknown[]) {
  const holding = deferred();
  const release = deferred();
  const done = open()
    .transaction(async (query) => {
      await query(statement, params);
      holding.resolve();
      await release.promise;
    })
    .catch((error: unknown) => {
      // A failure before the lock was taken reaches the test through `holding`; after it, the
      // transaction only waits, so there is nothing left to fail.
      holding.reject(error);
    });
  return { holding: holding.promise, release: () => release.resolve(), done };
}

describe("reserve on a real Postgres", () => {
  it("waits for the lock on the month's usage row, so it counts what the holder commits", async () => {
    const store = await newStore();
    await store.usage.add("p", MONTH, 10);
    const lock = holdLock(
      "select 1 from facetdb.usage where project_id = $1 and month = $2 for update",
      ["p", MONTH],
    );
    await lock.holding;

    let settled = false;
    const pending = store.usage.reserve("p", MONTH, 10, 100, 0, 60_000).then((id) => {
      settled = true;
      return id;
    });
    try {
      // If reserve never touched the usage row it would not wait, and this would time out.
      await untilSomeoneWaitsForALock(open());
      expect(settled).toBe(false);
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await pending).toBeDefined();
  });

  it("admits only the requests that fit when many arrive from separate connections at once", async () => {
    const workers = await Promise.all([newStore(), newStore(), newStore(), newStore()]);
    const attempts = workers.flatMap((store) =>
      Array.from({ length: 8 }, () => store.usage.reserve("p", MONTH, 30, 100, 0, 60_000)),
    );
    const admitted = (await Promise.all(attempts)).filter((id) => id !== undefined);
    // Counted before each one: 0, 30, 60 and 90 are under 100. Without the lock, reservations that
    // start together all see 0 and every one of the 32 would be admitted.
    expect(admitted).toHaveLength(4);
    const rows = await open().query("select count(*)::text as n from facetdb.usage_reservations");
    expect(Number(rows[0]?.["n"])).toBe(4);
  });
});

describe("claim on a real Postgres", () => {
  const SOURCE = "src";

  async function queue(store: Store, keys: readonly string[]): Promise<void> {
    await store.connector({ sourceId: SOURCE, fields: FIELDS, workerId: "seed" }).enqueue(keys);
  }

  it("passes over a job another connection holds, instead of waiting for it", async () => {
    const [first, second] = await Promise.all([newStore(), newStore()]);
    await queue(first, ["k1", "k2", "k3", "k4"]);
    const lock = holdLock("select 1 from facetdb.jobs where record_key = $1 for update", [
      queuePrefix(SOURCE) + "k1",
    ]);
    await lock.holding;
    const one = first.connector({ sourceId: SOURCE, fields: FIELDS, workerId: "one" });
    const two = second.connector({ sourceId: SOURCE, fields: FIELDS, workerId: "two" });
    try {
      // k1 is the oldest and is locked. Without `skip locked` this claim waits for the holder, which
      // lets go only after the claim returns, so the test would hang until its timeout.
      expect([...(await one.claim(2))].sort()).toEqual(["k2", "k3"]);
      expect(await two.claim(5)).toEqual(["k4"]);
    } finally {
      lock.release();
      await lock.done;
    }
    // The skipped job was never claimed: it is there for the next claim.
    expect(await two.claim(5)).toEqual(["k1"]);
  });

  it("never gives one job to two workers claiming from separate connections at once", async () => {
    const [first, second] = await Promise.all([newStore(), newStore()]);
    const keys = Array.from({ length: 60 }, (_, i) => `key-${String(i).padStart(3, "0")}`);
    await queue(first, keys);
    const one = first.connector({ sourceId: SOURCE, fields: FIELDS, workerId: "one" });
    const two = second.connector({ sourceId: SOURCE, fields: FIELDS, workerId: "two" });

    const taken: string[] = [];
    for (let round = 0; round < 6; round++) {
      const [a, b] = await Promise.all([one.claim(7), two.claim(7)]);
      taken.push(...a, ...b);
    }
    // Every job once, none twice: 84 asked for, 60 queued.
    expect([...taken].sort()).toEqual(keys);
  });
});
