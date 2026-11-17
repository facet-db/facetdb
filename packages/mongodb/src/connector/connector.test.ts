import {
  type BackfillProgress,
  type CursorStore,
  EngineRefusal,
  type EngineTarget,
  type QuestionSet,
  type RecordDecision,
  stateHash,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { Binary, ObjectId, Timestamp } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServerError, FakeWorkerMongo } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  changePipeline,
  createMongoConnector,
  type MongoConnector,
  stateOf,
  statePathPattern,
  storedText,
  storedValue,
  TOKEN_REFRESH_MS,
  tokenRun,
} from "./index.ts";

/**
 * The MongoDB connector against a recording fake of the worker's connection: the pipeline the
 * stream opens with, where it starts, the order of queue, yield and token save, the reconcile pass
 * after a refused token, claims and settles by token, the write's transaction, the subdocument read
 * back, and what `open` refuses. What only a server proves is in connector.db.test.ts.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const INSTALLED = Date.parse("2026-11-03T18:30:12.345Z");
const FIELDS = ["subject", "body"];
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const URL = "mongodb://facetdb_worker:pw@127.0.0.1:27017/app";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: FIELDS,
  model: "jev-1.14.0",
  thresholds: {},
};

function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange: "keep",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...overrides,
  };
}

/** The store's cursors as a map, noting each save in the fake's calls so one order reads. */
class Cursors implements CursorStore {
  readonly saved = new Map<string, BackfillProgress>();
  private readonly fake: FakeWorkerMongo;

  constructor(fake: FakeWorkerMongo) {
    this.fake = fake;
  }

  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.saved.get(run));
  }

  save(run: string, progress: BackfillProgress): Promise<void> {
    this.saved.set(run, progress);
    this.fake.note(`save ${progress.cursor ?? "null"}`);
    return Promise.resolve();
  }
}

/** A fake server with the install as the worker sees it: the marker and the jobs collection. */
function installed(): FakeWorkerMongo {
  const fake = new FakeWorkerMongo();
  fake.insert("facetdb_meta", {
    _id: "owner:tickets",
    project: PROJECT.id,
    source: "tickets",
    installedAt: new Date(INSTALLED),
  });
  fake.documents("facetdb_jobs");
  fake.documents("tickets");
  return fake;
}

type World = {
  readonly fake: FakeWorkerMongo;
  readonly cursors: Cursors;
  readonly clock: FakeClock;
  readonly warnings: string[];
  readonly connector: MongoConnector;
};

const opened: MongoConnector[] = [];
afterEach(async () => {
  for (const connector of opened.splice(0)) {
    await connector.close();
  }
});

async function world(
  options: {
    readonly fake?: FakeWorkerMongo;
    readonly target?: EngineTarget;
    readonly token?: string;
    readonly workerId?: string;
    readonly clock?: FakeClock;
    readonly cursors?: Cursors;
  } = {},
): Promise<World> {
  const fake = options.fake ?? installed();
  const cursors = options.cursors ?? new Cursors(fake);
  const on = options.target ?? target();
  if (options.token !== undefined) {
    cursors.saved.set(tokenRun(on), { cursor: options.token, done: false });
  }
  const clock = options.clock ?? new FakeClock(START);
  const warnings: string[] = [];
  const connector = await createMongoConnector(on, URL, {
    clock,
    cursors,
    allowInsecure: false,
    warn: (line) => warnings.push(line),
    connect: fake.connect,
    workerId: options.workerId ?? "w1",
    scanPageSize: 2,
  });
  opened.push(connector);
  return { fake, cursors, clock, warnings, connector };
}

const change = (id: unknown, token: string, operationType = "update") => ({
  _id: { _data: token },
  operationType,
  documentKey: { _id: id },
});

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
  status: "done",
};

const hashOf = (document: Record<string, unknown>) => stateHash(FIELDS, stateOf(document, FIELDS));

