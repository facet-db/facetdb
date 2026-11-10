import { PGlite } from "@electric-sql/pglite";
import type { Connector, QuestionSet, RecordDecision, RecordKey, StateValue } from "@facetdb/core";
import { FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../sql/index.ts";
import { createPollingConnector, type PollingConnector, pollingInstallSql } from "./index.ts";
import { pgliteClient } from "./pglite-client.ts";

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const INTERVAL_MS = 10_000;
const HOUR_MS = 3_600_000;

type WorldOptions = {
  readonly keyType?: "text" | "integer";
  readonly where?: string;
};

/**
 * A fake clock whose sleep also lets the event loop turn, so a watch loop that "sleeps" between polls
 * cannot starve the timers and I/O the test and the database wait on.
 */
class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** One PGlite database holding the application's table, shared by every connector a test opens. */
class World {
  readonly clock = new TurningClock();
  readonly warnings: string[] = [];
  readonly open: PollingConnector[] = [];
  readonly db = new PGlite();
  readonly keyType: "text" | "integer";
  readonly questionSet: QuestionSet;
  #tick = 1_700_000_000;

  constructor(options: WorldOptions = {}) {
    this.keyType = options.keyType ?? "text";
    this.questionSet =
      options.where === undefined ? questionSet : { ...questionSet, where: options.where };
  }

  async create(): Promise<this> {
    await this.db.exec(
      `create table listings (id ${this.keyType} primary key, title text, body text, price numeric(10,2), updated_at timestamptz not null default now())`,
    );
    return this;
  }

  /** A worker. `lastChangedColumn` defaults to the table's `updated_at`; pass `null` for none. */
  connector(
    extra: { lastChangedColumn?: string | null; pageSize?: number; intervalMs?: number } = {},
  ): PollingConnector {
    const lastChangedColumn =
      extra.lastChangedColumn === undefined ? "updated_at" : (extra.lastChangedColumn ?? undefined);
    const connector = createPollingConnector({
      url: "pglite://memory",
      source: { table: "listings", key: "id" },
      questionSet: this.questionSet,
      ...(lastChangedColumn === undefined ? {} : { lastChangedColumn }),
      ...(extra.pageSize === undefined ? {} : { pageSize: extra.pageSize }),
      intervalMs: extra.intervalMs ?? INTERVAL_MS,
      clock: this.clock,
      warn: (message) => this.warnings.push(message),
      connect: () => pgliteClient(this.db),
    });
    this.open.push(connector);
    return connector;
  }

  /** The application's own write: insert or update the state fields, bumping `updated_at`. */
  async edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<void> {
    await this.db.query(
      `insert into listings (id, title, body, updated_at) values ($1, $2, $3, to_timestamp($4))
       on conflict (id) do update set title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      [key, state["title"], state["body"], this.#tick++],
    );
  }

  /** An app-level trigger bumping `updated_at` on an update that changed no state field. */
  async bump(key: RecordKey): Promise<void> {
    await this.db.query("update listings set updated_at = to_timestamp($2) where id = $1", [
      key,
      this.#tick++,
    ]);
  }

  async decisionOf(key: RecordKey): Promise<RecordDecision | null> {
    const { rows } = await this.db.query<{
      status: string | null;
      value: boolean | null;
      probability: number | null;
      reviewed: boolean | null;
    }>(
      `select facetdb_status as status, not_priority as value, not_priority_probability as probability,
              facetdb_reviewed as reviewed from listings where id = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined || row.status === null) {
      return null;
    }
    return {
      decisions:
        row.value === null || row.probability === null
          ? {}
          : {
              not_priority: {
                kind: "decided",
                value: row.value,
                probabilityOrConfidence: row.probability,
              },
            },
      status: row.status as RecordDecision["status"],
      ...(row.reviewed === true ? { reviewed: true as const } : {}),
    };
  }

  async statusOf(key: RecordKey): Promise<string | null> {
    const { rows } = await this.db.query<{ status: string | null }>(
      "select facetdb_status as status from listings where id = $1",
      [key],
    );
    return rows[0]?.status ?? null;
  }

  async columns(): Promise<string[]> {
    const { rows } = await this.db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'listings' order by ordinal_position",
    );
    return rows.map((row) => row.column_name);
  }

  async close(): Promise<void> {
    for (const connector of this.open.splice(0)) {
      await connector.close();
    }
    await this.db.close();
  }
}

const worlds: World[] = [];
async function newWorld(options?: WorldOptions): Promise<World> {
  const world = await new World(options).create();
  worlds.push(world);
  return world;
}
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close();
  }
});

const states = (value: string): Record<string, StateValue> => ({
  title: `title:${value}`,
  body: `body:${value}`,
});

