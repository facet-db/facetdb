import type {
  BackfillProgress,
  CursorStore,
  EngineDeps,
  EngineTarget,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { type Db, Double, Long, MongoClient, type ObjectId } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { createMongoEngine } from "../engine/index.ts";
import {
  connectAdmin,
  JOBS_COLLECTION,
  META_COLLECTION,
  planInstall,
  planUninstall,
  runPlan,
  WORKER_USER,
  workerRole,
} from "../install/index.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  createMongoConnector,
  idOf,
  type MongoConnector,
  tokenRun,
} from "./index.ts";

/**
 * The runtime connector on a real MongoDB replica set, and the first run of the install on one: the
 * listings-shaped fixture is installed by the plan through the driver, as `facetdb migrate` runs it
 * (the printed mongosh lines are the same commands; mongosh itself is not needed), then the
 * connector contract suite with a peer, then what only a server proves: the pipeline keeps state
 * changes and drops FacetDB's own writes, a restart resumes from the stored token and misses
 * nothing, an invalid stored token reconciles exactly the documents that changed, a stale ack never
 * deletes the job a change queued, a backfill keeps a held claim, a lapsed lease is claimed again,
 * and doctor passes under the worker login.
 *
 * The test server runs without authentication, so it does not enforce the worker's role: the
 * worker's connection string still carries the login install created, and the driver
 * authenticates with it (a wrong password fails), so `connectionStatus` and doctor see the worker
 * and its role as a server that enforces them would. What the role forbids is proved only where
 * authentication is on (Atlas, a production replica set). The oplog of a fresh test server has
 * never been truncated, so `ChangeStreamHistoryLost` cannot be provoked per test: an invalid token
 * stored drives the same reconcile path.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const PASSWORD = "facetdb-worker-test-password";
const COLLECTION = "tickets";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: {},
};

function ticketsTarget(
  onChange: "keep" | "reset" = "keep",
  read: readonly string[] = FIELDS,
): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: COLLECTION,
    storage: "inline",
    onChange,
    questionSet: { ...questionSet, read: [...read] },
    urlVariable: "TICKETS_URL",
  };
}

function deps(clock: FakeClock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/** The store's cursors as a map: what `watch` loads and saves, and how often it saved. */
class MemoryCursors implements CursorStore {
  readonly saved = new Map<string, BackfillProgress>();
  saves = 0;

  load(run: string): Promise<BackfillProgress | undefined> {
    return Promise.resolve(this.saved.get(run));
  }

  save(run: string, progress: BackfillProgress): Promise<void> {
    this.saved.set(run, progress);
    this.saves += 1;
    return Promise.resolve();
  }
}

