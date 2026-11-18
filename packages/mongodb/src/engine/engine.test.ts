import type {
  BackfillProgress,
  CursorStore,
  DoctorCheck,
  EngineDeps,
  EngineTarget,
  QuestionSet,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { MONGO_CAPABILITIES, tokenRun } from "../connector/index.ts";
import { FakeServerError, FakeWorkerMongo } from "../testing/index.ts";
import { createMongoEngine, DOCTOR_CHECKS, ENGINE_NAME, type OpenCursors } from "./index.ts";

/**
 * The MongoDB engine over fakes: what it declares, the store's cursors opened only when `watch`
 * runs and closed with the connector, and doctor's checks under the worker login: passing, what the
 * worker may not read said with who can, and each failure with its fix.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const URL = "mongodb://facetdb_worker:pw@127.0.0.1:27017/app";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: ["subject", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: EngineTarget = {
  project: { id: "proj_tickets", name: "Tickets" },
  source: "tickets",
  table: "tickets",
  storage: "inline",
  onChange: "keep",
  questionSet,
  urlVariable: "TICKETS_URL",
};

const deps: EngineDeps = { clock: new FakeClock(START), allowInsecure: false, storeShared: false };

const RIGHTS = [
  { resource: { db: "app", collection: "tickets" }, actions: ["find", "update", "changeStream"] },
  {
    resource: { db: "app", collection: "facetdb_jobs" },
    actions: ["find", "insert", "update", "remove"],
  },
  { resource: { db: "app", collection: "facetdb_meta" }, actions: ["find"] },
];

/** A replica set member with the install, the worker logged in with its role. */
function installed(): FakeWorkerMongo {
  const fake = new FakeWorkerMongo();
  fake.insert("facetdb_meta", {
    _id: "owner:tickets",
    project: "proj_tickets",
    installedAt: new Date(START - 3_600_000),
  });
  fake.insert("facetdb_jobs", { collection: "tickets", record_key: "a", claimed_at: null });
  fake.insert("facetdb_jobs", {
    collection: "tickets",
    record_key: "b",
    claimed_at: new Date(START),
  });
  fake.documents("tickets");
  fake.insert(
    "oplog.rs",
    { ts: new Timestamp({ t: 1_800_000_000, i: 1 }) },
    { ts: new Timestamp({ t: 1_800_000_000 + 30 * 3600, i: 4 }) },
  );
  fake.replies.set("connectionStatus", {
    authInfo: {
      authenticatedUsers: [{ user: "facetdb_worker", db: "app" }],
      authenticatedUserRoles: [{ role: "facetdb_worker_tickets", db: "app" }],
      authenticatedUserPrivileges: RIGHTS,
    },
    ok: 1,
  });
  fake.replies.set("ping", { ok: 1 });
  fake.replies.set("buildInfo", { version: "7.0.45", ok: 1 });
  fake.replies.set("listIndexes facetdb_jobs", {
    cursor: {
      firstBatch: [
        { name: "_id_", key: { _id: 1 } },
        { name: "collection_1_record_key_1", key: { collection: 1, record_key: 1 }, unique: true },
        { name: "collection_1_claimed_at_1", key: { collection: 1, claimed_at: 1 } },
      ],
      id: 0,
    },
    ok: 1,
  });
  return fake;
}

const unauthorized = (what: string) =>
  new FakeServerError(13, "Unauthorized", `not authorized on ${what} to execute command`);

const summary = (checks: readonly DoctorCheck[]) =>
  checks.map((check) => `${check.status} ${check.name}: ${check.detail}`);

describe("the MongoDB engine", () => {
  it("names itself, its schemes, its capabilities and its checks", () => {
    const engine = createMongoEngine();
    expect(engine.name).toBe(ENGINE_NAME);
    expect(engine.schemes).toEqual(["mongodb", "mongodb+srv"]);
    // The collection in the connection string's database unless the config names one, as the plans
    // name it; a replica set's several hosts read too; no database leaves it bare.
    expect(engine.label(target, URL)).toBe("app.tickets");
    expect(engine.label({ ...target, schema: "support" }, URL)).toBe("support.tickets");
    expect(engine.label(target, "mongodb://a:27017,b:27017/shop?replicaSet=rs0")).toBe(
      "shop.tickets",
    );
    expect(engine.label(target, "mongodb://127.0.0.1:27017/")).toBe("tickets");
    expect(engine.capabilities).toEqual(MONGO_CAPABILITIES);
    expect(engine.capabilities).toMatchObject({
      pushWakeup: true,
      multipleWorkers: true,
      sideTable: false,
    });
    expect(engine.checks.map((check) => check.name)).toEqual([
      "database",
      "version",
      "replica-set",
      "login",
      "install",
      "oplog",
      "queue",
    ]);
    expect(
      engine.checkUrl(target, "mongodb://u:p@db.example.com/app?tls=false", deps),
    ).toMatchObject({
      code: "database-url-tls",
    });
    expect(
      engine.checkUrl(target, "mongodb+srv://u:p@cluster0.example.net/app", deps),
    ).toBeUndefined();
  });

  it("reads the login of a replica set's several-host string, which new URL refuses", () => {
    const engine = createMongoEngine();
    const replicaSet =
      "mongodb://facetdb_worker:p%40ss@a.example.com:27017,b.example.com:27017/app";
    expect(globalThis.URL.canParse(replicaSet)).toBe(false);
    expect(engine.login?.(replicaSet)).toEqual({ user: "facetdb_worker", password: "p@ss" });
    expect(engine.login?.("mongodb+srv://cluster0.example.net/app")).toEqual({
      user: "",
      password: "",
    });
    expect(engine.login?.("mongodb://a@evil.example.com@127.0.0.1/app")).toBeUndefined();
  });

  it("opens the store's cursors only when watch runs, and closes them with the connector", async () => {
    const fake = installed();
    const saved = new Map<string, BackfillProgress>([
      [tokenRun(target), { cursor: '{"_data":"t0"}', done: false }],
    ]);
    const events: string[] = [];
    const cursors: OpenCursors = ({ allowInsecure }) => {
      events.push(`open ${allowInsecure}`);
      const store: CursorStore = {
        load: (run) => Promise.resolve(saved.get(run)),
        save: (run, progress) => {
          saved.set(run, progress);
          return Promise.resolve();
        },
      };
      return Promise.resolve({
        cursors: store,
        close: () => {
          events.push("close");
          return Promise.resolve();
        },
      });
    };
    const engine = createMongoEngine({ worker: fake.connect, cursors, warn: () => undefined });
    const quiet = await engine.open(target, URL, deps);
    await quiet.scan(null);
    await quiet.close();
    expect(events).toEqual([]);

    fake.feed({
      changes: [{ _id: { _data: "t1" }, operationType: "insert", documentKey: { _id: "a" } }],
    });
    const connector = await engine.open(target, URL, {
      ...deps,
      workerId: "w1",
      maxConnections: 10,
    });
    const changes = connector.watch()[Symbol.asyncIterator]();
    expect((await changes.next()).value).toEqual(["a"]);
    expect(fake.callsOf("watch")[0]?.start).toEqual({ kind: "after", token: { _data: "t0" } });
    await connector.close();
    expect(events).toEqual(["open false", "close"]);
  });

  it("refuses watch in words when it was made without the store's cursors", async () => {
    const engine = createMongoEngine({ worker: installed().connect });
    const connector = await engine.open(target, URL, deps);
    await expect(connector.watch()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "this MongoDB engine was made without the store's cursors, where the change stream's resume token lives",
    );
    await connector.close();
  });
});

describe("doctor", () => {
  it("passes an installed replica set member under the worker login", async () => {
    const fake = installed();
    const checks = await createMongoEngine({ worker: fake.connect }).doctor(target, URL, deps);
    expect(summary(checks)).toEqual([
      'ok database: "tickets": connected to 127.0.0.1:27017/app as facetdb_worker@app without TLS (a server on this machine, or --allow-insecure), 0 ms per round trip',
      "ok version: MongoDB 7.0.45",
      "ok replica-set: a member of the replica set rs0",
      "ok login: facetdb_worker holds facetdb_worker_tickets@app, with every right it needs: find, update and changeStream on app.tickets; find, insert, update and remove on app.facetdb_jobs; and find on app.facetdb_meta",
      "ok install: the marker of project proj_tickets on app.tickets, facetdb_jobs and its 2 indexes are there",
      "ok oplog: the oplog holds 30 hours of changes: a worker stopped longer than that resumes with one full pass over app.tickets, queuing every document whose state changed since its last answer and every document never answered, unpaced and with no cost estimate first",
      "ok queue: 1 job waits for tickets, 1 is claimed (a claim lapses after 15 minutes)",
    ]);
    expect(
      fake.calls.filter(
        (call) => call.kind !== "command" && call.kind !== "connect" && call.kind !== "close",
      ),
    ).toEqual([]);
  });

  it("says who checks what the worker's role may not read: the jobs indexes and the oplog", async () => {
    const fake = installed();
    fake.replies.set("listIndexes facetdb_jobs", unauthorized("app"));
    fake.replies.set("find oplog.rs", unauthorized("local"));
    const checks = await createMongoEngine({ worker: fake.connect }).doctor(target, URL, deps);
    expect(checks.find((check) => check.name === "install")?.detail).toBe(
      "the marker of project proj_tickets on app.tickets and facetdb_jobs are there; the worker login may not list facetdb_jobs's indexes, which facetdb migrate --dry-run with the admin connection string checks (it plans nothing when they are as installed)",
    );
    expect(checks.find((check) => check.name === "oplog")).toEqual({
      name: "oplog",
      status: "warn",
      detail:
        "the worker login may not read local.oplog.rs, so doctor cannot say how long the worker may stop before its restart reconciles with a full pass; an admin sees the window with rs.printReplicationInfo() in mongosh",
    });
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("fails a standalone server, a login that is not the worker's, missing rights and a missing unique index, each with its fix", async () => {
    const standalone = installed();
    standalone.hello = { isWritablePrimary: true, ok: 1 };
    const alone = await createMongoEngine({ worker: standalone.connect }).doctor(target, URL, deps);
    expect(alone.find((check) => check.name === "replica-set")).toMatchObject({
      status: "fail",
      fix: expect.stringContaining("mongod --replSet rs0"),
    });
    expect(alone.find((check) => check.name === "oplog")?.status).toBe("skip");

    const admin = installed();
    admin.replies.set("connectionStatus", {
      authInfo: {
        authenticatedUsers: [],
        authenticatedUserRoles: [],
        authenticatedUserPrivileges: [],
      },
      ok: 1,
    });
    const nobody = await createMongoEngine({ worker: admin.connect }).doctor(target, URL, deps);
    expect(nobody[0]).toEqual({
      name: "database",
      status: "fail",
      detail:
        '"tickets": TICKETS_URL logs in to 127.0.0.1:27017/app as no user, not facetdb_worker',
      fix: "set TICKETS_URL to the worker login: mongodb://facetdb_worker:<the worker password>@<host>/app",
    });
    expect(nobody.slice(1).every((check) => check.status === "skip")).toBe(true);

    const partial = installed();
    partial.replies.set("connectionStatus", {
      authInfo: {
        authenticatedUsers: [{ user: "facetdb_worker", db: "app" }],
        authenticatedUserRoles: [],
        authenticatedUserPrivileges: RIGHTS.slice(0, 1),
      },
      ok: 1,
    });
    partial.replies.set("listIndexes facetdb_jobs", {
      cursor: {
        firstBatch: [{ name: "collection_1_record_key_1", key: { collection: 1, record_key: 1 } }],
        id: 0,
      },
      ok: 1,
    });
    const lacking = await createMongoEngine({ worker: partial.connect }).doctor(target, URL, deps);
    expect(lacking.find((check) => check.name === "login")).toMatchObject({
      status: "fail",
      detail:
        "facetdb_worker lacks find on app.facetdb_jobs, insert on app.facetdb_jobs, update on app.facetdb_jobs, remove on app.facetdb_jobs, find on app.facetdb_meta",
    });
    expect(lacking.find((check) => check.name === "install")).toMatchObject({
      status: "fail",
      detail:
        "app.facetdb_jobs lacks collection_1_record_key_1 (unique: without it a record changed twice before the worker comes is queued twice), collection_1_claimed_at_1",
      fix: "run facetdb migrate: it makes the missing indexes",
    });
  });

  it("fails a server it cannot reach, a plaintext string and a check that throws, never throwing itself", async () => {
    const down = installed();
    down.replies.set("connectionStatus", new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    const unreachable = await createMongoEngine({ worker: down.connect }).doctor(target, URL, deps);
    expect(unreachable[0]).toMatchObject({
      name: "database",
      status: "fail",
      detail:
        '"tickets": 127.0.0.1:27017/app could not be reached as the worker login: connect ECONNREFUSED 127.0.0.1:27017',
    });
    expect(unreachable).toHaveLength(DOCTOR_CHECKS.length);

    const plaintext = await createMongoEngine({ worker: down.connect }).doctor(
      target,
      "mongodb://facetdb_worker:pw@db.example.com/app?tls=false",
      deps,
    );
    expect(plaintext[0]).toMatchObject({ name: "database", status: "fail" });
    expect(plaintext[0]?.detail).not.toContain("pw@");

    const broken = installed();
    broken.replies.set("count facetdb_jobs", new Error("interrupted"));
    const thrown = await createMongoEngine({ worker: broken.connect }).doctor(target, URL, deps);
    expect(thrown.at(-1)).toMatchObject({
      name: "queue",
      status: "fail",
      detail:
        '"tickets": the queue check on 127.0.0.1:27017/app failed as the worker login: interrupted',
    });
  });
});
