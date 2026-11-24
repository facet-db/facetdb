import {
  type DatabaseEngine,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  type PlanResult,
  type QuestionSet,
  type RecordDecision,
  stateHash,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPollingConnector } from "../connector/index.ts";
import type { PollingClient, PollingConnect } from "../dialect/index.ts";
import { pollingEngine } from "../engine/index.ts";
import { connectOracle, oracleDialect } from "../oracle.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";

/**
 * Oracle as a polling dialect on a real server, Oracle Database Free in the container
 * `scripts/test-databases.sh up oracle` starts, through `oracledb` in thin mode: the listings
 * fixture installed by the polling engine's plan, as `facetdb migrate` runs it, on a table the
 * application created in lower case with quoted names (a `number` key) and on one created unquoted,
 * in capitals (a `varchar2` key), both read, polled and answered by the worker login; the connector
 * contract suite (one worker: the polling queue is the process's own); the hourly-scan warning of a
 * table with no last-changed column; the driver's errors as refusals; uninstall taking every column
 * and the mark.
 *
 * Oracle has no `create database`: the run's tables live in a scratch user, FACETDB_T077_<pid>,
 * dropped with everything in it after the run (and any a crashed run left, before it). The worker
 * login FACETDB_WORKER is the server's, made by the first install of the run and dropped after it.
 * One pool per login serves every case: Oracle Free is slow to open its first sessions.
 */

const SLOW = 180_000;
const OWNER = `FACETDB_T077_${process.pid}`;
const WORKER = "FACETDB_WORKER";
const WORKER_PASSWORD = "Facetdb-t077-worker-pw";
const PROJECT = { id: "proj_listings", name: "Listings" };

const LOWER_SET: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const UPPER_SET: QuestionSet = { ...LOWER_SET, read: ["TITLE", "DESCRIPTION"] };

const deps = { clock: new FakeClock(), allowInsecure: false, storeShared: false } as const;

function target(table: string, questionSet: QuestionSet): EngineTarget {
  return {
    project: PROJECT,
    source: table.toLowerCase(),
    table,
    schema: OWNER,
    storage: "inline",
    onChange: "reset",
    questionSet,
    urlVariable: "LISTINGS_URL",
  };
}

function planned(result: PlanResult) {
  if (!result.ok) {
    throw new Error(`the plan was refused: ${result.refusal.message}`);
  }
  return result.plan;
}

