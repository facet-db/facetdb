import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  PlanResult,
  QuestionSet,
  RecordDecision,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteConnector, type SqliteClient } from "../connector/index.ts";
import { createSqliteEngine } from "../engine/index.ts";
import { JOURNAL_MODE } from "../install/index.ts";
import { FakeRepeat, serverUrl, temporaryDatabase } from "../testing/index.ts";
import { createLibsqlEngine, openLibsql, SERVER_JOURNAL } from "./index.ts";

/**
 * The libSQL engine on a real sqld: the listings installed through @libsql/client with SQLite's SQL
 * (the file's plan less its journal mode), the trigger re-queueing a claimed key after an
 * application write from a second client, the connector contract (one worker, so no peer), and
 * uninstall leaving nothing. The server has one database and no scratch ones: every test drops the
 * fixture's tables and FacetDB's own before it starts, and the suite drops them again at the end.
 */

// The package's one server: unset, the file fails as it loads, never skips.
const url = serverUrl("LIBSQL_URL");

const START = Date.parse("2026-11-04T09:00:00.000Z");
/** The source's connection-string variable; the loopback test server needs no token. */
const VARIABLE = "LISTINGS_URL";

/** The listings, as the SQLite tests have them. */
const LISTINGS =
  "create table listings (id integer primary key, title text, description text, price real)";

function listingsTarget(): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: {
      questions: [
        { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
      ],
      read: ["title", "description"],
      model: "jev-1.14.0",
      thresholds: {},
    },
  };
}

