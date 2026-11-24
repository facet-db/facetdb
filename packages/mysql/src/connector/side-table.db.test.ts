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
import { URL_VARIABLES, type UrlVariable } from "../index.ts";
import {
  createMysqlInstaller,
  JOBS_TABLE,
  SETTINGS,
  sideTableName,
  sideViewName,
  WORKER_ACCOUNT,
} from "../install/index.ts";
import { connectMysql, type MysqlClient, type MysqlRow } from "../sql/index.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";
import { connectMysqlPool, createMysqlConnector, type MysqlConnector } from "./index.ts";

/**
 * Side-table mode on a real MySQL 8 and a real MariaDB 10.6: the tickets table is installed by the
 * install plan with `storage: "side-table"`, as `facetdb migrate` runs it, then the connector
 * contract suite with a peer, then what only a server proves: the table gains no column (its `show
 * create table` is the same before and after), a second plan is empty, an application delete takes
 * the side row with it and the worker's next read lets the job go, an application transaction that
 * changes the state while the worker writes is never written over, a key the application changes
 * keeps its answers, a reader granted after install reads the view once migrate runs again (and not
 * before: the view runs with the reader's rights), a table without foreign keys keeps a deleted
 * record's row out of sight, and uninstall and prune leave the table as it was. One SQL text, no
 * branch by engine.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const PASSWORD = "facetdb-worker-test-password";
/** This file's scratch database and reader login; the files of a package run one at a time. */
const SCRATCH = "facetdb_t065";
const READER = "facetdb_t065_reader";
const READER_PASSWORD = "facetdb-t065-reader-password";
const SIDE = sideTableName("tickets");
const VIEW = sideViewName("tickets");

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: {},
};

function ticketsTarget(
  onChange: "keep" | "reset" = "keep",
  set: QuestionSet = questionSet,
): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "side-table",
    onChange,
    questionSet: set,
    urlVariable: "TICKETS_URL",
  };
}

/** The server's URL with the scratch database as its path, under another login when given. */
function urlAs(server: string, user?: string, password?: string): string {
  const url = new URL(server);
  url.pathname = `/${SCRATCH}`;
  if (user !== undefined && password !== undefined) {
    url.username = user;
    url.password = password;
  }
  return url.toString();
}

