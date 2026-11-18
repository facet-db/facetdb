import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EngineTarget } from "@facetdb/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import { planInstall } from "./install.ts";
import {
  columns,
  execute,
  facetdbObjects,
  install,
  jobs,
  LISTINGS,
  listings,
  planned,
  ran,
  reading,
  rows,
  snapshot,
  status,
  target,
  withCategory,
} from "./listings-world.ts";
import { REFUSED_AFTER_WAL_FIX, REFUSED_FIX } from "./plan.ts";
import { BUSY_TIMEOUT_MS, openSource, render, run } from "./run.ts";
import { JOURNAL_MODE } from "./sql.ts";
import { planUninstall } from "./uninstall.ts";

/**
 * The install on a SQLite file, run for real on a temporary file: node:sqlite is in-process, so no
 * server and no container. The listings example is the committed fixture install.listings.sql,
 * compared byte for byte with the printed script; it is read, never written (`UPDATE_FIXTURES=1`
 * rewrites it on purpose, and the diff is reviewed).
 */
const FIXTURE = new URL("./install.listings.sql", import.meta.url);

let file: TemporaryDatabase;

beforeEach(() => {
  file = temporaryDatabase();
});

afterEach(() => {
  file.remove();
});

function plan(source: EngineTarget = target()) {
  return reading(file, (query) => planInstall(source, query));
}

