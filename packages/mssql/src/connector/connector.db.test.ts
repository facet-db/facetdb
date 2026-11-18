import type {
  Clock,
  EngineDeps,
  EngineTarget,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createMssqlEngine } from "../engine/index.ts";
import { createInstaller, JOBS_TABLE, WORKER_USER } from "../install/index.ts";
import { connectMssql, type MssqlClient, type MssqlQuery, type MssqlRow } from "../sql/index.ts";
import { dropScratch, skipUnless, testServerUrl } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  connectMssqlPool,
  createMssqlConnector,
  type MssqlConnector,
  type MssqlPoolConnect,
} from "./index.ts";

/**
 * The runtime connector on a real SQL Server, the first run of the install, its trigger and the
 * tedious client against a server: the listings-shaped fixture is installed by the plan, as
 * `facetdb migrate` runs it, then the connector contract suite with a peer, then what only a server
 * proves: the second plan of an installed table is empty (the stored trigger reads back as
 * generated), a claim older than its lease is reclaimed, a claim never waits on a job row another
 * transaction holds (another worker's open claim, an application's write; under
 * READ_COMMITTED_SNAPSHOT too), two workers claiming at once never share a key, an application
 * write while a key is claimed makes `write` refuse and the trigger re-queue, an ack never waits
 * holding other job rows, the pool's sessions run as the connector needs, keys read through the
 * queue's text, and doctor under the worker login.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
/** Strong enough for the server's password policy, and free of the login's name. */
const PASSWORD = "Wk-7e3c-Strong-Pass!";
/** The scratch database of this file; the files of the package run one at a time (vitest.db.config.ts). */
const SCRATCH = "facetdb_t067";

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
    onChange: "keep",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...changes,
  };
}

/** The server's URL with the scratch database as its path, and the worker's with its login too. */
function urlsOf(server: string): { readonly admin: string; readonly worker: string } {
  const admin = new URL(server);
  admin.pathname = `/${SCRATCH}`;
  const worker = new URL(admin);
  worker.username = WORKER_USER;
  worker.password = encodeURIComponent(PASSWORD);
  return { admin: admin.toString(), worker: worker.toString() };
}

function deps(clock: Clock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/** A pool that records every statement it sends, around the real one. */
function counting(connect: MssqlPoolConnect): { connect: MssqlPoolConnect; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    connect: (url, options) => {
      const pool = connect(url, options);
      return {
        query: (text, params) => {
          sent.push(text);
          return pool.query(text, params);
        },
        transaction: (work) => pool.transaction(work),
        close: () => pool.close(),
      };
    },
  };
}

/**
 * A pool whose every statement runs inside one transaction left open until `commit`: a worker
 * whose claim holds its job rows, uncommitted, as long as the test wants.
 */
function holding(): { readonly connect: MssqlPoolConnect; commit(): Promise<void> } {
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended: Promise<void> = Promise.resolve();
  let client: MssqlClient | undefined;
  return {
    connect: (url) => {
      const opened = connectMssql(url);
      client = opened;
      let ready: (query: MssqlQuery) => void = () => undefined;
      const inside = new Promise<MssqlQuery>((resolve) => {
        ready = resolve;
      });
      ended = opened.transaction(async (query) => {
        ready(query);
        await finished;
      });
      return {
        query: async (text, params) => (await inside)(text, params),
        transaction: () => Promise.reject(new Error("the holding pool runs one open transaction")),
        close: async () => {
          finish();
          await ended;
          await opened.close();
        },
      };
    },
    async commit() {
      finish();
      await ended;
      await client?.close();
    },
  };
}

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

/** One scratch database on the server, installed by the install plan, with the connectors opened on it. */
class World {
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly server: string;
  admin: MssqlClient;
  readonly urls: { readonly admin: string; readonly worker: string };
  readonly opened: MssqlConnector[] = [];
  readonly clients: MssqlClient[] = [];
  readonly installer = createInstaller({ connect: connectMssql });

  constructor(server: string, target: EngineTarget) {
    this.server = server;
    this.target = target;
    this.urls = urlsOf(server);
    this.admin = connectMssql(this.urls.admin);
  }

