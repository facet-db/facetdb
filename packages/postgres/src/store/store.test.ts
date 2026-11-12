import type { PGlite } from "@electric-sql/pglite";
import type {
  AnswerEntry,
  HumanEntry,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { pgliteClient } from "../polling/index.ts";
import { CLAIM_LEASE_MS, jobsTableSql } from "../sql/index.ts";
import { freshPglite } from "../testing/index.ts";
import { createCrypto, newSalt } from "./crypto.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { createStore, requireTls, type Store } from "./store.ts";

const SECRET = "a-long-random-secret-for-tests-only";

/** A fake clock whose sleep lets the event loop turn, so a watch loop cannot starve the database. */
class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const opened: PGlite[] = [];
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const db of opened.splice(0)) {
    await db.close();
  }
});

async function newDb(): Promise<PGlite> {
  const db = await freshPglite();
  opened.push(db);
  return db;
}

async function newStore(
  db?: PGlite,
  clock: FakeClock = new TurningClock(1_700_000_000_000),
  secret: string | undefined = SECRET,
): Promise<{ store: Store; db: PGlite; clock: FakeClock }> {
  const pglite = db ?? (await newDb());
  const store = await createStore({ pglite, secret, clock });
  stores.push(store);
  return { store, db: pglite, clock };
}

async function scalar(db: PGlite, sql: string): Promise<unknown> {
  const { rows } = await db.query<Record<string, unknown>>(sql);
  return Object.values(rows[0] ?? {})[0];
}

async function catalog(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ line: string }>(
    `select table_name || '.' || column_name || ':' || data_type as line
       from information_schema.columns where table_schema = 'facetdb' order by 1`,
  );
  return rows.map((row) => row.line);
}

describe("store migrations", () => {
  it("are idempotent: starting again changes nothing and records each migration once", async () => {
    const { db } = await newStore();
    const before = await catalog(db);
    expect(before.length).toBeGreaterThan(40);
    await newStore(db);
    await newStore(db);
    expect(await catalog(db)).toEqual(before);
    expect(await scalar(db, "select count(*)::int from facetdb.store_migrations")).toBe(
      SCHEMA_VERSION,
    );
    expect(await scalar(db, "select count(*)::int from facetdb.install")).toBe(1);
  });

  it("refuse a store written by a newer FacetDB instead of guessing", async () => {
    const { db } = await newStore();
    await db.query("insert into facetdb.store_migrations (version) values (99)");
    await expect(
      createStore({ pglite: db, secret: SECRET, clock: new FakeClock() }),
    ).rejects.toThrow(/schema version 99/);
  });

  it("define facetdb.jobs once: the store's table is the shared definition", async () => {
    const { db } = await newStore();
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'facetdb' and table_name = 'jobs' order by ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "record_key",
      "enqueued_at",
      "claimed_at",
      "claimed_by",
    ]);
    const before = await catalog(db);
    for (const statement of jobsTableSql()) {
      await db.exec(statement);
    }
    expect(await catalog(db)).toEqual(before);
  });
});

const answerEntry = (key: string, version: number, at: string, probability = 0.9): AnswerEntry => ({
  kind: "answer",
  key,
  version,
  model: "jev-1.14.0",
  stateHash: `hash-${key}-${version}`,
  answers: { scam: { type: "noul", probability } },
  usage: { inputTokens: 120, outputTokens: 4 },
  at: new Date(at),
});

const humanEntry = (key: string, value: boolean | string, at: string): HumanEntry => ({
  kind: "human",
  key,
  question: "scam",
  value,
  reviewer: "amara",
  note: "looked fine",
  stateHash: `hash-${key}-1`,
  version: 1,
  at: new Date(at),
});

