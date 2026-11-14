// Through the package's own `./testing` export, as the CLI's tests import the fake.
import { FakeClock, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DoctorCheck,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
  type RecordDecision,
  type Refusal,
  type RunResult,
} from "./index.ts";

/**
 * The engine contract's types are plain data a CLI can print, compare and send as `--json`, and the
 * fake engine the CLI's tests use behaves as the contract says a real one does.
 */

const ADMIN_URL = "fake://admin@db.example.com/app?tls=true";
const WORKER_URL = "fake://facetdb_worker@db.example.com/app?tls=true";
const PASSWORD = "a-long-random-password";
/** A Postgres source whose database is also the store: its plans hold the store's part too. */
const shared = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
/** Any other source: its plans hold the source's part only. */
const separate = { ...shared, storeShared: false };

const target: EngineTarget = {
  project: { id: "proj_listings", name: "Listings" },
  source: "listings",
  table: "listings",
  schema: "public",
  storage: "inline",
  onChange: "reset",
  questionSet: {
    questions: [
      { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
    ],
    read: ["title", "description"],
    model: "jev-1.14.0",
    thresholds: {},
  },
};

/**
 * An install as a Postgres source sharing its database with the store plans it, abridged: the
 * `facetdb` schema is the source's whatever the store, the log's table is the store's.
 */
const install: EnginePlan = {
  statements: [
    { database: "source", purpose: "schema", text: 'create schema if not exists "facetdb"' },
    {
      database: "store",
      purpose: "schema",
      text: "create table if not exists facetdb.decisions (id bigserial primary key)",
    },
    {
      database: "source",
      purpose: "columns",
      text: 'alter table "public"."listings" add column if not exists "is_scam" boolean',
    },
    {
      database: "source",
      purpose: "login",
      text: "-- the worker password: set by `facetdb migrate` for the transaction, never printed",
      secret: true,
    },
    {
      database: "source",
      purpose: "grants",
      text: 'grant update ("is_scam") on "public"."listings" to "facetdb_worker"',
    },
  ],
  transactional: true,
  removes: [],
  keeps: [
    {
      kind: "column",
      name: "category_probabilities",
      of: "public.listings",
      scope: "source",
      reason: "storeProbabilities is off",
    },
  ],
  notes: ["the store's sources are rekeyed to <project>:<name>"],
};

/** The first table's uninstall of a two-table purge on that database: its own objects and the run's. */
const uninstall: EnginePlan = {
  statements: [
    {
      database: "source",
      purpose: "capture",
      text: 'drop trigger if exists "facetdb_listings" on "public"."listings"',
    },
    {
      database: "source",
      purpose: "columns",
      text: 'alter table "public"."listings" drop column "is_scam"',
    },
    {
      database: "store",
      purpose: "data",
      text: "delete from facetdb.decisions where source_id = 'proj_listings:listings'",
    },
  ],
  transactional: true,
  removes: [
    { kind: "trigger", name: "facetdb_listings", of: "public.listings", scope: "source" },
    { kind: "column", name: "is_scam", of: "public.listings", scope: "source" },
    { kind: "jobs-table", name: "facetdb.jobs", of: "public.listings", scope: "source", count: 3 },
    { kind: "grant", name: "facetdb_worker", of: "public.listings", scope: "source" },
    { kind: "log", name: "facetdb.decisions", of: "listings", scope: "source", count: 1240 },
    {
      kind: "log",
      name: "facetdb.question_set_versions",
      of: "listings",
      scope: "source",
      count: 2,
    },
    {
      kind: "function",
      name: "facetdb.enqueue",
      scope: "run",
      reason: "no trigger uses them any more",
    },
    { kind: "grant", name: "facetdb_worker", of: "public", scope: "run" },
  ],
  keeps: [
    {
      kind: "login",
      name: "facetdb_worker",
      scope: "run",
      reason: "every project on the server may share it",
    },
    {
      kind: "store-table",
      name: "facetdb.usage",
      scope: "run",
      reason: "project proj_other remains",
    },
  ],
  notes: ["the purge deletes the decision log of source listings"],
  confirm: { kind: "project", name: "Listings" },
};

/** A MySQL install: one statement at a time, the source's part only, whatever the store. */
const mysqlInstall: EnginePlan = {
  statements: [
    {
      database: "source",
      purpose: "columns",
      text: "alter table `listings` add column `is_scam` boolean",
    },
    {
      database: "source",
      purpose: "queue",
      text: "create table if not exists `facetdb_jobs` (record_key varchar(255) primary key)",
    },
    {
      database: "source",
      purpose: "capture",
      text: "create trigger `facetdb_listings_ins` before insert on `listings` for each row set new.facetdb_status = 'pending'",
    },
  ],
  transactional: false,
  removes: [],
  keeps: [],
  notes: ["MySQL commits each statement: if the run stops, run facetdb migrate again to finish"],
};

const noKey: Refusal = {
  code: "no-primary-key",
  message: "public.listings has no primary key; FacetDB keys its jobs and decisions by it.",
  fix: "add a primary key to public.listings, then run facetdb migrate again",
};

const decided: RecordDecision = {
  decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.12 } },
  status: "done",
};

