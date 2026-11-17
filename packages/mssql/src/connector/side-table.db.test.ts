import type {
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
import { connectMssqlPool, createMssqlConnector, type MssqlConnector } from "./index.ts";

/**
 * Side-table mode on a real SQL Server: the install plan with `storage: "side-table"` installs
 * `facetdb_tickets_answers`, the view `tickets_with_answers` and the trigger that sets the side
 * row's status, and the table gains no column; then the connector contract suite in this mode with
 * a peer, and what only a server proves: the second plan is empty (the stored view and trigger read
 * back as generated), an application delete takes the side row with it (the foreign key's cascade)
 * and the worker's ack of the missing key takes the job, a reader granted select on the view after
 * the install reads it and nothing else, the write's update lock makes an application write wait
 * for it (under READ_COMMITTED_SNAPSHOT too), a write while a key is claimed is refused and
 * re-queued, prune and uninstall, and doctor under the worker login.
 *
 * The worker is a server login on this server (contained database authentication is off), shared by
 * every suite of the package: the scratch database is this file's own, the login is never dropped
 * here, and its password is the connector suite's, so whichever suite made it, both log in.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const PASSWORD = "Wk-7e3c-Strong-Pass!";
/** This file's scratch database; never another suite's. */
const SCRATCH = "facetdb_t068";
const SIDE = "dbo.facetdb_tickets_answers";

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
    storage: "side-table",
    onChange: "keep",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...changes,
  };
}