const decided = (probability = 0.93): RecordDecision => ({
  decisions: {
    not_priority: { kind: "decided", value: true, probabilityOrConfidence: probability },
  },
  status: "done",
});

/** Reads a key, writes a decision at the hash it read, and acks: what a worker pass does. */
async function answer(connector: Connector, key: RecordKey): Promise<void> {
  const [claimed] = await connector.claim(1);
  expect(claimed).toBe(key);
  const { rows } = await connector.read([key]);
  const hash = rows[0]?.hash ?? "";
  expect(await connector.write(key, decided(), hash)).toEqual({ written: true });
  await connector.ack([key]);
}

type Next = Promise<IteratorResult<readonly RecordKey[], void>>;

/**
 * Waits until the pending `watch` step yields, or until `polls` more polls have gone by without one
 * (the fake clock counts each sleep, so "quiet" means the connector looked that many times).
 */
async function yieldedWithin(pending: Next, clock: FakeClock, polls: number) {
  const start = clock.sleeps.length;
  let result: IteratorResult<readonly RecordKey[], void> | undefined;
  void pending.then((value) => {
    result = value;
  });
  while (result === undefined && clock.sleeps.length < start + polls) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return result?.done === false ? result.value : "quiet";
}

describe("polling connector contract", () => {
  runConnectorContract(async () => {
    const world = await new World().create();
    const connector = world.connector({ pageSize: 10 });
    return {
      connector,
      fields: questionSet.read,
      edit: (key, state) => world.edit(key, state),
      decisionOf: (key) => world.decisionOf(key),
      close: () => world.close(),
    };
  });
});

describe("polling connector install", () => {
  it("adds the answer, status and hash columns, no trigger and no jobs table, and is idempotent", async () => {
    const world = await newWorld();
    const connector = world.connector();
    const before = await world.columns();

    await connector.install();
    const once = await world.columns();
    await connector.install();
    expect(await world.columns()).toEqual(once);
    expect(once.filter((name) => !before.includes(name))).toEqual([
      "not_priority",
      "not_priority_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
      "facetdb_state_hash",
    ]);

    const { rows } = await world.db.query<{ n: number }>(
      `select (select count(*) from pg_trigger where not tgisinternal)::int
            + (select count(*) from information_schema.schemata where schema_name = 'facetdb')::int as n`,
    );
    expect(rows[0]?.n).toBe(0);
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, questionSet)) {
      expect(statement).not.toMatch(/trigger|jobs/i);
    }

    await connector.uninstall();
    expect(await world.columns()).toEqual(before);
  });

  it("refuses a question whose column the application already owns, and changes nothing", async () => {
    const world = await newWorld();
    await world.db.exec("alter table listings add column not_priority text");
    const before = await world.columns();

    await expect(world.connector().install()).rejects.toThrow(
      /"not_priority", which FacetDB did not create; rename the question or the column/,
    );

    expect(await world.columns()).toEqual(before);
  });

  it("adopts its own columns from an earlier install, by the mark it left on them", async () => {
    const world = await newWorld();
    await world.connector().install();
    const { rows } = await world.db.query<{ mark: string | null }>(
      "select col_description('listings'::regclass, ordinal_position) as mark from information_schema.columns where table_name = 'listings' and column_name = 'not_priority'",
    );
    expect(rows[0]?.mark).toBe("facetdb");

    await expect(world.connector().install()).resolves.toBeUndefined();
  });

  it("uninstall drops only the columns that carry FacetDB's mark: an app column sharing a question's name keeps its data", async () => {
    const world = await newWorld();
    await world.connector().install();
    await world.edit("k1", { title: "keep me", body: "b" });
    // A later question set names a question like the app's own `title` column.
    const wider: QuestionSet = {
      ...questionSet,
      questions: [
        ...questionSet.questions,
        { type: "noul", name: "title", instructions: "Is there a title?", stakes: "low" },
      ],
    };
    const later = createPollingConnector({
      url: "pglite://memory",
      source: { table: "listings", key: "id" },
      questionSet: wider,
      clock: world.clock,
      warn: () => undefined,
      connect: () => pgliteClient(world.db),
    });

    await later.uninstall();

    expect(await world.columns()).toEqual(["id", "title", "body", "price", "updated_at"]);
    const { rows } = await world.db.query<{ title: string }>(
      "select title from listings where id = 'k1'",
    );
    expect(rows[0]?.title).toBe("keep me");
  });

  it("installs in one transaction: a failure midway leaves no column and no unmarked leftover behind", async () => {
    const world = await newWorld();
    const before = await world.columns();
    const base = pgliteClient(world.db);
    const failing: SqlClient = {
      ...base,
      transaction: (work) =>
        base.transaction((query) =>
          work(async (text, params) => {
            if (/^comment on/.test(text)) {
              throw new Error("the connection dropped");
            }
            return query(text, params);
          }),
        ),
    };
    const connector = createPollingConnector({
      url: "pglite://memory",
      source: { table: "listings", key: "id" },
      questionSet,
      clock: world.clock,
      warn: () => undefined,
      connect: () => failing,
    });

    await expect(connector.install()).rejects.toThrow("the connection dropped");

    expect(await world.columns()).toEqual(before);
    // Nothing unmarked was left behind, so the next install is not refused.
    await expect(world.connector().install()).resolves.toBeUndefined();
  });

  it("quotes every identifier, so a hostile table name is one identifier and nothing else", () => {
    const [statement] = pollingInstallSql(
      { table: 'x"; drop table users; --', key: "id" },
      questionSet,
    );
    expect(statement).toContain('"public"."x""; drop table users; --"');
  });
});