function deps(clock: Clock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/**
 * What a reset makes and nothing else drops: the scratch database, the worker login and the reader,
 * whose passwords are this file's. The suite's `afterAll` drops them on each server, whatever its
 * cases did.
 */
async function dropScratch(server: string): Promise<void> {
  const root = connectMysql(server);
  try {
    await root.query(`drop database if exists \`${SCRATCH}\``);
    await root.query(`drop user if exists ${WORKER_ACCOUNT}`);
    await root.query(`drop user if exists '${READER}'@'%'`);
  } finally {
    await root.close();
  }
}

/** One scratch database on the server, installed by the plan in side-table mode. */
class World {
  readonly clock = new FakeClock(START);
  target: EngineTarget;
  readonly admin: MysqlClient;
  readonly server: string;
  readonly adminUrl: string;
  readonly workerUrl: string;
  readonly opened: MysqlConnector[] = [];
  readonly clients: MysqlClient[] = [];
  readonly installer = createMysqlInstaller({ connect: connectMysql });

  constructor(server: string, target: EngineTarget = ticketsTarget()) {
    this.server = server;
    this.target = target;
    this.adminUrl = urlAs(server);
    this.workerUrl = urlAs(server, "facetdb_worker", PASSWORD);
    this.admin = connectMysql(this.adminUrl);
  }

  /** A fresh scratch database, a fresh worker login and no reader, then the table (`options` after its columns). */
  async reset(options = "engine = InnoDB"): Promise<void> {
    await dropScratch(this.server);
    const root = connectMysql(this.server);
    try {
      await root.query(`create database \`${SCRATCH}\` character set utf8mb4`);
    } finally {
      await root.close();
    }
    await this.admin.query(
      `create table tickets (id varchar(64) primary key, subject text, body text) character set utf8mb4 ${options}`,
    );
  }

  async plan() {
    const planned = await this.installer.planInstall(this.target, this.adminUrl, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    return planned.plan;
  }

  /** `facetdb migrate`: the install plan, then its run. */
  async install(): Promise<void> {
    const plan = await this.plan();
    const result = await this.installer.run(this.target, plan, this.adminUrl, {
      ...deps(this.clock),
      workerPassword: PASSWORD,
    });
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  /** `facetdb uninstall`; nothing to do once nothing is installed. */
  async uninstall(): Promise<void> {
    const planned = await this.installer.planUninstall(this.target, this.adminUrl, {
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
    const result = await this.installer.run(
      this.target,
      planned.plan,
      this.adminUrl,
      deps(this.clock),
    );
    if (result.stopped !== undefined) {
      throw new Error(`uninstall stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  /** `facetdb migrate --prune`'s prune half. */
  async prune(): Promise<void> {
    const planned = await this.installer.planPrune(this.target, this.adminUrl, deps(this.clock));
    if (!planned.ok) {
      throw new Error(`prune refused: ${planned.refusal.message}`);
    }
    const result = await this.installer.run(
      this.target,
      planned.plan,
      this.adminUrl,
      deps(this.clock),
    );
    if (result.stopped !== undefined) {
      throw new Error(`prune stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async connector(workerId: string, scanPageSize?: number): Promise<MysqlConnector> {
    const connector = await createMysqlConnector(this.target, this.workerUrl, {
      clock: this.clock,
      workerId,
      connect: connectMysqlPool,
      maxConnections: 4,
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  /** Another connection to the scratch database, closed with the world. */
  client(user?: string, password?: string): MysqlClient {
    const client = connectMysql(urlAs(this.server, user, password));
    this.clients.push(client);
    return client;
  }

  /** The application's own write, through the admin: inserts the row or updates its state. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.admin.query(
      "insert into tickets (id, subject, body) values (?, ?, ?) on duplicate key update subject = values(subject), body = values(body)",
      [key, state["subject"] ?? null, state["body"] ?? null],
    );
  }

  /** The decision stored for a key: its side row, once a write stamped it. */
  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const [row] = await this.admin.query(
      `select facetdb_status as status, facetdb_updated_at as written, not_priority as value, not_priority_probability as probability, facetdb_reviewed as reviewed from ${SIDE} where id = ?`,
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
                value: row["value"] === 1,
                probabilityOrConfidence: Number(row["probability"]),
              },
            },
      status: String(row["status"]) as RecordDecision["status"],
      ...(row["reviewed"] === 1 ? { reviewed: true as const } : {}),
    };
  }

  async sideRows(): Promise<readonly MysqlRow[]> {
    return this.admin.query(`select id, facetdb_status as status from ${SIDE} order by id`);
  }

  async jobs(): Promise<readonly MysqlRow[]> {
    return this.admin.query(
      `select cast(record_key as char character set utf8mb4) as record_key, claimed_by from ${JOBS_TABLE} order by record_key`,
    );
  }

  async createTable(): Promise<string> {
    const [row] = await this.admin.query("show create table tickets");
    return String(row?.["Create Table"]);
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

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

/** The error number a refused statement carries, or undefined when it ran. */
async function errorOf(run: Promise<unknown>): Promise<number | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { errno?: number }).errno;
  }
}

for (const variable of URL_VARIABLES) {
  describe.skipIf(skipUnless(variable))(`side-table mode on ${variable}`, () => {
    const worlds: World[] = [];
    afterEach(async () => {
      for (const made of worlds.splice(0)) {
        await made.close();
      }
    });
    // The shared server keeps no account or database of this suite's, whatever its cases did.
    afterAll(async () => {
      await dropScratch(serverUrl(variable as UrlVariable));
    });

    async function world(target?: EngineTarget, engine?: string): Promise<World> {
      const made = new World(serverUrl(variable as UrlVariable), target);
      worlds.push(made);
      await made.reset(engine);
      return made;
    }

    describe("contract", () => {
      runConnectorContract(async () => {
        const made = await world();
        // The worker login exists only once install created it, so the fixture installs first; the
        // suite's own install is then the second, which plans nothing.
        await made.install();
        const connector = await made.connector("w1", 10);
        const peer = await made.connector("w2", 10);
        return {
          connector,
          peer,
          fields: [...FIELDS],
          edit: (key, state) => made.edit(key, state),
          // MySQL and MariaDB do not write `_probabilities` yet.
          probabilities: "not-yet",
          decisionOf: (key) => made.decisionOf(key),
          clock: made.clock,
        };
      });
    });

    it("the table gains no column, a second plan is empty, and the triggers fill the side row and the queue", async () => {
      const made = await world(ticketsTarget("reset"));
      const before = await made.createTable();
      await made.install();
      expect(await made.createTable()).toBe(before);
      expect(await made.plan()).toEqual({
        statements: [],
        transactional: false,
        removes: [],
        keeps: [],
        notes: [],
      });
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      expect(await made.sideRows()).toEqual([{ id: "t1", status: "pending" }]);
      expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null }]);
      // FacetDB's objects in the database are its own: no other name was added.
      const tables = await made.admin.query(
        "select table_name as name from information_schema.tables where table_schema = ? order by table_name",
        [SCRATCH],
      );
      expect(tables.map((row) => row["name"])).toEqual(
        ["facetdb_jobs", SIDE, "facetdb_table_owners", "tickets", VIEW].sort(),
      );
      // The worker reads the key and the state of the table and may write none of it.
      const worker = made.client("facetdb_worker", PASSWORD);
      expect(await worker.query("select id, subject, body from tickets")).toHaveLength(1);
      expect(await errorOf(worker.query("update tickets set subject = 'x'"))).toBe(1142);
      expect(await errorOf(worker.query("insert into tickets (id) values ('w')"))).toBe(1142);
      expect(await worker.query(`select id, facetdb_status from ${VIEW}`)).toHaveLength(1);
    });

    it("onChange reset sets a decided record pending when its state changes, keep does not", async () => {
      for (const onChange of ["reset", "keep"] as const) {
        const made = await world(ticketsTarget(onChange));
        await made.install();
        const connector = await made.connector("w1");
        await made.edit("t1", { subject: "Refund", body: "Charged twice" });
        const [row] = (await connector.read(["t1"])).rows;
        expect(await connector.write("t1", decided, row?.hash ?? "")).toEqual({ written: true });
        await made.edit("t1", { subject: "Refund", body: "Charged three times" });
        expect(await made.sideRows()).toEqual([
          { id: "t1", status: onChange === "reset" ? "pending" : "done" },
        ]);
        await made.close();
        worlds.splice(worlds.indexOf(made), 1);
      }
    });

    it("an application delete takes the side row with it, and the worker's read lets the job go", async () => {
      const made = await world();
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      const [row] = (await connector.read(["t1"])).rows;
      expect(await connector.write("t1", decided, row?.hash ?? "")).toEqual({ written: true });
      await made.edit("t1", { subject: "Refund", body: "Charged again" });

      // What the plan's note says the reference refuses, and what it lets through.
      expect(await errorOf(made.admin.query("truncate table tickets"))).toBeDefined();
      expect(await errorOf(made.admin.query("drop table tickets"))).toBeDefined();
      await made.admin.query("delete from tickets where id = ?", ["t1"]);
      expect(await made.sideRows()).toEqual([]);
      expect((await connector.current(["t1"])).has("t1")).toBe(false);
      // The job queued by the last change is still there; the worker finds no record and acks it.
      expect(await connector.claim(10)).toEqual(["t1"]);
      expect(await connector.read(["t1"])).toEqual({ rows: [], missing: ["t1"] });
      await connector.ack(["t1"]);
      expect(await made.jobs()).toEqual([]);
    });

    it("an application transaction changing the state while a write is in flight is never written over: the write waits on the side row, then refuses", async () => {
      const made = await world(ticketsTarget("reset"));
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      expect(await connector.claim(10)).toEqual(["t1"]);
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";

      // The application changes the state and stays open: its trigger holds the side row.
      const app = made.client();
      await app.query("begin");
      await app.query("update tickets set body = ? where id = ?", ["Charged three times", "t1"]);
      let settled = false;
      const writing = connector.write("t1", decided, sent).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await app.query("commit");
      expect(await writing).toEqual({ written: false });
      expect(await made.decisionOf("t1")).toBeNull();
      expect(await made.sideRows()).toEqual([{ id: "t1", status: "pending" }]);
      // The trigger cleared the claim: the ack leaves the job, to be asked at the new state.
      await connector.ack(["t1"]);
      expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null }]);
    });

    for (const onChange of ["reset", "keep"] as const) {
      it(`a state change waits for a side row a write holds (onChange ${onChange}): the write that locked it first commits first, and the change lands after it`, async () => {
        const made = await world(ticketsTarget(onChange));
        await made.install();
        await made.edit("t1", { subject: "Refund", body: "Charged twice" });
        // The worker login runs write's three statements by hand, holding the transaction open
        // between them.
        const worker = made.client("facetdb_worker", PASSWORD);
        await worker.query("set session transaction isolation level read committed");
        await worker.query("begin");
        await worker.query(
          `insert into ${SIDE} (id) select id from tickets where id = ? on duplicate key update facetdb_status = facetdb_status`,
          ["t1"],
        );
        const app = made.client();
        let landed = false;
        const changing = app
          .query("update tickets set body = ? where id = ?", ["Charged three times", "t1"])
          .then(() => {
            landed = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(landed).toBe(false);
        // The state the write reads is still the one it was sent for: the change has not landed.
        expect(await worker.query("select body from tickets where id = ?", ["t1"])).toEqual([
          { body: "Charged twice" },
        ]);
        await worker.query(
          `update ${SIDE} set facetdb_status = 'done', facetdb_updated_at = now(3) where id = ?`,
          ["t1"],
        );
        await worker.query("commit");
        await changing;
        expect(landed).toBe(true);
        expect(await made.sideRows()).toEqual([
          { id: "t1", status: onChange === "reset" ? "pending" : "done" },
        ]);
        expect(await made.jobs()).toEqual([{ record_key: "t1", claimed_by: null }]);
      });
    }

    it("a key the application changes keeps its answers, and its update is never refused for the side row", async () => {
      const made = await world();
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";
      expect(await connector.write("t1", decided, sent)).toEqual({ written: true });
      await made.admin.query("update tickets set id = ? where id = ?", ["t9", "t1"]);
      expect(await made.sideRows()).toEqual([{ id: "t9", status: "done" }]);
      expect(await made.decisionOf("t9")).toEqual(decided);
    });

    it("a reader granted select on the table after install reads the view once migrate runs again, and not before", async () => {
      const made = await world();
      await made.install();
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      await made.admin.query(`create user '${READER}'@'%' identified by '${READER_PASSWORD}'`);
      await made.admin.query(`grant select on \`${SCRATCH}\`.tickets to '${READER}'@'%'`);
      const reader = made.client(READER, READER_PASSWORD);
      expect(await errorOf(reader.query(`select * from ${VIEW}`))).toBe(1142);

      const plan = await made.plan();
      expect(plan.statements.map((statement) => statement.text)).toEqual([
        SETTINGS.text,
        expect.stringContaining("-- stops the script here"),
        `grant select on \`${SCRATCH}\`.\`${SIDE}\` to '${READER}'@'%'`,
        `grant select on \`${SCRATCH}\`.\`${VIEW}\` to '${READER}'@'%'`,
      ]);
      await made.install();
      const rows = await reader.query(
        `select id, subject, facetdb_status, not_priority from ${VIEW}`,
      );
      expect(rows).toEqual([
        { id: "t1", subject: "Refund", facetdb_status: "pending", not_priority: null },
      ]);
      // The view gives the reader nothing the table does not: no right to write FacetDB's rows.
      expect(await errorOf(reader.query(`update ${SIDE} set facetdb_status = 'done'`))).toBe(1142);
    });

    it("refuses a MyISAM table, whose table locks the worker's row lock could wait on until a timeout, and plans inline mode on it as before", async () => {
      const made = await world(ticketsTarget("reset"), "engine = MyISAM");
      const planned = await made.installer.planInstall(made.target, made.adminUrl, {
        ...deps(made.clock),
        workerPassword: PASSWORD,
      });
      expect(planned).toMatchObject({ ok: false, refusal: { code: "table-engine" } });
      const inline = await made.installer.planInstall(
        { ...made.target, storage: "inline" },
        made.adminUrl,
        { ...deps(made.clock), workerPassword: PASSWORD },
      );
      expect(inline.ok).toBe(true);
    });

    it("on a partitioned table, which takes no foreign key, a deleted record's row stays out of sight and a record inserted again starts fresh", async () => {
      const made = await world(
        ticketsTarget("reset"),
        "engine = InnoDB partition by key (id) partitions 2",
      );
      const plan = await made.plan();
      expect(plan.statements.some((statement) => statement.text.includes("foreign key"))).toBe(
        false,
      );
      expect(
        plan.notes.some((note) => note.includes("an InnoDB foreign key cannot reference")),
      ).toBe(true);
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";
      expect(await connector.write("t1", decided, sent)).toEqual({ written: true });

      await made.admin.query("delete from tickets where id = ?", ["t1"]);
      expect(await made.sideRows()).toEqual([{ id: "t1", status: "done" }]);
      expect((await connector.current(["t1"])).has("t1")).toBe(false);
      expect(await made.admin.query(`select id from ${VIEW}`)).toEqual([]);

      await made.edit("t1", { subject: "Another", body: "ticket" });
      expect(await made.sideRows()).toEqual([{ id: "t1", status: "pending" }]);
      expect(await made.decisionOf("t1")).toBeNull();
    });

    it("prune drops a removed question's columns from the side table and makes the view again first", async () => {
      const made = await world();
      await made.install();
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      made.target = ticketsTarget("keep", {
        ...questionSet,
        questions: CONTRACT_QUESTIONS.filter((question) => question.name !== "urgency"),
      });
      const before = await made.createTable();
      await made.prune();
      const columns = await made.admin.query(
        "select column_name as name from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position",
        [SCRATCH, SIDE],
      );
      expect(columns.map((row) => row["name"])).not.toContain("urgency");
      expect(columns.map((row) => row["name"])).not.toContain("urgency_confidence");
      const [row] = await made.admin.query(`select * from ${VIEW}`);
      expect(row).not.toHaveProperty("urgency");
      expect(row).toHaveProperty("category");
      await made.install();
      expect(await made.plan()).toMatchObject({ statements: [] });
      expect(await made.createTable()).toBe(before);
    });

    it("a record deleted while a write waits for its side row writes nothing, and the write says so", async () => {
      const made = await world();
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";
      // The application deletes the record and stays open: the cascade holds the side row.
      const app = made.client();
      await app.query("begin");
      await app.query("delete from tickets where id = ?", ["t1"]);
      const writing = connector.write("t1", decided, sent);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await app.query("commit");
      expect(await writing).toEqual({ written: false });
      expect(await made.sideRows()).toEqual([]);
    });

    it("refuses a view the customer wrote under FacetDB's name, even one over the side table, and leaves it", async () => {
      const made = await world();
      await made.install();
      await made.admin.query(
        `create or replace view ${VIEW} as select t.id, a.facetdb_status from tickets t join ${SIDE} a on a.id = t.id`,
      );
      const planned = await made.installer.planInstall(made.target, made.adminUrl, {
        ...deps(made.clock),
        workerPassword: PASSWORD,
      });
      expect(planned).toMatchObject({ ok: false, refusal: { code: "name-taken" } });
      const uninstall = await made.installer.planUninstall(made.target, made.adminUrl, {
        ...deps(made.clock),
        purge: false,
        alsoUninstalling: [],
      });
      expect(
        uninstall.ok && uninstall.plan.statements.some((one) => one.text.startsWith("drop view")),
      ).toBe(false);
    });

    it("uninstall takes back every right on the view and the side table, drops both, and leaves the table as it was", async () => {
      const made = await world();
      await made.admin.query(`create user '${READER}'@'%' identified by '${READER_PASSWORD}'`);
      await made.admin.query(`grant select on \`${SCRATCH}\`.tickets to '${READER}'@'%'`);
      const before = await made.createTable();
      await made.install();
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      // A right held with grant option is listed as `Grant` and taken back on its own.
      await made.admin.query(
        `grant select on \`${SCRATCH}\`.${VIEW} to '${READER}'@'%' with grant option`,
      );
      await made.uninstall();

      expect(await made.createTable()).toBe(before);
      const left = await made.admin.query(
        "select table_name as name from information_schema.tables where table_schema = ? order by table_name",
        [SCRATCH],
      );
      expect(left.map((one) => one["name"])).toEqual(["tickets"]);
      // No right is left on the two dropped side objects (MySQL would hand it to a later table of
      // the name); the reader keeps its own on the table, and the worker's on the shared tables go
      // with the login, as uninstall says.
      const grants = await made.admin.query(
        "select user as user_name, table_name as table_name from mysql.tables_priv where db = ? and table_name in (?, ?, ?) order by table_name, user",
        [SCRATCH, SIDE, VIEW, "tickets"],
      );
      expect(grants).toEqual([{ user_name: READER, table_name: "tickets" }]);
      const [triggers] = await made.admin.query(
        "select count(*) as n from information_schema.triggers where trigger_schema = ?",
        [SCRATCH],
      );
      expect(Number(triggers?.["n"])).toBe(0);
    });
  });
}
