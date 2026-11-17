import type { EnginePlan, EngineTarget } from "@facetdb/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import {
  columns,
  execute,
  facetdbObjects,
  install,
  jobs,
  LISTINGS,
  planned,
  ran,
  reading,
  rows,
  snapshot,
  target,
} from "./listings-world.ts";
import { REFUSED_FIX } from "./plan.ts";
import { render, run } from "./run.ts";
import { planUninstall } from "./uninstall.ts";

/**
 * The uninstall on a SQLite file, run for real on a temporary file: what install added goes, the
 * application's columns and rows stay, a column the application's index, view or trigger uses is
 * refused by name before anything runs, and FacetDB's shared tables go with the file's last
 * installed table, in one run of several tables as the CLI makes it.
 */

let file: TemporaryDatabase;

beforeEach(() => {
  file = temporaryDatabase();
});

afterEach(() => {
  file.remove();
});

const orders = target({ source: "orders", table: "orders" });

function plan(source: EngineTarget = target(), alsoUninstalling: readonly EngineTarget[] = []) {
  return reading(file, (query) => planUninstall(source, query, { alsoUninstalling }));
}

describe("planUninstall", () => {
  it("removes FacetDB's columns, triggers, queued jobs and tables, and keeps the application's rows", async () => {
    execute(file, LISTINGS);
    await install(file);
    execute(file, "insert into listings (title, description, price) values ('bike', 'red', 120)");
    const uninstall = planned(await plan());
    expect(uninstall.confirm).toEqual({ kind: "project", name: "Listings" });
    expect(uninstall.transactional).toBe(true);
    expect(uninstall.removes).toEqual([
      ...[
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ].map((name) => ({ kind: "column", name, of: "listings", scope: "source" })),
      { kind: "trigger", name: "facetdb_listings_ins", of: "listings", scope: "source" },
      { kind: "trigger", name: "facetdb_listings_upd", of: "listings", scope: "source" },
      { kind: "jobs-table", name: "facetdb_jobs", of: "listings", scope: "source" },
      { kind: "jobs-table", name: "facetdb_jobs", scope: "run" },
      { kind: "marker", name: "facetdb_table_owners", scope: "run" },
    ]);
    expect(uninstall.keeps).toEqual([]);
    expect(uninstall.notes).toEqual([
      expect.stringMatching(/^The file stays in WAL mode: .*pragma journal_mode = delete/),
      expect.stringMatching(
        /^SQLite has no conditional DDL: .*`unless this finds a row`.*Run by hand, run the script with sqlite3 -bail/,
      ),
    ]);

    const result = ran(target(), uninstall, file);
    expect(result.removed).toEqual(uninstall.removes);
    // The last table of the file: every statement ran, the guarded drops among them.
    expect(result.ran).toEqual(uninstall.statements);
    expect(columns(file)).toEqual(["id", "title", "description", "price"]);
    expect(facetdbObjects(file)).toEqual([]);
    const db = file.open();
    expect(rows(db, "select * from listings")).toEqual([
      { id: 1, title: "bike", description: "red", price: 120 },
    ]);
    expect(db.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  // A column of FacetDB's name that the application made is its own.
  it.each([
    [
      "rebuilt the SQLite way",
      `create table new_listings (id integer primary key, title text, description text, price real, is_scam integer);
       insert into new_listings (id, title, description, price, is_scam) select id, title, description, price, 1 from listings;
       drop table listings;
       alter table new_listings rename to listings;`,
      ["id", "title", "description", "price", "is_scam"],
    ],
    [
      "dropped and added again",
      "alter table listings drop column is_scam; alter table listings add column is_scam integer; update listings set is_scam = 1",
      ["id", "title", "description", "price", "is_scam"],
    ],
  ])(
    "keeps the application's own is_scam and its values when the application %s",
    async (_, change, left) => {
      execute(file, LISTINGS);
      await install(file);
      execute(file, "insert into listings (title, description) values ('bike', 'red')");
      execute(file, change);
      const uninstall = planned(await plan());
      expect(uninstall.removes).not.toContainEqual(expect.objectContaining({ name: "is_scam" }));
      expect(render(uninstall)).not.toContain('drop column "is_scam";');
      ran(target(), uninstall, file);
      expect(columns(file)).toEqual(left);
      expect(rows(file.open(), "select is_scam from listings")).toEqual([{ is_scam: 1 }]);
      expect(facetdbObjects(file)).toEqual([]);
    },
  );

  it("prints how to run it by hand, the triggers' drop first, then the columns, the table's rows, and the guarded drops", async () => {
    execute(file, LISTINGS);
    await install(file);
    const script = render(planned(await plan()));
    const queue =
      "select tbl_name from sqlite_master where type = 'trigger' and substr(name, 1, 8) = 'facetdb_' and instr(sql, 'facetdb_jobs') > 0 union all select 1 from \"facetdb_jobs\" limit 1";
    expect(script).toMatch(
      /^-- Run by hand, run this script with sqlite3 -bail: [^\n]*\n-- [^\n]*\nbegin immediate;\n\ndrop trigger if exists "facetdb_listings_ins";\n\ndrop trigger if exists "facetdb_listings_upd";\n\nalter table "listings" drop column "is_scam";\n/,
    );
    expect(script).toContain(
      `delete from "facetdb_jobs" where "table_name" = 'listings';\n\ndelete from "facetdb_table_owners" where "table_name" = 'listings';\n\ncreate temp table if not exists "facetdb_guard" ("ok" integer constraint "facetdb: another table of this file still uses it; stop and roll back, nothing of this script is committed yet" check ("ok"));`,
    );
    expect(script).toContain(
      `-- unless this finds a row: ${queue}\ninsert into temp."facetdb_guard" ("ok") select 0 where exists (${queue});\ndrop table if exists "facetdb_jobs";`,
    );
    expect(script).toMatch(/drop table if exists "facetdb_table_owners";\n\ncommit;\n$/);
  });

  it("run by hand as printed, removes it all from a file with no other table installed", async () => {
    execute(file, LISTINGS);
    await install(file);
    execute(file, "insert into listings (title, description) values ('bike', 'red')");
    const script = render(planned(await plan()));
    // sqlite3 -bail runs the statements in order and stops at the first error; exec does the same.
    execute(file, script);
    expect(facetdbObjects(file)).toEqual([]);
    expect(columns(file)).toEqual(["id", "title", "description", "price"]);
  });

  it("run by hand while another table still uses the shared tables, stops at the guard and drops nothing (sqlite3 -bail)", async () => {
    execute(file, LISTINGS);
    execute(file, "create table orders (id integer primary key, title text, description text)");
    await install(file);
    await install(file, orders);
    const script = render(planned(await plan()));
    const before = snapshot(file);
    const shell = file.open();
    expect(() => shell.exec(script)).toThrow(
      "CHECK constraint failed: facetdb: another table of this file still uses it; stop and roll back, nothing of this script is committed yet",
    );
    // The shell leaves the transaction open where it stopped; exiting (or the reader) rolls it back.
    expect(shell.isTransaction).toBe(true);
    shell.exec("rollback");
    expect(snapshot(file)).toEqual(before);
    // The other table's trigger still finds the queue (it failed with "no such table").
    shell.exec("insert into orders (title, description) values ('lamp', 'old')");
    expect(jobs(shell)).toEqual([
      { table_name: "orders", record_key: "1", claimed_by: null, claimed_at: null },
    ]);
  });

  const blockers: readonly {
    readonly what: string;
    readonly sql: string;
    readonly named: string;
  }[] = [
    {
      what: "a view",
      sql: "create view scams as select id, title from listings where is_scam = 1",
      named: "the view scams uses is_scam",
    },
    {
      what: "an index",
      sql: "create index listings_by_status on listings (facetdb_status)",
      named: "the index listings_by_status uses facetdb_status",
    },
    {
      what: "an expression index",
      sql: "create index listings_by_odds on listings (round(is_scam_probability, 1))",
      named: "the index listings_by_odds uses is_scam_probability",
    },
    {
      what: "a partial index",
      sql: "create index listings_reviewed on listings (title) where facetdb_reviewed = 1",
      named: "the index listings_reviewed uses facetdb_reviewed",
    },
    {
      what: "a trigger of the application's",
      sql: "create table decided (id integer); create trigger listings_decided after update of facetdb_status on listings begin insert into decided values (new.id); end",
      named: "the trigger listings_decided uses facetdb_status",
    },
    {
      what: "a trigger on another table that writes FacetDB's column",
      sql: "create table reviews (listing integer); create trigger reviews_mark after insert on reviews begin update listings set facetdb_reviewed = 1 where id = new.listing; end",
      named: "the trigger reviews_mark uses facetdb_reviewed",
    },
  ];

  it.each(blockers)("refuses, naming $what that uses a FacetDB column", async ({ sql, named }) => {
    execute(file, LISTINGS);
    await install(file);
    execute(file, sql);
    const before = snapshot(file);
    const result = await plan();
    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message: expect.stringContaining(`listings: ${named}; SQLite cannot drop a column`),
        fix: REFUSED_FIX,
      },
    });
    expect(snapshot(file)).toEqual(before);
  });

  it("names every object that blocks, with the columns each uses", async () => {
    execute(file, LISTINGS);
    await install(file);
    execute(
      file,
      "create view scams as select id, is_scam, is_scam_probability from listings; create index listings_by_status on listings (facetdb_status)",
    );
    const result = await plan();
    expect(result.ok ? undefined : result.refusal.message).toBe(
      "listings: the index listings_by_status uses facetdb_status and the view scams uses is_scam and is_scam_probability; SQLite cannot drop a column that an index, a view, a trigger or the table's own definition uses, and FacetDB never changes what is not its own. Drop or change them first, then run uninstall again.",
    );
  });

  it("keeps the queue and the marks while another table of the file is installed, and says why", async () => {
    execute(file, LISTINGS);
    execute(file, "create table orders (id integer primary key, title text, description text)");
    await install(file);
    await install(file, orders);
    // The queue is empty: only the other table's trigger keeps it.
    const uninstall = planned(await plan());
    expect(uninstall.removes.filter((object) => object.scope === "run")).toEqual([]);
    expect(uninstall.keeps).toEqual([
      {
        kind: "jobs-table",
        name: "facetdb_jobs",
        scope: "run",
        reason: "a trigger on orders still uses it",
      },
      {
        kind: "marker",
        name: "facetdb_table_owners",
        scope: "run",
        reason: "orders is still installed",
      },
    ]);
    const result = ran(target(), uninstall, file);
    expect(result.removed).toEqual(uninstall.removes);
    // The two guarded drops were skipped, so they are not among what ran (nor is anything after).
    expect(result.ran).toEqual(
      uninstall.statements.filter((statement) => !statement.text.includes("drop table")),
    );
    expect(columns(file)).toEqual(["id", "title", "description", "price"]);
    // The other table's install is untouched: its trigger still queues.
    expect(facetdbObjects(file)).toEqual([
      "facetdb_jobs",
      "facetdb_jobs_queue",
      "facetdb_orders_ins",
      "facetdb_orders_upd",
      "facetdb_table_owners",
    ]);
    const db = file.open();
    db.exec("insert into orders (title, description) values ('desk', 'oak')");
    expect(jobs(db)).toEqual([
      { table_name: "orders", record_key: "1", claimed_by: null, claimed_at: null },
    ]);
  });

  it("keeps the queue while it holds another table's jobs, even with no trigger left to write them", async () => {
    execute(file, LISTINGS);
    execute(file, "create table orders (id integer primary key, title text, description text)");
    await install(file);
    await install(file, orders);
    execute(
      file,
      "insert into orders (title, description) values ('lamp', 'old'); drop trigger facetdb_orders_ins; drop trigger facetdb_orders_upd",
    );
    const uninstall = planned(await plan());
    expect(uninstall.keeps[0]).toEqual({
      kind: "jobs-table",
      name: "facetdb_jobs",
      scope: "run",
      count: 1,
      reason: "it holds 1 queued job of other tables",
    });
    ran(target(), uninstall, file);
    const db = file.open();
    expect(jobs(db)).toEqual([
      { table_name: "orders", record_key: "1", claimed_by: null, claimed_at: null },
    ]);
  });

  it("uninstalls two tables in one run as the CLI does: each script planned again is the one shown", async () => {
    execute(file, LISTINGS);
    execute(file, "create table orders (id integer primary key, title text, description text)");
    await install(file);
    await install(file, orders);
    const all = [target(), orders];
    // The CLI shows every table's plan first, each counting the run's other tables as gone.
    const shown = await Promise.all(
      all.map(async (own) =>
        planned(
          await plan(
            own,
            all.filter((other) => other !== own),
          ),
        ),
      ),
    );
    const [first, second] = shown;
    for (const forecast of shown) {
      expect(forecast.removes.filter((object) => object.scope === "run")).toHaveLength(2);
    }
    const results = [];
    for (const [index, own] of all.entries()) {
      // Then, table by table, it plans again with the tables still to come and runs only the same script.
      const again = planned(await plan(own, all.slice(index + 1)));
      expect(render(again)).toBe(render(shown[index] as EnginePlan));
      results.push(ran(own, again, file));
    }
    // The first run left the queue under the second table's trigger; the last one removed it all.
    expect(results[0]?.removed.filter((object) => object.scope === "run")).toEqual([]);
    expect(results[0]?.ran.length).toBe((first?.statements.length ?? 0) - 2);
    expect(results[1]?.removed).toEqual(second?.removes);
    expect(results[1]?.ran).toEqual(second?.statements);
    expect(first?.statements).toHaveLength(second?.statements.length ?? 0);
    expect(facetdbObjects(file)).toEqual([]);
    expect(columns(file)).toEqual(["id", "title", "description", "price"]);
    expect(columns(file, "orders")).toEqual(["id", "title", "description"]);
  });

  it("refuses a table FacetDB is not installed on", async () => {
    execute(file, LISTINGS);
    expect(await plan()).toEqual({
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message:
          "FacetDB is not installed on listings (facetdb_table_owners has no row for it); run migrate first, or check the source's table.",
        fix: REFUSED_FIX,
      },
    });
  });

  it("refuses a table that does not exist", async () => {
    execute(file, LISTINGS);
    expect(await plan(target({ table: "adverts" }))).toEqual({
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message: "adverts does not exist; there is nothing of FacetDB's on it to remove.",
        fix: REFUSED_FIX,
      },
    });
  });

  it("refuses another project's table, and its run stops if the table changed hands since", async () => {
    execute(file, LISTINGS);
    await install(file);
    const shownAsOurs = planned(await plan());
    const other = target({ project: { id: "proj_other", name: "Other" } });
    expect(await plan(other)).toEqual({
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message:
          "listings belongs to another project (proj_listings); uninstall it from that project.",
        fix: REFUSED_FIX,
      },
    });
    // The marker read again inside the run's transaction: the other project's run stops there.
    const before = snapshot(file);
    expect(run(other, shownAsOurs, file.path).stopped).toEqual({
      at: 0,
      refusal: expect.objectContaining({ code: "another-project" }),
    });
    expect(snapshot(file)).toEqual(before);
  });
});