const ok = (plan: EnginePlan): PlanResult => ({ ok: true, plan });

describe("the engine contract's types", () => {
  it("round-trip through JSON: plans, refusals, run results and doctor checks are plain data", () => {
    const results: readonly PlanResult[] = [
      ok(install),
      ok(uninstall),
      ok(mysqlInstall),
      { ok: false, refusal: noKey },
    ];
    const runs: readonly RunResult[] = [
      { ran: install.statements, removed: [], notes: [] },
      { ran: [], stopped: { at: 2, refusal: noKey }, removed: [], notes: [] },
      {
        ran: mysqlInstall.statements.slice(0, 1),
        stopped: { at: 1, error: 'column "is_scam" is used by view listings_report' },
        removed: [],
        notes: [],
      },
    ];
    const checks: readonly DoctorCheck[] = [
      { name: "database", status: "ok", detail: "logged in as facetdb_worker (round trip 3 ms)" },
      { name: "distance", status: "warn", detail: "the database is 190 ms away" },
      {
        name: "install",
        status: "fail",
        detail: "public.listings has no trigger facetdb_listings",
        fix: "run facetdb migrate",
      },
      { name: "pooler", status: "skip", detail: "not checked: the database check did not pass" },
    ];

    for (const value of [...results, ...runs, checks]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it("a refusal carries no statements, so nothing can be run from it", async () => {
    const engine = new FakeEngine({ plans: { install: () => ({ ok: false, refusal: noKey }) } });

    const result = await engine.planInstall(target, ADMIN_URL, shared);

    expect(result).toEqual({ ok: false, refusal: noKey });
    expect(Object.keys(result)).toEqual(["ok", "refusal"]);
    expectTypeOf<Extract<PlanResult, { ok: false }>>().not.toHaveProperty("plan");
    // @ts-expect-error a refusal never carries a plan beside it
    const both: PlanResult = { ok: false, refusal: noKey, plan: install };
    expect(both.ok).toBe(false);
  });
});

describe("the fake engine", () => {
  it("runs a plan's statements in order, records the run, and keeps no password", async () => {
    const engine = new FakeEngine({ plans: { install: () => ok(install) } });
    const result = await engine.planInstall(target, ADMIN_URL, {
      ...shared,
      workerPassword: PASSWORD,
    });
    if (!result.ok) {
      throw new Error("the install fixture is a plan");
    }

    const ran = await engine.run(target, result.plan, ADMIN_URL, {
      ...shared,
      workerPassword: PASSWORD,
    });

    expect(ran).toEqual({ ran: install.statements, removed: [], notes: install.notes });
    expect(engine.runs).toEqual([
      { source: "listings", url: ADMIN_URL, statements: install.statements, workerPassword: true },
    ]);
    expect(engine.runs[0]?.statements.map((statement) => statement.purpose)).toEqual([
      "schema",
      "schema",
      "columns",
      "login",
      "grants",
    ]);
    expect(JSON.stringify([result, ran, engine.runs])).not.toContain(PASSWORD);
    expect(engine.render(result.plan)).toBe(
      [
        "begin;",
        'create schema if not exists "facetdb";',
        "create table if not exists facetdb.decisions (id bigserial primary key);",
        'alter table "public"."listings" add column if not exists "is_scam" boolean;',
        "-- the worker password: set by `facetdb migrate` for the transaction, never printed;",
        'grant update ("is_scam") on "public"."listings" to "facetdb_worker";',
        "commit;",
        "",
      ].join("\n"),
    );
    expect(engine.render({ ...install, statements: [] })).toBe("");
  });

  it("says where a run stopped and removes nothing: a transaction keeps nothing, else what ran stays", async () => {
    // Listings is the first table of a two-table uninstall: its run is not the run's last.
    const engine = new FakeEngine({ lastOfRun: (run) => run.source !== "listings" });
    const error = "permission denied for table listings";

    engine.stopNextRunAt(1, { error });
    const rolledBack = await engine.run(target, install, ADMIN_URL, {
      ...shared,
      workerPassword: PASSWORD,
    });
    expect(rolledBack).toEqual({ ran: [], stopped: { at: 1, error }, removed: [], notes: [] });
    expect(engine.runs[0]?.statements).toEqual(install.statements.slice(0, 2));

    const claimed: Refusal = {
      code: "another-project",
      message: "public.listings already carries FacetDB columns from another project (proj_other).",
      fix: "uninstall there first, or point this project at another table",
    };
    engine.stopNextRunAt(2, { refusal: claimed });
    const partial = await engine.run(target, mysqlInstall, ADMIN_URL, separate);
    expect(partial).toEqual({
      ran: mysqlInstall.statements.slice(0, 2),
      stopped: { at: 2, refusal: claimed },
      removed: [],
      notes: [],
    });

    // A stop is for one run: the next one finishes, and reports the first table's own objects.
    const again = await engine.run(target, uninstall, ADMIN_URL, shared);
    expect(again).toEqual({
      ran: uninstall.statements,
      removed: uninstall.removes.filter((object) => object.scope === "source"),
      notes: uninstall.notes,
    });
  });

  it("reports the run's shared objects from the last table's run only", async () => {
    const orders: EngineTarget = { ...target, source: "orders", table: "orders" };
    const last: EnginePlan = {
      ...uninstall,
      removes: [
        { kind: "trigger", name: "facetdb_orders", of: "public.orders", scope: "source" },
        { kind: "function", name: "facetdb.enqueue", scope: "run", reason: "no trigger uses it" },
        { kind: "schema", name: "facetdb", scope: "run", reason: "now empty" },
      ],
    };
    const engine = new FakeEngine({ lastOfRun: (run) => run.source === "orders" });

    const first = await engine.run(target, uninstall, ADMIN_URL, shared);
    const second = await engine.run(orders, last, ADMIN_URL, shared);

    expect(first.removed.map((object) => object.scope)).toEqual([
      "source",
      "source",
      "source",
      "source",
      "source",
      "source",
    ]);
    expect(second.removed).toEqual(last.removes);
  });

  it("stops at a secret statement when the run was given no password, as a real engine does", async () => {
    const engine = new FakeEngine();

    const result = await engine.run(target, install, ADMIN_URL, shared);

    expect(result.ran).toEqual([]);
    expect(result.stopped).toEqual({
      at: 3,
      refusal: expect.objectContaining({ code: "worker-password" }),
    });
    expect(engine.runs).toEqual([
      {
        source: "listings",
        url: ADMIN_URL,
        statements: install.statements.slice(0, 4),
        workerPassword: false,
      },
    ]);
  });

  it("reports the run's own notes when the fixture gives them (deleted, where the plan said deletes)", async () => {
    const engine = new FakeEngine({
      runNotes: () => ["the purge deleted the decision log of source listings"],
    });

    const result = await engine.run(target, uninstall, ADMIN_URL, shared);

    expect(result.notes).toEqual(["the purge deleted the decision log of source listings"]);
  });

  it("refuses a fixture that plans the store while the store is not shared, as no engine may", async () => {
    const engine = new FakeEngine({
      plans: { install: (_target, options) => ok(options.storeShared ? install : mysqlInstall) },
    });
    const storeWithoutSharing = new FakeEngine({ plans: { uninstall: () => ok(uninstall) } });

    expect(await engine.planInstall(target, ADMIN_URL, shared)).toEqual(ok(install));
    expect(await engine.planInstall(target, ADMIN_URL, separate)).toEqual(ok(mysqlInstall));
    await expect(
      storeWithoutSharing.planUninstall(target, ADMIN_URL, {
        ...separate,
        purge: true,
        alsoUninstalling: [],
      }),
    ).rejects.toThrow("plans the store, which no engine does unless storeShared");
  });

  it("refuses a plaintext URL to another host before connecting, unless the operator allows it", async () => {
    const plaintext = "fake://admin@db.example.com/app";
    const engine = new FakeEngine({ plans: { install: () => ok(install) } });

    const refused = await engine.planInstall(target, plaintext, shared);
    expect(refused).toEqual({
      ok: false,
      refusal: expect.objectContaining({ code: "insecure-url" }),
    });
    const run = await engine.run(target, install, plaintext, { ...shared, workerPassword: "x" });
    expect(run).toEqual({
      ran: [],
      stopped: { at: 0, refusal: expect.objectContaining({ code: "insecure-url" }) },
      removed: [],
      notes: [],
    });
    expect(engine.runs.at(-1)?.statements).toEqual([]);
    await expect(engine.open(target, plaintext, shared)).rejects.toThrow("in the clear");
    // `checkUrl` says the same without connecting, and `open` throws it as the one type the CLI
    // catches across engines.
    const checked = engine.checkUrl(target, plaintext, shared);
    expect(checked).toEqual(expect.objectContaining({ code: "insecure-url" }));
    const thrown = await engine.open(target, plaintext, shared).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(EngineRefusal);
    expect(thrown instanceof EngineRefusal && thrown.refusal).toEqual(checked);
    expect(engine.checkUrl(target, plaintext, { allowInsecure: true })).toBeUndefined();
    expect((await engine.doctor(target, plaintext, shared))[0]?.status).toBe("fail");

    expect(
      (await engine.planInstall(target, plaintext, { ...shared, allowInsecure: true })).ok,
    ).toBe(true);
    expect((await engine.planInstall(target, "fake://admin@localhost/app", shared)).ok).toBe(true);
    // The store's rule: the last sslmode counts, and a plaintext one wins over ssl=true.
    const tlsOf = async (query: string) =>
      (await engine.planInstall(target, `${plaintext}?${query}`, shared)).ok;
    expect(await tlsOf("sslmode=verify-full")).toBe(true);
    expect(await tlsOf("ssl=true")).toBe(true);
    expect(await tlsOf("sslmode=require&sslmode=disable")).toBe(false);
    expect(await tlsOf("sslmode=prefer&ssl=true")).toBe(false);
  });

  it("opens connectors over its database, whose current reads what write stored", async () => {
    const database = new FakeDatabase({
      fields: target.questionSet.read,
      clock: new FakeClock(1_700_000_000_000),
    });
    const listed = [{ name: "database", looksAt: "logs in as the worker and times a round trip" }];
    const checks: readonly DoctorCheck[] = [
      { name: "database", status: "ok", detail: "logged in as facetdb_worker" },
    ];
    const engine = new FakeEngine({
      name: "mysql",
      schemes: ["mysql"],
      database,
      checks: listed,
      doctor: () => checks,
    });

    const connector = await engine.open(target, WORKER_URL, { ...separate, workerId: "w1" });
    await connector.install();
    database.edit("r1", { title: "A car", description: "Cheap" });
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    expect(await connector.write("r1", decided, hash)).toEqual({ written: true });

    expect(await connector.current(["r1", "r2"])).toEqual(
      new Map([["r1", { ...decided, reviewed: false, updatedAt: new Date(1_700_000_000_000) }]]),
    );
    await connector.close();
    expect(engine.opened.map((opened) => opened.closed)).toEqual([true]);
    // `doctor --dry-run` lists the checks without connecting; `doctor` runs them.
    expect(engine.checks).toEqual(listed);
    expect(await engine.doctor(target, WORKER_URL, separate)).toEqual(checks);
    expect([engine.name, engine.schemes]).toEqual(["mysql", ["mysql"]]);
  });

  it("fails loudly on a plan or a database the test did not give it", async () => {
    const engine = new FakeEngine();

    await expect(engine.planPrune(target, ADMIN_URL, shared)).rejects.toThrow(
      'the fake engine "fake" has no prune plan',
    );
    await expect(engine.open(target, WORKER_URL, shared)).rejects.toThrow("no database to open");
  });
});
