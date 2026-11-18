import type {
  Clock,
  EngineDeps,
  EngineTarget,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { EngineRefusal } from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createMysqlEngine } from "../engine/index.ts";
import { URL_VARIABLES, type UrlVariable } from "../index.ts";
import {
  createMysqlInstaller,
  JOBS_TABLE,
  SETTINGS,
  sideKeyConstraint,
  sideTableName,
  WORKER_ACCOUNT,
} from "../install/index.ts";
import { connectMysql, type MysqlClient, type MysqlRow } from "../sql/index.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  connectMysqlPool,
  createMysqlConnector,
  type MysqlConnector,
  type MysqlPoolConnect,
} from "./index.ts";

/**
 * The runtime connector on a real MySQL 8 and a real MariaDB 10.6, the first run of the install on
 * either: the listings-shaped fixture is installed by the plan, as `facetdb migrate` runs it, then
 * the connector contract suite with a peer, then what only a server proves: the second plan of an
 * installed table is empty (the stored trigger bodies read back as generated), a claim older than
 * its lease is reclaimed, two workers claiming at once never share a key over fifty rounds, an
 * application write while a key is claimed makes `write` refuse and the trigger re-queue, and a
 * batch of 20 costs at most 2 statements per record. One SQL text, no branch by engine: the same
 * file runs on both servers.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const PASSWORD = "facetdb-worker-test-password";
/** The scratch database of this file; the files of a package run one at a time (vitest.db.config.ts). */
const SCRATCH = "facetdb_t064";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: {},
};

function ticketsTarget(onChange: "keep" | "reset" = "keep"): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange,
    questionSet,
    urlVariable: "TICKETS_URL",
  };
}

/** The server's URL with the scratch database as its path, and the worker's with its login too. */
function urlsOf(server: string): { readonly admin: string; readonly worker: string } {
  const admin = new URL(server);
  admin.pathname = `/${SCRATCH}`;
  const worker = new URL(admin);
  worker.username = "facetdb_worker";
  worker.password = PASSWORD;
  return { admin: admin.toString(), worker: worker.toString() };
}

function deps(clock: Clock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/** A pool that counts every statement it sends, around the real one. */
function counting(connect: MysqlPoolConnect): { connect: MysqlPoolConnect; sent: string[] } {
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
        // The pool's own `begin`, `commit` and `rollback` are counted as its contract sends them.
        transaction: async (work) => {
          sent.push("begin");
          try {
            const result = await pool.transaction((statement) =>
              work((text, params) => {
                sent.push(text);
                return statement(text, params);
              }),
            );
            sent.push("commit");
            return result;
          } catch (error) {
            sent.push("rollback");
            throw error;
          }
        },
        close: () => pool.close(),
      };
    },
  };
}

/**
 * What a reset makes and nothing else drops: the scratch database and the worker login, whose
 * password is this file's. The suite's `afterAll` drops them on each server, whatever its cases did.
 */
async function dropScratch(server: string): Promise<void> {
  const root = connectMysql(server);
  try {
    await root.query(`drop database if exists \`${SCRATCH}\``);
    await root.query(`drop user if exists ${WORKER_ACCOUNT}`);
  } finally {
    await root.close();
  }
}

/** One scratch database on the server, installed by the install plan, with the connectors opened on it. */
class World {
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly admin: MysqlClient;
  readonly urls: { readonly admin: string; readonly worker: string };
  readonly opened: MysqlConnector[] = [];
  readonly installer = createMysqlInstaller({ connect: connectMysql });

  constructor(server: string, target: EngineTarget = ticketsTarget()) {
    this.target = target;
    this.urls = urlsOf(server);
    this.admin = connectMysql(this.urls.admin);
  }

