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
import { afterEach, describe, expect, it } from "vitest";
import { createMssqlEngine } from "../engine/index.ts";
import { createInstaller, JOBS_TABLE, WORKER_USER } from "../install/index.ts";
import { connectMssql, type MssqlClient, type MssqlRow } from "../sql/index.ts";
import { skipUnless, testServerUrl } from "../testing/index.ts";
import {
  connectMssqlPool,
  createMssqlConnector,
  type MssqlConnector,
  VERSION_SAVE_MS,
  versionRun,
} from "./index.ts";

/**
 * Change Tracking as the capture on a real SQL Server: the scratch database gets `set
 * change_tracking = on` from the suite, as its admin would, then the install plan with `capture:
 * "change-tracking"` installs, as `facetdb migrate` runs it. The contract suite runs with the
 * application's writes followed by a poll of the peer's capture (the application path, then the
 * watch's own step, so the queue holds what the trigger would have queued), then what only a server
 * proves: a non-state update queues nothing, a restart resumes from the stored version, a version
 * older than the database keeps (its tracking turned off and on by the admin, so the change in
 * between is really gone) reconciles by the state hash, the refusals when tracking is off or its
 * retention short, uninstall turning tracking off only where FacetDB turned it on, a trigger
 * table's uninstall keeping the queue, and doctor under the worker login.
 *
 * The worker is the server login the other suites share (contained database authentication is off
 * on the test server): this suite never drops it, and its password is theirs, so whichever suite
 * made it first, the others log in with it.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const PASSWORD = "Wk-7e3c-Strong-Pass!";
/** The scratch databases of this file: the installed one, and one whose tracking is off. */
const SCRATCH = "facetdb_t069";
const SCRATCH_OFF = "facetdb_t069off";
const TRACKING_ON = "set change_tracking = on (change_retention = 2 days, auto_cleanup = on)";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: {},
};

function ticketsTarget(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "inline",
    capture: "change-tracking",
    onChange: "reset",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...changes,
  };
}