describe.skipIf(skipUnless("ORACLE_URL"))("Oracle as a polling dialect", { timeout: SLOW }, () => {
  // Read when the suite runs, not when it is collected: a skipped suite has no server.
  let server = "";
  let workerUrl = "";
  let admin: PollingClient;

  /** One pool per URL for the whole file; a client's own `close` lets go of nothing. */
  const pools = new Map<string, PollingClient>();
  const connect: PollingConnect = (url) => {
    let pool = pools.get(url);
    if (pool === undefined) {
      pool = connectOracle(url, { max: 4 });
      pools.set(url, pool);
    }
    const shared = pool;
    return {
      query: (text, params) => shared.query(text, params),
      transaction: (work) => shared.transaction(work),
      close: () => Promise.resolve(),
    };
  };
  const warnings: string[] = [];
  const engine: DatabaseEngine = pollingEngine(oracleDialect, connect, {
    warn: (message) => {
      warnings.push(message);
    },
  });
  const opened: OpenConnector[] = [];

  async function dropUser(name: string): Promise<void> {
    const found = await admin.query("select 1 as found from all_users where username = :1", [name]);
    if (found.length > 0) {
      await admin.query(`drop user "${name}" cascade`);
    }
  }

  beforeAll(async () => {
    server = serverUrl("ORACLE_URL");
    const worker = new URL(server);
    worker.username = "facetdb_worker";
    worker.password = WORKER_PASSWORD;
    workerUrl = worker.toString();
    admin = connect(server);
    const left = await admin.query(
      "select username from all_users where username like 'FACETDB\\_T077\\_%' escape '\\'",
    );
    for (const row of left) {
      await dropUser(String(row["username"]));
    }
    await dropUser(WORKER);
    await admin.query(
      `create user "${OWNER}" identified by "Owner-t077-pw" default tablespace users quota unlimited on users`,
    );
    // The application's two tables: quoted lower-case names with a number key, unquoted names
    // (upper case in the catalog) with a varchar2 key; each with the updated_at it bumps.
    await admin.query(`create table "${OWNER}"."listings" (
      "id" number(10) primary key,
      "title" varchar2(200),
      "description" clob,
      "updated_at" timestamp(6) default systimestamp not null
    )`);
    await admin.query(`create table ${OWNER}.LISTINGS (
      ID varchar2(40) primary key,
      TITLE varchar2(200),
      DESCRIPTION varchar2(4000),
      UPDATED_AT timestamp(6) default systimestamp not null
    )`);
  }, SLOW);

  afterAll(async () => {
    for (const connector of opened) {
      await connector.close();
    }
    // The worker's sessions end first: Oracle drops no user who is still connected (ORA-01940).
    for (const [url, pool] of pools) {
      if (url !== server) {
        await pool.close();
      }
    }
    await dropUser(OWNER);
    await dropUser(WORKER);
    await pools.get(server)?.close();
  }, SLOW);

  async function install(table: string, questionSet: QuestionSet) {
    const plan = planned(
      await engine.planInstall(target(table, questionSet), server, {
        ...deps,
        workerPassword: WORKER_PASSWORD,
      }),
    );
    const result = await engine.run(target(table, questionSet), plan, server, {
      ...deps,
      workerPassword: WORKER_PASSWORD,
    });
    expect(result.stopped).toBeUndefined();
    return plan;
  }

  async function open(table: string, questionSet: QuestionSet) {
    const connector = await engine.open(target(table, questionSet), workerUrl, deps);
    opened.push(connector);
    return connector;
  }

  it.each([
    ["listings", LOWER_SET, '"listings"', "1"],
    ["LISTINGS", UPPER_SET, '"LISTINGS"', "k-1"],
  ] as const)(
    "installs %s as the config spells it, and the worker polls, reads and answers it",
    async (table, questionSet, quoted, key) => {
      const [title, description] = questionSet.read;
      const plan = await install(table, questionSet);
      const script = engine.render(plan);
      expect(script).toContain(`alter table "${OWNER}".${quoted} add ("is_scam" number(1))`);
      expect(script).toContain(
        `comment on column "${OWNER}".${quoted}."facetdb_state_hash" is 'facetdb:proj_listings'`,
      );
      expect(plan.notes).toContain(
        `FacetDB polls ${OWNER}.${table} every 10 seconds by ${table === "listings" ? "updated_at" : "UPDATED_AT"}: the application must set ${table === "listings" ? "updated_at" : "UPDATED_AT"} on every insert and every update, or a change it makes is never noticed`,
      );

      // A second migrate adds nothing: the marks are set again, the grants given again.
      const again = planned(
        await engine.planInstall(target(table, questionSet), server, {
          ...deps,
          workerPassword: WORKER_PASSWORD,
        }),
      );
      expect(engine.render(again)).not.toMatch(/alter table|create user/);
      const rerun = await engine.run(target(table, questionSet), again, server, deps);
      expect(rerun.stopped).toBeUndefined();

      // The application's own rows, then the worker under its login.
      await admin.query(
        `insert into "${OWNER}".${quoted} ("${table === "listings" ? "id" : "ID"}", "${title}", "${description}") values (:1, :2, :3)`,
        [key, "Puppy for sale", "Send a gift card first"],
      );
      const connector = await open(table, questionSet);
      const watch = connector.watch()[Symbol.asyncIterator]();
      const batch = await watch.next();
      await watch.return?.();
      expect(batch.value).toEqual([key]);

      const { rows, missing } = await connector.read([key, "9999"]);
      expect(missing).toEqual(["9999"]);
      const state = {
        [title ?? ""]: "Puppy for sale",
        [description ?? ""]: "Send a gift card first",
      };
      expect(rows).toEqual([
        { key, state, hash: stateHash(questionSet.read, state), excluded: false },
      ]);
      const hash = rows[0]?.hash ?? "";
      const decision: RecordDecision = {
        decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
        status: "done",
      };
      expect(await connector.write(key, decision, "stale")).toEqual({ written: false });
      expect(await connector.write(key, decision, hash)).toEqual({ written: true });
      expect((await connector.current([key, "no-such-key"])).get(key)).toEqual({
        ...decision,
        reviewed: false,
        updatedAt: new Date(deps.clock.now()),
      });
      const [stored] = await admin.query(
        `select "is_scam" as v, to_char("is_scam_probability") as p, "facetdb_status" as s from "${OWNER}".${quoted}`,
      );
      expect(stored).toEqual({ v: 1, p: ".93", s: "done" });

      // The worker writes its own columns only: the application's stay out of its reach (23ai
      // names the missing privilege, ORA-41900; earlier releases say ORA-01031).
      const asWorker = connect(workerUrl);
      await expect(
        asWorker.query(`update "${OWNER}".${quoted} set "${title}" = 'x'`),
      ).rejects.toThrow(/ORA-41900: missing UPDATE privilege|ORA-01031/);
    },
  );

  it("reads, hashes and answers a CLOB state field past 4000 bytes, which to_char cannot read", async () => {
    const long = `Send a gift card first. ${"Then wire the deposit. ".repeat(300)}`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(4000);
    await admin.query(
      `insert into "${OWNER}"."listings" ("id", "title", "description") values (2, :1, :2)`,
      ["Kitten for sale", long],
    );
    const connector = await open("listings", LOWER_SET);
    const watch = connector.watch()[Symbol.asyncIterator]();
    const batch = await watch.next();
    await watch.return?.();
    expect(batch.value).toEqual(["2"]);
    const state = { title: "Kitten for sale", description: long };
    const { rows } = await connector.read(["2"]);
    expect(rows).toEqual([
      { key: "2", state, hash: stateHash(LOWER_SET.read, state), excluded: false },
    ]);
    const decision: RecordDecision = {
      decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.97 } },
      status: "done",
    };
    expect(await connector.write("2", decision, rows[0]?.hash ?? "")).toEqual({ written: true });
    expect((await connector.current(["2"])).get("2")).toMatchObject(decision);

    // The other door: a connector made without the catalog's columns reads their types itself,
    // under the worker login, and reads the CLOB whole too.
    const bare = createPollingConnector(
      oracleDialect,
      connect(workerUrl),
      { ...target("listings", LOWER_SET), key: "id" },
      { lastChangedColumn: "updated_at", clock: deps.clock, warn: () => undefined },
    );
    expect((await bare.read(["2"])).rows).toEqual(rows);
    await bare.close();
  });

  it("refuses BLOB, RAW, LONG, XMLTYPE and ROWID state fields in the same words at migrate, at the worker's open and in a connector made without columns", async () => {
    await admin.query(`create table "${OWNER}"."photos" (
      "id" number(10) primary key,
      "title" varchar2(200),
      "image" blob,
      "thumb" raw(16),
      "notes" long,
      "layout" xmltype,
      "origin" rowid,
      "updated_at" timestamp(6) default systimestamp not null
    )`);
    await admin.query(
      `insert into "${OWNER}"."photos" ("id", "title", "image", "thumb", "notes", "layout") values (1, 'Puppy', hextoraw('DEADBEEF'), hextoraw('CAFE'), 'old notes', xmltype('<a/>'))`,
    );
    await admin.query(
      `update "${OWNER}"."photos" p set "origin" = (select rowid from "${OWNER}"."photos" where "id" = 1)`,
    );
    const textOnly: QuestionSet = { ...LOWER_SET, read: ["title"] };
    const binary: QuestionSet = {
      ...LOWER_SET,
      read: ["title", "image", "thumb", "notes", "layout", "origin"],
    };
    const words = {
      code: "state-field",
      message: `${OWNER}.photos's state fields image (BLOB), thumb (RAW), notes (LONG), layout (XMLTYPE), origin (ROWID) hold nothing Oracle can read as text, so FacetDB can neither notice their changes nor ask a question about them`,
      fix: "take image, thumb, notes, layout, origin out of read, which names text, number and date columns; to ask about what they hold, keep a description in a text column and read that one",
    };
    // facetdb migrate refuses before any statement is planned.
    expect(
      await engine.planInstall(target("photos", binary), server, {
        ...deps,
        workerPassword: WORKER_PASSWORD,
      }),
    ).toEqual({ ok: false, refusal: words });
    // Installed reading the title alone, then the config's read gains the binary fields: the
    // worker's open refuses them in migrate's words, and so does doctor's polling line.
    await install("photos", textOnly);
    const refused = await engine.open(target("photos", binary), workerUrl, deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(EngineRefusal);
    expect((refused as EngineRefusal).refusal).toEqual(words);
    const checks = await engine.doctor(target("photos", binary), workerUrl, deps);
    expect(checks.find((check) => check.name === "polling")).toEqual({
      name: "polling",
      status: "fail",
      detail: words.message,
      fix: words.fix,
    });
    const bare = createPollingConnector(
      oracleDialect,
      connect(workerUrl),
      { ...target("photos", binary), key: "id" },
      { lastChangedColumn: "updated_at", clock: deps.clock, warn: () => undefined },
    );
    await expect(bare.read(["1"])).rejects.toEqual(new EngineRefusal(words));
    await bare.close();
    // What the refusal spares: to_char cannot read a RAW, a LONG, an XMLTYPE or a ROWID
    // (ORA-00932) on any poll.
    for (const column of ["thumb", "notes", "layout", "origin"]) {
      await expect(
        admin.query(`select to_char("${column}") as t from "${OWNER}"."photos"`),
      ).rejects.toThrow(/ORA-00932/);
    }
  });

  it("reads every type it lists as text through the worker's poll, the 23ai types among them", async () => {
    await admin.query(`create table "${OWNER}"."kinds" (
      "id" number(10) primary key,
      "v" varchar2(20), "nv" nvarchar2(20), "c" char(3), "nc" nchar(3),
      "n" number, "f" float, "bf" binary_float, "bd" binary_double,
      "d" date, "ts" timestamp(6), "tz" timestamp(6) with time zone,
      "ltz" timestamp(6) with local time zone,
      "ids" interval day(2) to second(6), "iym" interval year(2) to month,
      "cl" clob, "ncl" nclob, "j" json, "jl" json, "b" boolean,
      "updated_at" timestamp(6) default systimestamp not null
    )`);
    // A JSON value past 4,000 bytes, which to_char reads as NULL on 23ai without an error.
    const large = (tail: string) => `{"notes":"${"Send a gift card first. ".repeat(400)}${tail}"}`;
    expect(Buffer.byteLength(large("one"))).toBeGreaterThan(4000);
    await admin.query(
      `insert into "${OWNER}"."kinds" values (
      1, 'a', 'b', 'c', 'd', 1.5, 2.5, 3.5, 4.5,
      date '2026-11-05', timestamp '2026-11-05 10:00:00', timestamp '2026-11-05 10:00:00 +02:00',
      timestamp '2026-11-05 10:00:00', interval '1' day, interval '2' year,
      'clob', 'nclob', json('{"a":1}'), json(:1), true, systimestamp
    )`,
      [large("one")],
    );
    const [unread] = await admin.query(`select to_char("jl") as t from "${OWNER}"."kinds"`);
    expect(unread?.["t"]).toBeNull();
    const read = [
      "v",
      "nv",
      "c",
      "nc",
      "n",
      "f",
      "bf",
      "bd",
      "d",
      "ts",
      "tz",
      "ltz",
      "ids",
      "iym",
      "cl",
      "ncl",
      "j",
      "jl",
      "b",
    ];
    const kinds: QuestionSet = { ...LOWER_SET, read };
    await install("kinds", kinds);
    const connector = await open("kinds", kinds);
    const watch = connector.watch()[Symbol.asyncIterator]();
    expect((await watch.next()).value).toEqual(["1"]);
    await watch.return?.();
    const { rows } = await connector.read(["1"]);
    expect(rows).toHaveLength(1);
    const state = rows[0]?.state ?? {};
    expect(Object.keys(state)).toEqual(read);
    expect(Object.values(state).every((value) => typeof value === "string")).toBe(true);
    // JSON is read whole, as json_serialize writes it: a short value as to_char read it before.
    expect(state["j"]).toBe('{"a":1}');
    expect(state["jl"]).toBe(large("one"));

    // Answered, then the large value changes to another large value: the hash moves, and the
    // next poll asks the row again.
    expect((await connector.claim(1)).length).toBe(1);
    const decision: RecordDecision = {
      decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.9 } },
      status: "done",
    };
    expect(await connector.write("1", decision, rows[0]?.hash ?? "")).toEqual({ written: true });
    await connector.ack(["1"]);
    await admin.query(
      `update "${OWNER}"."kinds" set "jl" = json(:1), "updated_at" = systimestamp where "id" = 1`,
      [large("two")],
    );
    const after = (await connector.read(["1"])).rows[0];
    expect(after?.state["jl"]).toBe(large("two"));
    expect(after?.hash).not.toBe(rows[0]?.hash);
    const again = connector.watch()[Symbol.asyncIterator]();
    expect((await again.next()).value).toEqual(["1"]);
    await again.return?.();
  });

  it("doctor checks the source as the worker login, and says how it polls", async () => {
    const checks = await engine.doctor(target("LISTINGS", UPPER_SET), workerUrl, deps);
    expect(checks.find((check) => check.name === "database")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining(`logged in as ${WORKER}`),
    });
    expect(checks.find((check) => check.name === "install")).toMatchObject({
      status: "ok",
      detail: `the answer columns and facetdb_state_hash are in place; FacetDB polls ${OWNER}.LISTINGS every 10 seconds by UPDATED_AT; no trigger`,
    });
  });

  it("warns that a table with no last-changed column is read whole every hour", async () => {
    await admin.query(
      `create table "${OWNER}"."notes" ("id" number(10) primary key, "title" varchar2(200), "description" varchar2(200))`,
    );
    const plan = await install("notes", LOWER_SET);
    expect(plan.notes).toContain(
      `${OWNER}.notes has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour; give ${OWNER}.notes an updated_at, NOT NULL, that the application sets on every insert and every update; FacetDB then polls it every 10 seconds`,
    );
    await admin.query(
      `insert into "${OWNER}"."notes" ("id", "title", "description") values (7, 'a', 'b')`,
    );
    const connector = await open("notes", LOWER_SET);
    const watch = connector.watch()[Symbol.asyncIterator]();
    expect((await watch.next()).value).toEqual(["7"]);
    await watch.return?.();
    expect(warnings).toContain(
      `${OWNER}.notes has no last-changed column, so FacetDB reads the whole table every 60 minutes; give it an updated_at the application sets on every insert and every update (NOT NULL) to notice changes within 10 seconds`,
    );
    const checks = await engine.doctor(target("notes", LOWER_SET), workerUrl, deps);
    expect(checks.find((check) => check.name === "polling")).toMatchObject({ status: "warn" });
  });

  it("never holds the application's statements on a table another transaction holds", async () => {
    await admin.query(
      `create table "${OWNER}"."busy" ("id" number(10) primary key, "title" varchar2(200), "description" varchar2(200), "updated_at" timestamp not null)`,
    );
    await admin.query(`insert into "${OWNER}"."busy" values (1, 'a', 'b', systimestamp)`);
    await admin.query(`insert into "${OWNER}"."busy" values (2, 'c', 'd', systimestamp)`);
    const busy = target("busy", LOWER_SET);
    const plan = planned(await engine.planInstall(busy, server, deps));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const holds = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const transaction = admin.transaction(async (query) => {
      await query(`update "${OWNER}"."busy" set "title" = 'held' where "id" = 1`);
      holding();
      await held;
    });
    await holds;
    const running = engine.run(busy, plan, server, deps);
    // Give the run's `alter table` time to reach the held table.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // The application's own statement on another row goes on meanwhile, within seconds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      admin.query(`update "${OWNER}"."busy" set "title" = 'goes on' where "id" = 2`),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("the application's update waited behind FacetDB's DDL"));
        }, 10_000);
      }),
    ]);
    clearTimeout(timer);
    release();
    await transaction;
    const result = await running;
    if (result.stopped !== undefined) {
      // Up to 21c the DDL stops at once (ORA-00054), and a fresh plan completes the install.
      expect("error" in result.stopped ? result.stopped.error : "").toContain("the table is busy");
      const fresh = planned(await engine.planInstall(busy, server, deps));
      expect((await engine.run(busy, fresh, server, deps)).stopped).toBeUndefined();
    }
    // 23ai's `alter table` waited for the transaction instead; either way the table is installed.
    const again = planned(await engine.planInstall(busy, server, deps));
    expect(engine.render(again)).not.toContain("alter table");
  });

  it("refuses a worker login Oracle turns down, in plain words", async () => {
    const wrong = new URL(workerUrl);
    wrong.password = "not-the-password";
    const refused = await engine.open(target("LISTINGS", UPPER_SET), wrong.toString(), deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(EngineRefusal);
    expect((refused as EngineRefusal).refusal.code).toBe("database-login");
  });

  it("uninstalls every column of FacetDB's and the mark; the worker's read goes with them", async () => {
    const listings = target("listings", LOWER_SET);
    const still = await open("listings", LOWER_SET);
    const plan = planned(
      await engine.planUninstall(listings, server, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    expect(plan.removes.filter((one) => one.kind === "column").map((one) => one.name)).toEqual([
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
      "facetdb_state_hash",
    ]);
    expect((await engine.run(listings, plan, server, deps)).stopped).toBeUndefined();
    const left = await admin.query(
      `select c.column_name, m.comments as remark
         from all_tab_columns c
         left join all_col_comments m
           on m.owner = c.owner and m.table_name = c.table_name and m.column_name = c.column_name
        where c.owner = :1 and c.table_name = 'listings' order by c.column_id`,
      [OWNER],
    );
    expect(left).toEqual([
      { column_name: "id", remark: null },
      { column_name: "title", remark: null },
      { column_name: "description", remark: null },
      { column_name: "updated_at", remark: null },
    ]);
    const refused = await still.read(["1"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refused as EngineRefusal).refusal.code).toBe("polling-table");
    // Nothing of FacetDB's is left to uninstall.
    const again = await engine.planUninstall(listings, server, {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    expect(again.ok).toBe(false);
  });

  describe("the connector contract", () => {
    const questionSet: QuestionSet = {
      questions: CONTRACT_QUESTIONS,
      read: ["subject", "body"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    const tickets = `"${OWNER}"."tickets"`;

    runConnectorContract(
      async () => {
        await admin
          .query(`drop table ${tickets} purge`)
          .catch((error: unknown) =>
            String(error).includes("ORA-00942") ? undefined : Promise.reject(error),
          );
        await admin.query(`create table ${tickets} (
          "id" varchar2(40) primary key,
          "subject" varchar2(400),
          "body" clob,
          "updated_at" timestamp(6) default systimestamp not null
        )`);
        const clock = new FakeClock(Date.parse("2026-11-04T09:00:00.000Z"));
        // The worker, and the peer that starts after it: each on a connection of its own.
        const make = () =>
          createPollingConnector(
            oracleDialect,
            connect(server),
            {
              project: PROJECT,
              table: "tickets",
              schema: OWNER,
              onChange: "keep",
              questionSet,
              key: "id",
            },
            // Pages of 10, so the suite's 25 records take several and a scan has a cursor to resume.
            {
              lastChangedColumn: "updated_at",
              pageSize: 10,
              // The body is a CLOB, read whole as the engine's `open` reads it.
              columns: [
                { name: "id", type: "VARCHAR2" },
                { name: "subject", type: "VARCHAR2" },
                { name: "body", type: "CLOB" },
              ],
              clock,
              warn: () => undefined,
            },
          );
        const connector = make();
        const peer = make();
        return {
          connector,
          peer,
          fields: questionSet.read,
          clock,
          edit: async (key, state) => {
            await admin.query(
              `merge into ${tickets} t using (select :1 as id from dual) s on (t."id" = s.id)
                when matched then update set "subject" = :2, "body" = :3, "updated_at" = systimestamp
                when not matched then insert ("id", "subject", "body") values (:1, :2, :3)`,
              [key, state["subject"] ?? null, state["body"] ?? null],
            );
          },
          // The polling connector does not write `_probabilities` yet.
          probabilities: "not-yet",
          decisionOf: async (key) => {
            const found = (await connector.current([key])).get(key);
            return found === undefined
              ? null
              : {
                  decisions: found.decisions,
                  status: found.status,
                  ...(found.reviewed ? { reviewed: true } : {}),
                };
          },
          close: async () => {
            await connector.close();
            await peer.close();
          },
        };
      },
      { watchTimeoutMs: 60_000 },
    );
  });
});
