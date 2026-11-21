import type {
  Connector,
  EngineDeps,
  EnginePlan,
  EngineTarget,
  OpenConnector,
  PlanResult,
  QuestionSet,
  RecordDecision,
  RecordKey,
  StateValue,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPollingConnector } from "../connector/index.ts";
import type { PollingClient, PollingConnect, SqlDialect } from "../dialect/index.ts";
import { pollingEngine } from "../engine/index.ts";
import { plainDialect, serverUrl, skipUnless } from "../testing/index.ts";
import { cockroachDialect, connectCockroach, postgresWireEngine } from "./cockroach.ts";

/**
 * The CockroachDB dialect on a real node: the CockroachDB 24.3 container of
 * scripts/test-databases.sh, started `--insecure`, with its default settings, in a scratch database
 * of this file's. The listings fixture is installed by the polling engine's plan as `facetdb
 * migrate` runs it, then the worker login's connector watches it, doctor checks it, uninstall
 * removes every column and the mark; the connector contract runs on a table of its own (no peer: a
 * polling queue is one worker's), and a `postgres://` URL to the same node is told apart by
 * version(). Every statement the engine sends is recorded: none of Postgres's own (`lock table`,
 * its `set local lock_timeout`, a `do` block, a column-level grant, the catalogs CockroachDB lacks)
 * reaches it; the groups' own `set local autocommit_before_ddl` is CockroachDB's.
 *
 * The node runs without TLS and without passwords, so the URLs are this machine's (the loopback
 * rule) and the calls pass `allowInsecure` as the CLI's --allow-insecure would; a login is made
 * without a password there, which the install's own login statement cannot do (it binds one).
 */

const SCRATCH = "facetdb_t076";
const PROJECT = { id: "proj_listings", name: "Listings" };
const PASSWORD = "facetdb-worker-test-password";
const START = Date.parse("2026-11-04T09:00:00.000Z");

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: EngineTarget = {
  project: PROJECT,
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "reset",
  questionSet: listings,
  urlVariable: "LISTINGS_URL",
};

const OWNED = [
  "is_scam",
  "is_scam_probability",
  "facetdb_status",
  "facetdb_updated_at",
  "facetdb_reviewed",
  "facetdb_state_hash",
];

/**
 * A fake clock whose sleep also lets the event loop turn, so a watch loop that "sleeps" between
 * polls cannot starve the I/O the test and the server wait on.
 */
class TurningClock extends FakeClock {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** The server's URL with the scratch database as its path, as the given login. */
function urlOf(server: string, login?: string, scheme = "cockroachdb"): string {
  const url = new URL(server);
  url.pathname = `/${SCRATCH}`;
  if (login !== undefined) {
    url.username = login;
  }
  return `${scheme}:${url.toString().slice(url.protocol.length)}`;
}

/** Every statement the engine's connections send, in order, around the real connect. */
function recorded(connect: PollingConnect): { connect: PollingConnect; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    connect: (url, options) => {
      const client = connect(url, options);
      return {
        query: (text, params) => {
          sent.push(text);
          return client.query(text, params);
        },
        transaction: (work) =>
          client.transaction((query) =>
            work((text, params) => {
              sent.push(text);
              return query(text, params);
            }),
          ),
        close: () => client.close(),
      };
    },
  };
}