function deps(clock: FakeClock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

const TICKETS =
  "create table tickets (id nvarchar(64) primary key, subject nvarchar(max), body nvarchar(max), notes nvarchar(max))";

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

/** Resolves with what `pending` gives, or rejects when it takes longer than `ms`: "at once". */
async function within<T>(pending: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} waited longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The store's cursors as a map: the version is all this capture keeps there. */
function memoryCursors(): CursorStore & { readonly saved: Map<string, BackfillProgress> } {
  const saved = new Map<string, BackfillProgress>();
  return {
    saved,
    load: async (run) => saved.get(run),
    save: async (run, progress) => {
      saved.set(run, progress);
    },
  };
}

class World {
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly server: string;
  readonly database: string;
  readonly urls: { readonly admin: string; readonly worker: string };
  readonly installer = createInstaller({ connect: connectMssql });
  readonly cursors = memoryCursors();
  readonly warnings: string[] = [];
  /** What each connector said of polling, by its worker id. */
  readonly notes: string[] = [];
  readonly opened: MssqlConnector[] = [];
  admin: MssqlClient;
  /** The connector whose capture the application's writes are followed by, when there is one. */
  pump: MssqlConnector | undefined;

  constructor(server: string, target: EngineTarget, database = SCRATCH) {
    this.server = server;
    this.target = target;
    this.database = database;
    const admin = new URL(server);
    admin.pathname = `/${database}`;
    const worker = new URL(admin);
    worker.username = WORKER_USER;
    worker.password = encodeURIComponent(PASSWORD);
    this.urls = { admin: admin.toString(), worker: worker.toString() };
    this.admin = connectMssql(this.urls.admin);
  }

  /** A fresh scratch database, tracking on as its admin turns it on (unless `tracking` is false). */
  async reset(create: string, tracking = true): Promise<void> {
    const root = connectMssql(this.server);
    try {
      await root.query(
        `if db_id(N'${this.database}') is not null begin alter database [${this.database}] set single_user with rollback immediate; drop database [${this.database}]; end`,
      );
      await root.query(`create database [${this.database}]`);
      if (tracking) {
        await root.query(`alter database [${this.database}] ${TRACKING_ON}`);
      }
    } finally {
      await root.close();
    }
    await this.admin.query(create);
  }

  async alterDatabase(setting: string): Promise<void> {
    const root = connectMssql(this.server);
    try {
      await root.query(`alter database [${this.database}] ${setting}`);
    } finally {
      await root.close();
    }
  }

  async install(target: EngineTarget = this.target): Promise<void> {
    const planned = await this.installer.planInstall(target, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    const result = await this.installer.run(target, planned.plan, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async uninstall(target: EngineTarget = this.target): Promise<void> {
    const planned = await this.installer.planUninstall(target, this.urls.admin, {
      ...deps(this.clock),
      purge: false,
      alsoUninstalling: [],
    });
    if (!planned.ok) {
      if (planned.refusal.code === "not-installed") {
        return;
      }
      throw new Error(`uninstall refused: ${planned.refusal.message}`);
    }
    const result = await this.installer.run(
      target,
      planned.plan,
      this.urls.admin,
      deps(this.clock),
    );
    if (result.stopped !== undefined) {
      throw new Error(`uninstall stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async connector(workerId: string, scanPageSize?: number): Promise<MssqlConnector> {
    const connector = await createMssqlConnector(this.target, this.urls.worker, {
      clock: this.clock,
      workerId,
      connect: connectMssqlPool,
      maxConnections: 4,
      cursors: this.cursors,
      warn: (line) => {
        this.warnings.push(line);
      },
      note: (line) => {
        this.notes.push(`${workerId}: ${line}`);
      },
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  /** The application's own write, through the admin, with no poll after it. */
  async write(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.admin.query(
      "if exists (select 1 from tickets where id = @p1) update tickets set subject = @p2, body = @p3 where id = @p1 else insert into tickets (id, subject, body) values (@p1, @p2, @p3)",
      [key, state["subject"] ?? null, state["body"] ?? null],
    );
  }

  /** The application's write, then the pump's poll: what the trigger would have queued, queued. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.write(key, state);
    await this.pump?.tracked?.poll();
  }

  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const [row] = await this.admin.query(
      "select facetdb_status as status, facetdb_updated_at as written, not_priority as value, convert(nvarchar(30), not_priority_probability) as probability, facetdb_reviewed as reviewed from tickets where id = @p1",
      [key],
    );
    if (row === undefined || row["written"] === null) {
      return null;
    }
    return {
      decisions:
        row["value"] === null || row["probability"] === null
          ? {}
          : {
              not_priority: {
                kind: "decided",
                value: row["value"] === true,
                probabilityOrConfidence: Number(row["probability"]),
              },
            },
      status: String(row["status"]) as RecordDecision["status"],
      ...(row["reviewed"] === true ? { reviewed: true as const } : {}),
    };
  }

  async jobs(): Promise<readonly string[]> {
    return (
      await this.admin.query(
        `select record_key from dbo.${JOBS_TABLE} where table_name = N'[dbo].[tickets]' order by record_key`,
      )
    ).map((row) => String(row["record_key"]));
  }

  async one(text: string): Promise<MssqlRow | undefined> {
    const [row] = await this.admin.query(text);
    return row;
  }

  /** Answers every queued key through `connector`, as the worker does: claim, read, write, ack. */
  async answerAll(connector: MssqlConnector): Promise<void> {
    const claimed = await connector.claim(100);
    const { rows } = await connector.read(claimed);
    for (const row of rows) {
      expect(await connector.write(row.key, decided, row.hash)).toEqual({ written: true });
    }
    await connector.ack(claimed);
  }

  async close(): Promise<void> {
    for (const connector of this.opened.splice(0)) {
      await connector.close();
    }
    await this.admin.close();
  }
}

describe.skipIf(skipUnless("MSSQL_URL"))("Change Tracking as the capture on MSSQL_URL", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const made of worlds.splice(0)) {
      await made.close();
    }
  });

  async function world(
    target: EngineTarget = ticketsTarget(),
    options: {
      readonly create?: string;
      readonly tracking?: boolean;
      readonly database?: string;
    } = {},
  ): Promise<World> {
    const made = new World(testServerUrl("MSSQL_URL"), target, options.database);
    worlds.push(made);
    await made.reset(options.create ?? TICKETS, options.tracking ?? true);
    return made;
  }

  describe("contract", () => {
    runConnectorContract(async () => {
      const made = await world(ticketsTarget({ onChange: "keep" }));
      await made.install();
      const connector = await made.connector("w1", 10);
      const peer = await made.connector("w2", 10);
      made.pump = peer;
      return {
        connector,
        peer,
        fields: [...FIELDS],
        edit: (key, state) => made.edit(key, state),
        decisionOf: (key) => made.decisionOf(key),
        clock: made.clock,
      };
    });
  });

  it("installs with no trigger: tracking on with column tracking, FacetDB's mark, facetdb_state_hash and the worker's view change tracking; a second plan is empty", async () => {
    const made = await world();
    await made.install();
    expect(
      await made.one(
        "select count(*) as n from sys.triggers where parent_id = object_id(N'dbo.tickets')",
      ),
    ).toEqual({ n: 0 });
    expect(
      await made.one(
        "select cast(is_track_columns_updated_on as int) as columns from sys.change_tracking_tables where object_id = object_id(N'dbo.tickets')",
      ),
    ).toEqual({ columns: 1 });
    expect(
      await made.one(
        "select name from sys.extended_properties where class = 1 and major_id = object_id(N'dbo.tickets') and minor_id = 0",
      ),
    ).toEqual({ name: "facetdb_tracking_enabled" });
    expect(await made.one("select col_length(N'dbo.tickets', N'facetdb_state_hash') as n")).toEqual(
      {
        n: 64,
      },
    );
    const again = await made.installer.planInstall(made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(again).toMatchObject({ ok: true, plan: { statements: [] } });
  });

  it("queues an insert and a state update, sets them pending itself, and queues nothing for an update of another column", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.write("t1", { subject: "Refund", body: "Charged twice" });
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1"]);
    expect(await made.one("select facetdb_status as s from tickets")).toEqual({ s: "pending" });
    await made.answerAll(connector);
    await connector.tracked?.poll();
    // The worker's own write changed FacetDB's columns only: nothing is queued again.
    expect(await made.jobs()).toEqual([]);

    await made.admin.query("update tickets set notes = N'called back' where id = N't1'");
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual([]);
    expect(await made.one("select facetdb_status as s from tickets")).toEqual({ s: "done" });

    await made.admin.query("update tickets set body = N'Charged three times' where id = N't1'");
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1"]);
    expect(await made.one("select facetdb_status as s from tickets")).toEqual({ s: "pending" });
    // A deleted row queues nothing; the job it had reads as missing, which the worker drops.
    await made.admin.query("delete from tickets where id = N't1'");
    await connector.tracked?.poll();
    expect(await connector.read(["t1"])).toEqual({ rows: [], missing: ["t1"] });
  });

  it("an application write after a claimed key was answered: the poll clears the claim, so the stale ack leaves the job and the new state is asked", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.write("t1", { subject: "Refund", body: "Charged twice" });
    await connector.tracked?.poll();
    expect(await connector.claim(10)).toEqual(["t1"]);
    const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";
    expect(await connector.write("t1", decided, sent)).toEqual({ written: true });

    // The application changes the record before the worker's ack; the poll runs in between.
    await made.write("t1", { subject: "Refund", body: "Charged three times" });
    await connector.tracked?.poll();
    expect(
      await made.one(
        `select claimed_by, claim_token from dbo.${JOBS_TABLE} where record_key = N't1'`,
      ),
    ).toEqual({ claimed_by: null, claim_token: null });
    expect(await made.one("select facetdb_status as s from tickets")).toEqual({ s: "pending" });
    await connector.ack(["t1"]);
    expect(await made.jobs()).toEqual(["t1"]);

    expect(await connector.claim(10)).toEqual(["t1"]);
    const fresh = (await connector.read(["t1"])).rows[0]?.hash ?? "";
    expect(fresh).not.toBe(sent);
    expect(await connector.write("t1", decided, fresh)).toEqual({ written: true });
    await connector.ack(["t1"]);
    expect(await made.jobs()).toEqual([]);
  });

  // The application's transaction locks t1 without changing it (an uncommitted change would hold
  // its row of the table's change tracking too, and `changetable` waits for that commit holding no
  // lock of the table's rows: the queuing step is what must never wait while it holds others').
  it("reads past a row an open application transaction holds: the free row is queued at once, the held one by a poll after the commit", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.write("t1", { subject: "s", body: "one" });
    await made.write("t2", { subject: "s", body: "two" });
    const app = connectMssql(made.urls.admin);
    try {
      await app.transaction(async (query) => {
        await query("select id from tickets with (xlock, rowlock) where id = N't1'");
        await within(connector.tracked?.poll() ?? Promise.resolve(), 5_000, "the poll");
        expect(await made.jobs()).toEqual(["t2"]);
      });
    } finally {
      await app.close();
    }
    // Nothing was stored while t1 was held: the poll after the commit reads from the install's mark.
    expect(made.cursors.saved.get(versionRun(made.target))).toBeUndefined();
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1", "t2"]);
    expect(made.cursors.saved.get(versionRun(made.target))).toBeDefined();
  });

  it("one process polls a source: the other claims only, and takes over within a tick when the poller stops", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    const second = await made.connector("w2");
    await first.tracked?.poll();
    await second.tracked?.poll();
    expect(first.tracked?.polling()).toBe(true);
    expect(second.tracked?.polling()).toBe(false);

    await made.write("t1", { subject: "s", body: "one" });
    await second.tracked?.poll();
    expect(await made.jobs()).toEqual([]);
    await first.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1"]);

    // The poller stops: its session, and so its lock, ends with it.
    await first.close();
    await made.write("t2", { subject: "s", body: "two" });
    await second.tracked?.poll();
    expect(second.tracked?.polling()).toBe(true);
    expect(await made.jobs()).toEqual(["t1", "t2"]);
    expect(made.notes).toEqual([
      "w1: tickets: this worker polls Change Tracking for dbo.tickets",
      "w2: tickets: claiming only: another worker polls Change Tracking for dbo.tickets; this one takes over if it stops",
      "w2: tickets: this worker takes over polling Change Tracking for dbo.tickets: the worker that polled it stopped",
    ]);
  });

  it("a re-read of the same changes, its version held back by a held row, never clears a claim taken since", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.write("t1", { subject: "s", body: "one" });
    await made.write("t2", { subject: "s", body: "two" });
    const claimOf = async () =>
      made.one(`select claimed_by from dbo.${JOBS_TABLE} where record_key = N't1'`);
    const app = connectMssql(made.urls.admin);
    try {
      await app.transaction(async (query) => {
        await query("select id from tickets with (xlock, rowlock) where id = N't2'");
        await within(connector.tracked?.poll() ?? Promise.resolve(), 5_000, "the poll");
        expect(await connector.claim(10)).toEqual(["t1"]);
        // The version is held back by t2, so this poll reads t1's change again: its claim stays.
        await within(connector.tracked?.poll() ?? Promise.resolve(), 5_000, "the poll");
        expect(await claimOf()).toEqual({ claimed_by: "w1" });
      });
    } finally {
      await app.close();
    }
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1", "t2"]);
    expect(await claimOf()).toEqual({ claimed_by: "w1" });
  });

  it("a first start right after the install, with no write between, follows on with no warning and no reconcile", async () => {
    const made = await world();
    await made.install();
    const mark = await made.one(
      "select convert(nvarchar(20), value) as since, convert(nvarchar(20), change_tracking_current_version()) as now from sys.extended_properties where class = 1 and major_id = object_id(N'dbo.tickets') and minor_id = 0",
    );
    expect(BigInt(String(mark?.["since"]))).toBeLessThanOrEqual(BigInt(String(mark?.["now"])));
    const connector = await made.connector("w1");
    await connector.tracked?.poll();
    await connector.tracked?.poll();
    expect(made.warnings).toEqual([]);
    expect(await made.jobs()).toEqual([]);
    await made.write("t1", { subject: "s", body: "b" });
    await connector.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1"]);
    expect(made.warnings).toEqual([]);
  });

  it("watch queues and announces a change by itself, a second after it", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    const iterator = connector.watch()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await made.write("t1", { subject: "s", body: "b" });
    const batch = await pending;
    await iterator.return?.();
    expect(batch.value).toEqual(["t1"]);
  });

  it("a restart resumes from the stored version: a change made while the worker was down is queued, an answered row is not", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    await made.write("t1", { subject: "s", body: "one" });
    await first.tracked?.poll();
    await made.answerAll(first);
    // A poll that queues nothing stores its version once a minute.
    made.clock.advance(VERSION_SAVE_MS);
    await first.tracked?.poll();
    const current = await made.one(
      "select convert(nvarchar(20), change_tracking_current_version()) as v",
    );
    expect(made.cursors.saved.get(versionRun(made.target))).toEqual({
      cursor: current?.["v"],
      done: false,
    });
    await first.close();

    await made.write("t2", { subject: "s", body: "two" });
    const second = await made.connector("w2");
    await second.tracked?.poll();
    expect(await made.jobs()).toEqual(["t2"]);
    expect(made.warnings).toEqual([]);
  });

  it("a stored version below the oldest the database keeps reconciles: the row changed meanwhile is asked again, the untouched one is not, with a warning", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    await made.write("t1", { subject: "s", body: "one" });
    await made.write("t2", { subject: "s", body: "two" });
    await first.tracked?.poll();
    await made.answerAll(first);
    await first.tracked?.poll();
    const stored = made.cursors.saved.get(versionRun(made.target))?.cursor;
    await first.close();

    // The worker is down; t1 changes; then the database loses the changes (the admin turns the
    // table's tracking off and on, as a cleanup past the retention would): t1's change is gone.
    await made.write("t1", { subject: "s", body: "one, edited" });
    await made.admin.query("alter table tickets disable change_tracking");
    await made.admin.query(
      "alter table tickets enable change_tracking with (track_columns_updated = on)",
    );
    const min = await made.one(
      "select convert(nvarchar(20), change_tracking_min_valid_version(object_id(N'dbo.tickets'))) as v",
    );
    expect(BigInt(String(stored))).toBeLessThan(BigInt(String(min?.["v"])));

    const second = await made.connector("w2");
    await second.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1"]);
    expect(made.warnings).toHaveLength(1);
    expect(made.warnings[0]).toContain(
      `tickets: the changes of dbo.tickets since version ${stored}, where the worker stopped, are gone`,
    );
    expect(made.warnings[0]).toContain(
      "FacetDB reads every row of dbo.tickets once and queues each whose state changed since its last answer, or that has none",
    );
    // Then it follows changes again.
    await made.write("t2", { subject: "s", body: "two, edited" });
    await second.tracked?.poll();
    expect(await made.jobs()).toEqual(["t1", "t2"]);
    expect(made.warnings).toHaveLength(1);
  });

  it("refuses while tracking is off in the database, naming the statement its admin runs, and a retention under two days", async () => {
    const made = await world(ticketsTarget(), { tracking: false, database: SCRATCH_OFF });
    const off = await made.installer.planInstall(made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(off).toMatchObject({ ok: false, refusal: { code: "change-tracking-off" } });
    if (!off.ok) {
      expect(off.refusal.fix).toBe(
        `as the database's owner (or a login with ALTER on the database), run: alter database [${SCRATCH_OFF}] ${TRACKING_ON}; then run facetdb migrate again`,
      );
    }
    await made.alterDatabase("set change_tracking = on (change_retention = 12 hours)");
    const short = await made.installer.planInstall(made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(short).toMatchObject({ ok: false, refusal: { code: "change-tracking-retention" } });
    if (!short.ok) {
      expect(short.refusal.message).toContain("for 12 hours, under the two days FacetDB needs");
    }
  });

  it("uninstall turns tracking off where FacetDB turned it on, and leaves it on where it was on already", async () => {
    const made = await world();
    await made.install();
    await made.uninstall();
    const tracked =
      "select count(*) as n from sys.change_tracking_tables where object_id = object_id(N'dbo.tickets')";
    const marks =
      "select count(*) as n from sys.extended_properties where class = 1 and major_id = object_id(N'dbo.tickets') and minor_id = 0";
    expect(await made.one(tracked)).toEqual({ n: 0 });
    expect(await made.one(marks)).toEqual({ n: 0 });
    expect(await made.one("select col_length(N'dbo.tickets', N'facetdb_state_hash') as n")).toEqual(
      {
        n: null,
      },
    );

    await made.admin.query(
      "alter table tickets enable change_tracking with (track_columns_updated = on)",
    );
    await made.install();
    expect(
      await made.one(
        "select name from sys.extended_properties where class = 1 and major_id = object_id(N'dbo.tickets') and minor_id = 0",
      ),
    ).toEqual({ name: "facetdb_tracking_found" });
    await made.uninstall();
    expect(await made.one(tracked)).toEqual({ n: 1 });
    expect(await made.one(marks)).toEqual({ n: 0 });
  });

  it("a trigger table's uninstall keeps the queue a Change Tracking table still uses", async () => {
    const made = await world();
    await made.admin.query(
      "create table orders (id int primary key, subject nvarchar(max), body nvarchar(max))",
    );
    const orders = ticketsTarget({ source: "orders", table: "orders", capture: "trigger" });
    await made.install(orders);
    await made.install();
    await made.uninstall(orders);
    expect(await made.one(`select object_id(N'dbo.${JOBS_TABLE}', N'U') as id`)).not.toEqual({
      id: null,
    });
    await made.uninstall();
    expect(await made.one(`select object_id(N'dbo.${JOBS_TABLE}', N'U') as id`)).toEqual({
      id: null,
    });
  });

  it("doctor under the worker login: the Change Tracking check in the trigger's place, and the stored version against the oldest kept", async () => {
    const made = await world();
    await made.install();
    const engine = createMssqlEngine({
      cursors: async () => ({ cursors: made.cursors, close: async () => undefined }),
    });
    const before = await engine.doctor(made.target, made.urls.worker, deps(made.clock));
    expect(before.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["containment", "ok"],
      ["install", "ok"],
      ["change-tracking", "ok"],
      ["grants", "ok"],
      ["queue", "ok"],
    ]);
    expect(before.find((check) => check.name === "change-tracking")?.detail).toContain(
      "the worker has not run yet and starts from the install's version",
    );
    // Changes move the database's version on, then the table's tracking restarts past them.
    await made.write("t1", { subject: "s", body: "b" });
    await made.write("t2", { subject: "s", body: "b" });
    made.cursors.saved.set(versionRun(made.target), { cursor: "0", done: false });
    await made.admin.query("alter table tickets disable change_tracking");
    await made.admin.query(
      "alter table tickets enable change_tracking with (track_columns_updated = on)",
    );
    const after = await engine.doctor(made.target, made.urls.worker, deps(made.clock));
    expect(after.find((check) => check.name === "change-tracking")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("since version 0, where the worker stopped, are gone"),
    });
  });
});