describe("the decision log", () => {
  it("returns the latest answer, the history oldest first, and human rows beside them", async () => {
    const { store } = await newStore();
    const log = store.log("src");
    expect(await log.latestAnswer("a")).toBeUndefined();
    expect(await log.history("a")).toEqual([]);

    const first = answerEntry("a", 1, "2026-10-31T10:00:00.123Z", 0.5);
    const second = answerEntry("a", 1, "2026-10-31T11:00:00.456Z", 0.95);
    const human = humanEntry("a", true, "2026-10-31T12:00:00.000Z");
    await log.appendAnswer(first);
    await log.appendAnswer(second);
    await log.appendHuman(human);

    expect(await log.latestAnswer("a")).toEqual(second);
    expect(await log.history("a")).toEqual([first, second, human]);
    expect(await log.history("other")).toEqual([]);
  });

  it("keeps a choice value and a human note exactly, and omits an absent note", async () => {
    const { store } = await newStore();
    const log = store.log("src");
    const withoutNote: HumanEntry = { ...humanEntry("b", "billing", "2026-10-31T10:00:00Z") };
    delete (withoutNote as { note?: string }).note;
    await log.appendHuman(withoutNote);
    const [entry] = await log.history("b");
    expect(entry).toEqual(withoutNote);
    expect(entry).not.toHaveProperty("note");
  });

  it("latestAnswersSince gives each record's latest answer, optionally from a version", async () => {
    const { store } = await newStore();
    const log = store.log("src");
    await log.appendAnswer(answerEntry("a", 1, "2026-10-31T10:00:00Z"));
    await log.appendAnswer(answerEntry("b", 1, "2026-10-31T10:00:00Z"));
    await log.appendAnswer(answerEntry("b", 2, "2026-10-31T11:00:00Z"));
    await log.appendHuman(humanEntry("a", false, "2026-10-31T12:00:00Z"));

    const all = await log.latestAnswersSince();
    expect(all.map((entry) => [entry.key, entry.version])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    const fromTwo = await log.latestAnswersSince(2);
    expect(fromTwo.map((entry) => entry.key)).toEqual(["b"]);
  });

  it("latestAnswers gives each key's latest answer in one call, and leaves out keys never answered", async () => {
    const { store } = await newStore();
    const log = store.log("src");
    await log.appendAnswer(answerEntry("a", 1, "2026-10-31T10:00:00Z"));
    await log.appendAnswer(answerEntry("b", 1, "2026-10-31T10:00:00Z"));
    await log.appendAnswer(answerEntry("b", 2, "2026-10-31T11:00:00Z"));
    // A human row is newer than b's answer, and is not an answer: b's latest answer still wins.
    await log.appendHuman(humanEntry("b", true, "2026-10-31T12:00:00Z"));
    await log.appendHuman(humanEntry("h", true, "2026-10-31T12:00:00Z"));

    const keys = ["a", "b", "h", "never"];
    const latest = await log.latestAnswers(keys);
    expect([...latest.keys()].sort()).toEqual(["a", "b"]);
    for (const key of keys) {
      expect(latest.get(key)).toEqual(await log.latestAnswer(key));
    }
    expect(latest.get("b")?.version).toBe(2);
    expect((await log.latestAnswers([])).size).toBe(0);
  });

  it("keeps sources apart", async () => {
    const { store } = await newStore();
    await store.log("one").appendAnswer(answerEntry("a", 1, "2026-10-31T10:00:00Z"));
    expect(await store.log("two").latestAnswer("a")).toBeUndefined();
    expect((await store.log("two").latestAnswers(["a"])).size).toBe(0);
    expect(await store.log("two").latestAnswersSince()).toEqual([]);
  });
});

const FIELDS = ["title", "body"] as const;

describe("the store connector passes the contract suite", () => {
  runConnectorContract(async () => {
    const { store, clock } = await newStore();
    const make = (workerId: string) =>
      store.connector({ sourceId: "src", fields: FIELDS, workerId, pageSize: 10, pollMs: 2000 });
    const connector = make("worker-1");
    return {
      connector,
      peer: make("worker-2"),
      fields: FIELDS,
      edit: async (key: RecordKey, state: Readonly<Record<string, StateValue>>) => {
        await connector.upsertRecord(key, state);
      },
      decisionOf: async (key: RecordKey) => (await connector.getRecord(key))?.decision ?? null,
      close: async () => {
        void clock;
      },
    };
  });
});

describe("the store connector", () => {
  const state = (value: string): Record<string, StateValue> => ({ title: value, body: value });
  const decision: RecordDecision = {
    decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: 0.1 } },
    status: "done",
  };

  it("queues a record once when its state changes, and not at all when it does not", async () => {
    const { store, db } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    expect(await connector.upsertRecord("r1", state("x"))).toBe(true);
    expect(await connector.upsertRecord("r1", state("x"))).toBe(false);
    expect(await connector.upsertRecord("r1", state("y"))).toBe(true);
    expect(await scalar(db, "select count(*)::int from facetdb.jobs")).toBe(1);
  });

  it("sends a decided record back to pending when its state changes, keeping the old decision", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    await connector.upsertRecord("r1", state("x"));
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    await connector.write("r1", decision, hash);
    expect((await connector.getRecord("r1"))?.status).toBe("done");

    await connector.upsertRecord("r1", state("changed"));
    const record = await connector.getRecord("r1");
    expect(record?.status).toBe("pending");
    expect(record?.decision?.decisions).toEqual(decision.decisions);
  });

  it("keeps a job for a state that changed while a worker held the job for the old one", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const other = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await connector.upsertRecord("r1", state("x"));
    expect(await connector.claim(5)).toEqual(["r1"]);
    const staleHash = (await connector.read(["r1"])).rows[0]?.hash ?? "";

    // The state changes while the worker is asking about "x"; its answer is discarded by the hash guard.
    await connector.upsertRecord("r1", state("y"));
    expect(await connector.write("r1", decision, staleHash)).toEqual({ written: false });
    await connector.ack(["r1"]);

    expect((await connector.getRecord("r1"))?.status).toBe("pending");
    expect(await other.claim(5)).toEqual(["r1"]);
  });

  it("refuses a state that lacks a field", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    await expect(connector.upsertRecord("r1", { title: "only" })).rejects.toThrow(/"body"/);
  });

  it("gives a claim back to the queue when its worker never settles it", async () => {
    const { store, clock } = await newStore();
    const one = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const two = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await one.enqueue(["k"]);
    expect(await one.claim(5)).toEqual(["k"]);
    expect(await two.claim(5)).toEqual([]);
    clock.advance(CLAIM_LEASE_MS + 1);
    expect(await two.claim(5)).toEqual(["k"]);
    // The first worker's late ack removes nothing: the job is the second worker's now.
    await one.ack(["k"]);
    expect(await two.claim(5)).toEqual([]);
    await two.ack(["k"]);
  });

  it("claims only the one queued key it is asked for, and leaves the rest queued", async () => {
    const { store, clock } = await newStore();
    const one = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const two = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await one.enqueue(["old1", "old2", "mine"]);
    expect(await one.claimRecord("mine")).toBe(true);
    // Held by w1 now: nobody else takes it, and a key that is not queued is not claimed.
    expect(await two.claimRecord("mine")).toBe(false);
    expect(await two.claimRecord("absent")).toBe(false);
    expect([...(await two.claim(10))].sort()).toEqual(["old1", "old2"]);
    clock.advance(CLAIM_LEASE_MS + 1);
    expect(await two.claimRecord("mine")).toBe(true);
  });

  it("keeps sources' queues apart", async () => {
    const { store } = await newStore();
    const a = store.connector({ sourceId: "a", fields: FIELDS, workerId: "w" });
    const b = store.connector({ sourceId: "b", fields: FIELDS, workerId: "w" });
    await a.enqueue(["same"]);
    await b.enqueue(["same"]);
    expect(await a.claim(10)).toEqual(["same"]);
    expect(await b.claim(10)).toEqual(["same"]);
  });

  it("keeps apart sources whose ids start alike, and returns the keys as given", async () => {
    const { store } = await newStore();
    const short = store.connector({ sourceId: "a", fields: FIELDS, workerId: "w" });
    const long = store.connector({ sourceId: "a:1:b", fields: FIELDS, workerId: "w" });
    await short.enqueue(["1:b:k", "k"]);
    await long.enqueue(["k"]);
    expect([...(await short.claim(10))].sort()).toEqual(["1:b:k", "k"]);
    expect(await long.claim(10)).toEqual(["k"]);
  });

  it("queues with the trigger's statement: record_key alone is the primary key", async () => {
    const { db } = await newStore();
    // The statement the trigger runs, word for word.
    const enqueue =
      "insert into facetdb.jobs (record_key) values ('r1') on conflict (record_key) do nothing";
    await db.exec(enqueue);
    await db.exec(enqueue);
    expect(await scalar(db, "select count(*)::int from facetdb.jobs")).toBe(1);
    const key = await db.query<{ attname: string }>(
      `select a.attname from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'facetdb.jobs'::regclass and i.indisprimary`,
    );
    expect(key.rows.map((row) => row.attname)).toEqual(["record_key"]);
  });
});

