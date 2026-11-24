import {
  EngineRefusal,
  type EngineTarget,
  type QuestionSet,
  type RecordDecision,
  type RecordKey,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type FakeServer, type FakeServerOptions, fakeServer } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  createMysqlConnector,
  MYSQL_CAPABILITIES,
  type MysqlConnector,
  mysqlTime,
  POLL_MS,
  parseMysqlTime,
} from "./index.ts";

/**
 * The MySQL runtime connector on the in-memory fake server: the connector contract suite with a
 * peer, then the statements themselves (every queue statement carries `table_name`, times are the
 * clock's as text, the claim is one update stamping a token then a select by it, ack and release
 * match the token, claimKey is a plain insert whose duplicate is the false, enqueue is the no-op
 * upsert, write is one guarded update), the 1-second poll under the fake clock, the lease, and what
 * `open` refuses. The real servers run the same SQL in connector.db.test.ts.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };
const URL = "mysql://facetdb_worker:secret@127.0.0.1:3306/app";
const TOKEN = /^[0-9a-f]{32}$/;

function questionSet(): QuestionSet {
  return { questions: CONTRACT_QUESTIONS, read: [...FIELDS], model: "jev-1.14.0", thresholds: {} };
}

function ticketsTarget(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange: "keep",
    questionSet: questionSet(),
    urlVariable: "TICKETS_URL",
    ...changes,
  };
}

const SERVER: FakeServerOptions = { database: "app", table: "tickets", state: [...FIELDS] };

class World {
  readonly server: FakeServer;
  readonly clock = new FakeClock(START);
  readonly target: EngineTarget;
  readonly opened: MysqlConnector[] = [];

  constructor(target: EngineTarget = ticketsTarget(), server: Partial<FakeServerOptions> = {}) {
    this.target = target;
    this.server = fakeServer({ ...SERVER, onChange: target.onChange, ...server });
  }

  /** A connector; with `installed`, one whose install and uninstall the fake world already did. */
  connector(workerId: string, scanPageSize?: number, installed = false): Promise<MysqlConnector> {
    return createMysqlConnector(this.target, URL, {
      clock: this.clock,
      workerId,
      connect: this.server.connect,
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
      ...(installed
        ? { installer: { install: () => Promise.resolve(), uninstall: () => Promise.resolve() } }
        : {}),
    }).then((connector) => {
      this.opened.push(connector);
      return connector;
    });
  }

  /** The statements sent since the last look, their text with the parameters. */
  take(): readonly { readonly text: string; readonly params: readonly unknown[] | undefined }[] {
    const sent = this.server.sent;
    const taken = sent.slice(this.#seen);
    this.#seen = sent.length;
    return taken;
  }

  #seen = 0;

  decisionOf(key: RecordKey): RecordDecision | null {
    const row = this.server.rows.get(key);
    if (row === undefined || row["facetdb_updated_at"] === null) {
      return null;
    }
    const value = row["not_priority"];
    const probability = row["not_priority_probability"];
    return {
      decisions:
        value === null || value === undefined || probability === null || probability === undefined
          ? {}
          : {
              not_priority: {
                kind: "decided",
                value: value === true,
                probabilityOrConfidence: Number(probability),
              },
            },
      status: String(row["facetdb_status"]) as RecordDecision["status"],
      ...(row["facetdb_reviewed"] === true ? { reviewed: true as const } : {}),
    };
  }

  jobs(): readonly (readonly [key: string, claimedBy: string | null])[] {
    return [...this.server.jobs]
      .sort((a, b) => a.recordKey.localeCompare(b.recordKey))
      .map((job) => [job.recordKey, job.claimedBy] as const);
  }
}

describe("mysql connector contract", () => {
  runConnectorContract(async () => {
    const made = new World();
    // Pages of 10, so the 25 seeded records cross page boundaries.
    const connector = await made.connector("w1", 10, true);
    const peer = await made.connector("w2", 10, true);
    return {
      connector,
      peer,
      fields: [...FIELDS],
      edit: (key, state) => Promise.resolve(made.server.edit(key, state)),
      // MySQL and MariaDB do not write `_probabilities` yet.
      probabilities: "not-yet",
      decisionOf: (key) => Promise.resolve(made.decisionOf(key)),
      clock: made.clock,
      close: async () => {
        for (const opened of made.opened) {
          await opened.close();
        }
      },
    };
  });
});