describe("polling connector watch", () => {
  it("@timing yields a changed state column once, and an updated_at bump without a state change never", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", states("one"));

    const iterator = connector.watch()[Symbol.asyncIterator]();
    // A new record is asked.
    expect(await yieldedWithin(iterator.next(), world.clock, 1)).toEqual(["r1"]);
    await answer(connector, "r1");
    expect(await world.statusOf("r1")).toBe("done");

    // The app bumps updated_at with no state change; FacetDB's own write bumped nothing here, but
    // the row sits at the cursor and is read again each poll. Neither is asked again.
    await world.bump("r1");
    const quiet = iterator.next();
    expect(await yieldedWithin(quiet, world.clock, 4)).toBe("quiet");

    // A state column changes: asked once, however many polls see it.
    await world.edit("r1", states("two"));
    expect(await quiet).toEqual({ done: false, value: ["r1"] });
    expect(await world.statusOf("r1")).toBe("pending");
    const again = iterator.next();
    expect(await yieldedWithin(again, world.clock, 4)).toBe("quiet");

    // Answered at the new hash, it stays quiet across further bumps.
    await answer(connector, "r1");
    await world.bump("r1");
    expect(await yieldedWithin(again, world.clock, 4)).toBe("quiet");
  });

  it("@timing reads every row of a poll across pages, even when many share one updated_at", async () => {
    const world = await newWorld();
    const connector = world.connector({ pageSize: 2 });
    await connector.install();
    for (const key of ["a", "b", "c", "d", "e"]) {
      await world.edit(key, states(key));
    }
    await world.db.exec("update listings set updated_at = to_timestamp(1700000000)");

    const iterator = connector.watch()[Symbol.asyncIterator]();
    const first = await yieldedWithin(iterator.next(), world.clock, 1);
    expect(first === "quiet" ? [] : [...first].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(await yieldedWithin(iterator.next(), world.clock, 3)).toBe("quiet");
  });

  it("@timing without a last-changed column reads the whole table hourly and says so", async () => {
    const world = await newWorld();
    const connector = world.connector({ lastChangedColumn: null });
    await connector.install();
    await world.edit("r1", states("one"));

    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(iterator.next(), world.clock, 1)).toEqual(["r1"]);
    await answer(connector, "r1");
    expect(world.warnings).toHaveLength(1);
    expect(world.warnings[0]).toContain("no last-changed column");

    // Two scans later nothing has changed; then a state change shows up at the next hourly scan.
    const second = iterator.next();
    expect(await yieldedWithin(second, world.clock, 2)).toBe("quiet");
    await world.edit("r1", states("two"));
    expect(await second).toEqual({ done: false, value: ["r1"] });
    expect(world.clock.sleeps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(world.clock.sleeps)).toEqual(new Set([HOUR_MS]));
    expect(world.warnings).toHaveLength(1);
    await iterator.return?.();
  });

  it("@timing polls every 10 seconds by default and warns about nothing when a column is named", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(iterator.next(), world.clock, 3)).toBe("quiet");
    expect(new Set(world.clock.sleeps)).toEqual(new Set([INTERVAL_MS]));
    expect(world.warnings).toEqual([]);
  });

  it("@timing asks no row twice for the same state hash across a restart", async () => {
    const world = await newWorld();
    const first = world.connector();
    await first.install();
    for (const key of ["r1", "r2", "r3"]) {
      await world.edit(key, states(key));
    }
    const firstRun = first.watch()[Symbol.asyncIterator]();
    const asked = await yieldedWithin(firstRun.next(), world.clock, 1);
    expect(asked === "quiet" ? [] : [...asked].sort()).toEqual(["r1", "r2", "r3"]);
    // r1 and r2 are answered; r3 is queued when the worker dies.
    const claimed = await first.claim(2);
    for (const key of claimed) {
      const hash = (await first.read([key])).rows[0]?.hash ?? "";
      await first.write(key, decided(), hash);
      await first.ack([key]);
    }
    await firstRun.return?.();
    await first.close();

    // The restart has no cursor and no queue: it reads the table again from the start.
    const second = world.connector();
    await world.edit("r4", states("r4"));
    const secondRun = second.watch()[Symbol.asyncIterator]();
    const reAsked = await yieldedWithin(secondRun.next(), world.clock, 1);
    const unanswered = (
      await world.db.query<{ id: string }>(
        "select id from listings where facetdb_state_hash is null order by id",
      )
    ).rows.map((row) => row.id);
    expect(reAsked === "quiet" ? [] : [...reAsked].sort()).toEqual(unanswered);
    expect(unanswered).toEqual(["r3", "r4"]);
    await secondRun.return?.();
  });

  it("@timing a changed record is pending under reset and keeps its status under keep", async () => {
    const world = await newWorld();
    const reset = world.connector();
    await reset.install();
    await world.edit("r1", states("one"));
    const run = reset.watch()[Symbol.asyncIterator]();
    await yieldedWithin(run.next(), world.clock, 1);
    await answer(reset, "r1");
    await world.edit("r1", states("two"));
    expect(await yieldedWithin(run.next(), world.clock, 2)).toEqual(["r1"]);
    expect(await world.statusOf("r1")).toBe("pending");
    await run.return?.();

    const keep = createPollingConnector({
      url: "pglite://memory",
      source: { table: "listings", key: "id", onChange: "keep" },
      questionSet,
      lastChangedColumn: "updated_at",
      clock: world.clock,
      warn: () => undefined,
      connect: () => pgliteClient(world.db),
    });
    await world.db.query("update listings set facetdb_status = 'done' where id = 'r1'");
    await world.edit("r1", states("three"));
    const keepRun = keep.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(keepRun.next(), world.clock, 2)).toEqual(["r1"]);
    expect(await world.statusOf("r1")).toBe("done");
    await keepRun.return?.();
    await keep.close();
  });
});