describe("encrypted credentials", () => {
  const PLAINTEXT = "postgres://facetdb_worker:hunter2-very-secret@db.example/app?sslmode=require";

  async function storedCiphertexts(db: PGlite): Promise<string> {
    const { rows } = await db.query("select * from facetdb.credentials");
    return JSON.stringify(rows);
  }

  it("round-trips, and the table never shows the plaintext", async () => {
    const { store, db } = await newStore();
    await store.ensureProject({ id: "p", name: "Project" });
    await store.credentials.put("p", "worker-login", PLAINTEXT);
    await store.credentials.put("p", "webhook:src", "whsec_abcdef");

    expect(await store.credentials.get("p", "worker-login")).toBe(PLAINTEXT);
    expect(await store.credentials.get("p", "missing")).toBeUndefined();
    expect(await store.credentials.names("p")).toEqual(["webhook:src", "worker-login"]);

    const dump = await storedCiphertexts(db);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("facetdb_worker");
    expect(dump).not.toContain("whsec_abcdef");
    expect(dump).toContain("v1:");
  });

  it("encrypts the same value differently each time", async () => {
    const { store, db } = await newStore();
    await store.ensureProject({ id: "p", name: "Project" });
    await store.credentials.put("p", "a", PLAINTEXT);
    await store.credentials.put("p", "b", PLAINTEXT);
    const { rows } = await db.query<{ ciphertext: string }>(
      "select ciphertext from facetdb.credentials",
    );
    expect(new Set(rows.map((row) => row.ciphertext)).size).toBe(2);
  });

  it("fails loudly under a wrong secret, naming the variable", async () => {
    const { store, db } = await newStore();
    await store.ensureProject({ id: "p", name: "Project" });
    await store.credentials.put("p", "worker-login", PLAINTEXT);

    const other = await createStore({
      pglite: db,
      secret: "a-different-secret",
      clock: new FakeClock(),
    });
    stores.push(other);
    await expect(other.credentials.get("p", "worker-login")).rejects.toThrow(/FACETDB_SECRET/);
  });

  it("fails when a ciphertext is moved to another row", async () => {
    const { store, db } = await newStore();
    await store.ensureProject({ id: "p", name: "Project" });
    await store.credentials.put("p", "a", PLAINTEXT);
    await store.credentials.put("p", "b", "other");
    await db.query(
      "update facetdb.credentials set ciphertext = (select ciphertext from facetdb.credentials where name = 'a') where name = 'b'",
    );
    await expect(store.credentials.get("p", "b")).rejects.toThrow(/could not decrypt/);
  });

  it("refuses to start without a secret, and names the variable", async () => {
    const db = await newDb();
    for (const secret of [undefined, ""]) {
      await expect(createStore({ pglite: db, secret, clock: new FakeClock() })).rejects.toThrow(
        /FACETDB_SECRET is not set/,
      );
    }
    // It refused before touching the database: nothing was created.
    expect(
      await scalar(
        db,
        "select count(*)::int from information_schema.schemata where schema_name = 'facetdb'",
      ),
    ).toBe(0);
  });

  it("derives different keys from one secret under different salts", () => {
    const one = createCrypto(SECRET, newSalt());
    const two = createCrypto(SECRET, newSalt());
    expect(() => two.decrypt(one.encrypt("x", "p"), "p")).toThrow(/could not decrypt/);
  });

  it("refuses a value in a format it did not write", () => {
    const crypto = createCrypto(SECRET, newSalt());
    expect(() => crypto.decrypt("plain text", "p")).toThrow(/format/);
  });
});