/** What Postgres has and CockroachDB does not parse or have: none of it may reach the node. */
const POSTGRES_ONLY =
  /\block table\b|\bset local (lock_timeout|standard_conforming_strings)\b|\bdo \$\$|grant (select|update) \(|aclexplode|pg_policies|pg_trigger|create policy/i;

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

type Next = Promise<IteratorResult<readonly RecordKey[], void>>;

/** Waits until the pending watch step yields, or `polls` more polls go by without one ("quiet"). */
async function yieldedWithin(pending: Next, clock: FakeClock, polls: number) {
  const start = clock.sleeps.length;
  let result: IteratorResult<readonly RecordKey[], void> | undefined;
  void pending.then((value) => {
    result = value;
  });
  while (result === undefined && clock.sleeps.length < start + polls) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return result?.done === false ? result.value : "quiet";
}

const decided: RecordDecision = {
  decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
  status: "done",
};

/** Reads a key, writes a decision at the hash it read, and acks: what a worker pass does. */
async function answer(connector: Connector, key: RecordKey): Promise<void> {
  const [claimed] = await connector.claim(1);
  expect(claimed).toBe(key);
  const { rows } = await connector.read([key]);
  expect(await connector.write(key, decided, rows[0]?.hash ?? "")).toEqual({ written: true });
  await connector.ack([key]);
}

describe.skipIf(skipUnless("COCKROACH_URL"))("the CockroachDB dialect on COCKROACH_URL", () => {
  let server: string;
  let root: PollingClient;
  let admin: PollingClient;
  let adminUrl: string;
  let workerUrl: string;
  const warnings: string[] = [];
  const recording = recorded(connectCockroach);
  const engine = pollingEngine(cockroachDialect, recording.connect, {
    warn: (message) => warnings.push(message),
  });
  const clock = new TurningClock(START);
  const deps: EngineDeps = { clock, allowInsecure: true, storeShared: false };
  const opened: OpenConnector[] = [];

  beforeAll(async () => {
    server = serverUrl("COCKROACH_URL");
    adminUrl = urlOf(server);
    workerUrl = urlOf(server, "facetdb_worker");
    root = connectCockroach(server);
    // A run that stopped half-way leaves its database; the login goes once nothing grants to it.
    await root.query(`drop database if exists ${SCRATCH} cascade`);
    await root.query("drop user if exists facetdb_worker");
    await root.query(`create database ${SCRATCH}`);
    admin = connectCockroach(adminUrl);
  });

  afterEach(async () => {
    for (const connector of opened.splice(0)) {
      await connector.close();
    }
    warnings.splice(0);
    await admin.query("drop table if exists listings");
    await admin.query("drop table if exists tickets");
  });

  afterAll(async () => {
    await admin.close();
    await root.query(`drop database if exists ${SCRATCH} cascade`);
    await root.query("drop user if exists facetdb_worker");
    await root.close();
    expect(recording.sent.filter((text) => POSTGRES_ONLY.test(text))).toEqual([]);
  });

  /** The application's listings table: keyed by id, with the updated_at it bumps, or without one. */
  async function createListings(updatedAt: "not null" | "none" = "not null") {
    const column = updatedAt === "none" ? "" : ", updated_at timestamptz not null default now()";
    await admin.query(
      `create table listings (id text primary key, title text, description text${column})`,
    );
  }

  async function columns(name = "listings"): Promise<string[]> {
    const rows = await admin.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_hidden = 'NO' order by ordinal_position",
      [name],
    );
    return rows.map((row) => String(row["column_name"]));
  }

  /** Every comment on the table's columns, by column. */
  async function marks(): Promise<Record<string, string>> {
    const rows = await admin.query(
      `select a.attname::text as name, col_description(a.attrelid, a.attnum) as mark
         from pg_attribute a where a.attrelid = 'public.listings'::regclass and a.attnum > 0`,
    );
    return Object.fromEntries(
      rows
        .filter((row) => row["mark"] !== null)
        .map((row) => [String(row["name"]), String(row["mark"])]),
    );
  }

  /** The worker login's rights on the table, as CockroachDB lists them. */
  async function workerRights(): Promise<string[]> {
    const rows = await admin.query(
      "select privilege_type from [show grants on table listings for facetdb_worker] order by 1",
    );
    return rows.map((row) => String(row["privilege_type"]));
  }

  /** `facetdb migrate`'s two calls, the worker login already there. */
  async function migrate(): Promise<EnginePlan> {
    const plan = planned(await engine.planInstall(target, adminUrl, deps));
    const ran = await engine.run(target, plan, adminUrl, deps);
    expect(ran.stopped).toBeUndefined();
    return plan;
  }

  /** The listings fixture installed as migrate installs it, with the login an --insecure node can hold. */
  async function installListings(updatedAt: "not null" | "none" = "not null") {
    await createListings(updatedAt);
    await root.query("create user if not exists facetdb_worker");
    return migrate();
  }

  /** The application's write as the worker's own login cannot make it: by the admin. */
  async function edit(key: string, title: string, at: number) {
    await admin.query(
      `insert into listings (id, title, description, updated_at) values ($1, $2, 'd', to_timestamp($3::float8))
       on conflict (id) do update set title = excluded.title, updated_at = excluded.updated_at`,
      [key, title, at],
    );
  }

  async function workerConnector(): Promise<OpenConnector> {
    const connector = await engine.open(target, workerUrl, deps);
    opened.push(connector);
    return connector;
  }

  it("installs the listings fixture by the polling engine's plan: on the --insecure node the login's statement is refused for its password after the columns ran, and a fresh plan, once the login is made by hand, completes it", async () => {
    await createListings();
    const plan = planned(
      await engine.planInstall(target, adminUrl, { ...deps, workerPassword: PASSWORD }),
    );
    expect(plan.transactional).toBe(false);
    expect(plan.statements.filter((statement) => statement.secret === true)).toHaveLength(1);
    const stopped = await engine.run(target, plan, adminUrl, { ...deps, workerPassword: PASSWORD });
    const at = plan.statements.findIndex((statement) => statement.secret === true);
    expect(stopped.stopped).toEqual({
      at,
      error: "setting or updating a password is not supported in insecure mode",
    });
    // Each column's group committed with its mark: what stays is marked, the claim first; the
    // login does not stay.
    expect(stopped.ran).toEqual(plan.statements.slice(0, at));
    expect(await columns()).toEqual([
      "id",
      "title",
      "description",
      "updated_at",
      "facetdb_state_hash",
      ...OWNED.filter((name) => name !== "facetdb_state_hash"),
    ]);
    expect(await marks()).toEqual({
      ...Object.fromEntries(OWNED.map((name) => [name, "facetdb"])),
      facetdb_state_hash: "facetdb:proj_listings",
    });

    await root.query("create user facetdb_worker");
    const fresh = planned(await engine.planInstall(target, adminUrl, deps));
    expect(fresh.statements.some((statement) => statement.purpose === "login")).toBe(false);
    expect(fresh.notes).toEqual([
      "FacetDB polls public.listings every 10 seconds by updated_at: the application must set updated_at on every insert and every update, or a change it makes is never noticed",
      "CockroachDB has no column-level grants, so the worker login facetdb_worker may read and update every column of public.listings, not only its key, the state fields and FacetDB's own columns (FacetDB reads and writes only those); keep a column the worker must never read in another table",
    ]);
    const ran = await engine.run(target, fresh, adminUrl, deps);
    expect(ran.stopped).toBeUndefined();
    expect(await marks()).toEqual({
      ...Object.fromEntries(OWNED.map((name) => [name, "facetdb"])),
      facetdb_state_hash: "facetdb:proj_listings",
    });
    expect(await workerRights()).toEqual(["SELECT", "UPDATE"]);

    // Idempotent: the next migrate runs and changes nothing.
    const before = { columns: await columns(), marks: await marks() };
    await migrate();
    expect({ columns: await columns(), marks: await marks() }).toEqual(before);
  });

  it("lets one of two projects' installs claim a table: the second, planned before the first ran, stops at its claim with the ownership refusal, and its plan and its worker are refused after", async () => {
    await createListings();
    await root.query("create user if not exists facetdb_worker");
    const other: EngineTarget = { ...target, project: { id: "proj_other", name: "Other" } };
    // Both plans read the table before either ran: neither sees a mark.
    const second = planned(await engine.planInstall(other, adminUrl, deps));
    await migrate();
    const lost = await engine.run(other, second, adminUrl, deps);
    expect(lost.stopped).toEqual({
      at: 0,
      refusal: {
        code: "another-project",
        message:
          "public.listings already carries FacetDB columns from another project (proj_listings); one table belongs to one project. Uninstall there first, or point this project at another table.",
        fix: "change the table or the config as the message says, then run the command again; nothing was changed",
      },
    });
    expect(lost.ran).toEqual([]);
    expect((await marks())["facetdb_state_hash"]).toBe("facetdb:proj_listings");

    const again = await engine.planInstall(other, adminUrl, deps);
    expect(again.ok === false && again.refusal.code).toBe("migrate-refused");
    await expect(engine.open(other, workerUrl, deps)).rejects.toMatchObject({
      refusal: { code: "another-project" },
    });
  });

  it("refuses a table whose only key is CockroachDB's hidden rowid, as one with no primary key", async () => {
    await admin.query("create table listings (title text, description text)");
    const result = await engine.planInstall(target, adminUrl, {
      ...deps,
      workerPassword: PASSWORD,
    });
    expect(result.ok === false && result.refusal.message).toBe(
      "public.listings needs a single-column primary key, and has none; FacetDB keys its answers by it.",
    );
  });

  it("watches under the worker login: a new row is asked, an updated_at bump that changes no state field never, a state change once", async () => {
    await installListings();
    await edit("r1", "one", 1_700_000_000);
    const connector = await workerConnector();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(iterator.next(), clock, 1)).toEqual(["r1"]);
    await answer(connector, "r1");

    // The application's own trigger or ORM bumps updated_at on an update of no state field.
    await admin.query(
      "update listings set updated_at = to_timestamp(1700000100::float8), description = description where id = 'r1'",
    );
    const quiet = iterator.next();
    expect(await yieldedWithin(quiet, clock, 4)).toBe("quiet");

    await edit("r1", "two", 1_700_000_200);
    expect(await quiet).toEqual({ done: false, value: ["r1"] });
    const status = await admin.query("select facetdb_status from listings where id = 'r1'");
    expect(status[0]?.["facetdb_status"]).toBe("pending");
    await answer(connector, "r1");
    expect(await yieldedWithin(iterator.next(), clock, 4)).toBe("quiet");
    const current = await connector.current(["r1"]);
    expect(current.get("r1")).toMatchObject({ status: "done", decisions: decided.decisions });
    // The step still waiting ends when afterEach closes the connector (a `return` would queue behind it).
  });

  it("reads every row of a poll across pages when many share one updated_at to the microsecond", async () => {
    await installListings();
    for (const key of ["a", "b", "c", "d", "e"]) {
      await edit(key, key, 1_700_000_000.123456);
    }
    const connector = createPollingConnector(
      cockroachDialect,
      connectCockroach(workerUrl),
      {
        ...target,
        key: "id",
      },
      { lastChangedColumn: "updated_at", pageSize: 2, clock, warn: () => undefined },
    );
    opened.push(connector);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    const first = await yieldedWithin(iterator.next(), clock, 1);
    expect(first === "quiet" ? [] : [...first].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(await yieldedWithin(iterator.next(), clock, 3)).toBe("quiet");
  });

  /**
   * The worker's connector on a client that pauses each `write` right after its row lock (its
   * `select … for update`) to let `during` run, once, and counts the transactions the node
   * restarted (SQLSTATE 40001) before the connector ran them again.
   */
  function racingConnector(during: () => Promise<void>) {
    const client = connectCockroach(workerUrl);
    let pending: (() => Promise<void>) | undefined = during;
    const restarts = { count: 0 };
    const racing: PollingClient = {
      query: (text, params) => client.query(text, params),
      transaction: (work) =>
        client
          .transaction((query) =>
            work(async (text, params) => {
              const rows = await query(text, params);
              const now = pending;
              if (now !== undefined && text.endsWith(" for update")) {
                pending = undefined;
                await now();
              }
              return rows;
            }),
          )
          .catch((error: unknown) => {
            if ((error as { code?: unknown }).code === "40001") {
              restarts.count += 1;
            }
            throw error;
          }),
      close: () => client.close(),
    };
    const connector = createPollingConnector(
      cockroachDialect,
      racing,
      { ...target, key: "id" },
      { lastChangedColumn: "updated_at", clock, warn: () => undefined },
    );
    opened.push(connector);
    return { connector, restarts };
  }

  /** The application's update of r1's state, in a transaction of its own. */
  function applicationUpdate(priority: "high" | "normal"): Promise<void> {
    return admin.transaction(async (query) => {
      await query(`set transaction priority ${priority}`);
      await query(
        "update listings set title = 'changed by the app', updated_at = now() where id = 'r1'",
      );
    });
  }

  async function stored(): Promise<Record<string, unknown> | undefined> {
    const [row] = await admin.query(
      "select title, facetdb_status, facetdb_state_hash from listings where id = 'r1'",
    );
    return row;
  }

  it("ends a write the node restarts for an application's update of its row as the hash check: zero rows written, never a failed write", async () => {
    await installListings();
    await edit("r1", "one", 1_700_000_000);
    // A `priority high` update pushes the write's transaction past the row it holds: the node
    // restarts the write (WriteTooOldError, SQLSTATE 40001) where Postgres would have waited.
    const { connector, restarts } = racingConnector(() => applicationUpdate("high"));
    const { rows } = await connector.read(["r1"]);
    const result = await connector.write("r1", decided, rows[0]?.hash ?? "");
    expect(restarts.count).toBeGreaterThanOrEqual(1);
    // The retry read the application's state, whose hash is not the one asked about.
    expect(result).toEqual({ written: false });
    expect(await stored()).toEqual({
      title: "changed by the app",
      facetdb_status: null,
      facetdb_state_hash: null,
    });
  });

  it("writes when the application's update waits on the write's row lock, and the next poll asks the changed row again", async () => {
    await installListings();
    await edit("r1", "one", 1_700_000_000);
    let waiting: Promise<void> = Promise.resolve();
    const { connector, restarts } = racingConnector(async () => {
      waiting = applicationUpdate("normal");
      // Long enough for the update to reach the row and queue behind the write's lock.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const { rows } = await connector.read(["r1"]);
    const hash = rows[0]?.hash ?? "";
    expect(await connector.write("r1", decided, hash)).toEqual({ written: true });
    await waiting;
    expect(restarts.count).toBe(0);
    expect(await stored()).toEqual({
      title: "changed by the app",
      facetdb_status: "done",
      facetdb_state_hash: hash,
    });
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(iterator.next(), clock, 1)).toEqual(["r1"]);
  });

  it("passes doctor under the worker login: the login, the pooler, the install that polls every 10 seconds", async () => {
    await installListings();
    const checks = await engine.doctor(target, workerUrl, deps);
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["pooler", "ok"],
      ["install", "ok"],
      ["worker", "skip"],
    ]);
    expect(checks[2]?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place; FacetDB polls public.listings every 10 seconds by updated_at; no trigger",
    );
  });

  it("warns of the hourly full scan on a table without a last-changed column: in the plan, in doctor and in the worker's log", async () => {
    const plan = await installListings("none");
    expect(plan.notes[0]).toBe(
      "public.listings has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour; give public.listings an updated_at, NOT NULL, that the application sets on every insert and every update; FacetDB then polls it every 10 seconds",
    );
    const checks = await engine.doctor(target, workerUrl, deps);
    expect(checks.find((check) => check.name === "polling")).toMatchObject({ status: "warn" });
    await admin.query("insert into listings (id, title, description) values ('r1', 't', 'd')");
    const connector = await workerConnector();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await yieldedWithin(iterator.next(), clock, 1)).toEqual(["r1"]);
    expect(warnings).toEqual([
      "public.listings has no last-changed column, so FacetDB reads the whole table every 60 minutes; give it an updated_at the application sets on every insert and every update (NOT NULL) to notice changes within 10 seconds",
    ]);
    // The next read is an hour away, and finds nothing new.
    expect(await yieldedWithin(iterator.next(), clock, 1)).toBe("quiet");
    expect(clock.sleeps.at(-1)).toBe(3_600_000);
  });

  it("uninstalls every column and the mark with them, takes back the worker's rights, and keeps the login, saying why", async () => {
    await installListings();
    await edit("r1", "keep me", 1_700_000_000);
    const plan = planned(
      await engine.planUninstall(target, adminUrl, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    // In table order: the claim's facetdb_state_hash was added first.
    expect(plan.removes.filter((one) => one.kind === "column").map((one) => one.name)).toEqual([
      "facetdb_state_hash",
      ...OWNED.filter((name) => name !== "facetdb_state_hash"),
    ]);
    expect(plan.keeps.map((one) => one.kind)).toEqual(["grant", "login"]);
    const ran = await engine.run(target, plan, adminUrl, deps);
    expect(ran.stopped).toBeUndefined();
    expect(await columns()).toEqual(["id", "title", "description", "updated_at"]);
    expect(await marks()).toEqual({});
    expect(await workerRights()).toEqual([]);
    const login = await admin.query("select 1 from pg_roles where rolname = 'facetdb_worker'");
    expect(login).toHaveLength(1);
    const kept = await admin.query("select title from listings where id = 'r1'");
    expect(kept[0]?.["title"]).toBe("keep me");
    const again = await engine.planUninstall(target, adminUrl, {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    expect(again.ok === false && again.refusal.code).toBe("uninstall-refused");
  });

  it("tells CockroachDB behind a postgres:// URL by version(), says so on doctor's first line, and checks it with the CockroachDB dialect", async () => {
    await installListings();
    // The composition root's Postgres dialect, stood in for by one with Postgres's schemes and a
    // loopback rule: this package cannot load @facetdb/postgres, which loads it.
    const postgresStandIn: SqlDialect = {
      ...plainDialect,
      name: "Postgres",
      schemes: ["postgres", "postgresql"],
    };
    const wire = postgresWireEngine({
      postgres: postgresStandIn,
      connect: recording.connect,
      warn: () => undefined,
    });
    const url = urlOf(server, "facetdb_worker", "postgres");
    const checks = await wire.doctor(target, url, deps);
    expect(checks[0]).toEqual({
      name: "dialect",
      status: "ok",
      detail: expect.stringMatching(
        /^"listings" on 127\.0\.0\.1:26257\/facetdb_t076 answers version\(\) as CockroachDB \S+ v\d+\.\d+\.\d+, so FacetDB polls it with the CockroachDB dialect$/,
      ),
    });
    expect(checks.slice(1).map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["pooler", "ok"],
      ["install", "ok"],
      ["worker", "skip"],
    ]);
  });

  describe("the connector contract, on a table of its own", () => {
    let tick = 1_700_000_000;
    runConnectorContract(async () => {
      await admin.query(
        "create table tickets (id text primary key, subject text, body text, updated_at timestamptz not null default now())",
      );
      const contractClock = new TurningClock(START);
      // The admin's connection: the suite installs and uninstalls through the connector itself. The
      // peer is the worker that starts after it, on a connection of its own.
      const make = () =>
        createPollingConnector(
          cockroachDialect,
          connectCockroach(adminUrl),
          {
            project: { id: "proj_tickets", name: "Tickets" },
            table: "tickets",
            key: "id",
            onChange: "keep",
            questionSet: {
              questions: CONTRACT_QUESTIONS,
              read: ["subject", "body"],
              model: "jev-1.14.0",
              thresholds: {},
            },
          },
          {
            lastChangedColumn: "updated_at",
            pageSize: 10,
            clock: contractClock,
            warn: () => undefined,
          },
        );
      const connector = make();
      const peer = make();
      return {
        connector,
        peer,
        fields: ["subject", "body"],
        edit: async (key: RecordKey, state: Readonly<Record<string, StateValue>>) => {
          tick += 1;
          await admin.query(
            `insert into tickets (id, subject, body, updated_at) values ($1, $2, $3, to_timestamp($4::float8))
             on conflict (id) do update set subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
            [key, state["subject"], state["body"], tick],
          );
        },
        decisionOf: async (key: RecordKey): Promise<RecordDecision | null> => {
          const [row] = await admin.query(
            `select facetdb_status as status, not_priority as value, not_priority_probability::text as probability,
                    facetdb_reviewed as reviewed from tickets where id = $1`,
            [key],
          );
          if (row === undefined || row["status"] === null) {
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
        },
        clock: contractClock,
        close: async () => {
          await connector.close();
          await peer.close();
          await admin.query("drop table if exists tickets");
        },
      };
    });
  });
});
