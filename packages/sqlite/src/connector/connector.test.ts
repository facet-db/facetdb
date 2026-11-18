import type { DatabaseSync } from "node:sqlite";
import {
  EngineRefusal,
  type EngineTarget,
  type OnChange,
  type QuestionSet,
  type RecordDecision,
  type RecordKey,
  type StateValue,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUSY_TIMEOUT_MS,
  planInstall,
  planUninstall,
  readInstalled,
  run,
  sqliteQuery,
} from "../install/index.ts";
import { FakeRepeat, type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import {
  CLAIM_LEASE_MS,
  createSqliteConnector,
  LOCK_FRESH_MS,
  LOCK_HEARTBEAT_MS,
  openNodeSqlite,
  POLL_MS,
  type SqliteConnector,
} from "./index.ts";

/**
 * The SQLite runtime connector on a temporary file: the connector contract suite (one worker, so no
 * peer), then what only SQLite does: the 15-minute lease under the fake clock, the one worker's
 * lock with its refusal and its stale takeover, and an application write from a handle of its own
 * re-queueing a claimed key while `write` refuses the stale answer.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const FIELDS = ["subject", "body"] as const;
const PROJECT = { id: "proj_tickets", name: "Tickets" };

function questionSet(): QuestionSet {
  return { questions: CONTRACT_QUESTIONS, read: [...FIELDS], model: "jev-1.14.0", thresholds: {} };
}

function ticketsTarget(onChange: OnChange = "keep"): EngineTarget {
  return {
    project: PROJECT,
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange,
    questionSet: questionSet(),
  };
}

/** One file, its application handle, and the connectors opened on it, closed after each test. */
class World {
  readonly file: TemporaryDatabase = temporaryDatabase();
  readonly clock = new FakeClock(START);
  /** Every connector's lock heartbeat: it beats only when a test moves the clock through it. */
  readonly beats = new FakeRepeat(this.clock);
  readonly app: DatabaseSync;
  readonly #connectors: SqliteConnector[] = [];

  readonly target: EngineTarget;

  constructor(target: EngineTarget = ticketsTarget()) {
    this.target = target;
    this.app = this.file.open({ timeout: BUSY_TIMEOUT_MS });
    this.app.exec("create table tickets (id text primary key, subject text, body text)");
  }

  /** `facetdb migrate`, as the engine plans it through a read-only handle and runs it. */
  async install(): Promise<void> {
    const reader = this.file.open({ readOnly: true });
    let planned: Awaited<ReturnType<typeof planInstall>>;
    try {
      planned = await planInstall(this.target, sqliteQuery(reader));
    } finally {
      reader.close();
    }
    if (!planned.ok) {
      throw new Error(planned.refusal.message);
    }
    const result = run(this.target, planned.plan, this.file.path);
    if (result.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  /** `facetdb uninstall`; nothing to do once nothing is installed. */
  async uninstall(): Promise<void> {
    const reader = this.file.open({ readOnly: true });
    let planned: Awaited<ReturnType<typeof planUninstall>> | undefined;
    try {
      const query = sqliteQuery(reader);
      if (!("reason" in (await readInstalled(query, this.target.table)))) {
        planned = await planUninstall(this.target, query, { alsoUninstalling: [] });
      }
    } finally {
      reader.close();
    }
    if (planned === undefined) {
      return;
    }
    if (!planned.ok) {
      throw new Error(planned.refusal.message);
    }
    const result = run(this.target, planned.plan, this.file.path);
    if (result.stopped !== undefined) {
      throw new Error(`uninstall stopped: ${JSON.stringify(result.stopped)}`);
    }
  }

  async connector(workerId: string, scanPageSize?: number): Promise<SqliteConnector> {
    const connector = await createSqliteConnector(this.target, this.file.path, {
      clock: this.clock,
      repeat: this.beats.repeat,
      workerId,
      installer: { install: () => this.install(), uninstall: () => this.uninstall() },
      ...(scanPageSize === undefined ? {} : { scanPageSize }),
    });
    this.#connectors.push(connector);
    return connector;
  }

  /** The application's own write, from its own handle: inserts the row or updates its state. */
  edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): void {
    this.app
      .prepare(
        `insert into tickets (id, subject, body) values (?, ?, ?)
          on conflict (id) do update set subject = excluded.subject, body = excluded.body`,
      )
      .run(key, state["subject"] ?? null, state["body"] ?? null);
  }

  decisionOf(key: RecordKey): RecordDecision | null {
    const row = this.app
      .prepare(
        `select facetdb_status as status, facetdb_updated_at as written, not_priority as value,
                not_priority_probability as probability, facetdb_reviewed as reviewed
           from tickets where id = ?`,
      )
      .get(key);
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

  jobs(): readonly Record<string, unknown>[] {
    return this.app
      .prepare("select record_key, claimed_by, claimed_at from facetdb_jobs order by record_key")
      .all();
  }

  lock(): Record<string, unknown> | undefined {
    return this.app
      .prepare("select worker_id, heartbeat_at from facetdb_table_owners where table_name = ?")
      .get("tickets");
  }

  async close(): Promise<void> {
    for (const connector of this.#connectors.splice(0)) {
      await connector.close();
    }
    this.file.remove();
  }
}

const worlds: World[] = [];

function world(target?: EngineTarget): World {
  const made = new World(target);
  worlds.push(made);
  return made;
}

afterEach(async () => {
  for (const made of worlds.splice(0)) {
    await made.close();
  }
});

describe("sqlite connector contract", () => {
  runConnectorContract(async () => {
    const made = world();
    // Pages of 10, so the 25 seeded records cross page boundaries.
    const connector = await made.connector("w1", 10);
    return {
      connector,
      fields: [...FIELDS],
      edit: (key, state) => Promise.resolve(made.edit(key, state)),
      decisionOf: (key) => Promise.resolve(made.decisionOf(key)),
      clock: made.clock,
    };
  });
});

const decided: RecordDecision = {
  decisions: {
    not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.97 },
  },
  status: "done",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

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

describe("the sqlite connector", () => {
  it("declares one worker, inline columns, no push wake-up and no side table", async () => {
    const made = world();
    await made.install();
    const connector = await made.connector("w1");
    expect(connector.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: false,
      transactions: true,
      sideTable: false,
      multipleWorkers: false,
    });
  });

  it("@timing a claim's 15-minute lease ends on the clock, and the job goes to the next claim", async () => {
    const made = world();
    await made.install();
    const connector = await made.connector("w1");
    made.edit("t1", { subject: "Refund", body: "Charged twice" });

    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(made.jobs()).toEqual([
      { record_key: "t1", claimed_by: "w1", claimed_at: new Date(START).toISOString() },
    ]);
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(CLAIM_LEASE_MS);
    // Exactly 15 minutes is still within the lease.
    expect(await connector.claim(10)).toEqual([]);
    made.clock.advance(1);
    expect(await connector.claim(10)).toEqual(["t1"]);
    expect(made.jobs()[0]?.["claimed_at"]).toBe(new Date(START + CLAIM_LEASE_MS + 1).toISOString());
  });

  it("watch polls every second through the clock, announcing a waiting key once", async () => {
    const made = world();
    await made.install();
    const connector = await made.connector("w1");
    made.edit("t1", { subject: "Refund", body: "Charged twice" });
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(["t1"]);
    made.edit("t2", { subject: "Bug", body: "Crash on save" });
    // t1 waits still and is not announced again; t2 is, one poll later.
    expect((await iterator.next()).value).toEqual(["t2"]);
    expect(made.clock.sleeps).toEqual([POLL_MS]);
    await iterator.return?.();
  });

  it("an application write from another handle re-queues a claimed key, and write refuses the stale answer", async () => {
    const made = world();
    await made.install();
    const connector = await made.connector("w1");
    made.edit("t1", { subject: "Refund", body: "Charged twice" });
    const [claimed] = await connector.claim(10);
    expect(claimed).toBe("t1");
    const { rows } = await connector.read(["t1"]);
    const sent = rows[0]?.hash ?? "";

    // The application changes the record while the model is asked: the trigger clears the claim.
    made.edit("t1", { subject: "Refund", body: "Charged three times" });
    expect(made.jobs()).toEqual([{ record_key: "t1", claimed_by: null, claimed_at: null }]);

    expect(await connector.write("t1", decided, sent)).toEqual({ written: false });
    expect(made.decisionOf("t1")).toBeNull();
    // The worker acks what it holds; the job is no longer its claim, so it stays to be asked again.
    await connector.ack(["t1"]);
    expect(await connector.claim(10)).toEqual(["t1"]);
    const fresh = (await connector.read(["t1"])).rows[0]?.hash ?? "";
    expect(fresh).not.toBe(sent);
    expect(await connector.write("t1", decided, fresh)).toEqual({ written: true });
    await connector.ack(["t1"]);
    expect(made.jobs()).toEqual([]);
    expect(made.decisionOf("t1")).toEqual(decided);
  });

  describe("one worker", () => {
    it("a second worker is refused while the first one's lock is fresh, and takes a stale one over", async () => {
      const made = world();
      await made.install();
      const first = await made.connector("w1");
      const second = await made.connector("w2");
      made.edit("t1", { subject: "Refund", body: "Charged twice" });

      expect(await first.claim(10)).toEqual(["t1"]);
      expect(made.lock()).toEqual({ worker_id: "w1", heartbeat_at: new Date(START).toISOString() });

      made.clock.advance(LOCK_FRESH_MS - 1);
      const refused = await refusalOf(second.claim(10));
      expect(refused.refusal.code).toBe("one-worker");
      expect(refused.message).toBe(
        `SQLite allows one worker, and worker w1 holds the lock on tickets in ${made.file.path}: it last renewed it at ${iso(START)}, and the lock frees at ${iso(START + LOCK_FRESH_MS)} unless it is renewed before then (a running worker renews it every 30 seconds)`,
      );
      expect(refused.refusal.fix).toBe(
        `stop the other facetdb worker first: a worker that stops lets go of its lock at once. One that was killed keeps it until ${iso(START + LOCK_FRESH_MS)}, 2 minutes after its last renewal; start this worker after then, and it takes the lock over`,
      );
      // watch is the worker's too.
      const watching = second.watch()[Symbol.asyncIterator]();
      expect((await refusalOf(watching.next())).refusal.code).toBe("one-worker");
      // Nothing of the refused claim was kept.
      expect(made.lock()?.["worker_id"]).toBe("w1");

      // Two minutes without a renewal: the lock is stale, and the next worker takes it over.
      made.clock.advance(1);
      expect(await second.claim(10)).toEqual([]);
      expect(made.lock()).toEqual({
        worker_id: "w2",
        heartbeat_at: new Date(START + LOCK_FRESH_MS).toISOString(),
      });
      expect((await refusalOf(first.claim(10))).message).toContain("worker w2 holds the lock");
    });

    it("renews its lock on every poll of watch, and lets go of it on close", async () => {
      const made = world();
      await made.install();
      const first = await made.connector("w1");
      const iterator = first.watch()[Symbol.asyncIterator]();
      made.edit("t1", { subject: "Refund", body: "Charged twice" });
      await iterator.next();
      made.edit("t2", { subject: "Bug", body: "Crash on save" });
      await iterator.next();
      expect(made.lock()).toEqual({
        worker_id: "w1",
        heartbeat_at: new Date(START + POLL_MS).toISOString(),
      });
      await iterator.return?.();

      await first.close();
      expect(made.lock()).toEqual({ worker_id: null, heartbeat_at: null });
      const second = await made.connector("w2");
      expect(await second.claim(10)).toEqual(["t1", "t2"]);
    });

    it("@timing a worker whose pass waits 3 minutes on the model keeps its lock: its own heartbeat renews it every 30 seconds", async () => {
      const made = world();
      await made.install();
      const first = await made.connector("w1");
      const second = await made.connector("w2");
      made.edit("t1", { subject: "Refund", body: "Charged twice" });
      expect(await first.claim(10)).toEqual(["t1"]);
      const sent = (await first.read(["t1"])).rows[0]?.hash ?? "";
      expect(made.beats.intervals).toEqual([LOCK_HEARTBEAT_MS]);

      // The pass waits on the model's backoff: no poll and no claim for 3 minutes, only the beats.
      await made.beats.advance(30_000);
      expect(made.lock()).toEqual({ worker_id: "w1", heartbeat_at: iso(START + 30_000) });
      await made.beats.advance(3 * 60_000 - 30_000);
      expect(made.lock()).toEqual({ worker_id: "w1", heartbeat_at: iso(START + 3 * 60_000) });

      // No second worker takes the lock, and the refusal says when it would free.
      const refused = await refusalOf(second.claim(10));
      expect(refused.refusal.code).toBe("one-worker");
      expect(refused.message).toBe(
        `SQLite allows one worker, and worker w1 holds the lock on tickets in ${made.file.path}: it last renewed it at ${iso(START + 3 * 60_000)}, and the lock frees at ${iso(START + 5 * 60_000)} unless it is renewed before then (a running worker renews it every 30 seconds)`,
      );
      expect(made.jobs()).toEqual([{ record_key: "t1", claimed_by: "w1", claimed_at: iso(START) }]);

      // The pass ends as it began, the record still its own.
      expect(await first.write("t1", decided, sent)).toEqual({ written: true });
      await first.ack(["t1"]);
      expect(made.jobs()).toEqual([]);
      expect(made.decisionOf("t1")).toEqual(decided);

      // close stops the beat and lets go of the lock.
      await first.close();
      expect(made.beats.running).toBe(0);
      expect(made.lock()).toEqual({ worker_id: null, heartbeat_at: null });
    });

    it("@timing a worker killed without close keeps its lock 2 minutes past its last beat, and the next worker is told when, then takes it", async () => {
      const made = world();
      await made.install();
      const first = await made.connector("w1");
      const second = await made.connector("w2");
      expect(await first.claim(10)).toEqual([]);
      await made.beats.advance(30_000);
      // Killed: no close, so the lock stays as its last beat left it, and nothing renews it.
      made.beats.kill();
      const frees = iso(START + 30_000 + LOCK_FRESH_MS);

      made.clock.advance(60_000);
      const refused = await refusalOf(second.claim(10));
      expect(refused.message).toContain(
        `it last renewed it at ${iso(START + 30_000)}, and the lock frees at ${frees}`,
      );
      expect(refused.refusal.fix).toContain(`One that was killed keeps it until ${frees}`);
      made.clock.advance(LOCK_FRESH_MS - 60_000 - 1);
      expect((await refusalOf(second.claim(10))).message).toContain(`the lock frees at ${frees}`);

      // At the time the refusal named, the supervisor's restart takes the lock over.
      made.clock.advance(1);
      expect(await second.claim(10)).toEqual([]);
      expect(made.lock()).toEqual({ worker_id: "w2", heartbeat_at: frees });
    });

    it("says once when its heartbeat cannot renew the lock, with the time the lock frees, and again only after a beat landed", async () => {
      const made = world();
      await made.install();
      let failing = true;
      const warnings: string[] = [];
      const connector = await createSqliteConnector(made.target, made.file.path, {
        clock: made.clock,
        repeat: made.beats.repeat,
        workerId: "w1",
        warn: (line) => warnings.push(line),
        // The beat's own statement fails while `failing`, as on a file the application holds locked.
        open: (path) => {
          const client = openNodeSqlite(path);
          return {
            ...client,
            run: (sql, params) =>
              failing && sql.includes("set heartbeat_at = ? where")
                ? Promise.reject(new Error("database is locked"))
                : client.run(sql, params),
          };
        },
      });
      try {
        expect(await connector.claim(10)).toEqual([]);
        await made.beats.advance(LOCK_HEARTBEAT_MS);
        expect(warnings).toEqual([
          `facetdb: the worker's lock on tickets in ${made.file.path} could not be renewed (database is locked); it tries again every 30 seconds, and unless a renewal lands by ${iso(START + LOCK_FRESH_MS)} the lock frees and another worker may take it over`,
        ]);
        await made.beats.advance(LOCK_HEARTBEAT_MS);
        expect(warnings).toHaveLength(1);
        expect(made.lock()).toEqual({ worker_id: "w1", heartbeat_at: iso(START) });

        failing = false;
        await made.beats.advance(LOCK_HEARTBEAT_MS);
        expect(made.lock()).toEqual({ worker_id: "w1", heartbeat_at: iso(START + 90_000) });
        failing = true;
        await made.beats.advance(LOCK_HEARTBEAT_MS);
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toContain(
          `unless a renewal lands by ${iso(START + 90_000 + LOCK_FRESH_MS)}`,
        );
      } finally {
        failing = false;
        await connector.close();
      }
    });

    it("a beat never takes a lock back: once another worker took it over, the old worker's heartbeat stops", async () => {
      const made = world();
      await made.install();
      const first = await made.connector("w1");
      const second = await made.connector("w2");
      expect(await first.claim(10)).toEqual([]);
      // The first worker's beats did not land for 2 minutes (a file locked by the application, say).
      made.clock.advance(LOCK_FRESH_MS);
      expect(await second.claim(10)).toEqual([]);
      expect(made.beats.running).toBe(2);

      // The first one's late beat finds the lock another's, changes nothing and stops for good.
      await made.beats.advance(LOCK_HEARTBEAT_MS);
      expect(made.beats.running).toBe(1);
      expect(made.lock()).toEqual({
        worker_id: "w2",
        heartbeat_at: iso(START + LOCK_FRESH_MS + LOCK_HEARTBEAT_MS),
      });
      expect((await refusalOf(first.claim(10))).message).toContain("worker w2 holds the lock");
    });

    it("a backfill beside the running worker queues and holds keys without the lock", async () => {
      const made = world();
      await made.install();
      const worker = await made.connector("w1");
      const backfill = await made.connector("backfill-1");
      made.edit("t1", { subject: "Refund", body: "Charged twice" });
      made.edit("t2", { subject: "Bug", body: "Crash on save" });
      expect(await worker.claim(1)).toEqual(["t1"]);

      expect(await backfill.claimKey("t3")).toBe(true);
      expect(await backfill.claimKey("t2")).toBe(false);
      // A key queued already keeps its claim: only a change of state takes it away.
      await backfill.enqueue(["t4", "t3", "t1"]);
      expect(made.jobs().map((job) => [job["record_key"], job["claimed_by"]])).toEqual([
        ["t1", "w1"],
        ["t2", null],
        ["t3", "backfill-1"],
        ["t4", null],
      ]);
      // What a backfill reads and writes needs no lock either.
      expect((await backfill.read(["t2"])).rows.map((row) => row.key)).toEqual(["t2"]);
      expect(made.lock()?.["worker_id"]).toBe("w1");
      expect(await worker.claim(10)).toEqual(["t2", "t4"]);
    });

    it("refuses before claiming on a table FacetDB is not installed on", async () => {
      const made = world();
      const connector = await made.connector("w1");
      const refused = await refusalOf(connector.claim(10));
      expect(refused.refusal.code).toBe("not-installed");
      expect(refused.refusal.fix).toBe("run facetdb migrate first");
    });
  });
});

describe("keys, pages and filters", () => {
  const listings: QuestionSet = {
    questions: [
      { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
    ],
    read: ["title", "price"],
    where: "price > 0",
    model: "jev-1.14.0",
    thresholds: {},
  };

  function listingsTarget(changes: Partial<EngineTarget> = {}): EngineTarget {
    return {
      project: PROJECT,
      source: "listings",
      table: "Listings",
      storage: "inline",
      onChange: "reset",
      questionSet: listings,
      ...changes,
    };
  }

  it("an integer key reads, writes and reports as text, and the file's spelling of the table queues", async () => {
    const made = world(listingsTarget());
    made.app.exec("create table listings (id integer primary key, title text, price real)");
    await made.install();
    const connector = await made.connector("w1");
    made.app.exec("insert into listings (id, title, price) values (42, 'A red car', 1500.5)");
    made.app.exec("insert into listings (id, title, price) values (7, 'Free kitten', 0)");

    // The trigger queued both under the table's name as the file spells it.
    expect(await connector.claim(10)).toEqual(["42", "7"]);
    const { rows, missing } = await connector.read(["42", "7", "042", "9"]);
    expect(rows.map(({ key, state, excluded }) => ({ key, state, excluded }))).toEqual([
      { key: "42", state: { title: "A red car", price: "1500.5" }, excluded: false },
      { key: "7", state: { title: "Free kitten", price: "0.0" }, excluded: true },
    ]);
    expect(missing).toEqual(["042", "9"]);

    const hash = rows[0]?.hash ?? "";
    expect(
      await connector.write(
        "42",
        {
          decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.9 } },
          status: "done",
        },
        hash,
      ),
    ).toEqual({ written: true });
    expect(
      made.app
        .prepare("select is_scam, is_scam_probability, facetdb_status from listings where id = 42")
        .get(),
    ).toEqual({ is_scam: 1, is_scam_probability: 0.9, facetdb_status: "done" });
    const current = await connector.current(["42", "042", "7"]);
    expect([...current.keys()].sort()).toEqual(["42", "7"]);
    expect(current.get("42")).toEqual({
      decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.9 } },
      status: "done",
      reviewed: false,
      updatedAt: new Date(START),
    });
  });

  it("a rowid table pages newest first by rowid, a WITHOUT ROWID one by its key", async () => {
    const byRowid = world(listingsTarget({ table: "listings" }));
    byRowid.app.exec("create table listings (id text primary key, title text, price real)");
    await byRowid.install();
    for (const id of ["m", "z", "a"]) {
      byRowid.app.prepare("insert into listings (id, title, price) values (?, 't', 1)").run(id);
    }
    const rowid = await byRowid.connector("w1", 2);
    const first = await rowid.scan(null);
    expect(first.rows.map((row) => row.key)).toEqual(["a", "z"]);
    const second = await rowid.scan(first.next);
    expect(second).toMatchObject({ next: null });
    expect(second.rows.map((row) => row.key)).toEqual(["m"]);

    const byKey = world(listingsTarget({ table: "listings" }));
    byKey.app.exec(
      "create table listings (id text primary key, title text, price real) without rowid",
    );
    await byKey.install();
    for (const id of ["m", "z", "a"]) {
      byKey.app.prepare("insert into listings (id, title, price) values (?, 't', 1)").run(id);
    }
    const keyed = await byKey.connector("w1", 2);
    const page = await keyed.scan(null);
    expect(page.rows.map((row) => row.key)).toEqual(["z", "m"]);
    expect((await keyed.scan(page.next)).rows.map((row) => row.key)).toEqual(["a"]);
    await expect(keyed.scan("not a cursor")).rejects.toThrow(
      '"not a cursor" is not a scan cursor of a SQLite source',
    );
  });

  it("refuses a table without a single-column key, and a missing one, when it opens", async () => {
    const made = world(listingsTarget({ table: "pairs" }));
    made.app.exec("create table pairs (a text, b text, primary key (a, b))");
    const composite = await refusalOf(made.connector("w1"));
    expect(composite.refusal.code).toBe("primary-key");
    expect(composite.message).toBe(
      "pairs needs a single-column primary key, and has a composite one",
    );

    const missing = world(listingsTarget({ table: "nowhere" }));
    expect((await refusalOf(missing.connector("w1"))).refusal.code).toBe("no-table");

    // install keys by the primary key; a config naming another column disagrees with the table.
    const other = world(listingsTarget({ table: "listings", key: "title" }));
    other.app.exec("create table listings (id integer primary key, title text, price real)");
    expect((await refusalOf(other.connector("w1"))).message).toBe(
      "listings's primary key is id, not title; the config and the table disagree",
    );

    const blob = world(listingsTarget({ table: "blobs" }));
    blob.app.exec("create table blobs (id blob primary key, title text, price real)");
    expect((await refusalOf(blob.connector("w1"))).message).toBe(
      "blobs's primary key id is a BLOB, which the queue and the decision log cannot hold as text",
    );
  });

  it("a key column declared without a type, holding integers, is found by its text", async () => {
    const made = world(listingsTarget({ table: "listings" }));
    made.app.exec("create table listings (id primary key, title text, price real)");
    await made.install();
    made.app.exec("insert into listings (id, title, price) values (42, 'A red car', 1)");
    const connector = await made.connector("w1");
    expect(await connector.claim(10)).toEqual(["42"]);
    const { rows, missing } = await connector.read(["42"]);
    expect([rows.map((row) => row.key), missing]).toEqual([["42"], []]);
    expect(
      await connector.write(
        "42",
        {
          decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.2 } },
          status: "done",
        },
        rows[0]?.hash ?? "",
      ),
    ).toEqual({ written: true });
    expect([...(await connector.current(["42"])).keys()]).toEqual(["42"]);
    expect((await connector.scan(null)).rows.map((row) => row.key)).toEqual(["42"]);
  });

  it("a table with a column named rowid pages by SQLite's other name for the rowid", async () => {
    const made = world(listingsTarget({ table: "listings" }));
    made.app.exec(
      "create table listings (id text primary key, rowid integer, title text, price real)",
    );
    await made.install();
    made.app.exec("insert into listings (id, rowid, title, price) values ('a', null, 't', 1)");
    made.app.exec("insert into listings (id, rowid, title, price) values ('b', 7, 't', 1)");
    const connector = await made.connector("w1");
    expect((await connector.scan(null)).rows.map((row) => row.key)).toEqual(["b", "a"]);
  });
});