describe("polling connector read, write and scan", () => {
  it("hashes the database's own text: numeric 12.50 stays 12.50, and a missing key is reported", async () => {
    const world = await newWorld();
    const priced: QuestionSet = { ...questionSet, read: ["title", "price"] };
    const connector = createPollingConnector({
      url: "pglite://memory",
      source: { table: "listings", key: "id" },
      questionSet: priced,
      clock: world.clock,
      warn: () => undefined,
      connect: () => pgliteClient(world.db),
    });
    await connector.install();
    await world.db.exec("insert into listings (id, title, price) values ('p1', 'lamp', 12.50)");
    const { rows, missing } = await connector.read(["p1", "nope"]);
    expect(rows[0]?.state).toEqual({ title: "lamp", price: "12.50" });
    expect(missing).toEqual(["nope"]);
    await connector.close();
  });

  it("skips the where filter in SQL: an excluded row is flagged, not hidden", async () => {
    const world = await newWorld({ where: "title <> 'internal'" });
    const connector = world.connector();
    await connector.install();
    await world.edit("a", { title: "internal", body: "x" });
    await world.edit("b", { title: "public", body: "x" });
    const { rows } = await connector.read(["a", "b"]);
    expect(rows.map((row) => [row.key, row.excluded])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("works with an integer key: read, write, queue and newest-first scan", async () => {
    const world = await newWorld({ keyType: "integer" });
    const connector = world.connector({ pageSize: 2 });
    await connector.install();
    for (const key of ["1", "2", "10"]) {
      await world.edit(key, states(key));
    }
    const { rows } = await connector.read(["10", "2"]);
    expect(rows.map((row) => row.key)).toEqual(["10", "2"]);
    expect(await connector.write("10", decided(), rows[0]?.hash ?? "")).toEqual({ written: true });

    const firstPage = await connector.scan(null);
    expect(firstPage.rows.map((row) => row.key)).toEqual(["10", "2"]);
    const secondPage = await connector.scan(firstPage.next);
    expect(secondPage.rows.map((row) => row.key)).toEqual(["1"]);
    expect(secondPage.next).toBeNull();
  });

  it("stores the hash with the decision and a clock time, and never writes a column outside FacetDB's own", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", states("one"));
    world.clock.advance(5_000);
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    await connector.write("r1", decided(), hash);

    const { rows } = await world.db.query<{
      title: string;
      stamp: string;
      at: number;
    }>(
      `select title, facetdb_state_hash as stamp, extract(epoch from facetdb_updated_at)::float8 as at
         from listings where id = 'r1'`,
    );
    expect(rows[0]).toEqual({ title: "title:one", stamp: hash, at: 5 });
  });
});
