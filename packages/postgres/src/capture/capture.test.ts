import {
  type Clock,
  type QuestionSet,
  type RecordDecision,
  type RecordKey,
  type StateValue,
  stateHash,
} from "@facetdb/core";
import { FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, type TableSource, uninstall } from "../install/index.ts";
import type { StorageMode } from "../scan/index.ts";
import { CLAIM_LEASE_MS, jobsQueries, type SqlClient } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { createPostgresConnector, type Installer, type PostgresConnector } from "./connector.ts";
import { stateHashSql } from "./hash-sql.ts";

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const project = { id: "proj_listings", name: "Listings" };
const PASSWORD = "a-long-random-password";

/** A fake clock whose sleep lets the event loop turn, so a polling watch cannot starve the test's I/O. */
class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A clock whose sleep never ends: only a notification can wake a watch under it. */
class FrozenClock implements Clock {
  now(): number {
    return 1_700_000_000_000;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

/** One PGlite with the application's table; the admin and the workers share its single connection. */
class World {
  readonly clock = new TurningClock(1_700_000_000_000);
  readonly open: PostgresConnector[] = [];
  pg!: PgliteWorld;
  installed = false;
  readonly storage: StorageMode;
  readonly onChange: "reset" | "keep";
  constructor(storage: StorageMode = "inline", onChange: "reset" | "keep" = "reset") {
    this.storage = storage;
    this.onChange = onChange;
  }

  async create(): Promise<this> {
    this.pg = await createPgliteWorld();
    await this.pg.client.query(
      `create table public.listings (id text primary key, title text, body text)`,
    );
    return this;
  }

  get source(): TableSource {
    return { table: "listings", key: "id", storage: this.storage, onChange: this.onChange };
  }

  /** `facetdb migrate` / `uninstall` with the admin credential, which never reaches the connector. */
  installer(): Installer {
    return {
      install: async () => {
        const result = await migrate({
          adminUrl: "pglite://admin",
          connect: this.pg.connect,
          print: () => undefined,
          plan: { source: this.source, questionSet, project, workerPassword: PASSWORD },
        });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        this.installed = true;
      },
      uninstall: async () => {
        if (!this.installed) {
          return;
        }
        const result = await uninstall({
          adminUrl: "pglite://admin",
          connect: this.pg.connect,
          source: { table: "listings", sourceId: "listings" },
          print: () => undefined,
          confirm: ({ project: asked }) => Promise.resolve(asked.name),
        });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        this.installed = false;
      },
    };
  }

  connector(
    options: { workerId?: string; clock?: Clock; pollMs?: number } = {},
  ): PostgresConnector {
    const connector = createPostgresConnector({
      workerUrl: "pglite://worker",
      source: this.source,
      questionSet,
      clock: options.clock ?? this.clock,
      pollMs: options.pollMs ?? 50,
      scanPageSize: 10,
      workerId: options.workerId ?? "w1",
      installer: this.installer(),
      connect: () => this.pg.client,
    });
    this.open.push(connector);
    return connector;
  }

  /** The application's own write: insert or update the state fields; the trigger queues the key. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.pg.client.query(
      `insert into public.listings (id, title, body) values ($1, $2, $3)
       on conflict (id) do update set title = excluded.title, body = excluded.body`,
      [key, state["title"] ?? null, state["body"] ?? null],
    );
  }

  /** Where the decision lives: the table in inline mode, `facetdb.listings_answers` in side-table mode. */
  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const relation = this.storage === "side-table" ? `facetdb.listings_answers` : `public.listings`;
    const rows = await this.pg.client.query(
      `select facetdb_status as status, facetdb_updated_at as written, not_priority as value,
              not_priority_probability as probability, facetdb_reviewed as reviewed
         from ${relation} where id = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined || row["written"] === null || row["written"] === undefined) {
      return null;
    }
    return {
      decisions:
        row["value"] === null || row["probability"] === null
          ? {}
          : {
              not_priority: {
                kind: "decided",
                value: row["value"] as boolean,
                probabilityOrConfidence: Number(row["probability"]),
              },
            },
      status: String(row["status"]) as RecordDecision["status"],
      ...(row["reviewed"] === true ? { reviewed: true as const } : {}),
    };
  }

  async statusOf(key: RecordKey): Promise<string | null> {
    const relation =
      this.storage === "side-table" ? `public.listings_with_answers` : `public.listings`;
    const rows = await this.pg.client.query(
      `select facetdb_status as status from ${relation} where id = $1`,
      [key],
    );
    return rows[0] === undefined ? null : String(rows[0]["status"]);
  }

  async queued(): Promise<string[]> {
    const rows = await this.pg.client.query(`select record_key from facetdb.jobs order by 1`);
    return rows.map((row) => String(row["record_key"]));
  }

  /** The worker holding a queued key, or null when it is waiting. */
  async claimOf(queuedKey: string): Promise<string | null> {
    const rows = await this.pg.client.query(
      `select claimed_by from facetdb.jobs where record_key = $1`,
      [queuedKey],
    );
    return rows[0] === undefined ? null : (rows[0]["claimed_by"] as string | null);
  }

  async close(): Promise<void> {
    for (const connector of this.open.splice(0)) {
      await connector.close();
    }
    await this.pg.close();
  }
}

const worlds: World[] = [];
async function newWorld(storage: StorageMode = "inline", onChange: "reset" | "keep" = "reset") {
  const world = await new World(storage, onChange).create();
  worlds.push(world);
  return world;
}
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close();
  }
});

const decided = (): RecordDecision => ({
  decisions: { not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
  status: "done",
});

/**
 * A connector whose client records the text of every statement it sends, those inside a
 * transaction marked so, through the same `connect` parameter production uses.
 */
function recordingConnector(world: World): {
  connector: PostgresConnector;
  statements: string[];
} {
  const statements: string[] = [];
  const inner = world.pg.client;
  const client: SqlClient = {
    ...inner,
    query: (text, params) => {
      statements.push(text);
      return inner.query(text, params);
    },
    pipeline: (text, paramSets) => {
      statements.push(`pipeline of ${paramSets.length} one-key runs: ${text}`);
      expect(paramSets.every((params) => params.length === 1)).toBe(true);
      return inner.pipeline(text, paramSets);
    },
    transaction: (work) =>
      inner.transaction((query) =>
        work((text, params) => {
          statements.push(`in transaction: ${text}`);
          return query(text, params);
        }),
      ),
  };
  const connector = createPostgresConnector({
    workerUrl: "pglite://worker",
    source: world.source,
    questionSet,
    clock: world.clock,
    workerId: "w1",
    installer: world.installer(),
    connect: () => client,
  });
  world.open.push(connector);
  return { connector, statements };
}

/** The application inserts `count` records; the trigger queues each. Returns their keys, sorted. */
async function editMany(world: World, count: number): Promise<RecordKey[]> {
  const keys = Array.from({ length: count }, (_, i) => `r${String(i + 1).padStart(2, "0")}`);
  for (const key of keys) {
    await world.edit(key, { title: "a", body: "b" });
  }
  return keys;
}

async function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T | "quiet"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Promise<"quiet">((resolve) => {
    timer = setTimeout(() => resolve("quiet"), ms);
  });
  try {
    return await Promise.race([pending, quiet]);
  } finally {
    clearTimeout(timer);
  }
}

// The suite runs the connector with `onChange: "keep"`: one of its cases edits a record and then
// expects the stored decision, status included, untouched, which a `reset` trigger changes on the
// edit by design. Reset against keep has its own case below.
for (const storage of ["inline", "side-table"] as const) {
  describe(`postgres connector contract (${storage})`, () => {
    runConnectorContract(async () => {
      const world = await new World(storage, "keep").create();
      return {
        connector: world.connector({ workerId: "w1" }),
        peer: world.connector({ workerId: "w2" }),
        fields: questionSet.read,
        edit: (key, state) => world.edit(key, state),
        decisionOf: (key) => world.decisionOf(key),
        close: () => world.close(),
      };
    });
  });
}

describe("postgres connector", () => {
  it("wakes on the trigger's notification alone, with no poll at all", async () => {
    const world = await newWorld();
    const connector = world.connector({ clock: new FrozenClock() });
    await connector.install();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    const first = iterator.next();
    await world.edit("r1", { title: "a", body: "b" });
    const batch = await withTimeout(first, 3000);
    expect(batch).not.toBe("quiet");
    if (batch !== "quiet") {
      expect(batch.done).toBe(false);
      expect(batch.value).toEqual(["r1"]);
    }
    await iterator.return?.();
  });

  it("refuses a write after the state changed, in the database's own hash check", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    const { rows } = await connector.read(["r1"]);
    const hash = rows[0]?.hash ?? "";
    await world.edit("r1", { title: "changed", body: "b" });
    expect(await connector.write("r1", decided(), hash)).toEqual({ written: false });
    expect(await world.decisionOf("r1")).toBeNull();
    const fresh = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    expect(await connector.write("r1", decided(), fresh)).toEqual({ written: true });
    expect(await world.decisionOf("r1")).toEqual(decided());
  });

  it("reset puts an edited record back to pending and queues it; keep leaves the decision", async () => {
    for (const onChange of ["reset", "keep"] as const) {
      const world = await newWorld("inline", onChange);
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      await connector.ack(await connector.claim(10));
      const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
      await connector.write("r1", decided(), hash);
      expect(await world.statusOf("r1")).toBe("done");
      await world.edit("r1", { title: "edited", body: "b" });
      expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
      expect(await world.statusOf("r1")).toBe(onChange === "reset" ? "pending" : "done");
      expect((await world.decisionOf("r1"))?.decisions).toEqual(decided().decisions);
    }
  });

  it("an edit between a write and its ack takes the claim away, so the record is asked again", async () => {
    for (const storage of ["inline", "side-table"] as const) {
      const world = await newWorld(storage);
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      expect(await connector.claim(10)).toEqual(["r1"]);
      const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
      expect(await connector.write("r1", decided(), hash)).toEqual({ written: true });
      // The application edits the record while the worker still holds its job.
      await world.edit("r1", { title: "edited meanwhile", body: "b" });
      await connector.ack(["r1"]);
      // The job survived the ack and is claimable again: nothing is lost.
      expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
      expect(await connector.claim(10)).toEqual(["r1"]);
      expect(await world.statusOf("r1")).toBe("pending");
    }
  });

  it("an ack after the job was granted again deletes nothing: the job stays for the second batch", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    expect(await connector.claim(10)).toEqual(["r1"]);
    // The first batch outlives its lease; the same worker is granted the job again for a second batch.
    world.clock.advance(CLAIM_LEASE_MS + 1);
    expect(await connector.claim(10)).toEqual(["r1"]);
    await connector.ack(["r1"]);
    expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBe("w1");
    // The second batch's ack finds its own claim and takes the job.
    await connector.ack(["r1"]);
    expect(await world.queued()).toEqual([]);
  });

  it("a release after the job was granted again leaves the new claim alone", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    expect(await connector.claim(10)).toEqual(["r1"]);
    world.clock.advance(CLAIM_LEASE_MS + 1);
    expect(await connector.claim(10)).toEqual(["r1"]);
    await connector.release(["r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBe("w1");
    expect(await connector.claim(10)).toEqual([]);
    await connector.release(["r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBeNull();
    expect(await connector.claim(10)).toEqual(["r1"]);
  });

  it("a batch ack and a batch release of 20 keys are one statement each when no row is held", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = await editMany(world, 20);
    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    statements.length = 0;
    await connector.release(keys);
    expect(statements).toEqual([jobsQueries.releaseBatch]);
    expect(await world.claimOf(`t:15:public.listings:${keys[0]}`)).toBeNull();
    // The released keys left the ledger: releasing them again names nothing.
    statements.length = 0;
    await connector.release(keys);
    expect(statements).toEqual([]);

    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    statements.length = 0;
    await connector.ack(keys);
    expect(statements).toEqual([jobsQueries.ackBatch]);
    expect(await world.queued()).toEqual([]);
    statements.length = 0;
    await connector.ack(keys);
    expect(statements).toEqual([]);
  });

  it("a batch ack after one key was granted again deletes nothing for that key", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = await editMany(world, 20);
    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    // The first batch outlives its lease and one of its keys is granted again to a second batch.
    world.clock.advance(CLAIM_LEASE_MS + 1);
    const [regranted] = await connector.claim(1);
    expect(regranted).toBeDefined();
    statements.length = 0;
    await connector.ack(keys);
    // The batch skips the re-granted key; the ledger tries it alone, which finds no standing claim.
    expect(statements).toEqual([jobsQueries.ackBatch, jobsQueries.ack]);
    expect(await world.queued()).toEqual([`t:15:public.listings:${regranted}`]);
    expect(await world.claimOf(`t:15:public.listings:${regranted}`)).toBe("w1");
    // The second batch's ack finds its own claim and takes the job.
    await connector.ack([regranted ?? ""]);
    expect(await world.queued()).toEqual([]);
  });

  it("an enqueue of 60 keys is one pipeline of 60 one-key statements", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = Array.from({ length: 60 }, (_, i) => `page-${String(i).padStart(2, "0")}`);
    statements.length = 0;
    await connector.enqueue(keys);
    // No transaction and no other statement: on postgres.js the pipeline is a few round trips for
    // the lot (capture.db.test.ts counts them through a relay).
    expect(statements).toEqual([`pipeline of 60 one-key runs: ${jobsQueries.enqueue}`]);
    expect(await world.queued()).toEqual(keys.map((key) => `t:15:public.listings:${key}`));
  });

  it("writes only FacetDB's own columns, named one by one", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    await connector.write("r1", { ...decided(), reviewed: true }, hash);
    const rows = await world.pg.client.query(
      `select title, body, not_priority, not_priority_probability, facetdb_status, facetdb_reviewed from public.listings where id = 'r1'`,
    );
    expect(rows).toEqual([
      {
        title: "a",
        body: "b",
        not_priority: true,
        not_priority_probability: 0.93,
        facetdb_status: "done",
        facetdb_reviewed: true,
      },
    ]);
  });

  it("the SQL hash equals core's stateHash, quote, backslash, control and unicode text included", async () => {
    const world = await newWorld();
    await world.pg.client.query(`create table t (a text, b text)`);
    const cases: (readonly [string | null, string | null])[] = [
      ["plain", "text"],
      [null, ""],
      ['say "hi"', "back\\slash"],
      ["new\nline\ttab", "\u0001control\u001f"],
      ["é 😀 日本", "/slash/"],
    ];
    for (const [a, b] of cases) {
      await world.pg.client.query(`delete from t`);
      await world.pg.client.query(`insert into t (a, b) values ($1, $2)`, [a, b]);
      const rows = await world.pg.client.query(
        `select ${stateHashSql(["a", "b"], "t")} as h from t`,
      );
      expect(rows[0]?.["h"]).toBe(stateHash(["a", "b"], { a, b }));
    }
  });

  it("install and uninstall go through the installer, never a credential of the connector's", async () => {
    const world = await newWorld();
    const bare = createPostgresConnector({
      workerUrl: "pglite://worker",
      source: world.source,
      questionSet,
      clock: world.clock,
      connect: () => world.pg.client,
    });
    await expect(bare.install()).rejects.toThrow(/facetdb migrate/);
    await expect(bare.uninstall()).rejects.toThrow(/facetdb uninstall/);
    expect(bare.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: true,
      transactions: true,
      sideTable: true,
      multipleWorkers: true,
    });
    await bare.close();
  });
});