describe("watch", () => {
  it("follows the collection from the stored token with the state pipeline, queues a batch, yields it, and stores the token once the worker asks for more", async () => {
    const { fake, cursors, connector } = await world({ token: '{"_data":"t0"}' });
    fake.feed({ changes: [change("a", "t1", "insert"), change("b", "t2"), change("a", "t3")] });
    const changes = connector.watch()[Symbol.asyncIterator]();

    const first = await changes.next();
    fake.note("yielded");
    expect(first.value).toEqual(["a", "b"]);
    expect(fake.callsOf("watch")).toEqual([
      {
        kind: "watch",
        collection: "tickets",
        pipeline: changePipeline(FIELDS),
        start: { kind: "after", token: { _data: "t0" } },
      },
    ]);
    // The changes' keys are queued with their claims cleared before the batch leaves; the token
    // is stored only after the worker came back for more: a crash in between replays the batch.
    const pending = changes.next();
    await vi.waitFor(() =>
      expect(cursors.saved.get(tokenRun(target()))?.cursor).toBe('{"_data":"pbrt-1"}'),
    );
    expect(
      fake.calls
        .filter((call) => call.kind === "bulkUpdate" || call.kind === "note")
        .map((call) => (call.kind === "note" ? call.what : `${call.kind} ${call.collection}`)),
    ).toEqual(["bulkUpdate facetdb_jobs", "yielded", 'save {"_data":"pbrt-1"}']);
    expect(fake.documents("facetdb_jobs")).toEqual([
      {
        collection: "tickets",
        record_key: "a",
        claimed_at: null,
        claimed_by: null,
        claim_token: null,
        enqueued_at: new Date(START),
      },
      {
        collection: "tickets",
        record_key: "b",
        claimed_at: null,
        claimed_by: null,
        claim_token: null,
        enqueued_at: new Date(START),
      },
    ]);
    // Under onChange: "keep" no document is touched.
    expect(fake.callsOf("updateMany")).toEqual([]);
    await connector.close();
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it("drops nothing but FacetDB's own writes and other fields: the pipeline keeps inserts, replaces and updates touching a state field, and never the document", () => {
    const [match, project] = changePipeline(["subject", "meta.lang"]);
    expect(project).toEqual({ $project: { operationType: 1, documentKey: 1 } });
    const text = JSON.stringify(match);
    for (const piece of [
      '"operationType":{"$in":["insert","replace","drop","rename","dropDatabase","invalidate"]}',
      '"$updateDescription.updatedFields"',
      '"$updateDescription.removedFields"',
      '"$updateDescription.truncatedArrays"',
      JSON.stringify({
        $regexMatch: { input: "$$path", regex: statePathPattern(["subject", "meta.lang"]) },
      }),
    ]) {
      expect(text).toContain(piece);
    }
    expect(text).not.toContain("facetdb");
  });

  // The pattern `$regexMatch` applies on the server, read the same way by JavaScript's engine.
  const touches = (fields: readonly string[], path: string) =>
    new RegExp(statePathPattern(fields)).test(path);

  it.each([
    // The field itself, inside it, and what holds it.
    ["subject", "subject"],
    ["subject", "subject.en"],
    ["meta.lang", "meta.lang"],
    ["meta.lang", "meta"],
    ["meta.lang", "meta.lang.code"],
    // Through an array: a positional $set, a $push of a whole element, a $pull's whole array, an
    // index between every segment, and the array itself replaced.
    ["items.sku", "items.0.sku"],
    ["items.sku", "items.2"],
    ["items.sku", "items"],
    ["items.sku", "items.12.sku.3"],
    ["a.b.c", "a.1.b.0.c"],
    ["a.b.c", "a.3.b"],
    ["tags", "tags.4"],
  ])("a state field %s is touched by a change of %s", (field, path) => {
    expect(touches([field], path)).toBe(true);
  });

  it.each([
    ["items.sku", "items.0.name"],
    ["items.sku", "items.name"],
    ["price", "price_usd"],
    ["price", "prices"],
    ["meta.lang", "meta.other"],
    ["meta.lang", "metadata"],
    ["subject", "facetdb.status"],
    ["subject", "facetdb"],
    ["items.sku", "facetdb.items.0.sku"],
    ["a.b", "x.a.b"],
    ["a.b", "ab"],
    ["we.ird+(field)", "weXird+(field)"],
  ])("a state field %s is not touched by a change of %s", (field, path) => {
    expect(touches([field], path)).toBe(false);
  });

  it("matches a path touching any of several fields, and none of FacetDB's own", () => {
    const fields = ["subject", "items.sku", "meta.lang"];
    for (const path of ["subject", "items.1.sku", "meta"]) {
      expect(touches(fields, path)).toBe(true);
    }
    for (const path of ["facetdb.status", "facetdb.state_hash", "facetdb.is_scam", "other"]) {
      expect(touches(fields, path)).toBe(false);
    }
  });

  it("starts a first start at the second the install ran, so changes since migrate are queued", async () => {
    const { fake, connector } = await world();
    fake.feed({ changes: [change("a", "t1", "insert")] });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect((await changes.next()).value).toEqual(["a"]);
    expect(fake.callsOf("watch")[0]?.start).toEqual({
      kind: "at",
      time: new Timestamp({ t: Math.floor(INSTALLED / 1000), i: 0 }),
    });
  });

  it("sets each changed document pending under onChange: reset, and leaves updated_at to the decision", async () => {
    const { fake, connector } = await world({ target: target({ onChange: "reset" }) });
    fake.feed({ changes: [change("a", "t1"), change(42, "t2")] });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect((await changes.next()).value).toEqual(["a", "n:42"]);
    expect(fake.callsOf("updateMany")).toEqual([
      {
        kind: "updateMany",
        collection: "tickets",
        filter: { _id: { $in: ["a", 42] } },
        update: { $set: { "facetdb.status": "pending" } },
      },
    ]);
  });

  it("says aloud a changed document it cannot key, and ends with words when the collection is dropped", async () => {
    const { fake, warnings, connector } = await world();
    fake.feed({ changes: [change(new Date(0), "t1"), change("a", "t2")] });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect((await changes.next()).value).toEqual(["a"]);
    expect(warnings).toEqual([
      "tickets: a document of app.tickets with the _id 1970-01-01T00:00:00.000Z (a Date) changed, and FacetDB cannot queue it: it keys documents by an ObjectId, a string or a number up to 2^53 as their _id",
    ]);
    fake.push({ changes: [{ _id: { _data: "t3" }, operationType: "drop" }] });
    await expect(changes.next()).rejects.toThrow(
      "app.tickets was dropped (drop), and its change stream ended: FacetDB follows one collection by name. Run facetdb migrate on the collection the source names, then start the worker again",
    );
  });

  it("stores an idle stream's high-water mark at most once a minute, so a quiet collection keeps a token inside the oplog", async () => {
    const { fake, cursors, clock, connector } = await world({ token: '{"_data":"t0"}' });
    fake.feed({ empty: true }, { empty: true });
    const changes = connector.watch()[Symbol.asyncIterator]();
    const pending = changes.next();
    const run = tokenRun(target());
    await vi.waitFor(() => expect(cursors.saved.get(run)?.cursor).toBe('{"_data":"pbrt-1"}'));
    clock.advance(TOKEN_REFRESH_MS);
    fake.push({ empty: true });
    await vi.waitFor(() => expect(cursors.saved.get(run)?.cursor).toBe('{"_data":"pbrt-3"}'));
    expect(fake.callsOf("note").map((call) => call.what)).toEqual([
      'save {"_data":"pbrt-1"}',
      'save {"_data":"pbrt-3"}',
    ]);
    await connector.close();
    await pending;
  });
});

describe("a lost resume token", () => {
  /** Three decided documents: k0 unchanged since its answer, k1 changed, k2 never answered. */
  function lostWorld(): FakeWorkerMongo {
    const fake = installed();
    const k0 = { _id: "k0", subject: "s0", body: "b" };
    const k1 = { _id: "k1", subject: "s1 edited", body: "b" };
    fake.insert(
      "tickets",
      { ...k0, facetdb: { status: "done", state_hash: hashOf(k0) } },
      { ...k1, facetdb: { status: "done", state_hash: hashOf({ ...k1, subject: "s1" }) } },
      { _id: "k2", subject: "s2", body: "b" },
    );
    return fake;
  }

  it("warns, opens a stream from a time taken first, queues exactly the documents whose state moved or that have no answer, then follows the new stream", async () => {
    const fake = lostWorld();
    const { warnings, connector } = await world({
      fake,
      token: '{"_data":"old"}',
      target: target({ onChange: "reset" }),
    });
    fake.feed({
      error: new FakeServerError(
        286,
        "ChangeStreamHistoryLost",
        "Resume of change stream was not possible, as the resume point may no longer be in the oplog.",
      ),
    });
    fake.feed({ changes: [change("k0", "n1")] });
    const changes = connector.watch()[Symbol.asyncIterator]();

    const pass: string[] = [];
    while (!pass.includes("k1") || !pass.includes("k2")) {
      pass.push(...((await changes.next()).value ?? []));
    }
    expect(pass.sort()).toEqual(["k1", "k2"]);
    expect(warnings).toEqual([
      "tickets: the change stream cannot resume from its stored point (MongoDB: Resume of change stream was not possible, as the resume point may no longer be in the oplog.), so changes made while the worker was away may be missing. FacetDB reads every document of app.tickets once and queues each whose state changed since its last answer, or that has none, then follows changes again from before that pass",
    ]);
    const [stale, fresh] = fake.callsOf("watch");
    expect(stale?.start).toEqual({ kind: "after", token: { _data: "old" } });
    expect(fresh?.start).toEqual({ kind: "at", time: fake.operationTimeIs });
    // The time is taken before the pass reads a document.
    const order = fake.calls
      .filter(
        (call) =>
          call.kind === "operationTime" || (call.kind === "find" && call.collection === "tickets"),
      )
      .map((call) => call.kind);
    expect(order[0]).toBe("operationTime");
    // Only a decided document whose state moved goes back to pending, guarded by its stored hash.
    const statuses = fake
      .documents("tickets")
      .map((document) => [
        document["_id"],
        (document["facetdb"] as { status?: string } | undefined)?.status,
      ]);
    expect(statuses).toEqual([
      ["k0", "done"],
      ["k1", "pending"],
      ["k2", undefined],
    ]);

    expect((await changes.next()).value).toEqual(["k0"]);
    expect(warnings[1]).toBe(
      "tickets: the pass over app.tickets is done: 2 of 3 documents queued to be asked again; following changes",
    );
    expect(
      fake
        .documents("facetdb_jobs")
        .map((job) => job["record_key"])
        .sort(),
    ).toEqual(["k0", "k1", "k2"]);
  });

  it("an unreadable stored point goes straight to the pass", async () => {
    const fake = lostWorld();
    const { warnings, connector } = await world({ fake, token: "not a token" });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect(((await changes.next()).value ?? []).slice().sort()).toEqual(["k1", "k2"]);
    expect(warnings[0]).toMatch(
      /^tickets: the stored resume point "not a token" is not a resume token\. FacetDB reads every document/,
    );
    expect(fake.callsOf("watch").map((call) => call.start.kind)).toEqual(["at"]);
  });

  it("a first start the oplog no longer reaches back to the install for reconciles too, in its own words", async () => {
    const fake = lostWorld();
    const { warnings, connector } = await world({ fake });
    fake.feed({
      error: new FakeServerError(286, "ChangeStreamHistoryLost", "the resume point is gone"),
    });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect(((await changes.next()).value ?? []).slice().sort()).toEqual(["k1", "k2"]);
    expect(warnings[0]).toBe(
      "tickets: the oplog no longer reaches back to the install of app.tickets at 2026-11-03T18:30:12.345Z (MongoDB: the resume point is gone), so changes made before this first start may be missing. FacetDB reads every document of app.tickets once and queues each whose state changed since its last answer, or that has none, then follows changes again from before that pass",
    );
  });

  it("throws any other error of the stream, never reconciling on it", async () => {
    const fake = lostWorld();
    const { warnings, connector } = await world({ fake, token: '{"_data":"old"}' });
    fake.feed({
      error: new FakeServerError(13, "Unauthorized", "not authorized on app to execute command"),
    });
    await expect(connector.watch()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "not authorized on app to execute command",
    );
    expect(warnings).toEqual([]);
    expect(fake.callsOf("operationTime")).toEqual([]);
  });
});

describe("the queue", () => {
  function queued(fake: FakeWorkerMongo, ...keys: string[]): void {
    for (const key of keys) {
      fake.insert("facetdb_jobs", {
        collection: "tickets",
        record_key: key,
        claimed_at: null,
        claimed_by: null,
        claim_token: null,
      });
    }
  }

  it("claims by one atomic find-and-update per job, and settles by key, owner and token, so a job a change queued again stays", async () => {
    const fake = installed();
    queued(fake, "a", "b");
    fake.insert("facetdb_jobs", { collection: "other", record_key: "x", claimed_at: null });
    const { connector } = await world({ fake });
    expect(await connector.claim(10)).toEqual(["a", "b"]);
    const [first] = fake.callsOf("findOneAndUpdate");
    expect(first?.filter).toEqual({
      collection: "tickets",
      $or: [{ claimed_at: null }, { claimed_at: { $lt: new Date(START - CLAIM_LEASE_MS) } }],
    });
    const [a, b] = fake.documents("facetdb_jobs");
    expect(a).toMatchObject({ claimed_by: "w1", claimed_at: new Date(START) });
    expect(typeof a?.["claim_token"]).toBe("string");
    expect(b?.["claim_token"]).toBe(a?.["claim_token"]);

    // A change of a's state between the read and the ack: the change path clears its claim.
    Object.assign(a ?? {}, { claimed_at: null, claimed_by: null, claim_token: null });
    await connector.ack(["a", "b"]);
    expect(fake.callsOf("deleteMany")[0]?.filter).toEqual({
      collection: "tickets",
      record_key: { $in: ["a", "b"] },
      claimed_by: "w1",
      claim_token: b?.["claim_token"],
    });
    expect(fake.documents("facetdb_jobs").map((job) => job["record_key"])).toEqual(["a", "x"]);

    expect(await connector.claim(10)).toEqual(["a"]);
    await connector.release(["a"]);
    expect(fake.documents("facetdb_jobs")[0]).toMatchObject({
      record_key: "a",
      claimed_at: null,
      claimed_by: null,
      claim_token: null,
    });
    // A key this worker does not hold is settled by nobody.
    await connector.ack(["a"]);
    expect(fake.documents("facetdb_jobs")).toHaveLength(2);
  });

  it("enqueue keeps a held claim and a queued key one job; claimKey holds only a key nobody queued", async () => {
    const fake = installed();
    const { connector } = await world({ fake });
    await connector.enqueue(["q1", "q1", "q2"]);
    expect(await connector.claim(1)).toEqual(["q1"]);
    await connector.enqueue(["q1", "q3"]);
    expect(
      fake.documents("facetdb_jobs").map((job) => [job["record_key"], job["claimed_by"]]),
    ).toEqual([
      ["q1", "w1"],
      ["q2", null],
      ["q3", null],
    ]);
    expect(await connector.claimKey("q2")).toBe(false);
    expect(await connector.claimKey("q4")).toBe(true);
    expect(fake.documents("facetdb_jobs").at(-1)).toMatchObject({
      record_key: "q4",
      claimed_by: "w1",
      claimed_at: new Date(START),
    });
    await connector.ack(["q4"]);
    expect(fake.documents("facetdb_jobs").map((job) => job["record_key"])).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  it("claims again a job whose lease ended, and the first worker's late ack leaves it", async () => {
    const fake = installed();
    queued(fake, "a");
    const clock = new FakeClock(START);
    const first = (await world({ fake, clock, workerId: "w1" })).connector;
    const second = (await world({ fake, clock, workerId: "w2" })).connector;
    expect(await first.claim(1)).toEqual(["a"]);
    expect(await second.claim(1)).toEqual([]);
    clock.advance(CLAIM_LEASE_MS + 1);
    expect(await second.claim(1)).toEqual(["a"]);
    await first.ack(["a"]);
    expect(fake.documents("facetdb_jobs")[0]?.["claimed_by"]).toBe("w2");
  });
});

describe("read, write, current and scan", () => {
  it("writes only the facetdb fields, in one transaction, while the state hash still matches", async () => {
    const fake = installed();
    fake.insert("tickets", {
      _id: new ObjectId("65f1a2b3c4d5e6f708192a3b"),
      subject: "Refund",
      body: "Twice",
      other: 1,
    });
    const { connector, clock } = await world({ fake });
    const key = "oid:65f1a2b3c4d5e6f708192a3b";
    const { rows, missing } = await connector.read([key, "n:042", "gone"]);
    expect(missing).toEqual(["n:042", "gone"]);
    const [row] = rows;
    expect(row?.state).toEqual({ subject: "Refund", body: "Twice" });
    clock.advance(60_000);
    expect(await connector.write(key, { ...decided, reviewed: true }, row?.hash ?? "")).toEqual({
      written: true,
    });
    expect(fake.callsOf("transaction")).toHaveLength(1);
    expect(fake.documents("tickets")[0]).toEqual({
      _id: new ObjectId("65f1a2b3c4d5e6f708192a3b"),
      subject: "Refund",
      body: "Twice",
      other: 1,
      facetdb: {
        not_priority: true,
        not_priority_probability: 0.93,
        status: "done",
        updated_at: new Date(START + 60_000),
        state_hash: row?.hash,
        reviewed: true,
      },
    });
    expect(await connector.write(key, decided, "stale-hash")).toEqual({ written: false });
    expect(await connector.write("n:042", decided, row?.hash ?? "")).toEqual({ written: false });
    const current = await connector.current([key, "never", "n:042"]);
    expect(current.get(key)).toEqual({
      decisions: { not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
      status: "done",
      reviewed: true,
      updatedAt: new Date(START + 60_000),
    });
    expect([...current.keys()]).toEqual([key]);
  });

  it("reads a document FacetDB never wrote as pending with nothing decided", async () => {
    const fake = installed();
    fake.insert("tickets", { _id: "t1", subject: "s" });
    const { connector } = await world({ fake });
    expect((await connector.current(["t1"])).get("t1")).toEqual({
      decisions: {},
      status: "pending",
      reviewed: false,
      updatedAt: null,
    });
    expect((await connector.read(["t1"])).rows[0]?.state).toEqual({ subject: "s", body: null });
  });

  it("scans newest first across _id types, from a cursor that survives, leaving out an _id of another type aloud", async () => {
    const fake = installed();
    const oid = new ObjectId("65f1a2b3c4d5e6f708192a3b");
    fake.insert(
      "tickets",
      { _id: 2, subject: "n2" },
      { _id: "b", subject: "b" },
      { _id: oid, subject: "o" },
      { _id: "a", subject: "a" },
      { _id: new Date(0), subject: "d" },
    );
    const { connector, warnings } = await world({ fake });
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await connector.scan(cursor);
      keys.push(...page.rows.map((row) => row.key));
      cursor = page.next;
    } while (cursor !== null);
    expect(keys).toEqual([`oid:${oid.toHexString()}`, "b", "a", "n:2"]);
    expect(warnings).toEqual([
      "tickets: app.tickets holds documents whose _id is neither an ObjectId, a string nor a number (such as 1970-01-01T00:00:00.000Z (a Date)); FacetDB leaves them out, since it keys documents by their _id",
    ]);
    await expect(connector.scan("not a cursor")).rejects.toThrow(
      '"not a cursor" is not a scan cursor of a MongoDB source',
    );
  });

  it("pages on past a page that ends on an _id with no key, never ending the pass early", async () => {
    const fake = installed();
    fake.insert(
      "tickets",
      { _id: 2 ** 61, subject: "big" },
      { _id: 2 ** 60, subject: "big" },
      { _id: 3, subject: "small" },
    );
    const { connector, warnings } = await world({ fake });
    const first = await connector.scan(null);
    expect(first.rows).toEqual([]);
    expect(first.next).toBe('{"after":{"$numberDouble":"1152921504606846976.0"}}');
    const second = await connector.scan(first.next);
    expect(second.rows.map((row) => row.key)).toEqual(["n:3"]);
    expect(second.next).toBeNull();
    expect(warnings).toHaveLength(2);
  });
});

describe("the stored resume token", () => {
  it("keeps a token's Binary a Binary through the store, as canonical Extended JSON", async () => {
    const token = { _data: "82635A", _typeBits: new Binary(Buffer.from([0x40])) };
    const text = storedText(token);
    expect(text).toBe(
      '{"_data":"82635A","_typeBits":{"$binary":{"base64":"QA==","subType":"00"}}}',
    );
    const { fake, connector } = await world({ token: text });
    fake.feed({ changes: [change("a", "t1")] });
    await connector.watch()[Symbol.asyncIterator]().next();
    const start = fake.callsOf("watch")[0]?.start;
    expect(start?.kind).toBe("after");
    const resumed = start?.kind === "after" ? start.token["_typeBits"] : undefined;
    expect(resumed).toBeInstanceOf(Binary);
    expect(storedValue(text)).toEqual(token);
  });
});

describe("open", () => {
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof EngineRefusal)) {
      throw new Error(`expected an EngineRefusal, got ${String(error)}`);
    }
    return error.refusal;
  };

  const opening = (fake: FakeWorkerMongo, on: EngineTarget, url = URL) =>
    createMongoConnector(on, url, {
      clock: new FakeClock(START),
      cursors: new Cursors(fake),
      allowInsecure: false,
      warn: () => undefined,
      connect: fake.connect,
    });

  it("refuses before connecting: a where filter, side-table storage, a password in the clear, no database", async () => {
    const fake = installed();
    expect(
      await refusal(
        opening(fake, target({ questionSet: { ...questionSet, where: "status = 'open'" } })),
      ),
    ).toMatchObject({ code: "where-unsupported" });
    expect(await refusal(opening(fake, target({ storage: "side-table" })))).toMatchObject({
      code: "side-table",
    });
    expect(
      await refusal(
        opening(fake, target(), "mongodb://facetdb_worker:pw@db.example.com/app?tls=false"),
      ),
    ).toEqual({
      code: "database-url-tls",
      message:
        "TICKETS_URL reaches db.example.com with tls=false, so the password in it would travel in the clear; no connection was made",
      fix: "remove tls=false (and ssl=false) from TICKETS_URL: FacetDB connects with TLS to any host but this machine; or pass --allow-insecure if that network is trusted",
    });
    expect(
      await refusal(opening(fake, target(), "mongodb://facetdb_worker:pw@127.0.0.1:27017")),
    ).toMatchObject({
      code: "no-database",
    });
    expect(fake.callsOf("connect")).toEqual([]);
  });

  it("refuses an install the worker cannot see, another project's, and a missing jobs collection, closing what it opened", async () => {
    expect(await refusal(opening(new FakeWorkerMongo(), target()))).toEqual({
      code: "not-installed",
      message:
        "FacetDB is not installed on app.tickets: facetdb_meta holds no marker for it, or the worker login may not read it",
      fix: "run facetdb migrate on the source first",
    });
    const theirs = new FakeWorkerMongo();
    theirs.insert("facetdb_meta", { _id: "owner:tickets", project: "proj_other" });
    expect(await refusal(opening(theirs, target()))).toMatchObject({
      code: "another-project",
      message: "app.tickets belongs to another project (proj_other)",
    });
    const noJobs = installed();
    noJobs.collections.delete("facetdb_jobs");
    expect((await refusal(opening(noJobs, target()))).message).toBe(
      "FacetDB is not installed on app.tickets: app.facetdb_jobs is missing, and the worker never makes it: made by a write it would lack the unique index that keeps one job per record",
    );
    expect(noJobs.callsOf("close")).toHaveLength(1);
    expect(
      noJobs.calls.some(
        (call) =>
          "collection" in call && call.collection === "facetdb_jobs" && call.kind !== "find",
      ),
    ).toBe(false);
  });
});