const decided: RecordDecision = {
  decisions: {
    not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 },
  },
  status: "done",
};

async function refusalOf(pending: Promise<unknown>): Promise<EngineRefusal> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof EngineRefusal)) {
    throw new Error(`expected an EngineRefusal, got ${String(error)}`);
  }
  return error;
}

describe("times", () => {
  it("writes the clock's time as a UTC datetime(3) literal and reads it back", () => {
    expect(mysqlTime(START)).toBe("2026-11-04 09:00:00.000");
    expect(mysqlTime(START + 1)).toBe("2026-11-04 09:00:00.001");
    expect(parseMysqlTime("2026-11-04 09:00:00.001")).toBe(START + 1);
    expect(parseMysqlTime("yesterday")).toBeNaN();
  });
});

describe("the mysql connector", () => {
  it("declares inline columns, a side table, several workers and no push wake-up", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    expect(connector.capabilities).toBe(MYSQL_CAPABILITIES);
    expect(connector.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: false,
      transactions: true,
      sideTable: true,
      multipleWorkers: true,
    });
  });

  it("opens a pool as wide as the worker asks, reads the key from the catalog, and closes the pool with the connector", async () => {
    const made = new World();
    const connector = await createMysqlConnector(made.target, URL, {
      clock: made.clock,
      connect: made.server.connect,
      maxConnections: 10,
      workerId: "w1",
    });
    expect(made.server.pools).toEqual([{ maxConnections: 10 }]);
    expect(connector.workerId).toBe("w1");
    // The source names no schema, so the connection's database is asked; the key comes from the
    // catalog as the worker sees it.
    expect(made.take().map((sent) => [sent.text.split(" from ")[0], sent.params])).toEqual([
      ["select database() as name", undefined],
      ["select table_type as type", ["app", "tickets"]],
      ["select column_name as name", ["app", "tickets"]],
    ]);
    await connector.close();
    expect(made.server.closed).toBe(1);
    await connector.close();
    expect(made.server.closed).toBe(1);
  });

  it("watch polls the table's waiting jobs every second through the clock, announcing a key once", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.take();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(["t1"]);
    expect(made.take()).toEqual([
      {
        text: "select record_key from `app`.`facetdb_jobs` where table_name = ? and claimed_at is null order by enqueued_at, record_key limit ?",
        params: ["tickets", 200],
      },
    ]);
    made.server.edit("t2", { subject: "Bug", body: "Crash on save" });
    // t1 waits still and is not announced again; t2 is, one poll later.
    expect((await iterator.next()).value).toEqual(["t2"]);
    expect(made.clock.sleeps).toEqual([POLL_MS]);
    await iterator.return?.();
    await connector.close();
    const woken = connector.watch()[Symbol.asyncIterator]();
    expect(await woken.next()).toEqual({ done: true, value: undefined });
  });

  it("claim is one update stamping a token, this worker and the lease, then a select by the token", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.server.edit("t2", { subject: "Bug", body: "Crash on save" });
    made.take();

    expect(await connector.claim(20)).toEqual(["t1", "t2"]);
    const [update, select] = made.take();
    expect(update?.text).toBe(
      "update `app`.`facetdb_jobs` set claim_token = ?, claimed_by = ?, claimed_at = ? where table_name = ? and (claimed_at is null or claimed_at < ?) order by enqueued_at, record_key limit ?",
    );
    const [token, worker, at, table, expired, limit] = update?.params ?? [];
    expect(String(token)).toMatch(TOKEN);
    expect([worker, at, table, expired, limit]).toEqual([
      "w1",
      "2026-11-04 09:00:00.000",
      "tickets",
      "2026-11-04 08:45:00.000",
      20,
    ]);
    expect(select).toEqual({
      text: "select record_key from `app`.`facetdb_jobs` where table_name = ? and claim_token = ?",
      params: ["tickets", token],
    });
    expect(made.jobs()).toEqual([
      ["t1", "w1"],
      ["t2", "w1"],
    ]);
    // Nothing left to claim: the update matched no row, so nothing is read back.
    expect(await connector.claim(20)).toEqual([]);
    expect(made.take()).toHaveLength(1);
    expect(await connector.claim(0)).toEqual([]);
  });

  it("@timing a claim's 15-minute lease ends on the clock, and the job goes to the next claim", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });

    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(made.server.jobs[0]?.claimedAt).toBe("2026-11-04 09:00:00.000");
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(CLAIM_LEASE_MS);
    // Exactly 15 minutes is still within the lease.
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(1);
    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(made.server.jobs[0]?.claimedAt).toBe(mysqlTime(START + CLAIM_LEASE_MS + 1));
  });

  it("ack and release match the token: a claim the trigger cleared stays queued, a released one goes to any worker", async () => {
    const made = new World();
    const first = await made.connector("w1");
    const second = await made.connector("w2");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.server.edit("t2", { subject: "Bug", body: "Crash on save" });
    made.server.edit("t3", { subject: "Login", body: "Password reset fails" });

    expect(await first.claim(10)).toEqual(["t1", "t2", "t3"]);
    expect(await second.claim(10)).toEqual([]);
    const token = made.server.jobs[0]?.claimToken;
    made.take();

    // The application changes t1 while w1 holds it: the trigger clears the claim.
    made.server.edit("t1", { subject: "Refund", body: "Charged three times" });
    await first.ack(["t1", "t2"]);
    // One short transaction: the batch is locked without waiting, then deleted by the token.
    expect(made.take()).toEqual([
      { text: "begin", params: undefined },
      {
        text: "select record_key from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key in (?) for update nowait",
        params: ["tickets", token, ["t1", "t2"]],
      },
      // t1's claim was cleared by the trigger, so the probe locked t2 alone, and only t2 is deleted.
      {
        text: "delete from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key in (?)",
        params: ["tickets", token, ["t2"]],
      },
      { text: "commit", params: undefined },
    ]);
    expect(made.jobs()).toEqual([
      ["t1", null],
      ["t3", "w1"],
    ]);

    await first.release(["t3"]);
    expect(made.take().map((sent) => sent.text)).toEqual([
      "begin",
      "select record_key from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key in (?) for update nowait",
      "update `app`.`facetdb_jobs` set claimed_at = null, claimed_by = null, claim_token = null where table_name = ? and claim_token = ? and record_key in (?)",
      "commit",
    ]);
    expect(await second.claim(10)).toEqual(["t1", "t3"]);
    // A key this worker never claimed settles nothing: no statement goes.
    made.take();
    await first.ack(["t1", "t3", "never"]);
    expect(made.take()).toEqual([]);
    expect(made.jobs()).toEqual([
      ["t1", "w2"],
      ["t3", "w2"],
    ]);
  });

  it("a settle whose probe cannot lock a row an application transaction holds goes one key at a time, holding nothing", async () => {
    const made = new World();
    const worker = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.server.edit("t2", { subject: "Bug", body: "Crash on save" });
    expect(await worker.claim(10)).toEqual(["t1", "t2"]);
    const token = made.server.jobs[0]?.claimToken;
    made.take();

    // The application's open transaction holds job t2 (its trigger just cleared the claim).
    made.server.locked.add("t2");
    await worker.ack(["t1", "t2"]);
    expect(made.take()).toEqual([
      { text: "begin", params: undefined },
      {
        text: "select record_key from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key in (?) for update nowait",
        params: ["tickets", token, ["t1", "t2"]],
      },
      { text: "rollback", params: undefined },
      {
        text: "delete from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key = ?",
        params: ["tickets", token, "t1"],
      },
      {
        text: "delete from `app`.`facetdb_jobs` where table_name = ? and claim_token = ? and record_key = ?",
        params: ["tickets", token, "t2"],
      },
    ]);
    expect(made.jobs()).toEqual([]);
    // Settled once: the tokens are gone, so nothing goes again.
    await worker.ack(["t1", "t2"]);
    expect(made.take()).toEqual([]);
  });

  it("a settle that throws keeps the claim's token, so the next settle tries again", async () => {
    const made = new World();
    const worker = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    expect(await worker.claim(10)).toEqual(["t1"]);
    made.server.failNext = new Error("Lost connection to MySQL server during query");
    await expect(worker.release(["t1"])).rejects.toThrow("Lost connection");
    made.take();
    await worker.release(["t1"]);
    expect(made.take().map((sent) => sent.text.split(" ")[0])).toEqual([
      "begin",
      "select",
      "update",
      "commit",
    ]);
    expect(made.jobs()).toEqual([["t1", null]]);
  });

  it("claimKey inserts the job already claimed in one statement, and a duplicate is the false", async () => {
    const made = new World();
    const worker = await made.connector("w1");
    const backfill = await made.connector("backfill-1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.take();

    expect(await backfill.claimKey("t2")).toBe(true);
    const [insert] = made.take();
    expect(insert?.text).toBe(
      "insert into `app`.`facetdb_jobs` (table_name, record_key, claimed_by, claimed_at, claim_token) values (?, ?, ?, ?, ?)",
    );
    const [table, key, by, at, token] = insert?.params ?? [];
    expect([table, key, by, at]).toEqual([
      "tickets",
      "t2",
      "backfill-1",
      "2026-11-04 09:00:00.000",
    ]);
    expect(String(token)).toMatch(TOKEN);
    // Queued already, claimed or not: false, and the one statement.
    expect(await backfill.claimKey("t1")).toBe(false);
    expect(await backfill.claimKey("t2")).toBe(false);
    expect(made.take()).toHaveLength(2);
    expect(await worker.claim(10)).toEqual(["t1"]);
    await backfill.ack(["t2"]);
    expect(made.jobs()).toEqual([["t1", "w1"]]);
  });

  it("enqueue is one no-op upsert per key, never insert ignore, and keeps a held claim", async () => {
    const made = new World();
    const worker = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    expect(await worker.claim(1)).toEqual(["t1"]);
    made.take();

    await worker.enqueue(["t3", "t1", "t3", "t2"]);
    expect(made.take()).toEqual(
      ["t3", "t1", "t2"].map((key) => ({
        text: "insert into `app`.`facetdb_jobs` (table_name, record_key) values (?, ?) on duplicate key update table_name = table_name",
        params: ["tickets", key],
      })),
    );
    expect(made.jobs()).toEqual([
      ["t1", "w1"],
      ["t2", null],
      ["t3", null],
    ]);
    await worker.enqueue([]);
    expect(made.take()).toEqual([]);
  });

  it("read selects the key and the state as utf8mb4 text in one statement per 500 keys, and hashes them", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.server.edit("t2", { subject: "Bug", body: null });
    made.take();

    const { rows, missing } = await connector.read(["t2", "t1", "t2", "nowhere"]);
    expect(made.take()).toEqual([
      {
        text: "select cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` where `id` in (?)",
        params: [["t2", "t1", "nowhere"]],
      },
    ]);
    expect(rows.map(({ key, state, excluded }) => ({ key, state, excluded }))).toEqual([
      { key: "t2", state: { subject: "Bug", body: null }, excluded: false },
      { key: "t1", state: { subject: "Refund", body: "Charged twice" }, excluded: false },
    ]);
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.hash).not.toBe(rows[1]?.hash);
    expect(missing).toEqual(["nowhere"]);

    const many = Array.from({ length: 1_001 }, (_, index) => `k${index}`);
    await connector.read(many);
    const listed = (params: readonly unknown[] | undefined): number => {
      const [list] = params ?? [];
      return Array.isArray(list) ? list.length : -1;
    };
    expect(made.take().map((sent) => listed(sent.params))).toEqual([500, 500, 1]);
  });

  it("write after a read of the key is one guarded update: FacetDB's columns, only where the state bytes still equal what was read", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    const { rows } = await connector.read(["t1"]);
    const hash = rows[0]?.hash ?? "";
    made.take();

    expect(await connector.write("t1", decided, hash)).toEqual({ written: true });
    expect(made.take()).toEqual([
      {
        text: "update `app`.`tickets` set `not_priority` = ?, `not_priority_probability` = ?, `facetdb_status` = ?, `facetdb_updated_at` = ? where `id` = ? and cast(cast(`subject` as char character set utf8mb4) as binary) <=> cast(? as binary) and cast(cast(`body` as char character set utf8mb4) as binary) <=> cast(? as binary)",
        params: [false, 0.97, "done", "2026-11-04 09:00:00.000", "t1", "Refund", "Charged twice"],
      },
    ]);
    expect(made.decisionOf("t1")).toEqual(decided);

    // A reviewed decision sets the flag; a decision left for review writes NULLs.
    const reviewed: RecordDecision = {
      decisions: { not_priority: { kind: "needs_review" } },
      status: "needs_review",
      reviewed: true,
    };
    expect(await connector.write("t1", reviewed, hash)).toEqual({ written: true });
    expect(made.take()[0]?.params).toEqual([
      null,
      null,
      "needs_review",
      "2026-11-04 09:00:00.000",
      true,
      "t1",
      "Refund",
      "Charged twice",
    ]);
    expect(made.decisionOf("t1")).toEqual({
      decisions: {},
      status: "needs_review",
      reviewed: true,
    });
  });

  it("write without a read of that hash selects the state first, and a hash that moved writes nothing", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    const sent = (await connector.read(["t1"])).rows[0]?.hash ?? "";
    made.take();

    // Another process's hash is checked by a select, then the same guarded update.
    const other = await made.connector("w2");
    made.take();
    expect(await other.write("t1", decided, sent)).toEqual({ written: true });
    expect(made.take().map((one) => one.text.split(" ")[0])).toEqual(["select", "update"]);
    expect(made.take()).toEqual([]);

    // The application changes the record: the state the model saw is gone, so nothing is written,
    // on either path.
    made.server.edit("t1", { subject: "Refund", body: "Charged three times" });
    expect(await connector.write("t1", decided, sent)).toEqual({ written: false });
    expect(made.take().map((one) => one.text.split(" ")[0])).toEqual(["update"]);
    expect(await other.write("t1", decided, sent)).toEqual({ written: false });
    expect(made.take().map((one) => one.text.split(" ")[0])).toEqual(["select"]);
    expect(await connector.write("gone", decided, sent)).toEqual({ written: false });
    expect(made.take().map((one) => one.text.split(" ")[0])).toEqual(["select"]);
    // The decision written before the change stands; nothing was written over it.
    expect(made.decisionOf("t1")).toEqual(decided);
  });

  it("current reads FacetDB's columns as text and a noul as true or false", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    made.server.edit("t1", { subject: "Refund", body: "Charged twice" });
    made.server.edit("t2", { subject: "Bug", body: "Crash on save" });
    const { rows } = await connector.read(["t1"]);
    made.clock.advance(60_000);
    await connector.write("t1", decided, rows[0]?.hash ?? "");
    made.take();

    const current = await connector.current(["t1", "t2", "nowhere"]);
    expect(made.take()).toEqual([
      {
        text: "select cast(`id` as char character set utf8mb4) as k, cast(`not_priority` as char character set utf8mb4) as q0v, cast(`not_priority_probability` as char character set utf8mb4) as q0p, cast(`category` as char character set utf8mb4) as q1v, cast(`category_confidence` as char character set utf8mb4) as q1p, cast(`urgency` as char character set utf8mb4) as q2v, cast(`urgency_confidence` as char character set utf8mb4) as q2p, cast(`urgency_expected` as char character set utf8mb4) as q2e, `facetdb_status` as cs, cast(`facetdb_updated_at` as char character set utf8mb4) as cu, `facetdb_reviewed` as cr from `app`.`tickets` where `id` in (?)",
        params: [["t1", "t2", "nowhere"]],
      },
    ]);
    expect(current.get("t1")).toEqual({
      decisions: { not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
      status: "done",
      reviewed: false,
      updatedAt: new Date(START + 60_000),
    });
    expect(current.get("t2")).toEqual({
      decisions: {},
      status: "pending",
      reviewed: false,
      updatedAt: null,
    });
    expect(current.has("nowhere")).toBe(false);
  });

  it("install and uninstall run through the engine's plans: without an installer both reject", async () => {
    const made = new World();
    const connector = await made.connector("w1");
    await expect(connector.install()).rejects.toThrow("run `facetdb migrate`");
    await expect(connector.uninstall()).rejects.toThrow("run `facetdb uninstall`");
  });
});