function deps(clock: FakeClock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

const TICKETS =
  "create table tickets (id nvarchar(64) primary key, subject nvarchar(max), body nvarchar(max))";

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

/** Resolves with what `pending` gives, or rejects when it takes longer than `ms`. */
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

/** Whether `pending` is still unsettled after `ms`. */
async function stillWaiting(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}

/** The scratch database, installed by the plan in side-table mode, with the connectors opened on it. */
class World {
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly server: string;
  readonly urls: { readonly admin: string; readonly worker: string };
  readonly installer = createInstaller({ connect: connectMssql });
  readonly opened: MssqlConnector[] = [];
  readonly clients: MssqlClient[] = [];
  admin: MssqlClient;

  constructor(server: string, target: EngineTarget) {
    this.server = server;
    this.target = target;
    const admin = new URL(server);
    admin.pathname = `/${SCRATCH}`;
    const worker = new URL(admin);
    worker.username = WORKER_USER;
    worker.password = encodeURIComponent(PASSWORD);
    this.urls = { admin: admin.toString(), worker: worker.toString() };
    this.admin = connectMssql(this.urls.admin);
  }

  async reset(create: string): Promise<void> {
    const root = connectMssql(this.server);
    try {
      await root.query(
        `if db_id(N'${SCRATCH}') is not null begin alter database [${SCRATCH}] set single_user with rollback immediate; drop database [${SCRATCH}]; end`,
      );
      await root.query(`create database [${SCRATCH}]`);
    } finally {
      await root.close();
    }
    await this.admin.query(create);
  }

  /** A database setting only the server's admin changes; its sessions end, so the admin connects again. */
  async alterDatabase(setting: string): Promise<void> {
    const root = connectMssql(this.server);
    try {
      await root.query(`alter database [${SCRATCH}] set ${setting} with rollback immediate`);
    } finally {
      await root.close();
    }
    await this.admin.close().catch(() => undefined);
    this.admin = connectMssql(this.urls.admin);
  }

  async install(target: EngineTarget = this.target): Promise<void> {
    const options = { ...deps(this.clock), workerPassword: PASSWORD };
    const planned = await this.installer.planInstall(target, this.urls.admin, options);
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    const result = await this.installer.run(target, planned.plan, this.urls.admin, options);
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async uninstall(): Promise<void> {
    const planned = await this.installer.planUninstall(this.target, this.urls.admin, {
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
      this.target,
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
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  app(): MssqlClient {
    const client = connectMssql(this.urls.admin);
    this.clients.push(client);
    return client;
  }

  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.admin.query(
      "if exists (select 1 from tickets where id = @p1) update tickets set subject = @p2, body = @p3 where id = @p1 else insert into tickets (id, subject, body) values (@p1, @p2, @p3)",
      [key, state["subject"] ?? null, state["body"] ?? null],
    );
  }

  /** The decision in the side row, as the contract suite reads it. */
  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const [row] = await this.admin.query(
      `select facetdb_status as status, facetdb_updated_at as written, not_priority as value, convert(nvarchar(30), not_priority_probability) as probability, facetdb_reviewed as reviewed from ${SIDE} where id = @p1`,
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

  async sideRows(): Promise<readonly MssqlRow[]> {
    return this.admin.query(`select id, facetdb_status as status from ${SIDE} order by id`);
  }

  async jobs(): Promise<readonly MssqlRow[]> {
    return this.admin.query(
      `select record_key, claimed_by from dbo.${JOBS_TABLE} order by record_key`,
    );
  }

  async tableColumns(): Promise<readonly string[]> {
    return (
      await this.admin.query(
        "select name from sys.columns where object_id = object_id(N'dbo.tickets') order by column_id",
      )
    ).map((row) => String(row["name"]));
  }

  async close(): Promise<void> {
    for (const connector of this.opened.splice(0)) {
      await connector.close();
    }
    for (const client of this.clients.splice(0)) {
      await client.close();
    }
    await this.admin.close();
  }
}

describe.skipIf(skipUnless("MSSQL_URL"))("side-table mode on MSSQL_URL", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const made of worlds.splice(0)) {
      await made.close();
    }
  });

  async function world(target: EngineTarget = ticketsTarget()): Promise<World> {
    const made = new World(testServerUrl("MSSQL_URL"), target);
    worlds.push(made);
    await made.reset(TICKETS);
    return made;
  }

  describe("contract", () => {
    runConnectorContract(async () => {
      const made = await world();
      await made.install();
      const connector = await made.connector("w1", 10);
      const peer = await made.connector("w2", 10);
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

  it("installs without a column on the table, and plans nothing on the installed table: the view and the trigger read back as generated", async () => {
    const made = await world(ticketsTarget({ onChange: "reset" }));
    const before = await made.tableColumns();
    await made.install();
    expect(await made.tableColumns()).toEqual(before);
    const again = await made.installer.planInstall(made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(again).toMatchObject({ ok: true, plan: { statements: [] } });
    // The trigger makes the new record's side row, pending, and queues its key.
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    expect(await made.sideRows()).toEqual([{ id: "t1", status: "pending" }]);
    expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null }]);
    const [view] = await made.admin.query(
      "select id, subject, facetdb_status as status, facetdb_reviewed as reviewed from tickets_with_answers",
    );
    expect(view).toEqual({ id: "t1", subject: "Refund", status: "pending", reviewed: false });
  });

  it("an application delete takes the record's side row with it, the worker's ack of the missing key takes the job, and a key inserted again starts fresh", async () => {
    const made = await world(ticketsTarget({ onChange: "reset" }));
    await made.install();
    const connector = await made.connector("w1");
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    const { rows } = await connector.read(["t1"]);
    expect(await connector.write("t1", decided, rows[0]?.hash ?? "")).toEqual({ written: true });
    await connector.ack(await connector.claim(10));
    await made.edit("t1", { subject: "Refund", body: "Charged three times" });
    expect(await made.jobs()).toHaveLength(1);

    await made.admin.query("delete from tickets where id = N't1'");
    expect(await made.sideRows()).toEqual([]);
    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(await connector.read(["t1"])).toEqual({ rows: [], missing: ["t1"] });
    expect(await connector.current(["t1"])).toEqual(new Map());
    await connector.ack(["t1"]);
    expect(await made.jobs()).toEqual([]);

    await made.edit("t1", { subject: "New", body: "Again" });
    expect(await made.decisionOf("t1")).toBeNull();
    expect((await connector.current(["t1"])).get("t1")).toEqual({
      decisions: {},
      status: "pending",
      reviewed: false,
      updatedAt: null,
    });
  });

  it("a reader granted select on the view after the install reads it, and neither table", async () => {
    const made = await world();
    await made.install();
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    await made.admin.query("create user [t068_reader] without login");
    await made.admin.query("grant select on dbo.tickets_with_answers to [t068_reader]");
    // Each read on a session of its own: a refused one ends its batch before the revert.
    const as = (text: string) =>
      made.app().query(`execute as user = N't068_reader'; ${text}; revert;`);
    expect(await as("select id, facetdb_status as status from dbo.tickets_with_answers")).toEqual([
      { id: "t1", status: "pending" },
    ]);
    await expect(as(`select id from ${SIDE}`)).rejects.toThrow("SELECT permission was denied");
    await expect(as("select id from dbo.tickets")).rejects.toThrow("SELECT permission was denied");
  });

  it("the worker's write waits on the row an application transaction holds, a locking read under READ_COMMITTED_SNAPSHOT too, then finds the new state and writes nothing; the trigger put the side row back to pending and re-queued it", async () => {
    for (const snapshot of [false, true]) {
      const made = await world(ticketsTarget({ onChange: "reset" }));
      if (snapshot) {
        await made.alterDatabase("read_committed_snapshot on");
      }
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      const [claimed] = await connector.claim(10);
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";

      // The application holds the row: the worker's guard waits for its commit, then reads the
      // new state and writes nothing.
      const app = made.app();
      let writing: Promise<unknown> = Promise.resolve();
      await app.transaction(async (query) => {
        await query("update tickets set body = N'Charged three times' where id = N't1'");
        writing = connector.write("t1", decided, sent);
        expect(await stillWaiting(writing, 500)).toBe(true);
      });
      expect(await within(writing, 5_000, "the write")).toEqual({ written: false });
      expect(await made.decisionOf("t1")).toBeNull();
      expect(await made.sideRows()).toEqual([{ id: "t1", status: "pending" }]);
      await connector.ack([claimed ?? ""]);
      expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null }]);

      // At the new state the write goes through and the view shows it.
      const fresh = (await connector.read(["t1"])).rows[0]?.hash ?? "";
      expect(await connector.write("t1", decided, fresh)).toEqual({ written: true });
      expect(await made.decisionOf("t1")).toEqual(decided);
      const [view] = await made.admin.query(
        "select facetdb_status as status, not_priority from tickets_with_answers where id = N't1'",
      );
      expect(view).toEqual({ status: "done", not_priority: false });
      await made.close();
      worlds.splice(worlds.indexOf(made), 1);
    }
  });

  it("two application updates of a row the table held before the install, the second waiting on the first, under READ_COMMITTED_SNAPSHOT: one side row, no duplicate key, both commit", async () => {
    const made = await world(ticketsTarget({ onChange: "reset" }));
    await made.alterDatabase("read_committed_snapshot on");
    await made.admin.query(
      "insert into tickets (id, subject, body) values (N'old', N'Before', N'install')",
    );
    await made.install();
    const first = made.app();
    const second = made.app();
    let racing: Promise<unknown> = Promise.resolve();
    await first.transaction(async (query) => {
      // The first trigger inserts the side row, uncommitted; the second update waits on the row.
      await query("update tickets set body = N'one' where id = N'old'");
      racing = second.query("update tickets set body = N'two' where id = N'old'");
      expect(await stillWaiting(racing, 500)).toBe(true);
    });
    await within(racing, 5_000, "the second update");
    expect(await made.sideRows()).toEqual([{ id: "old", status: "pending" }]);
    expect(await made.jobs()).toEqual([{ record_key: "old", claimed_by: null }]);
    expect(await made.admin.query("select body from tickets")).toEqual([{ body: "two" }]);
  });

  it("two application transactions at serializable (TransactionScope's default) inserting new keys never wait on each other in the trigger, and the caller's isolation level comes back after it", async () => {
    const made = await world();
    await made.install();
    const first = made.app();
    const second = made.app();
    const insert = "insert into tickets (id, subject, body) values (@p1, N's', N'b')";
    await first.transaction(async (one) => {
      await one("set transaction isolation level serializable");
      await one(insert, ["k1"]);
      // The trigger ran at read committed; the application's transaction is serializable again.
      expect(
        await one(
          "select transaction_isolation_level as level from sys.dm_exec_sessions where session_id = @@spid",
        ),
      ).toEqual([{ level: 4 }]);
      await second.transaction(async (two) => {
        await two("set transaction isolation level serializable");
        // Without read committed in the trigger, its range locks on the queue and the side table
        // make this wait on the first transaction, and the next insert close a deadlock.
        await within(two(insert, ["k2"]), 5_000, "the second transaction's insert");
        await within(one(insert, ["k3"]), 5_000, "the first transaction's next insert");
      });
    });
    expect((await made.sideRows()).map((row) => row["id"])).toEqual(["k1", "k2", "k3"]);
    expect((await made.jobs()).map((row) => row["record_key"])).toEqual(["k1", "k2", "k3"]);
  });

  it("writes a record the table held before the install: its first answer inserts its side row", async () => {
    const made = await world();
    await made.admin.query(
      "insert into tickets (id, subject, body) values (N'old', N'Before', N'install')",
    );
    await made.install();
    expect(await made.sideRows()).toEqual([]);
    const connector = await made.connector("w1");
    const [row] = (await connector.scan(null)).rows;
    expect(row?.key).toBe("old");
    expect(await connector.write("old", decided, row?.hash ?? "")).toEqual({ written: true });
    expect(await made.sideRows()).toEqual([{ id: "old", status: "done" }]);
  });

  it("prune drops a removed question's columns from the side table and the view; uninstall drops the view and the side table, and the table is as it was", async () => {
    const made = await world();
    const before = await made.tableColumns();
    await made.install();
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    const fewer: EngineTarget = {
      ...made.target,
      questionSet: { ...questionSet, questions: CONTRACT_QUESTIONS.slice(0, 1) },
    };
    const pruned = await made.installer.planPrune(fewer, made.urls.admin, deps(made.clock));
    if (!pruned.ok) {
      throw new Error(pruned.refusal.message);
    }
    expect(pruned.plan.removes.map((object) => object.name)).toEqual([
      "category",
      "category_confidence",
      "urgency",
      "urgency_confidence",
      "urgency_expected",
    ]);
    const ran = await made.installer.run(fewer, pruned.plan, made.urls.admin, deps(made.clock));
    expect(ran.stopped).toBeUndefined();
    const viewColumns = async () =>
      (
        await made.admin.query(
          "select name from sys.columns where object_id = object_id(N'dbo.tickets_with_answers') order by column_id",
        )
      ).map((row) => String(row["name"]));
    expect(await viewColumns()).toEqual([
      ...before,
      "not_priority",
      "not_priority_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
    // The second install of the smaller set plans nothing: the view prune made is install's.
    const again = await made.installer.planInstall(fewer, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(again).toMatchObject({ ok: true, plan: { statements: [] } });

    await made.uninstall();
    expect(
      await made.admin.query(
        "select name from sys.objects where name in (N'tickets_with_answers', N'facetdb_tickets_answers', N'facetdb_tickets')",
      ),
    ).toEqual([]);
    expect(await made.tableColumns()).toEqual(before);
    // With the foreign key gone, the application may truncate its table again.
    await made.admin.query("truncate table tickets");
  });

  it("doctor under the worker login: every check passes on the side-table install", async () => {
    const made = await world();
    await made.install();
    await made.edit("t1", { subject: "s", body: "b" });
    const checks = await createMssqlEngine().doctor(
      made.target,
      made.urls.worker,
      deps(made.clock),
    );
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["containment", "ok"],
      ["install", "ok"],
      ["trigger", "ok"],
      ["app-writes", "warn"],
      ["grants", "ok"],
      ["queue", "ok"],
    ]);
    expect(checks.find((check) => check.name === "install")?.detail).toContain(SIDE);
  });
});