describe("planInstall", () => {
  it("reproduces the listings example byte for byte", async () => {
    execute(file, LISTINGS);
    const sql = render(planned(await plan(target({ key: "id" }))));
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("puts WAL first, outside the transaction, and serves the source's database only", async () => {
    execute(file, LISTINGS);
    const installPlan = planned(await plan());
    expect(installPlan.statements[0]).toEqual(JOURNAL_MODE);
    expect(installPlan.transactional).toBe(true);
    expect(installPlan.statements.every((statement) => statement.database === "source")).toBe(true);
    // SQLite has no logins, so nothing is a secret, nothing is kept and nothing is asked back.
    expect(installPlan.statements.some((statement) => statement.secret === true)).toBe(false);
    expect(installPlan.removes).toEqual([]);
    expect(installPlan.keeps).toEqual([]);
    expect(installPlan.confirm).toBeUndefined();
    expect(render(installPlan)).toMatch(
      /^-- WAL[\s\S]*pragma journal_mode = wal;\n\nbegin immediate;\n/,
    );
    expect(render(installPlan)).toMatch(/;\n\ncommit;\n$/);
  });

  it("says that SQLite has no users, that one worker may run, and that WAL stays", async () => {
    execute(file, LISTINGS);
    const { notes } = planned(await plan());
    expect(notes).toEqual([
      expect.stringMatching(
        /^SQLite has no users: .*the file's path and its permissions are the credential/,
      ),
      expect.stringMatching(/^One worker may run on this file at a time/),
      expect.stringMatching(/WAL mode before the transaction opens .* persistent/),
    ]);
  });

  it("reads and changes nothing: planning leaves the file as it was", async () => {
    execute(file, LISTINGS);
    const before = snapshot(file);
    await plan();
    expect(snapshot(file)).toEqual(before);
  });
});

describe("run", () => {
  it("installs, and a second install changes nothing", async () => {
    execute(file, LISTINGS);
    await install(file);
    expect(columns(file)).toEqual([
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
    expect(facetdbObjects(file)).toEqual([
      "facetdb_jobs",
      "facetdb_jobs_queue",
      "facetdb_listings_ins",
      "facetdb_listings_upd",
      "facetdb_table_owners",
    ]);
    execute(file, "insert into listings (title, description) values ('bike', 'red')");
    const before = snapshot(file);
    const again = planned(await plan());
    // Only what the table lacks is added: nothing, the second time.
    expect(again.statements.filter((statement) => statement.purpose === "columns")).toEqual([]);
    expect(run(target(), again, file.path).stopped).toBeUndefined();
    expect(snapshot(file)).toEqual(before);
  });

  it("runs as printed: the script run by hand installs exactly what run does", async () => {
    execute(file, LISTINGS);
    const script = render(planned(await plan()));
    const byHand = temporaryDatabase();
    try {
      execute(byHand, LISTINGS);
      execute(byHand, script);
      await install(file);
      // The marker's time is each install's own clock; everything else must be the same.
      for (const each of [byHand, file]) {
        execute(each, "update facetdb_table_owners set installed_at = '2026-11-03T12:00:00.000Z'");
      }
      expect(snapshot(byHand)).toEqual(snapshot(file));
    } finally {
      byHand.remove();
    }
  });

  it("marks every column it adds in the table's own definition, and the mark survives other changes", async () => {
    execute(file, LISTINGS);
    await install(file);
    const definition = () =>
      rows(file.open(), "select sql from sqlite_master where name = 'listings'")[0]?.["sql"];
    expect(definition()).toBe(
      `CREATE TABLE listings (id integer primary key, title text, description text, price real, "is_scam" /* facetdb */ integer, "is_scam_probability" /* facetdb */ real, "facetdb_status" /* facetdb */ text not null default 'pending', "facetdb_updated_at" /* facetdb */ text, "facetdb_reviewed" /* facetdb */ integer not null default 0)`,
    );
    // The application drops and renames its own columns: FacetDB's marks stay, and so does adoption.
    execute(
      file,
      "alter table listings drop column price; alter table listings rename column description to body",
    );
    const again = planned(
      await plan(target({ questionSet: { ...listings, read: ["title", "body"] } })),
    );
    expect(again.statements.filter((statement) => statement.purpose === "columns")).toEqual([]);
  });

  it("leaves the file in WAL mode: a second connection reads and writes while the worker's is open", async () => {
    execute(file, LISTINGS);
    await install(file);
    const worker = file.open();
    const application = file.open();
    expect(worker.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    const count = (db: DatabaseSync) =>
      db.prepare("select count(*) as n from listings").get()?.["n"];

    // The worker holds a read transaction open; the application writes beside it, never waiting
    // (its busy timeout is 0, so a lock would fail the write at once).
    worker.exec("begin");
    expect(count(worker)).toBe(0);
    application.exec("insert into listings (title, description) values ('bike', 'red')");
    application.exec("update listings set title = 'red bike' where id = 1");
    expect(count(worker)).toBe(0);
    worker.exec("commit");
    expect(count(worker)).toBe(1);

    // The application holds a read transaction open; the worker writes FacetDB's columns beside it.
    application.exec("begin");
    expect(status(application)).toBe("pending");
    worker.exec(
      "update listings set is_scam = 0, is_scam_probability = 0.02, facetdb_status = 'done' where id = 1",
    );
    expect(status(application)).toBe("pending");
    application.exec("commit");
    expect(status(application)).toBe("done");
  });

  it("is what makes that work: without the install, the same writer waits on the reader and fails", () => {
    execute(file, LISTINGS);
    const worker = file.open();
    const application = file.open();
    expect(worker.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "delete" });
    worker.exec("begin");
    worker.prepare("select count(*) from listings").get();
    expect(() =>
      application.exec("insert into listings (title, description) values ('bike', 'red')"),
    ).toThrow(/database is locked/);
    worker.exec("commit");
  });

  it("queues once for two edits of the state, and not for a FacetDB write or another column", async () => {
    execute(file, LISTINGS);
    await install(file);
    const application = file.open();
    application.exec("insert into listings (title, description) values ('bike', 'red')");
    const queued = [
      { table_name: "listings", record_key: "1", claimed_by: null, claimed_at: null },
    ];
    expect(jobs(application)).toEqual(queued);
    expect(status(application)).toBe("pending");

    // The worker's own write sets FacetDB's columns only: nothing is queued, the status stays.
    application.exec("delete from facetdb_jobs");
    application.exec(
      "update listings set is_scam = 1, is_scam_probability = 0.97, facetdb_status = 'done', facetdb_updated_at = '2026-11-03T12:00:00.000Z' where id = 1",
    );
    expect(jobs(application)).toEqual([]);
    expect(status(application)).toBe("done");
    application.exec("update listings set price = 120 where id = 1");
    expect(jobs(application)).toEqual([]);

    // Two edits of the state before the worker comes back: one job, and the record pending again.
    application.exec("update listings set title = 'red bike' where id = 1");
    application.exec("update listings set description = 'barely used' where id = 1");
    expect(jobs(application)).toEqual(queued);
    expect(status(application)).toBe("pending");
  });

  it("queues again a record changed while the worker holds it: the change clears the claim", async () => {
    execute(file, LISTINGS);
    await install(file);
    const application = file.open();
    application.exec("insert into listings (title, description) values ('bike', 'red')");
    application.exec(
      "update facetdb_jobs set claimed_by = 'worker-1', claimed_at = '2026-11-03T12:00:00.000Z'",
    );
    application.exec("update listings set title = 'red bike' where id = 1");
    expect(jobs(application)).toEqual([
      { table_name: "listings", record_key: "1", claimed_by: null, claimed_at: null },
    ]);
    // The worker's ack deletes its own claim only, so the job stays for the new state.
    application.exec("delete from facetdb_jobs where claimed_by = 'worker-1'");
    expect(jobs(application)).toHaveLength(1);
  });

  it("keeps a decided record's status under onChange keep, and still queues it", async () => {
    execute(file, LISTINGS);
    await install(file, target({ onChange: "keep" }));
    const application = file.open();
    application.exec("insert into listings (title, description) values ('bike', 'red')");
    application.exec("delete from facetdb_jobs");
    application.exec("update listings set facetdb_status = 'done' where id = 1");
    application.exec("update listings set title = 'red bike' where id = 1");
    expect(jobs(application)).toHaveLength(1);
    expect(status(application)).toBe("done");
  });

  it("adds only the columns a new question needs, each marked as FacetDB's", async () => {
    execute(file, LISTINGS);
    await install(file);
    const grown = planned(await plan(target({ questionSet: withCategory })));
    expect(
      grown.statements
        .filter((statement) => statement.purpose === "columns")
        .map((statement) => statement.text),
    ).toEqual([
      'alter table "listings" add column "category" /* facetdb */ text',
      'alter table "listings" add column "category_confidence" /* facetdb */ real',
      'alter table "listings" add column "category_probabilities" /* facetdb */ text',
    ]);
    expect(run(target({ questionSet: withCategory }), grown, file.path).stopped).toBeUndefined();
    expect(
      planned(await plan(target({ questionSet: withCategory }))).statements,
    ).not.toContainEqual(expect.objectContaining({ purpose: "columns" }));
  });

  // A column of FacetDB's name and another type is the application's.
  it("refuses to adopt a column of FacetDB's name and another type the application rebuilt the table with, naming it the application's", async () => {
    execute(file, LISTINGS);
    await install(file);
    execute(file, "insert into listings (title, description) values ('bike', 'red')");
    execute(
      file,
      `create table new_listings (id integer primary key, title text, description text, price real, is_scam text);
       insert into new_listings (id, title, description, price) select id, title, description, price from listings;
       drop table listings;
       alter table new_listings rename to listings;`,
    );
    expect(await plan()).toEqual({
      ok: false,
      refusal: {
        code: "migrate-refused",
        message:
          "listings already has a column named is_scam that is the application's: FacetDB marks every column it adds (/* facetdb */ in the table's definition), and this one has no mark, so FacetDB neither writes nor drops it. Rename the question or the column.",
        fix: REFUSED_FIX,
      },
    });
  });

  /*
   * An ORM's table rebuild copies FacetDB's columns without their marks. migrate names the case and
   * the recovery, and the recovery, run as printed, brings the columns back marked with the
   * answered records queued for the worker to write back from the decision log.
   */
  describe("a table rebuilt since the install (lost marks)", () => {
    /** Prisma's and Drizzle's form: the table made again with every column, the rows copied. */
    const ORM_REBUILD = `
    create table new_listings ("id" integer primary key, "title" text, "description" text, "price" real,
      "is_scam" integer, "is_scam_probability" real, "facetdb_status" text not null default 'pending',
      "facetdb_updated_at" text, "facetdb_reviewed" integer not null default 0);
    insert into new_listings select * from listings;
    drop table listings;
    alter table new_listings rename to listings;`;

    const COPIES = [
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ];

    const CASE =
      "listings has columns named is_scam, is_scam_probability, facetdb_status, facetdb_updated_at and facetdb_reviewed with FacetDB's names and types but without FacetDB's mark (/* facetdb */ in the table's definition), on a table FacetDB installed for this project where no column carries the mark any more and FacetDB's two triggers are gone: the table was rebuilt since (a new table, the rows copied, the old one dropped and the new one renamed, as an ORM migration that copies every column does, or a hand-written create table … as select), which copies columns and their values but not their marks and drops the triggers, so changes made since were not queued. SQLite cannot mark a column without rebuilding the table again, and FacetDB never adopts an unmarked column: it may be the application's own.";

    const RECOVERY = [
      "Nothing is lost: the decision log keeps every answer and every human decision (facetdb explain shows a record's). Stop facetdb worker, then run this on the database; it queues every record FacetDB has written to and drops the copies:",
      "  begin immediate;",
      `  insert or ignore into "facetdb_jobs" ("table_name", "record_key") select 'listings', "id" from "listings" where "facetdb_updated_at" is not null;`,
      ...COPIES.map((column) => `  alter table "listings" drop column "${column}";`),
      "  commit;",
      "Then run facetdb migrate, which adds the columns back, marked, with the triggers, and start facetdb worker: it writes each queued record's decision back from the decision log without asking the model, and runs the record's actions again as every write does (webhooks, plugins). It asks the model for a queued record whose state changed since its last answer, whose question set or model version changed since, or whose last outcome was an error or held, and those asks skip backfill's estimate. facetdb backfill asks the records never answered, after its estimate. If the application made these columns itself, rename the question or the column instead.",
    ].join("\n");

    /** The listings installed, one record decided by the worker and one never asked, the queue empty. */
    async function decided(): Promise<void> {
      execute(file, LISTINGS);
      await install(file);
      execute(
        file,
        `insert into listings (id, title, description) values (1, 'bike', 'red'), (2, 'car', 'blue');
       update listings set is_scam = 1, is_scam_probability = 0.93, facetdb_status = 'done',
         facetdb_updated_at = '2026-11-04T09:00:00.000Z' where id = 1;
       delete from facetdb_jobs;`,
      );
    }

    it("migrate names the rebuild and the recovery, step by step, as SQL to run", async () => {
      await decided();
      execute(file, ORM_REBUILD);
      expect(await plan()).toEqual({
        ok: false,
        refusal: { code: "migrate-refused", message: CASE, fix: RECOVERY },
      });
    });

    it("the recovery run as printed brings the columns back marked, the answered record queued and the values gone only from the table", async () => {
      await decided();
      execute(file, ORM_REBUILD);
      const refused = await plan();
      if (refused.ok) {
        throw new Error("the rebuilt table was not refused");
      }
      const script = refused.refusal.fix
        .split("\n")
        .filter((line) => line.startsWith("  "))
        .join("\n");
      execute(file, script);
      expect(columns(file)).toEqual(["id", "title", "description", "price"]);
      // Only the record FacetDB had written to is queued: the one never asked waits for a backfill.
      expect(jobs(file.open())).toEqual([
        { table_name: "listings", record_key: "1", claimed_by: null, claimed_at: null },
      ]);

      const again = planned(await plan());
      expect(again.statements.filter((one) => one.purpose === "columns")).toHaveLength(5);
      ran(target(), again, file);
      const db = file.open();
      const definition = String(
        db.prepare("select sql from sqlite_master where name = 'listings'").get()?.["sql"],
      );
      for (const column of COPIES) {
        expect(definition).toContain(`"${column}" /* facetdb */`);
      }
      expect(rows(db, "select id, is_scam, facetdb_status from listings order by id")).toEqual([
        { id: 1, is_scam: null, facetdb_status: "pending" },
        { id: 2, is_scam: null, facetdb_status: "pending" },
      ]);
      expect(jobs(db)).toHaveLength(1);
      // The triggers are back: the application's next change is queued again.
      db.exec("update listings set title = 'red bike' where id = 2");
      expect(jobs(db)).toHaveLength(2);
    });

    it("names a rebuild that copied one column, and queues nothing when no facetdb_updated_at survived", async () => {
      await decided();
      execute(
        file,
        `create table new_listings (id integer primary key, title text, description text, price real, is_scam integer, note text not null default '');
         insert into new_listings (id, title, description, price, is_scam) select id, title, description, price, is_scam from listings;
         drop table listings;
         alter table new_listings rename to listings;`,
      );
      const result = await plan();
      expect(result).toMatchObject({ ok: false, refusal: { code: "migrate-refused" } });
      if (result.ok) {
        return;
      }
      expect(result.refusal.message).toMatch(
        /^listings has a column named is_scam with FacetDB's name and type but without FacetDB's mark/,
      );
      // Queuing every record would ask the model for each one never answered, unpaced, unestimated.
      expect(result.refusal.fix).toBe(
        [
          "Nothing is lost: the decision log keeps every answer and every human decision (facetdb explain shows a record's). Stop facetdb worker, then run this on the database; it drops the copy, and queues nothing, since the table kept no facetdb_updated_at to tell the answered records from the others:",
          "  begin immediate;",
          `  alter table "listings" drop column "is_scam";`,
          "  commit;",
          "Then run facetdb migrate, which adds the column back, marked, with the triggers. facetdb backfill asks the records never answered, after its estimate; an answered record's columns fill again when its state next changes, and facetdb explain shows its answers meanwhile. If the application made this column itself, rename the question or the column instead.",
        ].join("\n"),
      );
    });

    // Anything short of a rebuild (no mark left, no trigger left) is the application's column,
    // refused as before, and never handed a drop.
    it("refuses a column the application dropped and added again beside FacetDB's marked ones as the application's", async () => {
      await decided();
      execute(
        file,
        "alter table listings drop column is_scam; alter table listings add column is_scam integer; update listings set is_scam = 1;",
      );
      expect(await plan()).toEqual({
        ok: false,
        refusal: {
          code: "migrate-refused",
          message:
            "listings already has a column named is_scam that is the application's: FacetDB marks every column it adds (/* facetdb */ in the table's definition), and this one has no mark, so FacetDB neither writes nor drops it. Rename the question or the column.",
          fix: REFUSED_FIX,
        },
      });
    });

    it("refuses a question added under the name of the application's own column of the same type as the application's", async () => {
      execute(
        file,
        "create table listings (id integer primary key, title text, description text, price real, verified integer)",
      );
      await install(file);
      execute(file, "insert into listings (title, verified) values ('bike', 1)");
      const grown = target({
        questionSet: {
          ...listings,
          questions: [
            ...listings.questions,
            {
              type: "noul",
              name: "verified",
              instructions: "Is the seller verified?",
              stakes: "low",
            },
          ],
        },
      });
      expect(await plan(grown)).toEqual({
        ok: false,
        refusal: {
          code: "migrate-refused",
          message:
            "listings already has a column named verified that is the application's: FacetDB marks every column it adds (/* facetdb */ in the table's definition), and this one has no mark, so FacetDB neither writes nor drops it. Rename the question or the column.",
          fix: REFUSED_FIX,
        },
      });
    });

    it("after create table as select, which drops the key too, names the rebuild and asks for the key first", async () => {
      await decided();
      execute(
        file,
        `create table new_listings as select * from listings;
       drop table listings;
       alter table new_listings rename to listings;`,
      );
      // CTAS declares the copies INT, REAL, TEXT: FacetDB's types by SQLite's affinity.
      expect(await plan()).toEqual({
        ok: false,
        refusal: {
          code: "migrate-refused",
          message: CASE,
          fix: "The rebuild left the table without the key FacetDB keys its records by: listings has no primary key; FacetDB keys its jobs and decisions by it. Add one, or name rowid as the source's key, and run migrate again. Then run facetdb migrate again: it names the rest of the recovery. If the application made these columns itself, rename the question or the column instead.",
        },
      });
    });

    it("names what of the application's blocks the drops first", async () => {
      await decided();
      execute(file, ORM_REBUILD);
      execute(file, "create index listings_scam on listings (is_scam)");
      const result = await plan();
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          fix: expect.stringMatching(
            /^First, the index listings_scam uses is_scam, and SQLite cannot drop a column in use: drop or change it\. Nothing is lost:/,
          ),
        },
      });
    });

    it("never names a recovery on a table this project did not install: the columns are the application's", async () => {
      execute(
        file,
        "create table listings (id integer primary key, title text, description text, is_scam integer)",
      );
      const result = await plan();
      expect(result).toMatchObject({
        ok: false,
        refusal: { fix: REFUSED_FIX, message: expect.stringContaining("the application's") },
      });
    });
  });

  it("keys a table by its rowid when the config names it, and says when VACUUM may renumber it", async () => {
    execute(file, "create table listings (title text, description text)");
    const keyed = target({ key: "rowid" });
    const rowidPlan = planned(await plan(keyed));
    expect(rowidPlan.notes.at(-1)).toMatch(/keyed by its rowid, .*VACUUM may renumber/);
    expect(render(rowidPlan)).toContain("values ('listings', new.rowid)");
    await install(file, keyed);
    const application = file.open();
    application.exec("insert into listings (title, description) values ('bike', 'red')");
    expect(jobs(application)).toEqual([
      { table_name: "listings", record_key: "1", claimed_by: null, claimed_at: null },
    ]);
  });

  it("names no VACUUM risk for a rowid that an integer primary key holds", async () => {
    execute(file, LISTINGS);
    const { notes } = planned(await plan(target({ key: "rowid" })));
    expect(notes.some((note) => note.includes("VACUUM"))).toBe(false);
  });

  it("finds a WITHOUT ROWID table's records by their key", async () => {
    execute(
      file,
      "create table listings (code text primary key, title text, description text) without rowid",
    );
    const keyed = planned(await plan());
    expect(render(keyed)).toContain(
      `where "code" = new."code" and "facetdb_status" is not 'pending'`,
    );
    await install(file);
    const application = file.open();
    application.exec(
      "insert into listings (code, title, description) values ('b-1', 'bike', 'red')",
    );
    application.exec("delete from facetdb_jobs");
    application.exec("update listings set facetdb_status = 'done' where code = 'b-1'");
    application.exec("update listings set title = 'red bike' where code = 'b-1'");
    expect(jobs(application)).toEqual([
      { table_name: "listings", record_key: "b-1", claimed_by: null, claimed_at: null },
    ]);
    expect(
      application.prepare("select facetdb_status from listings where code = 'b-1'").get(),
    ).toEqual({ facetdb_status: "pending" });
  });

  it("stops, changing nothing but the journal mode, when another project claimed the table after the plan", async () => {
    execute(file, LISTINGS);
    const late = planned(await plan());
    const other = target({ project: { id: "proj_other", name: "Other" } });
    await install(file, other);
    const before = snapshot(file);
    const result = run(target(), late, file.path);
    expect(result).toEqual({
      ran: [JOURNAL_MODE],
      stopped: {
        at: 1,
        refusal: {
          code: "another-project",
          message:
            "listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
          // The journal mode ran before the transaction, and the fix says it stays.
          fix: REFUSED_AFTER_WAL_FIX,
        },
      },
      removed: [],
      notes: [],
    });
    expect(snapshot(file)).toEqual(before);
  });

  it("reads whether it was the uninstall's last inside the transaction: a failure there commits nothing", async () => {
    execute(file, LISTINGS);
    await install(file);
    const uninstall = planned(
      await reading(file, (query) => planUninstall(target(), query, { alsoUninstalling: [] })),
    );
    const before = snapshot(file);
    // A handle whose read of the file's objects, the last-table check, fails.
    class FailingCheck extends DatabaseSync {
      override prepare(sql: string) {
        if (sql === "select 1 from sqlite_master where name = ?") {
          throw new Error("disk I/O error");
        }
        return super.prepare(sql);
      }
    }
    const result = run(target(), uninstall, file.path, (path) => new FailingCheck(path));
    expect(result.stopped).toEqual({ at: uninstall.statements.length, error: "disk I/O error" });
    expect(result.ran).toEqual([]);
    expect(snapshot(file)).toEqual(before);
  });

  it("rolls the whole transaction back when a statement fails, and says where it stopped", async () => {
    execute(file, LISTINGS);
    const late = planned(await plan());
    // The application adds a column of FacetDB's name after the plan was read.
    execute(file, "alter table listings add column is_scam text");
    const result = run(target(), late, file.path);
    const failing = late.statements.findIndex((statement) =>
      statement.text.endsWith('add column "is_scam" /* facetdb */ integer'),
    );
    expect(result.stopped).toEqual({ at: failing, error: "duplicate column name: is_scam" });
    // Only the journal mode, which ran before the transaction, stays.
    expect(result.ran).toEqual([JOURNAL_MODE]);
    expect(facetdbObjects(file)).toEqual([]);
    const db = file.open();
    expect(db.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  it("stops before anything when the file cannot be put in WAL mode", async () => {
    execute(file, LISTINGS);
    const installPlan = planned(await plan());
    const result = run(target(), installPlan, file.path, () => new DatabaseSync(":memory:"));
    expect(result.ran).toEqual([]);
    expect(result.stopped).toEqual({
      at: 0,
      refusal: expect.objectContaining({
        code: "journal-mode",
        message: expect.stringMatching(
          /stays in memory journal mode: SQLite would not put it in WAL/,
        ),
      }),
    });
    expect(facetdbObjects(file)).toEqual([]);
  });

  it("never creates a file that is not there", async () => {
    execute(file, LISTINGS);
    const installPlan = planned(await plan());
    const missing = join(file.path, "..", "missing.db");
    expect(run(target(), installPlan, missing)).toEqual({
      ran: [],
      stopped: { at: 0, refusal: expect.objectContaining({ code: "no-file" }) },
      removed: [],
      notes: [],
    });
  });

  it("opens the file waiting 5 seconds behind another connection's write", () => {
    execute(file, LISTINGS);
    const db = openSource(file.path);
    try {
      expect(BUSY_TIMEOUT_MS).toBe(5_000);
      expect(db.prepare("pragma busy_timeout").get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
    } finally {
      db.close();
    }
  });
});

describe("planInstall refuses", () => {
  const otherProject = target({ project: { id: "proj_other", name: "Other" } });
  const cases: readonly {
    readonly what: string;
    readonly table?: string;
    readonly before?: (file: TemporaryDatabase) => Promise<void>;
    readonly source?: EngineTarget;
    readonly message: RegExp;
  }[] = [
    {
      what: "a table that does not exist",
      message:
        /^listings does not exist; FacetDB adds columns to a table, it does not create one\.$/,
    },
    {
      what: "a view",
      table:
        "create table items (id integer primary key, title text, description text); create view listings as select * from items",
      message: /^listings is a view; /,
    },
    {
      what: "a virtual table",
      table: "create virtual table listings using fts5(title, description)",
      message:
        /^listings is a virtual table, which SQLite gives neither added columns nor triggers/,
    },
    {
      what: "side-table storage",
      table: LISTINGS,
      source: target({ storage: "side-table" }),
      message: /SQLite keeps answers in inline columns only/,
    },
    {
      what: "a schema other than main",
      table: LISTINGS,
      source: target({ schema: "archive" }),
      message: /^archive\.listings: a SQLite source names its table bare/,
    },
    {
      what: "a table without a primary key",
      table: "create table listings (title text, description text)",
      message: /^listings has no primary key; .*or name rowid as the source's key/,
    },
    {
      what: "a composite primary key",
      table:
        "create table listings (a integer, b integer, title text, description text, primary key (a, b))",
      message: /^listings has a composite primary key \(a, b\); /,
    },
    {
      what: "a key the table's primary key is not",
      table: LISTINGS,
      source: target({ key: "title" }),
      message: /^listings's primary key is id, not title; the config and the table disagree\.$/,
    },
    {
      what: "rowid on a WITHOUT ROWID table",
      table:
        "create table listings (code text primary key, title text, description text) without rowid",
      source: target({ key: "rowid" }),
      message: /^listings is a WITHOUT ROWID table, so it has no rowid to key by/,
    },
    {
      what: "a state field FacetDB writes",
      table: LISTINGS,
      source: target({ questionSet: { ...listings, read: ["title", "is_scam"] } }),
      message: /the state field is_scam is a column FacetDB writes/,
    },
    {
      what: "a state field the table does not have",
      table: LISTINGS,
      source: target({ questionSet: { ...listings, read: ["title", "body"] } }),
      message: /^listings has no column named body, which read lists/,
    },
    {
      what: "a generated state field",
      table:
        "create table listings (id integer primary key, title text, description text, summary text generated always as (title || description))",
      source: target({ questionSet: { ...listings, read: ["summary"] } }),
      message: /summary is a generated column, which no update sets/,
    },
    {
      what: "an application's column of a question's name",
      table:
        "create table listings (id integer primary key, title text, description text, is_scam text)",
      message:
        /^listings already has a column named is_scam that is the application's: .*Rename the question or the column\.$/,
    },
    {
      what: "a table another project installed on",
      table: LISTINGS,
      before: async (file) => {
        await install(file, otherProject);
      },
      message: /^listings already carries FacetDB columns from another project \(proj_other\)/,
    },
    {
      what: "a question whose type changed",
      table: LISTINGS,
      before: async (file) => {
        await install(file);
      },
      source: target({
        questionSet: {
          ...listings,
          questions: [
            {
              type: "choice",
              name: "is_scam",
              instructions: "Is this listing a scam?",
              options: [
                { name: "yes", description: "A scam" },
                { name: "no", description: "Not a scam" },
              ],
              stakes: "high",
              storeProbabilities: false,
            },
          ],
        },
      }),
      message:
        /^listings: is_scam is integer and the question now needs text; a question's type cannot change in place/,
    },
  ];

  it.each(cases)("$what", async ({ table, before, source, message }) => {
    if (table !== undefined) {
      execute(file, table);
    }
    await before?.(file);
    const ahead = snapshot(file);
    const result = await plan(source ?? target());
    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "migrate-refused",
        message: expect.stringMatching(message),
        fix: REFUSED_FIX,
      },
    });
    expect(snapshot(file)).toEqual(ahead);
  });
});