describe("API keys", () => {
  it("are stored as hashes, verified, and revoked", async () => {
    const { store, db } = await newStore();
    await store.ensureProject({ id: "p", name: "Project" });
    const created = await store.apiKeys.create("p", "ci");
    expect(await store.apiKeys.verify(created.secret)).toEqual({ id: created.id, projectId: "p" });
    expect(await store.apiKeys.verify("fdb_not-a-key")).toBeUndefined();

    const { rows } = await db.query("select * from facetdb.api_keys");
    expect(JSON.stringify(rows)).not.toContain(created.secret);

    expect(await store.apiKeys.revoke(created.id)).toBe(true);
    expect(await store.apiKeys.revoke(created.id)).toBe(false);
    expect(await store.apiKeys.verify(created.secret)).toBeUndefined();
  });
});

describe("TLS", () => {
  it("is required for a URL that leaves this machine unless allowInsecure is set", () => {
    expect(() => requireTls("postgres://u:p@db.example.com/app", false)).toThrow(/TLS/);
    expect(() => requireTls("postgres://u:p@db.example.com/app?sslmode=disable", false)).toThrow(
      /TLS/,
    );
    expect(() => requireTls("postgres://u:p@db.example.com/app?sslmode=prefer", false)).toThrow(
      /TLS/,
    );
    expect(() =>
      requireTls("postgres://u:p@db.example.com/app?sslmode=require", false),
    ).not.toThrow();
    expect(() =>
      requireTls("postgres://u:p@db.example.com/app?sslmode=verify-full", false),
    ).not.toThrow();
    expect(() => requireTls("postgres://u:p@db.example.com/app", true)).not.toThrow();
  });

  it("reads the last sslmode, as the driver does", () => {
    const host = "postgres://u:p@db.example.com/app";
    expect(() => requireTls(`${host}?sslmode=require&sslmode=disable`, false)).toThrow(/TLS/);
    expect(() => requireTls(`${host}?sslmode=disable&sslmode=require`, false)).not.toThrow();
  });

  it("does not take ssl=true for TLS when sslmode says disable, allow or prefer", () => {
    const host = "postgres://u:p@db.example.com/app";
    for (const mode of ["disable", "allow", "prefer"]) {
      expect(() => requireTls(`${host}?ssl=true&sslmode=${mode}`, false)).toThrow(/TLS/);
      expect(() => requireTls(`${host}?sslmode=${mode}&ssl=true`, false)).toThrow(/TLS/);
    }
    expect(() => requireTls(`${host}?ssl=true`, false)).not.toThrow();
    expect(() => requireTls(`${host}?ssl=true&sslmode=require`, false)).not.toThrow();
    // `ssl` is read the way the driver reads it too: the last value wins.
    expect(() => requireTls(`${host}?ssl=true&ssl=false`, false)).toThrow(/TLS/);
    expect(() => requireTls(`${host}?ssl=false&ssl=true`, false)).not.toThrow();
  });

  it("does not take an empty host for this machine", () => {
    expect(() => requireTls("postgres:///app", false)).toThrow();
    expect(() => requireTls("postgres://u:p@/app", false)).toThrow();
    expect(() => requireTls("postgres:///app", true)).not.toThrow();
  });

  it("is not required on this machine", () => {
    expect(() => requireTls("postgres://u:p@localhost/app", false)).not.toThrow();
    expect(() => requireTls("postgres://u:p@127.0.0.1:5432/app", false)).not.toThrow();
    expect(() => requireTls("postgres://u:p@[::1]/app", false)).not.toThrow();
  });

  it("is checked before a connection is opened", async () => {
    let opened = false;
    await expect(
      createStore({
        url: "postgres://u:p@db.example.com/app",
        secret: SECRET,
        clock: new FakeClock(),
        connect: () => {
          opened = true;
          throw new Error("must not connect");
        },
      }),
    ).rejects.toThrow(/TLS/);
    expect(opened).toBe(false);
  });
});