describe("scan", () => {
  it("pages newest first by the key when the worker sees no created_at, with a keyset cursor", async () => {
    const made = new World();
    const connector = await made.connector("w1", 2);
    for (const key of ["m", "z", "a"]) {
      made.server.edit(key, { subject: "s", body: "b" });
    }
    made.take();

    const first = await connector.scan(null);
    expect(made.take()).toEqual([
      {
        text: "select data_type as data_type from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?",
        params: ["app", "tickets", "created_at"],
      },
      {
        text: "select cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` order by `id` desc limit ?",
        params: [2],
      },
    ]);
    expect(first.rows.map((row) => row.key)).toEqual(["z", "m"]);
    expect(first.next).toBe(JSON.stringify(["m"]));
    const second = await connector.scan(first.next);
    expect(made.take()).toEqual([
      {
        text: "select cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` where `id` < ? order by `id` desc limit ?",
        params: ["m", 2],
      },
    ]);
    expect(second).toMatchObject({ next: null });
    expect(second.rows.map((row) => row.key)).toEqual(["a"]);
    await expect(connector.scan("not a cursor")).rejects.toThrow(
      '"not a cursor" is not a scan cursor of a MySQL source',
    );
    await expect(connector.scan(JSON.stringify([1, "y"]))).rejects.toThrow("not a scan cursor");
    await expect(connector.scan(JSON.stringify([7]))).rejects.toThrow("not a scan cursor");
    // A cursor of the creation order, saved while the marker was readable, starts again from the
    // newest: the answered records are skipped by their hash.
    made.take();
    const again = await connector.scan(JSON.stringify(["2026-06-01 00:00:00.000", "m"]));
    const [restart] = made.take();
    expect(restart?.text).toContain("order by `id` desc limit ?");
    expect(restart?.text).not.toContain("where");
    expect(again.rows.map((row) => row.key)).toEqual(["z", "m"]);
  });

  it("pages by created_at then the key where the worker may read it, nulls last", async () => {
    const made = new World(ticketsTarget(), { createdAtType: "datetime" });
    const connector = await made.connector("w1", 2);
    made.server.edit("old", { subject: "s", body: "b" }, "2026-01-01 00:00:00.000");
    made.server.edit("new-a", { subject: "s", body: "b" }, "2026-06-01 00:00:00.000");
    made.server.edit("new-b", { subject: "s", body: "b" }, "2026-06-01 00:00:00.000");
    made.server.edit("undated", { subject: "s", body: "b" }, null);
    made.take();

    const first = await connector.scan(null);
    expect(made.take()[1]).toEqual({
      text: "select cast(`created_at` as char character set utf8mb4) as o, cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` order by `created_at` desc, `id` desc limit ?",
      params: [2],
    });
    expect(first.rows.map((row) => row.key)).toEqual(["new-b", "new-a"]);
    expect(first.next).toBe(JSON.stringify(["2026-06-01 00:00:00.000", "new-a"]));

    const second = await connector.scan(first.next);
    expect(made.take()).toEqual([
      {
        text: "select cast(`created_at` as char character set utf8mb4) as o, cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` where (`created_at` < ? or (`created_at` = ? and `id` < ?) or `created_at` is null) order by `created_at` desc, `id` desc limit ?",
        params: ["2026-06-01 00:00:00.000", "2026-06-01 00:00:00.000", "new-a", 2],
      },
    ]);
    expect(second.rows.map((row) => row.key)).toEqual(["old", "undated"]);
    expect(second.next).toBe(JSON.stringify([null, "undated"]));

    const third = await connector.scan(second.next);
    expect(made.take()[0]?.text).toContain("where `created_at` is null and `id` < ?");
    expect(third).toEqual({ rows: [], next: null });

    // A key-only cursor saved before migrate granted created_at starts the scan again from the
    // newest record, rather than stopping every run of the backfill.
    const restarted = await connector.scan(JSON.stringify(["new-a"]));
    const [sent] = made.take();
    expect(sent?.text).toContain("order by `created_at` desc, `id` desc limit ?");
    expect(sent?.text).not.toContain("where");
    expect(sent?.params).toEqual([2]);
    expect(restarted.rows.map((row) => row.key)).toEqual(["new-b", "new-a"]);
    // An instant from a timestamp marker is no datetime text: it starts again too, never compared.
    await connector.scan(JSON.stringify(["1793610000.000", "new-a"]));
    expect(made.take()[0]?.text).not.toContain("where");
  });

  it("sorts a timestamp created_at by the column, which an index serves, and bounds and resumes it by its instant, unix_timestamp, never its local-time text", async () => {
    const made = new World(ticketsTarget(), { createdAtType: "timestamp" });
    const connector = await made.connector("w1", 2);
    // What the fake prints for the marker is what the server's unix_timestamp prints.
    made.server.edit("old", { subject: "s", body: "b" }, "1793500000.000");
    made.server.edit("new-a", { subject: "s", body: "b" }, "1793610000.123");
    made.server.edit("new-b", { subject: "s", body: "b" }, "1793610000.123");
    made.take();

    const first = await connector.scan(null);
    expect(made.take()[1]).toEqual({
      text: "select cast(unix_timestamp(`created_at`) as char character set utf8mb4) as o, cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` order by `created_at` desc, `id` desc limit ?",
      params: [2],
    });
    expect(first.rows.map((row) => row.key)).toEqual(["new-b", "new-a"]);
    expect(first.next).toBe(JSON.stringify(["1793610000.123", "new-a"]));

    const second = await connector.scan(first.next);
    expect(made.take()).toEqual([
      {
        text: "select cast(unix_timestamp(`created_at`) as char character set utf8mb4) as o, cast(`id` as char character set utf8mb4) as k, cast(`subject` as char character set utf8mb4) as s0, cast(`body` as char character set utf8mb4) as s1, (false) as x from `app`.`tickets` where (unix_timestamp(`created_at`) < cast(? as decimal(20,6)) or (unix_timestamp(`created_at`) = cast(? as decimal(20,6)) and `id` < ?) or unix_timestamp(`created_at`) is null) order by `created_at` desc, `id` desc limit ?",
        params: ["1793610000.123", "1793610000.123", "new-a", 2],
      },
    ]);
    expect(second.rows.map((row) => row.key)).toEqual(["old"]);

    // A cursor of local-time text, written before the marker was ordered by its instant, is never
    // compared: the scan starts again from the newest record.
    const restarted = await connector.scan(JSON.stringify(["2026-11-02 14:00:00.000", "new-a"]));
    expect(made.take()[0]?.text).not.toContain("where");
    expect(restarted.rows.map((row) => row.key)).toEqual(["new-b", "new-a"]);
  });
});