  /** A fresh scratch database and no worker login, then the table as `create` makes it. */
  async reset(create: string): Promise<void> {
    const root = connectMssql(this.server);
    try {
      await root.query(
        `if db_id(N'${SCRATCH}') is not null begin alter database [${SCRATCH}] set single_user with rollback immediate; drop database [${SCRATCH}]; end`,
      );
      await root.query(
        `if exists (select 1 from sys.server_principals where name = N'${WORKER_USER}') drop login [${WORKER_USER}]`,
      );
      await root.query(`create database [${SCRATCH}]`);
    } finally {
      await root.close();
    }
    await this.admin.query(create);
  }

  /**
   * A database setting only an admin of the server changes (the scratch database's own). `with
   * rollback immediate` ends every session in the database, the world's admin connection among
   * them, so it connects again.
   */
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

  /** `facetdb migrate`: the install plan, then its run. */
  async install(): Promise<void> {
    const planned = await this.installer.planInstall(this.target, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    const result = await this.installer.run(this.target, planned.plan, this.urls.admin, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  /** `facetdb uninstall`; nothing to do once nothing is installed. */
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

  async connector(
    workerId: string,
    options: { readonly scanPageSize?: number; readonly connect?: MssqlPoolConnect } = {},
  ): Promise<MssqlConnector> {
    const connector = await createMssqlConnector(this.target, this.urls.worker, {
      clock: this.clock,
      workerId,
      connect: options.connect ?? connectMssqlPool,
      maxConnections: 4,
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(options.scanPageSize === undefined ? {} : { scanPageSize: options.scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  /** A connection of the application's, through the admin login, closed with the world. */
  app(): MssqlClient {
    const client = connectMssql(this.urls.admin);
    this.clients.push(client);
    return client;
  }

  /** The application's own write, through the admin: inserts the row or updates its state. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.admin.query(
      "if exists (select 1 from tickets where id = @p1) update tickets set subject = @p2, body = @p3 where id = @p1 else insert into tickets (id, subject, body) values (@p1, @p2, @p3)",
      [key, state["subject"] ?? null, state["body"] ?? null],
    );
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

  async jobs(): Promise<readonly MssqlRow[]> {
    return this.admin.query(
      `select record_key, claimed_by, claim_token from dbo.${JOBS_TABLE} order by record_key`,
    );
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

const TICKETS =
  "create table tickets (id nvarchar(64) primary key, subject nvarchar(max), body nvarchar(max))";

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

describe.skipIf(skipUnless("MSSQL_URL"))("the connector on MSSQL_URL", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const made of worlds.splice(0)) {
      await made.close();
    }
  });
  // The shared server keeps nothing of this suite: its database and the worker's login.
  afterAll(async () => {
    await dropScratch(testServerUrl("MSSQL_URL"), [SCRATCH]);
  });

  async function world(
    target: EngineTarget = ticketsTarget(),
    create: string = TICKETS,
  ): Promise<World> {
    const server = testServerUrl("MSSQL_URL");
    const made = new World(server, target);
    worlds.push(made);
    await made.reset(create);
    return made;
  }

  describe("contract", () => {
    runConnectorContract(async () => {
      const made = await world();
      // The worker login exists only once install created it, so the fixture installs first; the
      // suite's own install is then the second, which plans nothing.
      await made.install();
      // Pages of 10, so the 25 seeded records cross page boundaries.
      const connector = await made.connector("w1", { scanPageSize: 10 });
      const peer = await made.connector("w2", { scanPageSize: 10 });
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

  it("installs by the plan, and plans nothing on the installed table: the stored trigger reads back as generated", async () => {
    const made = await world(ticketsTarget({ onChange: "reset" }));
    await made.install();
    const again = await made.installer.planInstall(made.target, made.urls.admin, {
      ...deps(made.clock),
      workerPassword: PASSWORD,
    });
    expect(again).toMatchObject({ ok: true, plan: { statements: [] } });
    // The trigger queues under the table's bracketed name, and reset sets a new row pending.
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null, claim_token: null }]);
    expect(await made.admin.query(`select table_name from dbo.${JOBS_TABLE}`)).toEqual([
      { table_name: "[dbo].[tickets]" },
    ]);
    expect(await made.admin.query("select facetdb_status from tickets")).toEqual([
      { facetdb_status: "pending" },
    ]);
  });

  it("runs every pooled session at read committed with xact_abort on and deadlock_priority low, so a deadlock with the application ends the worker's statement", async () => {
    const made = await world();
    await made.install();
    const pool = connectMssqlPool(made.urls.worker, { maxConnections: 2 });
    try {
      const sessions = await Promise.all(
        [1, 2, 3].map(() =>
          pool.query(
            "select transaction_isolation_level as level, cast(@@options & 16384 as int) as xact_abort, deadlock_priority as priority, user_name() as who from sys.dm_exec_sessions where session_id = @@spid",
          ),
        ),
      );
      for (const [session] of sessions) {
        expect(session).toEqual({ level: 2, xact_abort: 16384, priority: -5, who: WORKER_USER });
      }
    } finally {
      await pool.close();
    }
  });

  it("@timing a claim older than its lease is reclaimed; one within it is not", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });

    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(CLAIM_LEASE_MS);
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(1);
    expect(await connector.claim(10)).toEqual(["t1"]);
    const peer = await made.connector("w2");
    expect(await peer.claim(10)).toEqual([]);
  });

  it("readpast: a second claim returns at once, with other keys, while the first holds an open transaction on its rows", async () => {
    const made = await world();
    await made.install();
    for (let index = 0; index < 10; index += 1) {
      await made.edit(`k${index}`, { subject: "s", body: "b" });
    }
    const held = holding();
    const first = await made.connector("w1", { connect: held.connect });
    const second = await made.connector("w2");
    try {
      const a = await first.claim(4);
      expect(a).toHaveLength(4);
      // The first claim's transaction is open: its four job rows are locked, uncommitted.
      const b = await within(second.claim(10), 5_000, "the second claim");
      expect(b).toHaveLength(6);
      expect(b.filter((key) => a.includes(key))).toEqual([]);
    } finally {
      await held.commit();
    }
  });

  it("a claim reads past a job row an application transaction holds, and never waits for it, under READ_COMMITTED_SNAPSHOT too", async () => {
    for (const snapshot of [false, true]) {
      const made = await world();
      if (snapshot) {
        await made.alterDatabase("read_committed_snapshot on");
      }
      await made.install();
      // Many claimed jobs make the facetdb_jobs_claimed index the cheaper read, whose lookup into
      // the clustered key would wait on the held row: the claim reads the clustered key.
      await made.admin.query(
        `insert into dbo.${JOBS_TABLE} (table_name, record_key, claimed_by, claimed_at) select N'[dbo].[tickets]', concat(N'busy', n), N'elsewhere', sysutcdatetime() from (select top (5000) row_number() over (order by (select null)) as n from sys.all_objects a cross join sys.all_objects b) x`,
      );
      await made.admin.query(`update statistics dbo.${JOBS_TABLE}`);
      await made.edit("a", { subject: "s", body: "a1" });
      await made.edit("b", { subject: "s", body: "b1" });
      const connector = await made.connector("w1");
      const app = made.app();
      await app.transaction(async (query) => {
        // The application's transaction changes record b: its trigger holds job b, uncommitted.
        await query("update tickets set body = N'b2' where id = N'b'");
        expect(await within(connector.claim(10), 5_000, "the claim")).toEqual(["a"]);
      });
      expect(await connector.claim(10)).toEqual(["b"]);
      await made.close();
      worlds.splice(worlds.indexOf(made), 1);
    }
  });

  it("two workers claiming at once never share a key, fifty rounds", async () => {
    const made = await world();
    await made.install();
    const first = await made.connector("w1");
    const second = await made.connector("w2");
    for (let index = 0; index < 100; index += 1) {
      await made.edit(`k${String(index).padStart(3, "0")}`, { subject: "s", body: "b" });
    }
    for (let round = 0; round < 50; round += 1) {
      const [a, b] = await Promise.all([first.claim(3), second.claim(3)]);
      expect(a).toHaveLength(3);
      expect(b).toHaveLength(3);
      expect(a.filter((key) => b.includes(key))).toEqual([]);
      await Promise.all([first.release(a), second.release(b)]);
    }
    expect((await made.jobs()).every((job) => job["claimed_by"] === null)).toBe(true);
  });

  it("an application write while a key is claimed: write refuses the stale answer, the trigger re-queues, and the ack leaves the job", async () => {
    const made = await world(ticketsTarget({ onChange: "reset" }));
    await made.install();
    const connector = await made.connector("w1");
    await made.edit("t1", { subject: "Refund", body: "Charged twice" });
    expect(await connector.claim(10)).toEqual(["t1"]);
    const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";

    await made.edit("t1", { subject: "Refund", body: "Charged three times" });
    expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null, claim_token: null }]);
    expect(await connector.write("t1", decided, sent)).toEqual({ written: false });
    expect(await made.decisionOf("t1")).toBeNull();
    await connector.ack(["t1"]);
    expect(await made.jobs()).toHaveLength(1);

    expect(await connector.claim(10)).toEqual(["t1"]);
    const fresh = (await connector.read(["t1"])).rows[0]?.hash ?? "";
    expect(fresh).not.toBe(sent);
    expect(await connector.write("t1", decided, fresh)).toEqual({ written: true });
    await connector.ack(["t1"]);
    expect(await made.jobs()).toEqual([]);
    expect(await made.decisionOf("t1")).toEqual(decided);
  });

  it("write compares the state's bytes: a change of case alone, equal under the table's _CI_AS collation, writes nothing", async () => {
    const made = await world();
    await made.install();
    const connector = await made.connector("w1");
    await made.edit("t1", { subject: "Scam", body: null });
    const { rows } = await connector.read(["t1"]);
    // Changed behind the worker's back without the trigger (a bulk load without FIRE_TRIGGERS):
    // the state the model was sent is gone, and the remembered state guards the write.
    await made.admin.query("disable trigger facetdb_tickets on tickets");
    await made.admin.query("update tickets set subject = N'scam' where id = N't1'");
    await made.admin.query("enable trigger facetdb_tickets on tickets");
    expect(await connector.write("t1", decided, rows[0]?.hash ?? "")).toEqual({ written: false });
    expect(await made.decisionOf("t1")).toBeNull();
    // A NULL guards as NULL, and a value with quotes, brackets and other scripts reads and writes.
    const tricky = "O'Reilly ] [x] -- ' ünïcødé 漢字 🙂";
    await made.edit("t2", { subject: tricky, body: null });
    const read = await connector.read(["t2"]);
    expect(read.rows[0]?.state).toEqual({ subject: tricky, body: null });
    expect(await connector.write("t2", decided, read.rows[0]?.hash ?? "")).toEqual({
      written: true,
    });
    expect(await made.decisionOf("t2")).toEqual(decided);
  });

  it("an ack while an application transaction holds one of its job rows never waits holding the others: the held key settles on its own, under READ_COMMITTED_SNAPSHOT too", async () => {
    for (const snapshot of [false, true]) {
      const made = await world();
      if (snapshot) {
        // The option Azure SQL runs by default: the batch must still read past the held row, a
        // locking read (readcommittedlock), never wait on it holding the row it already deleted.
        await made.alterDatabase("read_committed_snapshot on");
      }
      await made.install();
      const counted = counting(connectMssqlPool);
      const connector = await made.connector("w1", { connect: counted.connect });
      await made.edit("a", { subject: "s", body: "a1" });
      await made.edit("b", { subject: "s", body: "b1" });
      expect([...(await connector.claim(10))].sort()).toEqual(["a", "b"]);

      const app = made.app();
      let acking: Promise<void> = Promise.resolve();
      await app.transaction(async (query) => {
        // The application's transaction changes record b and stays open: its trigger holds job b
        // with the claim cleared, uncommitted.
        await query("update tickets set body = N'b2' where id = N'b'");
        counted.sent.length = 0;
        acking = connector.ack(["a", "b"]);
        // The batch reads past b and deletes a at once; the one-key delete of b then waits for
        // the application, holding nothing.
        await within(
          (async () => {
            while (counted.sent.length < 2) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          })(),
          5_000,
          "the batch delete",
        );
        expect(counted.sent.map((text) => text.split(" ")[0])).toEqual(["delete", "delete"]);
        expect(counted.sent[0]).toContain("with (readcommittedlock, readpast, rowlock, index(1))");
        expect(counted.sent[1]).not.toContain("readpast");
        // a is gone already, committed, while the application still holds b.
        const other = made.app();
        expect(
          await other.query(
            `select record_key from dbo.${JOBS_TABLE} with (readcommittedlock, readpast) where record_key = N'a'`,
          ),
        ).toEqual([]);
      });
      await acking;
      // b's claim was cleared by the trigger, so it stays, to be asked at its new state.
      expect(await made.jobs()).toEqual([{ record_key: "b", claimed_by: null, claim_token: null }]);
      expect(await connector.claim(10)).toEqual(["b"]);
      await made.close();
      worlds.splice(worlds.indexOf(made), 1);
    }
  });

  it("reads every key as the queue's text: a decimal(10,2) key is 5.00 in the queue and in the connector", async () => {
    const made = await world(
      ticketsTarget({ table: "prices" }),
      "create table prices (id decimal(10,2) primary key, subject nvarchar(200), body nvarchar(200))",
    );
    await made.install();
    await made.admin.query(
      "insert into prices (id, subject, body) values (5, N'five', N'b'), (12.5, N'twelve', N'b')",
    );
    const connector = await made.connector("w1", { scanPageSize: 1 });
    expect([...(await connector.claim(10))].sort()).toEqual(["12.50", "5.00"]);
    const { rows, missing } = await connector.read(["5.00", "5", "nonsense"]);
    expect(rows.map((row) => row.key)).toEqual(["5.00"]);
    expect(missing).toEqual(["5", "nonsense"]);
    expect(await connector.write("5.00", decided, rows[0]?.hash ?? "")).toEqual({ written: true });
    expect((await connector.current(["5.00", "5"])).get("5.00")?.status).toBe("done");
    const first = await connector.scan(null);
    expect(first.rows.map((row) => row.key)).toEqual(["12.50"]);
    const second = await connector.scan(first.next);
    expect(second.rows.map((row) => row.key)).toEqual(["5.00"]);
    await connector.ack(["5.00", "12.50"]);
    expect(await made.jobs()).toEqual([]);
    expect(await connector.claimKey("5.00")).toBe(true);
    expect(await connector.claimKey("5.00")).toBe(false);
  });

  it("doctor under the worker login: every check passes on the installed table", async () => {
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
    expect(checks.find((check) => check.name === "trigger")?.detail).toContain(
      "facetdb migrate --dry-run",
    );
    expect(checks.find((check) => check.name === "queue")?.detail).toBe(
      "1 job waits for dbo.tickets, 0 are claimed",
    );
  });

  it("doctor says a table renamed under its trigger fails every application write", async () => {
    const made = await world();
    await made.install();
    await made.admin.query("exec sp_rename N'dbo.tickets', N'tickets_old'");
    const checks = await createMssqlEngine().doctor(
      made.target,
      made.urls.worker,
      deps(made.clock),
    );
    const install = checks.find((check) => check.name === "install");
    expect(install?.status).toBe("fail");
    expect(install?.detail).toBe(
      "dbo.tickets was renamed to dbo.tickets_old: FacetDB's trigger facetdb_tickets moved with it and still writes to [dbo].[tickets], so every insert and update of dbo.tickets_old fails (error 208)",
    );
    // What doctor says is what the application meets.
    await expect(
      made.admin.query("insert into tickets_old (id, subject, body) values (N'x', N's', N'b')"),
    ).rejects.toThrow("Invalid object name");
  });
});