describe("usage", () => {
  const MONTH = "2026-11";
  const OTHER = "2026-12";

  it("adds and totals per project and month", async () => {
    const { store } = await newStore();
    await store.usage.add("p", MONTH, 100);
    await store.usage.add("p", MONTH, 50);
    await store.usage.add("p", OTHER, 7);
    await store.usage.add("q", MONTH, 1);
    expect(await store.usage.total("p", MONTH)).toBe(150);
    expect(await store.usage.total("p", OTHER)).toBe(7);
    expect(await store.usage.total("none", MONTH)).toBe(0);
  });

  it("reserves against the count plus the open reservations, so one request crosses the cap and no more follow", async () => {
    const { store } = await newStore();
    const now = 1_000;
    const expires = now + 60_000;
    await store.usage.add("p", MONTH, 40);
    const first = await store.usage.reserve("p", MONTH, 50, 100, now, expires);
    const second = await store.usage.reserve("p", MONTH, 50, 100, now, expires);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // 40 counted + 100 reserved is past the cap of 100: nothing more goes out.
    expect(await store.usage.reserve("p", MONTH, 1, 100, now, expires)).toBeUndefined();

    await store.usage.release("p", first ?? "");
    // Releasing leaves 40 + 50 = 90, under the cap again.
    expect(await store.usage.reserve("p", MONTH, 1, 100, now, expires)).toBeDefined();
  });

  it("takes the lock on the month's usage row before it checks the count", async () => {
    // PGlite runs one transaction at a time, so no test on it can tell a locked reserve from an
    // unlocked one by its outcome (store.db.test.ts proves the outcome on a real Postgres, with
    // separate connections). What this proves without one is the statement the guarantee rests on:
    // inside the reserve transaction, a write to the project's `usage` row comes before the insert
    // that counts. Remove the lock statement and this fails.
    const db = await newDb();
    const inner = pgliteClient(db);
    const transactions: string[][] = [];
    const store = await createStore({
      url: "postgres://localhost/facetdb",
      secret: SECRET,
      clock: new TurningClock(1_700_000_000_000),
      connect: () => ({
        ...inner,
        transaction: (work) => {
          const statements: string[] = [];
          transactions.push(statements);
          return inner.transaction((query) =>
            work((text, params) => {
              statements.push(text);
              return query(text, params);
            }),
          );
        },
      }),
    });
    stores.push(store);
    transactions.length = 0;

    await store.usage.reserve("p", MONTH, 10, 100, 0, 60_000);

    expect(transactions).toHaveLength(1);
    const statements = transactions[0] ?? [];
    const countAt = statements.findIndex((text) =>
      text.includes("insert into facetdb.usage_reservations"),
    );
    const lockAt = statements.findIndex(
      (text) =>
        text.includes("insert into facetdb.usage ") && text.includes("do update set input_tokens"),
    );
    expect(countAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
  });

  it("lets only the requests that fit pass when several arrive together", async () => {
    // The arithmetic under concurrent calls; the lock itself is the test above and store.db.test.ts.
    const { store } = await newStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.usage.reserve("p", MONTH, 30, 100, 0, 60_000)),
    );
    // 0, 30, 60, 90 are under 100; the fifth and sixth find 120 reserved.
    expect(results.filter((id) => id !== undefined)).toHaveLength(4);
  });

  it("returns a reservation's headroom when its lease ends", async () => {
    const { store } = await newStore();
    expect(await store.usage.reserve("p", MONTH, 100, 100, 0, 1_000)).toBeDefined();
    expect(await store.usage.reserve("p", MONTH, 1, 100, 999, 2_000)).toBeUndefined();
    expect(await store.usage.reserve("p", MONTH, 1, 100, 1_000, 2_000)).toBeDefined();
  });

  it("counts a reservation against its own month only, and always admits a project with no limit", async () => {
    const { store } = await newStore();
    expect(await store.usage.reserve("p", MONTH, 100, 100, 0, 60_000)).toBeDefined();
    expect(await store.usage.reserve("p", OTHER, 1, 100, 0, 60_000)).toBeDefined();
    expect(await store.usage.reserve("p", MONTH, 1_000_000, undefined, 0, 60_000)).toBeDefined();
  });

  it("releases a reservation twice without harm", async () => {
    const { store } = await newStore();
    const id = await store.usage.reserve("p", MONTH, 10, 100, 0, 60_000);
    await store.usage.release("p", id ?? "");
    await store.usage.release("p", id ?? "");
  });

  it("finishes a request in one statement: the tokens are counted and the reservation released", async () => {
    const db = await newDb();
    const inner = pgliteClient(db);
    const sent: string[] = [];
    const store = await createStore({
      url: "postgres://localhost/facetdb",
      secret: SECRET,
      clock: new TurningClock(1_700_000_000_000),
      connect: () => ({
        ...inner,
        query: (text, params) => {
          sent.push(text);
          return inner.query(text, params);
        },
        transaction: (work) => {
          sent.push("transaction");
          return inner.transaction(work);
        },
      }),
    });
    stores.push(store);
    await store.usage.add("p", MONTH, 10);
    const id = await store.usage.reserve("p", MONTH, 90, 100, 0, 60_000);
    expect(id).toBeDefined();
    // 10 counted + 90 reserved is the cap: nothing more goes out until the request is finished.
    expect(await store.usage.reserve("p", MONTH, 1, 100, 0, 60_000)).toBeUndefined();
    sent.length = 0;

    await store.usage.finish("p", MONTH, id ?? "", 40);

    expect(sent).toHaveLength(1);
    expect(await store.usage.total("p", MONTH)).toBe(50);
    // 50 counted and nothing reserved: the 90 gave way to the 40 it cost.
    expect(await store.usage.reserve("p", MONTH, 49, 100, 0, 60_000)).toBeDefined();
  });

  it("counts a finish whose reservation is already released, and agrees with add then release", async () => {
    const { store } = await newStore();
    const id = await store.usage.reserve("p", MONTH, 30, 100, 0, 60_000);
    await store.usage.release("p", id ?? "");
    await store.usage.finish("p", MONTH, id ?? "", 25);
    await store.usage.finish("p", OTHER, id ?? "", 5);
    await store.usage.add("q", MONTH, 25);

    expect(await store.usage.total("p", MONTH)).toBe(25);
    expect(await store.usage.total("p", OTHER)).toBe(5);
    expect(await store.usage.total("p", MONTH)).toBe(await store.usage.total("q", MONTH));
  });

  it("claims each alert once a month and lets a released claim be taken again", async () => {
    const { store } = await newStore();
    expect(await store.usage.claimAlert("p", MONTH, "spending_80")).toBe(true);
    expect(await store.usage.claimAlert("p", MONTH, "spending_80")).toBe(false);
    expect(await store.usage.claimAlert("p", MONTH, "spending_paused")).toBe(true);
    expect(await store.usage.claimAlert("p", OTHER, "spending_80")).toBe(true);
    await store.usage.releaseAlert("p", MONTH, "spending_80");
    expect(await store.usage.claimAlert("p", MONTH, "spending_80")).toBe(true);
  });

  it("survives a restart: a second store on the same database sees the counts", async () => {
    const { store, db } = await newStore();
    await store.usage.add("p", MONTH, 123);
    const again = await newStore(db);
    expect(await again.store.usage.total("p", MONTH)).toBe(123);
  });
});