/** Waits until `ready` holds, polling every 20 ms, or fails naming what never came. */
async function eventually(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A connector's `watch` followed in the background: every key it yields, counted. */
class Follower {
  readonly seen = new Map<RecordKey, number>();
  readonly batches: RecordKey[][] = [];
  error: unknown;
  readonly done: Promise<void>;

  constructor(connector: MongoConnector) {
    this.done = (async () => {
      for await (const batch of connector.watch()) {
        this.batches.push([...batch]);
        for (const key of batch) {
          this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
        }
      }
    })().catch((error: unknown) => {
      this.error = error;
    });
  }

  count(key: RecordKey): number {
    return this.seen.get(key) ?? 0;
  }

  /** Until every key was yielded more often than `before` says (0 when absent). */
  async until(keys: readonly RecordKey[], before: ReadonlyMap<RecordKey, number> = new Map()) {
    await eventually(
      () => {
        if (this.error !== undefined) {
          throw this.error;
        }
        return keys.every((key) => this.count(key) > (before.get(key) ?? 0));
      },
      `watch to yield ${keys.join(", ")}`,
    );
  }

  keys(): ReadonlySet<RecordKey> {
    return new Set(this.seen.keys());
  }
}

let scratch = 0;

/** One scratch database on the server, installed by the plan, with the connectors opened on it. */
class World {
  readonly clock = new FakeClock(START);
  readonly tokens = new MemoryCursors();
  readonly warnings: string[] = [];
  readonly name: string;
  readonly urls: { readonly admin: string; readonly worker: string };
  readonly root: MongoClient;
  readonly db: Db;
  readonly opened: MongoConnector[] = [];
  readonly followers: Follower[] = [];
  readonly target: EngineTarget;

  constructor(server: string, target: EngineTarget = ticketsTarget()) {
    this.target = target;
    // A database per fixture: the suite's files run one at a time on the one shared server.
    scratch += 1;
    this.name = `facetdb_t074_${process.pid}_${scratch}`;
    const admin = new URL(server);
    admin.pathname = `/${this.name}`;
    const worker = new URL(admin);
    worker.username = WORKER_USER;
    worker.password = PASSWORD;
    this.urls = { admin: admin.toString(), worker: worker.toString() };
    this.root = new MongoClient(server);
    this.db = this.root.db(this.name);
  }

  /** A fresh database with the application's collection, and nothing of FacetDB's. */
  async reset(): Promise<void> {
    await this.drop();
    await this.db.createCollection(COLLECTION);
  }

  async drop(): Promise<void> {
    await this.db.command({ dropAllUsersFromDatabase: 1 });
    await this.db.command({ dropAllRolesFromDatabase: 1 });
    await this.db.dropDatabase();
  }

  /** `facetdb migrate`: the install plan, then its run, through the driver. */
  async install(): Promise<void> {
    const planned = await planInstall(connectAdmin, this.target, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    const result = await runPlan(connectAdmin, this.target, planned.plan, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  /** `facetdb uninstall`; nothing to do once nothing is installed. */
  async uninstall(): Promise<void> {
    const planned = await planUninstall(connectAdmin, this.target, this.urls.admin, {
      ...deps(this.clock),
      purge: false,
      alsoUninstalling: [],
    });
    if (!planned.ok) {
      if (planned.refusal.message.includes("is not installed")) {
        return;
      }
      throw new Error(`uninstall refused: ${planned.refusal.message}`);
    }
    const result = await runPlan(
      connectAdmin,
      this.target,
      planned.plan,
      this.urls.admin,
      deps(this.clock),
    );
    if (result.stopped !== undefined) {
      throw new Error(`uninstall stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async connector(
    workerId: string,
    options: { readonly scanPageSize?: number } = {},
  ): Promise<MongoConnector> {
    const connector = await createMongoConnector(this.target, this.urls.worker, {
      clock: this.clock,
      cursors: this.tokens,
      allowInsecure: false,
      warn: (line) => this.warnings.push(line),
      workerId,
      maxConnections: 4,
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(options.scanPageSize === undefined ? {} : { scanPageSize: options.scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  /** A connector whose `watch` runs in the background, as a worker's does. */
  async follower(workerId = "watcher"): Promise<Follower> {
    const follower = new Follower(await this.connector(workerId));
    this.followers.push(follower);
    return follower;
  }

  /** The application's collection, whose `_id`s are of every type a key has. */
  get tickets() {
    return this.db.collection<{
      _id?: string | number | ObjectId | Long | Double;
      [field: string]: unknown;
    }>(COLLECTION);
  }

  get jobs() {
    return this.db.collection(JOBS_COLLECTION);
  }

  /** The application's own write: inserts the document or sets its state fields. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.tickets.updateOne({ _id: idOf(key) ?? key }, { $set: state }, { upsert: true });
  }

  /** What `write` stored for `not_priority`, read with the admin's own connection. */
  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const document = await this.tickets.findOne({ _id: idOf(key) ?? key });
    const sub: unknown = document?.["facetdb"];
    if (typeof sub !== "object" || sub === null || !("updated_at" in sub)) {
      return null;
    }
    const value: unknown = Reflect.get(sub, "not_priority");
    const probability: unknown = Reflect.get(sub, "not_priority_probability");
    return {
      decisions:
        typeof value === "boolean" && typeof probability === "number"
          ? {
              not_priority: { kind: "decided", value, probabilityOrConfidence: probability },
            }
          : {},
      status: String(Reflect.get(sub, "status")) as RecordDecision["status"],
      ...(Reflect.get(sub, "reviewed") === true ? { reviewed: true as const } : {}),
    };
  }

  /** The collection's jobs: key, owner and token, by key. */
  async queue(): Promise<
    readonly { readonly key: unknown; readonly by: unknown; readonly token: unknown }[]
  > {
    const jobs = await this.jobs.find({ collection: COLLECTION }).sort({ record_key: 1 }).toArray();
    return jobs.map((job) => ({
      key: job["record_key"],
      by: job["claimed_by"],
      token: job["claim_token"],
    }));
  }

  async close(): Promise<void> {
    for (const connector of this.opened.splice(0)) {
      await connector.close();
    }
    for (const follower of this.followers.splice(0)) {
      await follower.done;
    }
    try {
      await this.drop();
    } finally {
      await this.root.close();
    }
  }
}

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

describe.skipIf(skipUnless("MONGODB_URL"))("the connector on MONGODB_URL", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const made of worlds.splice(0)) {
      await made.close();
    }
  });

  async function world(target?: EngineTarget): Promise<World> {
    const made = new World(serverUrl("MONGODB_URL"), target);
    worlds.push(made);
    await made.reset();
    return made;
  }

  describe("contract", () => {
    runConnectorContract(async () => {
      const made = await world();
      // The worker login exists only once install created it, so the fixture installs first; the
      // suite's own install is then the second, which plans nothing.
      await made.install();
      // A collection has no trigger: the queue fills from a running `watch`, as in production,
      // and an application write is done once the watcher has queued its key.
      const watcher = await made.follower();
      // Pages of 10, so the 25 seeded records cross page boundaries.
      const connector = await made.connector("w1", { scanPageSize: 10 });
      const peer = await made.connector("w2", { scanPageSize: 10 });
      return {
        connector,
        peer,
        fields: [...FIELDS],
        edit: async (key, state) => {
          const before = new Map([[key, watcher.count(key)]]);
          await made.edit(key, state);
          await watcher.until([key], before);
        },
        // MongoDB does not write `_probabilities` yet.
        probabilities: "not-yet",
        decisionOf: (key) => made.decisionOf(key),
        clock: made.clock,
      };
    });
  });

  it("installs by the plan on a real server, plans nothing the second time, logs the worker in, and uninstalls to nothing", async () => {
    const made = await world();
    await made.install();
    const again = await planInstall(connectAdmin, made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(again).toEqual({
      ok: true,
      plan: { statements: [], transactional: false, removes: [], keeps: [], notes: [] },
    });
    const worker = new MongoClient(made.urls.worker);
    try {
      const status = await worker.db(made.name).command({ connectionStatus: 1 });
      expect(status["authInfo"]).toMatchObject({
        authenticatedUsers: [{ user: WORKER_USER, db: made.name }],
        authenticatedUserRoles: [{ role: workerRole(COLLECTION), db: made.name }],
      });
    } finally {
      await worker.close();
    }
    const indexes = await made.jobs.indexes();
    expect(indexes.find((index) => index.name === "collection_1_record_key_1")).toMatchObject({
      key: { collection: 1, record_key: 1 },
      unique: true,
    });

    await made.uninstall();
    const left = (await made.db.listCollections({}, { nameOnly: true }).toArray()).map(
      (info) => info.name,
    );
    expect(left).toEqual([COLLECTION]);
    expect((await made.db.command({ rolesInfo: workerRole(COLLECTION) }))["roles"]).toEqual([]);
  });

  it("follows inserts, replaces and changes of a state field, and keeps no change FacetDB or another field made", async () => {
    const made = await world(ticketsTarget("keep", ["subject", "meta.lang"]));
    await made.install();
    await made.tickets.insertMany(
      ["a", "b", "c", "d"].map((key) => ({ _id: key, subject: key, meta: { lang: "en", n: 1 } })),
    );
    const watcher = await made.follower();
    await watcher.until(["a", "b", "c", "d"]);
    const connector = await made.connector("w1");
    const before = new Map(watcher.seen);

    // FacetDB's own writes, by hand and by `write`, and fields outside the state: none is kept.
    await made.tickets.updateOne(
      { _id: "a" },
      { $set: { "facetdb.status": "done", "facetdb.note": 1 } },
    );
    const [row] = (await connector.read(["a"])).rows;
    expect(await connector.write("a", decided, row?.hash ?? "")).toEqual({ written: true });
    await made.tickets.updateOne({ _id: "a" }, { $set: { other: 1, "meta.n": 2 } });
    await made.tickets.updateOne({ _id: "a" }, { $unset: { facetdb: "" } });
    // The sentinel: changes arrive in order, so once b is yielded every earlier one was judged.
    await made.tickets.updateOne({ _id: "b" }, { $set: { subject: "b2" } });
    await watcher.until(["b"], before);
    expect(watcher.count("a")).toBe(before.get("a"));

    // A dotted state field set, a state field removed, its parent replaced, a document replaced,
    // a document inserted: each is kept.
    const counts = new Map(watcher.seen);
    await made.tickets.updateOne({ _id: "a" }, { $set: { "meta.lang": "fr" } });
    await made.tickets.updateOne({ _id: "b" }, { $unset: { subject: "" } });
    await made.tickets.updateOne({ _id: "c" }, { $set: { meta: { lang: "de" } } });
    await made.tickets.replaceOne({ _id: "d" }, { subject: "d2" });
    await made.tickets.insertOne({ _id: "e", subject: "e" });
    await watcher.until(["a", "b", "c", "d", "e"], counts);
    expect(made.warnings).toEqual([]);
  });

  it("a first start follows from the install: a change made between migrate and the worker's first start is queued", async () => {
    const made = await world();
    await made.install();
    await made.tickets.insertOne({ _id: "early", subject: "before the worker", body: "b" });
    expect(made.tokens.saved.size).toBe(0);
    const watcher = await made.follower();
    await watcher.until(["early"]);
    expect((await made.queue()).map((job) => job.key)).toEqual(["early"]);
    expect(made.warnings).toEqual([]);
  });

  it("the worker's write sets only fields under facetdb, and leaves every state field as it was", async () => {
    const made = await world();
    await made.install();
    await made.tickets.insertOne({ _id: "t1", subject: "Refund", body: "Charged twice", other: 7 });
    const connector = await made.connector("w1");
    const [row] = (await connector.read(["t1"])).rows;
    await connector.write("t1", { ...decided, reviewed: true }, row?.hash ?? "");
    const document = await made.tickets.findOne({ _id: "t1" });
    expect(document).toEqual({
      _id: "t1",
      subject: "Refund",
      body: "Charged twice",
      other: 7,
      facetdb: {
        not_priority: false,
        not_priority_probability: 0.97,
        status: "done",
        updated_at: new Date(START),
        reviewed: true,
        state_hash: row?.hash,
      },
    });
  });

  it("a restart resumes from the stored token: ten edits made while stopped are queued, nothing before them is replayed", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    const iterator = first.watch()[Symbol.asyncIterator]();
    const untouched = ["u0", "u1", "u2", "u3", "u4"];
    const edited = Array.from({ length: 10 }, (_, index) => `e${index}`);
    await made.tickets.insertMany(
      [...untouched, ...edited].map((key) => ({ _id: key, subject: key })),
    );
    const seen = new Set<RecordKey>();
    while (![...untouched, ...edited].every((key) => seen.has(key))) {
      const next = await iterator.next();
      for (const key of next.value ?? []) {
        seen.add(key);
      }
    }
    // The token is saved once the worker asks for the next batch; the stream then waits.
    const saves = made.tokens.saves;
    const waiting = iterator.next();
    await eventually(() => made.tokens.saves > saves, "the token to be saved");
    await first.close();
    await waiting;

    await made.jobs.deleteMany({});
    for (const key of edited) {
      await made.tickets.updateOne({ _id: key }, { $set: { body: `edited ${key}` } });
    }
    const second = await made.follower("w2");
    await second.until(edited);
    expect([...second.keys()].sort()).toEqual([...edited].sort());
    expect((await made.queue()).map((job) => job.key)).toEqual([...edited].sort());
    expect(made.warnings).toEqual([]);
  });

  it("a restart resumes from a token whose _typeBits is a Binary (Long and double _ids), stored as canonical Extended JSON", async () => {
    const made = await world();
    await made.install();
    const ids = [Long.fromNumber(5), Long.fromNumber(7), new Double(2.5)];
    const first = await made.connector("w1");
    const iterator = first.watch()[Symbol.asyncIterator]();
    await made.tickets.insertMany(ids.map((_id) => ({ _id, subject: "s", body: "b" })));
    const seen = new Set<RecordKey>();
    while (!["n:5", "n:7", "n:2.5"].every((key) => seen.has(key))) {
      for (const key of (await iterator.next()).value ?? []) {
        seen.add(key);
      }
    }
    const saves = made.tokens.saves;
    const waiting = iterator.next();
    await eventually(() => made.tokens.saves > saves, "the token to be saved");
    await first.close();
    await waiting;
    // The token of the batch's last change carries the key's type bits, a Binary.
    expect(made.tokens.saved.get(tokenRun(made.target))?.cursor).toContain('"$binary"');

    await made.jobs.deleteMany({});
    await made.tickets.updateOne({ _id: new Double(2.5) }, { $set: { body: "edited" } });
    await made.tickets.updateOne({ _id: Long.fromNumber(5) }, { $set: { subject: "edited" } });
    const second = await made.follower("w2");
    await second.until(["n:2.5", "n:5"]);
    expect([...second.keys()].sort()).toEqual(["n:2.5", "n:5"]);
    expect(made.warnings).toEqual([]);
  });

  it("a positional $set and a $push on an array of subdocuments read as state each queue the record, and move its hash", async () => {
    const made = await world(ticketsTarget("keep", ["subject", "items.sku"]));
    await made.install();
    await made.tickets.insertMany([
      { _id: "set", subject: "s", items: [{ sku: "a", name: "x" }, { sku: "b" }] },
      { _id: "push", subject: "s", items: [{ sku: "a" }] },
      { _id: "other", subject: "s", items: [{ sku: "a", name: "x" }] },
    ]);
    const watcher = await made.follower();
    await watcher.until(["set", "push", "other"]);
    const connector = await made.connector("w1");
    const before = await connector.read(["set", "push", "other"]);
    const counts = new Map(watcher.seen);

    // A field of an element outside the state: dropped (the sentinel below proves it was judged).
    await made.tickets.updateOne({ _id: "other" }, { $set: { "items.0.name": "y" } });
    await made.tickets.updateOne({ _id: "set" }, { $set: { "items.0.sku": "changed" } });
    await made.db
      .collection<{ _id: string; items: { sku: string }[] }>(COLLECTION)
      .updateOne({ _id: "push" }, { $push: { items: { sku: "pushed" } } });
    await watcher.until(["set", "push"], counts);
    expect(watcher.count("other")).toBe(counts.get("other"));

    const after = await connector.read(["set", "push", "other"]);
    const hashes = (result: typeof before) =>
      Object.fromEntries(result.rows.map((row) => [row.key, row.hash]));
    expect(hashes(after)["set"]).not.toBe(hashes(before)["set"]);
    expect(hashes(after)["push"]).not.toBe(hashes(before)["push"]);
    expect(hashes(after)["other"]).toBe(hashes(before)["other"]);
    expect(after.rows.find((row) => row.key === "push")?.state["items.sku"]).toBe('["a","pushed"]');
  });

  it("an invalid stored token: a warning, then exactly the documents changed meanwhile are queued, then changes are followed again", async () => {
    const made = await world(ticketsTarget("reset"));
    await made.install();
    const keys = ["k0", "k1", "k2", "k3", "k4", "k5"];
    await made.tickets.insertMany(keys.map((key) => ({ _id: key, subject: key, body: "b" })));
    const connector = await made.connector("w1");
    const { rows } = await connector.read(keys);
    for (const row of rows) {
      expect(await connector.write(row.key, decided, row.hash)).toEqual({ written: true });
    }
    await made.jobs.deleteMany({});
    // While the worker is away: three state changes, a field outside the state, FacetDB's own.
    for (const key of ["k1", "k3", "k5"]) {
      await made.tickets.updateOne({ _id: key }, { $set: { subject: `${key} edited` } });
    }
    await made.tickets.updateOne({ _id: "k0" }, { $set: { other: 1 } });
    await made.tickets.updateOne({ _id: "k2" }, { $set: { "facetdb.reviewed": true } });
    await made.tokens.save(tokenRun(made.target), {
      cursor: JSON.stringify({ _data: "00" }),
      done: false,
    });

    const watcher = await made.follower("w2");
    await watcher.until(["k1", "k3", "k5"]);
    await eventually(() => made.warnings.length >= 2, "the reconcile's closing line");
    expect(made.warnings[0]).toMatch(
      /^tickets: the change stream cannot resume from its stored point \(MongoDB: .+\), so changes made while the worker was away may be missing\. FacetDB reads every document of facetdb_t074_\d+_\d+\.tickets once/,
    );
    expect(made.warnings[1]).toMatch(
      /3 of 6 documents queued to be asked again; following changes$/,
    );
    expect((await made.queue()).map((job) => job.key)).toEqual(["k1", "k3", "k5"]);
    const statuses = await made.tickets
      .find({}, { projection: { "facetdb.status": 1 } })
      .sort({ _id: 1 })
      .toArray();
    const statusOf = (sub: unknown) =>
      typeof sub === "object" && sub !== null ? Reflect.get(sub, "status") : undefined;
    expect(statuses.map((document) => [document._id, statusOf(document["facetdb"])])).toEqual([
      ["k0", "done"],
      ["k1", "pending"],
      ["k2", "done"],
      ["k3", "pending"],
      ["k4", "done"],
      ["k5", "pending"],
    ]);

    // The new stream started before the pass: a change now is followed.
    const before = new Map(watcher.seen);
    await made.tickets.updateOne({ _id: "k4" }, { $set: { body: "late" } });
    await watcher.until(["k4"], before);
  });

  it("an ack from a batch read before a change never deletes the job that change queued", async () => {
    const made = await world();
    await made.install();
    const watcher = await made.follower();
    await made.edit("t1", { subject: "s", body: "b" });
    await watcher.until(["t1"]);
    const connector = await made.connector("w1");
    expect(await connector.claim(10)).toEqual(["t1"]);
    const before = new Map(watcher.seen);
    await made.edit("t1", { subject: "changed", body: "b" });
    await watcher.until(["t1"], before);
    await connector.ack(["t1"]);
    expect(await made.queue()).toEqual([{ key: "t1", by: null, token: null }]);
    expect(await connector.claim(10)).toEqual(["t1"]);
  });

  it("a backfill's enqueue keeps a held claim, and claimKey is false for a held key", async () => {
    const made = await world();
    await made.install();
    const holder = await made.connector("w1");
    const backfill = await made.connector("w2");
    await holder.enqueue(["t1"]);
    expect(await holder.claim(10)).toEqual(["t1"]);
    await backfill.enqueue(["t1", "t2"]);
    expect((await made.queue()).map((job) => [job.key, job.by])).toEqual([
      ["t1", "w1"],
      ["t2", null],
    ]);
    expect(await backfill.claimKey("t1")).toBe(false);
    expect(await backfill.claim(10)).toEqual(["t2"]);
  });

  it("a claim whose lease ended is claimed again, and the first worker's late ack leaves it", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    const second = await made.connector("w2");
    await first.enqueue(["t1"]);
    expect(await first.claim(1)).toEqual(["t1"]);
    expect(await second.claim(1)).toEqual([]);
    made.clock.advance(CLAIM_LEASE_MS + 1);
    expect(await second.claim(1)).toEqual(["t1"]);
    await first.ack(["t1"]);
    expect((await made.queue()).map((job) => job.by)).toEqual(["w2"]);
    await second.ack(["t1"]);
    expect(await made.queue()).toEqual([]);
  });

  it("keys keep their _id's type: an ObjectId and a number read back as themselves, a tag-like string escaped", async () => {
    const made = await world();
    await made.install();
    const inserted = await made.tickets.insertOne({ subject: "oid", body: "b" });
    await made.tickets.insertMany([
      { _id: 42, subject: "number", body: "b" },
      { _id: "n:42", subject: "string", body: "b" },
    ]);
    const connector = await made.connector("w1");
    const oid = `oid:${String(inserted.insertedId)}`;
    const { rows, missing } = await connector.read([oid, "n:42", "s:n:42", "n:042", "s:42"]);
    expect(rows.map((row) => [row.key, row.state["subject"]])).toEqual([
      [oid, "oid"],
      ["n:42", "number"],
      ["s:n:42", "string"],
    ]);
    expect(missing).toEqual(["n:042", "s:42"]);
    const page = await connector.scan(null);
    expect(page.rows.map((row) => row.key)).toEqual([oid, "s:n:42", "n:42"]);
  });

  it("doctor passes under the worker login, and fails a connection string that logs in as nobody", async () => {
    const made = await world();
    await made.install();
    const engine = createMongoEngine({ warn: (line) => made.warnings.push(line) });
    const checks = await engine.doctor(made.target, made.urls.worker, deps(made.clock));
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(checks.filter((check) => check.status !== "warn").map((check) => check.name)).toEqual([
      "database",
      "version",
      "replica-set",
      "login",
      "capture",
      "install",
      "oplog",
      "queue",
    ]);
    const nobody = await engine.doctor(made.target, made.urls.admin, deps(made.clock));
    expect(nobody[0]).toMatchObject({
      name: "database",
      status: "fail",
      fix: `set TICKETS_URL to the worker login: mongodb://facetdb_worker:<the worker password>@<host>/${made.name}`,
    });
  });

  it("refuses to open on a collection FacetDB is not installed on, and never makes the jobs collection", async () => {
    const made = await world();
    // No login exists before install: the admin's connection string opens it.
    const opening = createMongoConnector(made.target, made.urls.admin, {
      clock: made.clock,
      cursors: made.tokens,
      allowInsecure: false,
      warn: (line) => made.warnings.push(line),
    });
    await expect(opening).rejects.toThrow(
      `FacetDB is not installed on ${made.name}.tickets: ${META_COLLECTION} holds no marker for it`,
    );
    expect((await made.db.listCollections({ name: JOBS_COLLECTION }).toArray()).length).toBe(0);
  });
});