  /** A fresh scratch database and a fresh worker login, then the table (`more` columns after its own). */
  async reset(server: string, more = ""): Promise<void> {
    await dropScratch(server);
    const root = connectMysql(server);
    try {
      await root.query(`create database \`${SCRATCH}\` character set utf8mb4`);
    } finally {
      await root.close();
    }
    await this.admin.query(
      `create table tickets (id varchar(64) primary key, subject text, body text${more}) character set utf8mb4`,
    );
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
      if (planned.refusal.message.includes("is not installed")) {
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
    options: { readonly scanPageSize?: number; readonly connect?: MysqlPoolConnect } = {},
  ): Promise<MysqlConnector> {
    const connector = await createMysqlConnector(this.target, this.urls.worker, {
      clock: this.clock,
      workerId,
      connect: options.connect ?? connectMysqlPool,
      maxConnections: 4,
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(options.scanPageSize === undefined ? {} : { scanPageSize: options.scanPageSize }),
    });
    this.opened.push(connector);
    return connector;
  }

  /** The application's own write, through the admin: inserts the row or updates its state. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.admin.query(
      "insert into tickets (id, subject, body) values (?, ?, ?) on duplicate key update subject = values(subject), body = values(body)",
      [key, state["subject"] ?? null, state["body"] ?? null],
    );
  }

  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const [row] = await this.admin.query(
      "select facetdb_status as status, facetdb_updated_at as written, not_priority as value, not_priority_probability as probability, facetdb_reviewed as reviewed from tickets where id = ?",
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

  async jobs(): Promise<readonly MysqlRow[]> {
    return this.admin.query(
      `select cast(record_key as char character set utf8mb4) as record_key, claimed_by, claim_token from ${JOBS_TABLE} order by record_key`,
    );
  }

  async close(): Promise<void> {
    for (const connector of this.opened.splice(0)) {
      await connector.close();
    }
    await this.admin.close();
  }
}

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
  status: "done",
};

for (const variable of URL_VARIABLES) {
  describe.skipIf(skipUnless(variable))(`the connector on ${variable}`, () => {
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

    async function world(target?: EngineTarget, more?: string): Promise<World> {
      const server = serverUrl(variable as UrlVariable);
      const made = new World(server, target);
      worlds.push(made);
      await made.reset(server, more);
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

    it("installs by the plan, and plans nothing on the installed table: the stored triggers read back as generated", async () => {
      const made = await world(ticketsTarget("reset"));
      await made.install();
      const again = await made.installer.planInstall(made.target, made.urls.admin, {
        ...deps(made.clock),
        workerPassword: PASSWORD,
      });
      expect(again).toEqual({
        ok: true,
        plan: { statements: [], transactional: false, removes: [], keeps: [], notes: [] },
      });
      // The triggers queue under the table's name, and reset sets a new row pending.
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      expect(await made.jobs()).toEqual([
        { record_key: "t1", claimed_by: null, claim_token: null },
      ]);
      expect(await made.decisionOf("t1")).toBeNull();
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
      const made = await world(ticketsTarget("reset"));
      await made.install();
      const connector = await made.connector("w1");
      await made.edit("t1", { subject: "Refund", body: "Charged twice" });
      expect(await connector.claim(10)).toEqual(["t1"]);
      const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";

      await made.edit("t1", { subject: "Refund", body: "Charged three times" });
      expect(await made.jobs()).toEqual([
        { record_key: "t1", claimed_by: null, claim_token: null },
      ]);
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

    it("a batch of 20 costs at most 2 statements per record on the answered path: claim, read, 20 writes, ack", async () => {
      const made = await world();
      await made.install();
      const counted = counting(connectMysqlPool);
      const connector = await made.connector("w1", { connect: counted.connect });
      for (let index = 0; index < 20; index += 1) {
        await made.edit(`k${String(index).padStart(2, "0")}`, { subject: "s", body: `b${index}` });
      }
      counted.sent.length = 0;

      const claimed = await connector.claim(20);
      expect(claimed).toHaveLength(20);
      const { rows } = await connector.read(claimed);
      expect(rows).toHaveLength(20);
      for (const row of rows) {
        expect(await connector.write(row.key, decided, row.hash)).toEqual({ written: true });
      }
      await connector.ack(claimed);
      expect(await made.jobs()).toEqual([]);
      expect(counted.sent.length).toBeLessThanOrEqual(40);
      expect(counted.sent.map((text) => text.split(" ")[0])).toEqual([
        "update",
        "select",
        "select",
        ...Array.from({ length: 20 }, () => "update"),
        "begin",
        "select",
        "delete",
        "commit",
      ]);
    });

    it("an ack while an application transaction holds one of its job rows never waits holding the others: the batch is given up and each key settles on its own", async () => {
      const made = await world();
      await made.install();
      const counted = counting(connectMysqlPool);
      const connector = await made.connector("w1", { connect: counted.connect });
      await made.edit("a", { subject: "s", body: "a1" });
      await made.edit("b", { subject: "s", body: "b1" });
      expect([...(await connector.claim(10))].sort()).toEqual(["a", "b"]);

      // The application's transaction changes record b and stays open: its trigger's upsert holds
      // job b with the claim cleared, uncommitted.
      const app = connectMysql(made.urls.admin);
      try {
        await app.query("begin");
        await app.query("update tickets set body = ? where id = ?", ["b2", "b"]);
        counted.sent.length = 0;
        const acking = connector.ack(["a", "b"]);
        // The probe fails at once; the one-key delete of b then waits for the application, holding
        // nothing, and finishes when the application commits.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(counted.sent.map((text) => text.split(" ")[0])).toEqual([
          "begin",
          "select",
          "rollback",
          "delete",
          "delete",
        ]);
        expect(
          await made.admin.query(`select 1 from ${JOBS_TABLE} where record_key = 'a'`),
        ).toEqual([]);
        await app.query("commit");
        await acking;
      } finally {
        await app.close();
      }
      // a is settled; b's claim was cleared by the trigger, so it stays, to be asked at its new state.
      expect(await made.jobs()).toEqual([{ record_key: "b", claimed_by: null, claim_token: null }]);
      expect(await connector.claim(10)).toEqual(["b"]);
    });

    it("drops NO_BACKSLASH_ESCAPES from its own sessions: a state value with quotes and backslashes reads, guards and writes right", async () => {
      const made = await world();
      await made.install();
      const server = serverUrl(variable as UrlVariable);
      const root = connectMysql(server);
      const [before] = await root.query("select @@global.sql_mode as mode");
      const mode = String(before?.["mode"] ?? "");
      try {
        await root.query(
          `set global sql_mode = '${[...mode.split(",").filter((part) => part !== ""), "NO_BACKSLASH_ESCAPES"].join(",")}'`,
        );
        const connector = await made.connector("w1");
        const tricky = String.raw`O'Reilly \ "x" ' as binary) or 1=1 -- `;
        await made.edit("t1", { subject: tricky, body: "b" });
        await made.edit("t2", { subject: "plain", body: "b" });
        const { rows } = await connector.read(["t1"]);
        expect(rows[0]?.state["subject"]).toBe(tricky);
        expect(await connector.write("t1", decided, rows[0]?.hash ?? "")).toEqual({
          written: true,
        });
        expect(await made.decisionOf("t1")).toEqual(decided);
        // The guard matched one row: the other record is untouched.
        expect(await made.decisionOf("t2")).toBeNull();
      } finally {
        await root.query("set global sql_mode = ?", [mode]);
        await root.close();
      }
    });

    it("a backfill asks the newest record first by created_at, which install grants the worker, whatever order the keys sort in", async () => {
      const made = await world(ticketsTarget(), ", created_at datetime(3) not null");
      const planned = await made.installer.planInstall(made.target, made.urls.admin, {
        ...deps(made.clock),
        workerPassword: PASSWORD,
      });
      expect(planned.ok && planned.plan.notes.at(-1)).toContain(
        "asks its newest records first, by created_at",
      );
      await made.install();
      // Keys whose order is not the records' age, as uuids are: the newest has the smallest key.
      const rows: readonly (readonly [string, string])[] = [
        ["c-oldest", "2026-11-01 09:00:00.000"],
        ["a-newest", "2026-11-04 09:00:00.000"],
        ["b-middle", "2026-11-02 09:00:00.000"],
      ];
      for (const [id, created] of rows) {
        await made.admin.query(
          "insert into tickets (id, subject, body, created_at) values (?, 's', 'b', ?)",
          [id, created],
        );
      }
      const connector = await made.connector("w1", { scanPageSize: 2 });
      const first = await connector.scan(null);
      expect(first.rows.map((row) => row.key)).toEqual(["a-newest", "b-middle"]);
      const second = await connector.scan(first.next);
      expect(second.rows.map((row) => row.key)).toEqual(["c-oldest"]);
      // A key-only cursor saved before migrate granted created_at starts again from the newest.
      const restarted = await connector.scan(JSON.stringify(["b-middle"]));
      expect(restarted.rows.map((row) => row.key)).toEqual(["a-newest", "b-middle"]);
    });

    it("a timestamp created_at orders and resumes by its instant, whatever zone each session wrote or reads it in", async () => {
      const made = await world(ticketsTarget(), ", created_at timestamp(3) null");
      await made.install();
      // The application writes from sessions in zones of their own; the server keeps the instant.
      // Read as local text in one zone, d-early (14:00 at +05:00, 09:00 UTC) would sort after
      // e-late (06:30 at -03:00, 09:30 UTC); by instant it comes first. Two share an instant.
      const writes: readonly (readonly [string, string, string])[] = [
        ["+05:00", "c-oldest", "2026-11-01 14:00:00.000"],
        ["+05:00", "d-early", "2026-11-04 14:00:00.000"],
        ["-03:00", "e-late", "2026-11-04 06:30:00.250"],
        ["+00:00", "a-tie", "2026-11-04 09:30:00.250"],
      ];
      for (const [zone, id, created] of writes) {
        await made.admin.query("set session time_zone = ?", [zone]);
        await made.admin.query(
          "insert into tickets (id, subject, body, created_at) values (?, 's', 'b', ?)",
          [id, created],
        );
      }
      const connector = await made.connector("w1", { scanPageSize: 1 });
      const keys: string[] = [];
      const cursors: (string | null)[] = [];
      let cursor: string | null = null;
      do {
        const page = await connector.scan(cursor);
        keys.push(...page.rows.map((row) => row.key));
        cursor = page.next;
        cursors.push(cursor);
      } while (cursor !== null);
      // Newest first by instant, the tie broken by the key, each record once.
      expect(keys).toEqual(["e-late", "a-tie", "d-early", "c-oldest"]);
      // The cursor carries unix_timestamp's number, the stored instant, not a zone's text.
      const [stamp] = await made.admin.query(
        "select cast(unix_timestamp(created_at) as char) as n from tickets where id = 'e-late'",
      );
      expect(cursors[0]).toBe(JSON.stringify([String(stamp?.["n"]), "e-late"]));
      // A saved cursor resumes in another connector with the rest, each record once.
      const later = await made.connector("w2", { scanPageSize: 10 });
      expect((await later.scan(cursors[1] ?? null)).rows.map((row) => row.key)).toEqual([
        "d-early",
        "c-oldest",
      ]);
      // A cursor of local-time text from before is never compared: it starts again.
      const restarted = await later.scan(JSON.stringify(["2026-11-04 09:30:00.250", "e-late"]));
      expect(restarted.rows.map((row) => row.key)).toEqual([
        "e-late",
        "a-tie",
        "d-early",
        "c-oldest",
      ]);
    });

    it("side-table mode on a table turned MyISAM after install: open refuses and doctor fails, in install's words", async () => {
      const made = await world({ ...ticketsTarget("reset"), storage: "side-table" });
      await made.install();
      await (await made.connector("w1")).close();
      // The side table's foreign key holds the table to InnoDB on both servers (errors 3776, 1217):
      // a conversion goes through dropping it first.
      await made.admin.query(
        `alter table ${sideTableName("tickets")} drop foreign key ${sideKeyConstraint("tickets")}`,
      );
      await made.admin.query("alter table tickets engine = MyISAM");
      const opening = made.connector("w2");
      await expect(opening).rejects.toBeInstanceOf(EngineRefusal);
      await expect(opening).rejects.toMatchObject({
        refusal: {
          code: "table-engine",
          message: expect.stringContaining(`${SCRATCH}.tickets is a MyISAM table`),
          fix: `convert the table to InnoDB (alter table ${SCRATCH}.tickets engine = InnoDB), or set storage "inline" for this source, then run facetdb migrate again`,
        },
      });
      const checks = await createMysqlEngine().doctor(
        made.target,
        made.urls.worker,
        deps(made.clock),
      );
      expect(checks.find((check) => check.name === "install")).toMatchObject({
        status: "fail",
        detail: expect.stringContaining(`${SCRATCH}.tickets is a MyISAM table`),
      });
    });

    it("the script's settings add NO_AUTO_CREATE_USER to the session on MariaDB, under any sql_mode, and change no mode on MySQL", async () => {
      const made = await world();
      await made.admin.query("set session sql_mode = ''");
      await made.admin.query(SETTINGS.text);
      const [row] = await made.admin.query(
        "select @@session.sql_mode as mode, @@session.lock_wait_timeout as wait, version() as version",
      );
      const mariadb = /mariadb/i.test(String(row?.["version"]));
      expect(String(row?.["mode"])).toBe(mariadb ? "NO_AUTO_CREATE_USER" : "");
      expect(Number(row?.["wait"])).toBe(10);
      // Run again on a mode that has it, it stays one.
      await made.admin.query(SETTINGS.text);
      const [again] = await made.admin.query("select @@session.sql_mode as mode");
      expect(String(again?.["mode"])).toBe(mariadb ? "NO_AUTO_CREATE_USER" : "");
    });
  });
}