describe("open refuses, and closes the pool, before anything else", () => {
  it("a table the worker login cannot see", async () => {
    const made = new World(ticketsTarget(), { installed: false });
    const refused = await refusalOf(made.connector("w1"));
    expect(refused.refusal.code).toBe("no-table");
    expect(refused.message).toBe(
      "app.tickets does not exist, or the worker login has no right on it",
    );
    expect(made.server.closed).toBe(1);
  });

  it("a config naming another key than the table's primary key", async () => {
    const made = new World(ticketsTarget({ key: "subject" }));
    const refused = await refusalOf(made.connector("w1"));
    expect(refused.refusal.code).toBe("primary-key");
    expect(refused.message).toBe(
      "app.tickets's primary key is id, not subject; the config and the table disagree",
    );
  });

  it("a connection string naming no database, when the source names none either", async () => {
    const made = new World(ticketsTarget(), { database: undefined });
    const refused = await refusalOf(made.connector("w1"));
    expect(refused.refusal.code).toBe("no-database");
    expect(refused.message).toBe(
      "TICKETS_URL names no database, and the source names no database for the table tickets",
    );
    expect(refused.refusal.fix).toContain("name the table as <database>.tickets in the config");
  });

  it("the schema the source names wins over the connection's database", async () => {
    const made = new World(ticketsTarget({ schema: "support" }), { database: undefined });
    const connector = await made.connector("w1");
    expect(made.take().map((sent) => sent.params)).toEqual([
      ["support", "tickets"],
      ["support", "tickets"],
    ]);
    made.server.edit("t1", { subject: "s", body: "b" });
    await connector.claim(1);
    expect(made.take()[0]?.text).toContain("update `support`.`facetdb_jobs`");
  });
});