/** Everything a test here may leave on the server: the fixtures' tables and FacetDB's. */
const LEFT_BEHIND = [
  "listings",
  "new_listings",
  "offers",
  "tickets",
  "facetdb_jobs",
  "facetdb_table_owners",
  "facetdb_guard",
] as const;

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused (${result.refusal.code}): ${result.refusal.message}`);
  }
  return result.plan;
}

describe("the libSQL engine on sqld", () => {
  const env = { [VARIABLE]: url };
  const engine = createLibsqlEngine({ env });
  const clock = new FakeClock(START);
  const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };
  /** The application: a second client of its own, as an app beside the worker holds one. */
  let app: SqliteClient;

  /** Drops what a test may have left; a table's triggers go with it. */
  async function wipe(): Promise<void> {
    for (const table of LEFT_BEHIND) {
      await app.exec(`drop table if exists "${table}"`);
    }
  }

  beforeAll(() => {
    app = openLibsql({ url });
  });

  afterAll(async () => {
    await wipe();
    await app.close();
  });

  async function rows(sql: string): Promise<readonly Record<string, unknown>[]> {
    return app.all(sql);
  }

  async function install(source: EngineTarget): Promise<EnginePlan> {
    const plan = planned(await engine.planInstall(source, url, deps));
    const result = await engine.run(source, plan, url, deps);
    expect(result.stopped).toBeUndefined();
    return plan;
  }

  async function uninstall(source: EngineTarget): Promise<void> {
    const plan = planned(
      await engine.planUninstall(source, url, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    const result = await engine.run(source, plan, url, deps);
    expect(result.stopped).toBeUndefined();
  }

  describe("the listings fixture", () => {
    const listings = { ...listingsTarget(), urlVariable: VARIABLE };

    it("installs with the file's SQL less its journal mode, through the client, and again changes nothing", async () => {
      await wipe();
      await app.exec(LISTINGS);

      // The same statements a SQLite file of the same table is given, but for the pragma.
      const file = temporaryDatabase();
      let filePlan: EnginePlan;
      try {
        const db = file.open();
        db.exec(LISTINGS);
        db.close();
        filePlan = planned(await createSqliteEngine().planInstall(listings, file.path, deps));
      } finally {
        file.remove();
      }
      const plan = await install(listings);
      expect(plan.statements).toEqual(
        filePlan.statements.filter((statement) => statement.text !== JOURNAL_MODE.text),
      );
      expect(plan.notes).toContain(SERVER_JOURNAL);
      expect(engine.render(plan)).toMatch(/^begin immediate;\n\n/);

      const columns = (
        await rows("select name from pragma_table_info('listings') order by cid")
      ).map((row) => row["name"]);
      expect(columns).toEqual([
        "id",
        "title",
        "description",
        "price",
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ]);

      // Idempotent: the second plan adds no column, and its run leaves the schema as it was.
      const schema = await rows("select type, name, sql from sqlite_master order by type, name");
      const again = await install(listings);
      expect(again.statements.some((statement) => statement.purpose === "columns")).toBe(false);
      expect(await rows("select type, name, sql from sqlite_master order by type, name")).toEqual(
        schema,
      );

      const checks = await engine.doctor(listings, url, deps);
      expect(checks.map((check) => [check.name, check.status])).toEqual([
        ["server", "ok"],
        ["token", "ok"],
        ["sqlite", "ok"],
        ["install", "ok"],
        ["marks", "ok"],
        ["lock", "ok"],
      ]);
    });

    it("after an ORM rebuild on the server: migrate names the case and the recovery, doctor fails marks, uninstall keeps the copies, and the recovery as printed runs", async () => {
      await wipe();
      await app.exec(LISTINGS);
      await install(listings);
      await app.exec("insert into listings (id, title, description) values (1, 'bike', 'red')");
      await app.exec(
        "update listings set is_scam = 1, facetdb_status = 'done', facetdb_updated_at = '2026-11-04T09:00:00.000Z' where id = 1",
      );
      await app.exec("delete from facetdb_jobs");
      for (const statement of [
        `create table new_listings (id integer primary key, title text, description text, price real,
           is_scam integer, is_scam_probability real, facetdb_status text not null default 'pending',
           facetdb_updated_at text, facetdb_reviewed integer not null default 0)`,
        "insert into new_listings select * from listings",
        "drop table listings",
        "alter table new_listings rename to listings",
      ]) {
        await app.exec(statement);
      }

      const refused = await engine.planInstall(listings, url, deps);
      expect(refused).toMatchObject({
        ok: false,
        refusal: {
          code: "migrate-refused",
          message: expect.stringMatching(
            /^listings has columns named is_scam, .* but without FacetDB's mark .*the table was rebuilt since/,
          ),
        },
      });
      if (refused.ok) {
        return;
      }
      const checks = await engine.doctor(listings, url, deps);
      const marks = checks.find((check) => check.name === "marks");
      expect(marks).toEqual({
        name: "marks",
        status: "fail",
        detail: refused.refusal.message,
        fix: refused.refusal.fix,
      });
      const uninstall = planned(
        await engine.planUninstall(listings, url, { ...deps, purge: false, alsoUninstalling: [] }),
      );
      expect(
        uninstall.keeps.filter((kept) => kept.kind === "column").map((kept) => kept.name),
      ).toEqual([
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ]);

      // The recovery as printed, run through a client, then migrate: the columns come back marked.
      const script = refused.refusal.fix
        .split("\n")
        .filter((line) => line.startsWith("  "))
        .join("\n");
      await app.exec(script);
      expect(await rows("select record_key from facetdb_jobs")).toEqual([{ record_key: "1" }]);
      await install(listings);
      const after = await engine.doctor(listings, url, deps);
      expect(after.find((check) => check.name === "marks")?.status).toBe("ok");
    });

    it("an application write from a second client re-queues a claimed key, and write refuses the stale answer", async () => {
      await wipe();
      await app.exec(LISTINGS);
      await install(listings);
      await app.run("insert into listings (id, title, description, price) values (?, ?, ?, ?)", [
        1,
        "A red car",
        "Barely used",
        1500,
      ]);
      expect(await rows("select record_key, claimed_by from facetdb_jobs")).toEqual([
        { record_key: "1", claimed_by: null },
      ]);

      const connector = await engine.open(listings, url, { ...deps, workerId: "w1" });
      try {
        expect(await connector.claim(10)).toEqual(["1"]);
        const sent = (await connector.read(["1"])).rows[0]?.hash ?? "";

        await app.run("update listings set description = ? where id = ?", ["Wire the deposit", 1]);
        // The trigger cleared the claim and reset the record to pending.
        expect(await rows("select record_key, claimed_by, claimed_at from facetdb_jobs")).toEqual([
          { record_key: "1", claimed_by: null, claimed_at: null },
        ]);

        const decided: RecordDecision = {
          decisions: { is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.93 } },
          status: "done",
        };
        expect(await connector.write("1", decided, sent)).toEqual({ written: false });
        await connector.ack(["1"]);
        expect(await connector.claim(10)).toEqual(["1"]);
        const fresh = (await connector.read(["1"])).rows[0]?.hash ?? "";
        expect(fresh).not.toBe(sent);
        expect(await connector.write("1", decided, fresh)).toEqual({ written: true });
        await connector.ack(["1"]);
        expect(await rows("select count(*) as n from facetdb_jobs")).toEqual([{ n: 0 }]);
        expect(
          await rows(
            "select is_scam, is_scam_probability, facetdb_status from listings where id = 1",
          ),
        ).toEqual([{ is_scam: 1, is_scam_probability: 0.93, facetdb_status: "done" }]);

        // One worker: a second one is refused while the first one's lock on the server is fresh.
        const second = await engine.open(listings, url, { ...deps, workerId: "w2" });
        try {
          await expect(second.claim(1)).rejects.toThrow(/SQLite allows one worker/);
        } finally {
          await second.close();
        }
      } finally {
        await connector.close();
      }
    });

    it("uninstall keeps the shared tables while another table uses them, and then leaves nothing of FacetDB's", async () => {
      const offers = { ...listings, source: "offers", table: "offers" };
      await wipe();
      await app.exec(LISTINGS);
      await app.exec(LISTINGS.replace("listings", "offers"));
      await install(listings);
      await install(offers);
      const facetdb = async () =>
        (
          await rows(
            "select name from sqlite_master where substr(name, 1, 8) = 'facetdb_' order by name",
          )
        ).map((row) => row["name"]);

      // Run by hand (the script as printed), the guard stops the drop of the queue offers still
      // uses, and nothing of the script stays: the guard table lives in main, never in temp.
      const plan = planned(
        await engine.planUninstall(listings, url, { ...deps, purge: false, alsoUninstalling: [] }),
      );
      const script = engine.render(plan);
      expect(script).not.toMatch(/\btemp\b/);
      const before = await rows("select type, name, sql from sqlite_master order by type, name");
      await expect(app.exec(script)).rejects.toThrow(/another table of this file still uses it/);
      expect(await rows("select type, name, sql from sqlite_master order by type, name")).toEqual(
        before,
      );

      // Run by the engine, the guard skips the shared drops, and the last table's run makes them.
      await uninstall(listings);
      expect(await facetdb()).toEqual([
        "facetdb_jobs",
        "facetdb_jobs_queue",
        "facetdb_offers_ins",
        "facetdb_offers_upd",
        "facetdb_table_owners",
      ]);
      await uninstall(offers);
      expect(await facetdb()).toEqual([]);
      await app.exec('drop table "offers"');
      expect(
        (await rows("select name from pragma_table_info('listings') order by cid")).map(
          (row) => row["name"],
        ),
      ).toEqual(["id", "title", "description", "price"]);
    });
  });

  describe("one worker on the server", () => {
    const tickets: EngineTarget = {
      ...listingsTarget(),
      source: "tickets",
      table: "tickets",
      onChange: "keep",
      urlVariable: VARIABLE,
      questionSet: { ...listingsTarget().questionSet, read: ["subject"] },
    };

    async function workers() {
      await wipe();
      await app.exec("create table tickets (id text primary key, subject text)");
      await install(tickets);
      const fixtureClock = new FakeClock(START);
      const beats = new FakeRepeat(fixtureClock);
      const open = (workerId: string) =>
        createSqliteConnector(tickets, url, {
          clock: fixtureClock,
          repeat: beats.repeat,
          workerId,
          open: () => openLibsql({ url }),
          label: "the libSQL database under test",
        });
      return { beats, first: await open("w1"), second: await open("w2") };
    }

    async function lock(): Promise<readonly Record<string, unknown>[]> {
      return rows(
        "select worker_id, heartbeat_at from facetdb_table_owners where table_name = 'tickets'",
      );
    }

    const iso = (ms: number) => new Date(ms).toISOString();

    it("a worker whose pass waits 3 minutes keeps its lock on its heartbeat, and the second is told when it frees", async () => {
      const { beats, first, second } = await workers();
      try {
        await app.run("insert into tickets (id, subject) values (?, ?)", ["t1", "Refund"]);
        expect(await first.claim(10)).toEqual(["t1"]);
        await beats.advance(3 * 60_000);
        expect(await lock()).toEqual([{ worker_id: "w1", heartbeat_at: iso(START + 3 * 60_000) }]);
        await expect(second.claim(10)).rejects.toThrow(
          `SQLite allows one worker, and worker w1 holds the lock on tickets in the libSQL database under test: it last renewed it at ${iso(START + 3 * 60_000)}, and the lock frees at ${iso(START + 5 * 60_000)} unless it is renewed before then`,
        );
        await first.ack(["t1"]);
      } finally {
        await first.close();
        await second.close();
      }
      expect(await lock()).toEqual([{ worker_id: null, heartbeat_at: null }]);
    });

    it("a worker killed without close keeps its lock until the time the refusal names, then the next takes it", async () => {
      const { beats, first, second } = await workers();
      try {
        expect(await first.claim(10)).toEqual([]);
        await beats.advance(30_000);
        beats.kill();
        const frees = iso(START + 30_000 + 2 * 60_000);
        await beats.advance(2 * 60_000 - 1);
        await expect(second.claim(10)).rejects.toThrow(`the lock frees at ${frees}`);
        await beats.advance(1);
        expect(await second.claim(10)).toEqual([]);
        expect(await lock()).toEqual([{ worker_id: "w2", heartbeat_at: frees }]);
      } finally {
        await second.close();
        await first.close();
      }
    });
  });

  describe("connector contract", () => {
    const FIELDS = ["subject", "body"] as const;
    const questionSet: QuestionSet = {
      questions: CONTRACT_QUESTIONS,
      read: [...FIELDS],
      model: "jev-1.14.0",
      thresholds: {},
    };
    const tickets: EngineTarget = {
      project: { id: "proj_tickets", name: "Tickets" },
      source: "tickets",
      table: "tickets",
      storage: "inline",
      onChange: "keep",
      questionSet,
      urlVariable: VARIABLE,
    };

    runConnectorContract(async () => {
      await wipe();
      await app.exec("create table tickets (id text primary key, subject text, body text)");
      const fixtureClock = new FakeClock(START);
      const connector = await createSqliteConnector(tickets, url, {
        clock: fixtureClock,
        workerId: "w1",
        open: () => openLibsql({ url }),
        label: "the libSQL database under test",
        // Pages of 10, so the 25 seeded records cross page boundaries.
        scanPageSize: 10,
        installer: {
          install: async () => {
            await install(tickets);
          },
          uninstall: async () => {
            if (
              (await rows("select 1 from sqlite_master where name = 'facetdb_table_owners'"))
                .length > 0
            ) {
              await uninstall(tickets);
            }
          },
        },
      });
      return {
        connector,
        fields: [...FIELDS],
        clock: fixtureClock,
        edit: async (key, state) => {
          await app.run(
            `insert into tickets (id, subject, body) values (?, ?, ?)
              on conflict (id) do update set subject = excluded.subject, body = excluded.body`,
            [key, state["subject"] ?? null, state["body"] ?? null],
          );
        },
        decisionOf: async (key) => {
          const [row] = await app.all(
            `select facetdb_status as status, facetdb_updated_at as written, not_priority as value,
                    not_priority_probability as probability, facetdb_reviewed as reviewed
               from tickets where id = ?`,
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
        },
        close: () => connector.close(),
      };
    });
  });
});