describe("alerts, cursors and question-set versions", () => {
  it("keep alert state, history and the heartbeat", async () => {
    const { store, db } = await newStore();
    const event = {
      kind: "model_failing" as const,
      what: "w",
      project: "p",
      source: "s",
      question: null,
      did: "d",
      link: "l",
    };
    expect(await store.alerts.getActive("k")).toBeUndefined();
    await store.alerts.setActive("k", { event, raisedAt: 10, lastSentAt: null });
    await store.alerts.setActive("k", { event, raisedAt: 10, lastSentAt: 20 });
    expect(await store.alerts.getActive("k")).toEqual({ event, raisedAt: 10, lastSentAt: 20 });
    await store.alerts.clearActive("k");
    expect(await store.alerts.getActive("k")).toBeUndefined();

    await store.alerts.append({
      at: 1,
      key: "k",
      phase: "raised",
      severity: "warning",
      event,
      delivered: true,
    });
    expect(await scalar(db, "select count(*)::int from facetdb.alert_history")).toBe(1);

    expect(await store.alerts.lastHeartbeat("p")).toBeUndefined();
    await store.alerts.saveHeartbeat("p", 1_700_000_000_000);
    await store.alerts.saveHeartbeat("p", 1_700_000_060_000);
    expect(await store.alerts.lastHeartbeat("p")).toBe(1_700_000_060_000);
  });

  it("resume a backfill run from its saved cursor", async () => {
    const { store } = await newStore();
    expect(await store.cursors.load("run")).toBeUndefined();
    await store.cursors.save("run", { cursor: "page-3", done: false });
    expect(await store.cursors.load("run")).toEqual({ cursor: "page-3", done: false });
    await store.cursors.save("run", { cursor: null, done: true });
    expect(await store.cursors.load("run")).toEqual({ cursor: null, done: true });
  });

  it("number question-set versions by content, reusing the version when nothing changed", async () => {
    const { store, db, clock } = await newStore();
    await store.ensureProject({ id: "p", name: "P" });
    await store.ensureSource({ id: "src", projectId: "p", name: "issues", kind: "plugin" });
    await store.ensureSource({ id: "src", projectId: "p", name: "issues", kind: "plugin" });
    const set: QuestionSet = {
      questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    expect(await store.questionSets.latest("src")).toBeUndefined();
    const one = await store.questionSets.record("src", set);
    expect(one.version).toBe(1);
    clock.advance(1_000);
    expect((await store.questionSets.record("src", set)).version).toBe(1);
    const changed = { ...set, read: ["body", "title"] };
    const two = await store.questionSets.record("src", changed);
    expect(two.version).toBe(2);
    expect(await store.questionSets.latest("src")).toEqual(two);
    expect(one.createdAt.getTime()).toBe(1_700_000_000_000);
    expect(await scalar(db, "select count(*)::int from facetdb.question_set_versions")).toBe(2);
  });
});
