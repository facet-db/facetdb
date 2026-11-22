import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEntry, HumanEntry, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { jobsTableSql, pgliteClient } from "../sql/index.ts";
import { createCrypto, newSalt } from "./crypto.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { sourceIdOf } from "./source-id.ts";
import {
  AmbiguousHostError,
  createStore,
  PlaintextUrlError,
  requireTls,
  type Store,
} from "./store.ts";
import {
  closeAfterTest,
  newDb,
  newStore,
  SECRET,
  scalar,
  TurningClock,
  useStoreWorld,
} from "./store-world.ts";

/**
 * The FacetDB store on PGlite: its migrations, the decision log, encrypted credentials, API keys,
 * TLS and usage. The queue and records (the store connector) are store-queue.test.ts (split by
 * subject so no file passes 10 s).
 */

useStoreWorld();

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

  it("keeps two logs for two projects with a same-named source", async () => {
    const { store, db } = await newStore();
    for (const projectId of ["proj_a", "proj_b"]) {
      await store.ensureProject({ id: projectId, name: projectId });
      await store.ensureSource({ projectId, name: "listings", kind: "plugin" });
    }
    expect(sourceIdOf("proj_a", "listings")).toBe("proj_a:listings");
    const a = store.log(sourceIdOf("proj_a", "listings"));
    const b = store.log(sourceIdOf("proj_b", "listings"));
    const fromA = answerEntry("1", 1, "2026-10-31T10:00:00Z", 0.9);
    const fromB = answerEntry("1", 1, "2026-10-31T11:00:00Z", 0.2);
    await a.appendAnswer(fromA);
    await b.appendAnswer(fromB);
    await b.appendAnswer(answerEntry("2", 1, "2026-10-31T11:00:00Z", 0.4));

    expect([...(await a.latestAnswers(["1", "2"])).entries()]).toEqual([["1", fromA]]);
    expect((await b.latestAnswers(["1"])).get("1")).toEqual(fromB);
    expect(await a.history("1")).toEqual([fromA]);
    expect(await a.history("2")).toEqual([]);
    expect(await a.latestAnswersSince()).toEqual([fromA]);
    const sources = await db.query<{ id: string; project_id: string; name: string }>(
      "select id, project_id, name from facetdb.sources order by id",
    );
    expect(sources.rows).toEqual([
      { id: "proj_a:listings", project_id: "proj_a", name: "listings" },
      { id: "proj_b:listings", project_id: "proj_b", name: "listings" },
    ]);
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
    closeAfterTest(other);
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
  /** The rule with `PGHOST` unset, as most of these cases need. */
  const tls = (url: string, allowInsecure: boolean) => requireTls(url, allowInsecure, undefined);

  it("is required for a URL that leaves this machine unless allowInsecure is set", () => {
    expect(() => tls("postgres://u:p@db.example.com/app", false)).toThrow(/TLS/);
    expect(() => tls("postgres://u:p@db.example.com/app?sslmode=disable", false)).toThrow(/TLS/);
    expect(() => tls("postgres://u:p@db.example.com/app?sslmode=prefer", false)).toThrow(/TLS/);
    expect(() => tls("postgres://u:p@db.example.com/app?sslmode=require", false)).not.toThrow();
    expect(() => tls("postgres://u:p@db.example.com/app?sslmode=verify-full", false)).not.toThrow();
    expect(() => tls("postgres://u:p@db.example.com/app", true)).not.toThrow();
  });

  it("reads the last sslmode, as the driver does", () => {
    const host = "postgres://u:p@db.example.com/app";
    expect(() => tls(`${host}?sslmode=require&sslmode=disable`, false)).toThrow(/TLS/);
    expect(() => tls(`${host}?sslmode=disable&sslmode=require`, false)).not.toThrow();
  });

  it("does not take ssl=true for TLS when sslmode says disable, allow or prefer", () => {
    const host = "postgres://u:p@db.example.com/app";
    for (const mode of ["disable", "allow", "prefer"]) {
      expect(() => tls(`${host}?ssl=true&sslmode=${mode}`, false)).toThrow(/TLS/);
      expect(() => tls(`${host}?sslmode=${mode}&ssl=true`, false)).toThrow(/TLS/);
    }
    expect(() => tls(`${host}?ssl=true`, false)).not.toThrow();
    expect(() => tls(`${host}?ssl=true&sslmode=require`, false)).not.toThrow();
    // `ssl` is read the way the driver reads it too: the last value wins.
    expect(() => tls(`${host}?ssl=true&ssl=false`, false)).toThrow(/TLS/);
    expect(() => tls(`${host}?ssl=false&ssl=true`, false)).not.toThrow();
  });

  it("resolves an empty host as the driver does: PGHOST, then localhost; a PGHOST path is a socket", () => {
    // PGHOST unset (or empty): the driver connects to localhost.
    expect(() => requireTls("postgres:///app", false, undefined)).not.toThrow();
    expect(() => requireTls("postgres:///app?user=u", false, "")).not.toThrow();
    // Credentials with no host are not a URL at all, to the driver either.
    expect(() => requireTls("postgres://u:p@/app", false, undefined)).toThrow(
      /not a connection string/,
    );
    // PGHOST names a socket directory or this machine (with a port, or a list of such hosts).
    expect(() => requireTls("postgres:///app", false, "/var/run/postgresql")).not.toThrow();
    expect(() => requireTls("postgres:///app", false, "localhost:5433")).not.toThrow();
    expect(() => requireTls("postgres:///app", false, "127.0.0.1,localhost")).not.toThrow();
    // PGHOST names another machine: refused, and the fix names PGHOST, not only the URL.
    let refused: unknown;
    try {
      requireTls("postgres:///app?user=u", false, "db.example.com");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PlaintextUrlError);
    expect(refused).toMatchObject({ host: "db.example.com", viaPgHost: true });
    expect(String(refused)).toContain("PGHOST (db.example.com)");
    expect(String(refused)).toContain("point PGHOST at this machine or a socket directory");
    expect(() => requireTls("postgres:///app", false, "localhost,db.example.com")).toThrow(
      /PGHOST/,
    );
    expect(() =>
      requireTls("postgres:///app?sslmode=require", false, "db.example.com"),
    ).not.toThrow();
    expect(() => requireTls("postgres:///app", true, "db.example.com")).not.toThrow();
    // A URL that names its host is not about PGHOST, whatever it says.
    expect(() => requireTls("postgres://u:p@db.example.com/app", false, "/tmp")).toThrow(
      PlaintextUrlError,
    );
    expect(() => requireTls("postgres://u:p@localhost/app", false, "db.example.com")).not.toThrow();
  });

  it("refuses a URL whose host two readers would read differently (more than one @ before the path)", () => {
    // postgres.js reads the hosts after the first @ (evil.com, then y@localhost), the URL parser
    // after the last (localhost): the check must not pass what the driver would send elsewhere.
    expect(() => tls("postgres://x@evil.com,y@localhost/app", false)).toThrow(AmbiguousHostError);
    expect(() => tls("postgres://u:p@ss@localhost/app", false)).toThrow(/percent-encode @/);
    // An encoded @ is one @, and a comma list of local hosts is still this machine.
    expect(() => tls("postgres://u:p%40ss@localhost/app", false)).not.toThrow();
    expect(() => tls("postgres://u:p@localhost,127.0.0.1/app", false)).not.toThrow();
    expect(() => tls("postgres://u:p@localhost,db.example.com/app", false)).toThrow(
      PlaintextUrlError,
    );
    // An @ after the path is not in the host.
    expect(() => tls("postgres://u:p@localhost/app?options=a@b", false)).not.toThrow();
  });

  it("is not required on this machine", () => {
    expect(() => tls("postgres://u:p@localhost/app", false)).not.toThrow();
    expect(() => tls("postgres://u:p@127.0.0.1:5432/app", false)).not.toThrow();
    expect(() => tls("postgres://u:p@[::1]/app", false)).not.toThrow();
  });

  it("is checked before a connection is opened", async () => {
    let opened = false;
    await expect(
      createStore({
        url: "postgres://u:p@db.example.com/app",
        pgHost: undefined,
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

/** The reservation's id, or undefined when refused: what most usage tests look at. */
async function reserved(
  store: Store,
  ...args: Parameters<Store["usage"]["reserve"]>
): Promise<string | undefined> {
  return (await store.usage.reserve(...args)).reservation;
}

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
    const first = await reserved(store, "p", MONTH, 50, 100, now, expires);
    const second = await reserved(store, "p", MONTH, 50, 100, now, expires);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // 40 counted + 100 reserved is past the cap of 100: nothing more goes out.
    expect(await reserved(store, "p", MONTH, 1, 100, now, expires)).toBeUndefined();

    await store.usage.release("p", first ?? "");
    // Releasing leaves 40 + 50 = 90, under the cap again.
    expect(await reserved(store, "p", MONTH, 1, 100, now, expires)).toBeDefined();
  });

  it("admits in one statement, whose function takes the lock on the month's usage row before it reads the count", async () => {
    // PGlite runs one transaction at a time, so no test on it can tell a locked reserve from an
    // unlocked one by its outcome (store.db.test.ts proves the outcome on a real Postgres, with
    // separate connections). What this proves without one is what the guarantee rests on: one
    // statement reaches the store (one round trip, no transaction), and inside the function it calls,
    // a write to the project's `usage` row comes before the count is read and before the insert
    // that checks it, each its own statement. Move the lock after the count and this fails.
    const db = await newDb();
    const inner = pgliteClient(db);
    const sent: string[] = [];
    const store = await createStore({
      url: "postgres://localhost/facetdb",
      pgHost: undefined,
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
    closeAfterTest(store);
    await store.usage.add("p", MONTH, 25);
    sent.length = 0;

    expect(await store.usage.reserve("p", MONTH, 10, 100, 0, 60_000)).toEqual({
      reservation: expect.any(String),
      monthTotal: 25,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("from facetdb.reserve_usage(");
    const body = String(
      await scalar(db, "select prosrc from pg_catalog.pg_proc where proname = 'reserve_usage'"),
    );
    const lockAt = body.indexOf("insert into facetdb.usage (");
    const countAt = body.indexOf("month_total :=");
    const insertAt = body.indexOf("insert into facetdb.usage_reservations");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
    expect(countAt).toBeLessThan(insertAt);
  });

  it("answers a refusal with the count it read, and counts no reservation in it", async () => {
    const { store } = await newStore();
    await store.usage.add("p", MONTH, 60);
    expect((await store.usage.reserve("p", MONTH, 40, 100, 0, 60_000)).monthTotal).toBe(60);
    // 60 counted + 40 reserved reaches the cap of 100: refused, and the count is still 60.
    expect(await store.usage.reserve("p", MONTH, 1, 100, 0, 60_000)).toEqual({
      reservation: undefined,
      monthTotal: 60,
    });
    // A month with no usage row yet reads 0, with or without a limit.
    expect((await store.usage.reserve("p", OTHER, 1, undefined, 0, 60_000)).monthTotal).toBe(0);
    expect((await store.usage.reserve("q", MONTH, 1, 100, 0, 60_000)).monthTotal).toBe(0);
  });

  it("lets only the requests that fit pass when several arrive together", async () => {
    // The arithmetic under concurrent calls; the lock itself is the test above and store.db.test.ts.
    const { store } = await newStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserved(store, "p", MONTH, 30, 100, 0, 60_000)),
    );
    // 0, 30, 60, 90 are under 100; the fifth and sixth find 120 reserved.
    expect(results.filter((id) => id !== undefined)).toHaveLength(4);
  });

  it("returns a reservation's headroom when its lease ends", async () => {
    const { store } = await newStore();
    expect(await reserved(store, "p", MONTH, 100, 100, 0, 1_000)).toBeDefined();
    expect(await reserved(store, "p", MONTH, 1, 100, 999, 2_000)).toBeUndefined();
    expect(await reserved(store, "p", MONTH, 1, 100, 1_000, 2_000)).toBeDefined();
  });

  it("counts a reservation against its own month only, and always admits a project with no limit", async () => {
    const { store } = await newStore();
    expect(await reserved(store, "p", MONTH, 100, 100, 0, 60_000)).toBeDefined();
    expect(await reserved(store, "p", OTHER, 1, 100, 0, 60_000)).toBeDefined();
    expect(await reserved(store, "p", MONTH, 1_000_000, undefined, 0, 60_000)).toBeDefined();
  });

  it("releases a reservation twice without harm", async () => {
    const { store } = await newStore();
    const id = await reserved(store, "p", MONTH, 10, 100, 0, 60_000);
    await store.usage.release("p", id ?? "");
    await store.usage.release("p", id ?? "");
  });

  it("finishes a request in one statement: the tokens are counted and the reservation released", async () => {
    const db = await newDb();
    const inner = pgliteClient(db);
    const sent: string[] = [];
    const store = await createStore({
      url: "postgres://localhost/facetdb",
      pgHost: undefined,
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
    closeAfterTest(store);
    await store.usage.add("p", MONTH, 10);
    const id = await reserved(store, "p", MONTH, 90, 100, 0, 60_000);
    expect(id).toBeDefined();
    // 10 counted + 90 reserved is the cap: nothing more goes out until the request is finished.
    expect(await reserved(store, "p", MONTH, 1, 100, 0, 60_000)).toBeUndefined();
    sent.length = 0;

    // It answers with the month's count after it, so the gate needs no second read.
    expect(await store.usage.finish("p", MONTH, id ?? "", 40)).toBe(50);

    expect(sent).toHaveLength(1);
    expect(await store.usage.total("p", MONTH)).toBe(50);
    // 50 counted and nothing reserved: the 90 gave way to the 40 it cost.
    expect(await reserved(store, "p", MONTH, 49, 100, 0, 60_000)).toBeDefined();
  });

  it("counts a finish whose reservation is already released, and agrees with add then release", async () => {
    const { store } = await newStore();
    const id = await reserved(store, "p", MONTH, 30, 100, 0, 60_000);
    await store.usage.release("p", id ?? "");
    expect(await store.usage.finish("p", MONTH, id ?? "", 25)).toBe(25);
    expect(await store.usage.finish("p", OTHER, id ?? "", 5)).toBe(5);
    expect(await store.usage.add("q", MONTH, 25)).toBe(25);
    expect(await store.usage.add("q", MONTH, 0)).toBe(25);

    expect(await store.usage.total("p", MONTH)).toBe(25);
    expect(await store.usage.total("p", OTHER)).toBe(5);
    expect(await store.usage.total("p", MONTH)).toBe(await store.usage.total("q", MONTH));
  });

  it("claims each alert once a month under a cap and lets a released claim be taken again", async () => {
    const { store } = await newStore();
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 1_000)).toBe(true);
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 1_000)).toBe(false);
    expect(await store.usage.claimAlert("p", MONTH, "spending_paused", 1_000)).toBe(true);
    expect(await store.usage.claimAlert("p", OTHER, "spending_80", 1_000)).toBe(true);
    // A cap changed mid-month is a new claim (migration 7; a real run).
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 5_000)).toBe(true);
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 5_000)).toBe(false);
    await store.usage.releaseAlert("p", MONTH, "spending_80", 1_000);
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 1_000)).toBe(true);
    expect(await store.usage.claimAlert("p", MONTH, "spending_80", 5_000)).toBe(false);
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

    // A line recorded before its channels are tried, then settled with their outcomes.
    const id = await store.alerts.append({
      at: 2,
      key: "k",
      phase: "raised",
      severity: "critical",
      event,
      delivered: false,
      deliveries: [],
      pending: true,
    });
    await store.alerts.settle(id, {
      delivered: true,
      deliveries: [
        { channel: "slack:#ops", ok: true },
        { channel: "email:ops@example.com", ok: false, error: "the channel did not answer" },
      ],
    });
    const settled = await db.query<{ record: string }>(
      "select record::text as record from facetdb.alert_history where id = $1::bigint",
      [id],
    );
    expect(JSON.parse(String(settled.rows[0]?.record))).toEqual({
      at: 2,
      key: "k",
      phase: "raised",
      severity: "critical",
      event,
      delivered: true,
      deliveries: [
        { channel: "slack:#ops", ok: true },
        { channel: "email:ops@example.com", ok: false, error: "the channel did not answer" },
      ],
    });

    expect(await store.alerts.lastHeartbeat("p")).toBeUndefined();
    await store.alerts.saveHeartbeat("p", 1_700_000_000_000);
    await store.alerts.saveHeartbeat("p", 1_700_000_060_000);
    expect(await store.alerts.lastHeartbeat("p")).toBe(1_700_000_060_000);
  });

  it("keep one heartbeat row per worker, stamped and aged by the database's clock, which the take removes and counts", async () => {
    // The store's own clock here is a fake one in 2023: only the database's reaches these rows.
    const { store, db } = await newStore();
    const databaseNow = async () =>
      Number(
        await scalar(db, "select (extract(epoch from clock_timestamp()) * 1000)::bigint::text"),
      );
    /** A row as a worker `ageMs` ago would have left it, written on the database's clock. */
    const seed = (project: string, worker: string, ageMs: number) =>
      db.exec(
        `insert into facetdb.worker_heartbeats (project, worker, at)
         values ('${project}', '${worker}', (extract(epoch from clock_timestamp()) * 1000)::bigint - ${ageMs})`,
      );

    const before = await databaseNow();
    const saved = await store.alerts.saveWorkerBeat("p", "worker-a");
    expect(saved).toBeGreaterThanOrEqual(before);
    expect(saved).toBeLessThanOrEqual(await databaseNow());
    expect(await store.alerts.saveWorkerBeat("p", "worker-a")).toBeGreaterThanOrEqual(saved);
    await seed("p", "worker-b", 100_000);
    await seed("p", "worker-c", 130_000);
    await seed("p", "worker-e", 300_000);
    await seed("q", "worker-z", 500_000);
    // The project's own heartbeat is a different row and is left as it was.
    await store.alerts.saveHeartbeat("p", 1_700_000_000_000);

    // Rows 2 minutes old or older go, oldest first, but never the caller's own or another project's;
    // the count is of the rows still beating, the caller's own among them.
    const taken = await store.alerts.takeDeadWorkers("p", "worker-b", 120_000);
    expect(taken.taken.map((row) => row.worker)).toEqual(["worker-e", "worker-c"]);
    expect(taken.beating).toBe(2);
    expect(taken.taken[1]?.at).toBeLessThanOrEqual((await databaseNow()) - 130_000);
    expect(await store.alerts.takeDeadWorkers("p", "worker-b", 120_000)).toEqual({
      taken: [],
      beating: 0,
    });
    // The caller's own row is never taken, however old.
    expect(
      (await store.alerts.takeDeadWorkers("p", "worker-a", 0)).taken.map((row) => row.worker),
    ).toEqual(["worker-b"]);
    expect(
      await scalar(
        db,
        "select count(*)::int from facetdb.worker_heartbeats where worker = 'worker-a'",
      ),
    ).toBe(1);
    await store.alerts.removeWorkerBeat("p", "worker-a");
    await store.alerts.removeWorkerBeat("p", "worker-a");
    expect(
      (await store.alerts.takeDeadWorkers("q", "worker-x", 120_000)).taken.map((r) => r.worker),
    ).toEqual(["worker-z"]);
    expect(await store.alerts.lastHeartbeat("p")).toBe(1_700_000_000_000);
  });

  it("keep a channel's quiet-hours summary state, swapped only from the state read, and read back what was held for it", async () => {
    const { store, db } = await newStore();
    const key = "quiet|p|slack:#ops";
    const claimed = { until: 2_000, since: 1_000, triedAt: 2_060, sentAt: null };
    expect(await store.alerts.quietState(key)).toBeUndefined();
    expect(await store.alerts.swapQuietState(key, undefined, claimed)).toBe(true);
    // A second claim from nothing finds the row there.
    expect(await store.alerts.swapQuietState(key, undefined, { ...claimed, triedAt: 9 })).toBe(
      false,
    );
    expect(await store.alerts.quietState(key)).toEqual(claimed);
    const sent = { ...claimed, sentAt: 2_070 };
    // A swap from a state that is no longer there changes nothing; from the one there, it writes.
    expect(await store.alerts.swapQuietState(key, sent, { ...sent, until: 5 })).toBe(false);
    expect(await store.alerts.swapQuietState(key, claimed, sent)).toBe(true);
    expect(await store.alerts.quietState(key)).toEqual(sent);
    // Whether the span held anything is read back as written, and a swap from the state as read
    // still matches the row (a state without it, above, reads without it).
    const held = { ...sent, held: true };
    expect(await store.alerts.swapQuietState(key, sent, held)).toBe(true);
    expect(await store.alerts.quietState(key)).toEqual(held);
    const read = await store.alerts.quietState(key);
    expect(await store.alerts.swapQuietState(key, read, { ...held, triedAt: 3_000 })).toBe(true);
    await db.exec(`update facetdb.alerts set state = state || '{"held": "yes"}'::jsonb`);
    await expect(store.alerts.quietState(key)).rejects.toThrow(/"held"/);
    // A row that is not a state is refused by name, not taken for one.
    await db.exec(`update facetdb.alerts set state = '{"until": "soon"}'::jsonb`);
    await expect(store.alerts.quietState(key)).rejects.toThrow(/"until"/);

    const event = {
      kind: "backfill_failed" as const,
      what: "w",
      project: "p",
      source: "listings",
      question: null,
      did: "d",
      link: "l",
    };
    const line = (at: number, held: readonly string[] | undefined, project = "p") =>
      store.alerts.append({
        at,
        key: `k${at}`,
        phase: "raised",
        severity: "warning",
        event: { ...event, project },
        delivered: true,
        ...(held === undefined ? {} : { held }),
      });
    await line(999, ["slack:#ops"]);
    await line(1_000, ["slack:#ops", "email:ops@example.com"]);
    await line(1_500, undefined);
    await line(1_600, ["slack:#data"]);
    await line(1_700, ["slack:#ops"], "q");
    await line(1_999, ["slack:#ops"]);
    await line(2_000, ["slack:#ops"]);
    await store.alerts.append({
      at: 1_800,
      key: "k1800",
      phase: "resolved",
      severity: "information",
      event: { ...event, kind: "spending_80", source: "all sources" },
      delivered: true,
      held: ["slack:#ops"],
    });
    expect(await store.alerts.heldFor("p", "slack:#ops", 1_000, 2_000)).toEqual([
      {
        key: "k1000",
        phase: "raised",
        severity: "warning",
        kind: "backfill_failed",
        source: "listings",
      },
      {
        key: "k1999",
        phase: "raised",
        severity: "warning",
        kind: "backfill_failed",
        source: "listings",
      },
      {
        key: "k1800",
        phase: "resolved",
        severity: "information",
        kind: "spending_80",
        source: "all sources",
      },
    ]);
    expect(await store.alerts.heldFor("p", "slack:#nowhere", 0, 10_000)).toEqual([]);
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
    await store.ensureSource({ projectId: "p", name: "issues", kind: "plugin" });
    await store.ensureSource({ projectId: "p", name: "issues", kind: "plugin" });
    expect(
      (await db.query<{ id: string }>("select id from facetdb.sources")).rows.map((r) => r.id),
    ).toEqual(["p:issues"]);
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

  it("keeps the set a worker runs whole, one row per source, replaced at each loop open and read back exactly (store migration 8)", async () => {
    const { store, db, clock } = await newStore();
    const set: QuestionSet = {
      questions: [
        { type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" },
        { type: "noul", name: "urgent", instructions: "Is it urgent?", stakes: "low" },
      ],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    // Nothing until a worker records what it runs: `record` alone (a backfill's) writes no row.
    const recorded = await store.questionSets.record("src", set);
    expect(await store.questionSets.inForce("src")).toBeNull();

    await store.questionSets.run("src", recorded.version, set);
    expect(await store.questionSets.inForce("src")).toEqual({
      version: 1,
      questionSet: set,
      recordedAt: new Date(1_700_000_000_000),
    });
    expect(await store.questionSets.inForce("other")).toBeNull();

    // A threshold, a where filter and the questions' order change no version (the content hash
    // leaves them out), and the row shows them all the same: it is the whole set.
    clock.advance(60_000);
    const [scam, urgent] = set.questions;
    const retuned: QuestionSet = {
      ...set,
      questions: [urgent as (typeof set.questions)[number], scam as (typeof set.questions)[number]],
      thresholds: { scam: { yesAbove: 0.5 } },
      where: "body is not null",
    };
    const again = await store.questionSets.record("src", retuned);
    expect(again.version).toBe(1);
    await store.questionSets.run("src", again.version, retuned);
    expect(await store.questionSets.inForce("src")).toEqual({
      version: 1,
      questionSet: retuned,
      recordedAt: new Date(1_700_000_060_000),
    });
    expect(await scalar(db, "select count(*)::int from facetdb.question_sets_in_force")).toBe(1);
    expect(await scalar(db, "select count(*)::int from facetdb.question_set_versions")).toBe(1);

    // A row that no longer parses is a corrupt store, said with the version and the source.
    await db.query(
      `update facetdb.question_sets_in_force set question_set = $1::jsonb where source_id = 'src'`,
      [JSON.stringify({ ...set, model: "jev-latest" })],
    );
    await expect(store.questionSets.inForce("src")).rejects.toThrow(
      /question set v1 of "src" in the FacetDB store cannot be read/,
    );
  });

  it("answers the row each write of the set in force replaced, and a row that no longer parses as a version without its set", async () => {
    const { store, db } = await newStore();
    const set: QuestionSet = {
      questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    // The first open of a source replaces nothing.
    expect(await store.questionSets.run("src", 1, set)).toBeNull();
    // The same version again (a restart, a second worker) is answered with itself.
    expect(await store.questionSets.run("src", 1, set)).toEqual({ version: 1, questionSet: set });
    const reworded: QuestionSet = {
      ...set,
      questions: [{ type: "noul", name: "scam", instructions: "Is it a fake?", stakes: "low" }],
    };
    // A new version is answered with the one it replaced, once: the next write sees the new one.
    expect(await store.questionSets.run("src", 2, reworded)).toEqual({
      version: 1,
      questionSet: set,
    });
    expect(await store.questionSets.run("src", 2, reworded)).toEqual({
      version: 2,
      questionSet: reworded,
    });
    // Another source's row is its own.
    expect(await store.questionSets.run("other", 1, set)).toBeNull();

    // A row an older FacetDB wrote that this one cannot read never stops the open: it is answered
    // with its version and no set, and replaced.
    await db.query(
      `update facetdb.question_sets_in_force set question_set = $1::jsonb where source_id = 'src'`,
      [JSON.stringify({ ...set, model: "jev-latest" })],
    );
    expect(await store.questionSets.run("src", 3, set)).toEqual({ version: 2, questionSet: null });
    expect(await store.questionSets.inForce("src")).toMatchObject({ version: 3, questionSet: set });
  });

  it("read a source's version history newest first, each with its time and the set it was made from, up to a limit", async () => {
    const { store, clock } = await newStore();
    const set: QuestionSet = {
      questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    expect(await store.questionSets.history("src", 5)).toEqual([]);
    await store.questionSets.record("src", set);
    clock.advance(60_000);
    const reworded: QuestionSet = {
      ...set,
      questions: [
        {
          type: "noul",
          name: "scam",
          instructions: "Is this listing likely a scam?",
          stakes: "low",
        },
      ],
    };
    await store.questionSets.record("src", reworded);
    clock.advance(60_000);
    const widened: QuestionSet = { ...reworded, read: ["body", "title"] };
    await store.questionSets.record("src", widened);
    await store.questionSets.record("other", set);

    const history = await store.questionSets.history("src", 5);
    expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.map((entry) => entry.createdAt.getTime())).toEqual([
      1_700_000_120_000, 1_700_000_060_000, 1_700_000_000_000,
    ]);
    expect(history[0]?.questionSet).toEqual(widened);
    expect(history[2]?.questionSet).toEqual(set);
    expect(history[0]?.contentHash).toBe((await store.questionSets.latest("src"))?.contentHash);
    expect((await store.questionSets.history("src", 2)).map((entry) => entry.version)).toEqual([
      3, 2,
    ]);
  });

  it("read a stored set that no longer parses as unreadable, with the parser's words, and the others as they are", async () => {
    const { store, db } = await newStore();
    const set: QuestionSet = {
      questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    await store.questionSets.record("src", set);
    // A set an older FacetDB saved under rules this one refuses: an alias for the model.
    await db.query(
      `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set)
       values ('src', 2, 'h2', $1::jsonb)`,
      [JSON.stringify({ ...set, model: "jev-latest" })],
    );

    const [newest, oldest] = await store.questionSets.history("src", 5);
    expect(newest).toMatchObject({ version: 2, questionSet: null });
    expect(newest?.unreadable).toEqual(expect.stringContaining("jev-latest"));
    expect(oldest).toMatchObject({ version: 1, questionSet: set, unreadable: null });
  });
});
