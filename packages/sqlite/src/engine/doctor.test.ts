import type { DatabaseSync } from "node:sqlite";
import type { DoctorCheck, EngineDeps, EngineTarget, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { planInstall, sqliteQuery } from "../install/index.ts";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import { createSqliteEngine, DOCTOR_CHECKS } from "./index.ts";

/**
 * Doctor's `marks` check: every column FacetDB writes on the table carries its mark in the table's
 * definition. A table an ORM rebuilt fails it with migrate's own words and recovery, and a table
 * not installed for this project skips it. A column the table lacks is the install check's
 * (doctor-capture.test.ts): a question added is an install behind the file.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

function target(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    urlVariable: "LISTINGS_URL",
    ...changes,
  };
}

const deps: EngineDeps = { clock: new FakeClock(START), allowInsecure: false, storeShared: false };

const files: TemporaryDatabase[] = [];
afterEach(() => {
  for (const file of files.splice(0)) {
    file.remove();
  }
});

function withFile(work: (db: DatabaseSync) => void): TemporaryDatabase {
  const file = temporaryDatabase();
  files.push(file);
  const db = file.open();
  try {
    work(db);
  } finally {
    db.close();
  }
  return file;
}

async function installed(source: EngineTarget = target()): Promise<TemporaryDatabase> {
  const file = withFile((db) =>
    db.exec("create table listings (id integer primary key, title text)"),
  );
  const engine = createSqliteEngine();
  const plan = await engine.planInstall(source, file.path, deps);
  if (!plan.ok) {
    throw new Error(plan.refusal.message);
  }
  expect((await engine.run(source, plan.plan, file.path, deps)).stopped).toBeUndefined();
  return file;
}

function edit(file: TemporaryDatabase, sql: string): void {
  const db = file.open();
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function marksOf(file: TemporaryDatabase, source: EngineTarget = target()) {
  const checks = await createSqliteEngine().doctor(source, file.path, deps);
  return {
    statuses: checks.map((check) => [check.name, check.status]),
    marks: checks.find((check) => check.name === "marks") as DoctorCheck,
  };
}

/** Prisma's and Drizzle's rebuild: the table made again with every column, the rows copied. */
const ORM_REBUILD = `
  create table new_listings (id integer primary key, title text, is_scam integer,
    is_scam_probability real, facetdb_status text not null default 'pending', facetdb_updated_at text,
    facetdb_reviewed integer not null default 0);
  insert into new_listings select * from listings;
  drop table listings;
  alter table new_listings rename to listings;`;

describe("doctor's marks check", () => {
  it("is listed between the install and the lock, saying what it reads", () => {
    expect(DOCTOR_CHECKS.map((check) => check.name)).toEqual([
      "file",
      "wal",
      "sqlite",
      "capture",
      "install",
      "marks",
      "lock",
    ]);
    expect(DOCTOR_CHECKS.find((check) => check.name === "marks")?.looksAt).toBe(
      "reads the table's definition for FacetDB's mark on each of its columns, which a table rebuild drops",
    );
  });

  it("passes on a table as migrate left it", async () => {
    const { statuses, marks } = await marksOf(await installed());
    expect(statuses.every(([, status]) => status === "ok")).toBe(true);
    expect(marks.detail).toBe("every column FacetDB writes on listings carries FacetDB's mark");
  });

  it("fails after an ORM rebuild with migrate's words and recovery, the capture failing for the lost triggers", async () => {
    const file = await installed();
    edit(file, ORM_REBUILD);
    const { statuses, marks } = await marksOf(file);
    expect(statuses).toEqual([
      ["file", "ok"],
      ["wal", "ok"],
      ["sqlite", "ok"],
      ["capture", "fail"],
      ["install", "ok"],
      ["marks", "fail"],
      ["lock", "skip"],
    ]);
    // The same words migrate refuses with: one finding, one recovery, wherever it is read.
    const reader = file.open({ readOnly: true });
    let refused: Awaited<ReturnType<typeof planInstall>>;
    try {
      refused = await planInstall(target(), sqliteQuery(reader));
    } finally {
      reader.close();
    }
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(marks.detail).toBe(refused.refusal.message);
    expect(marks.fix).toBe(refused.refusal.fix);
    expect(marks.detail).toMatch(
      /^listings has columns named is_scam, is_scam_probability, facetdb_status, facetdb_updated_at and facetdb_reviewed with FacetDB's names and types but without FacetDB's mark/,
    );
    expect(marks.fix).toContain('  alter table "listings" drop column "is_scam";');
    // The step after migrate is the write-back from the log, which runs no action.
    expect(marks.fix).toContain(
      "Then run facetdb migrate, which adds the columns back, marked, with the triggers, and then facetdb backfill --from-log,",
    );
  });

  it("fails after a create table as select rebuild too, which also drops the key", async () => {
    const file = await installed();
    edit(
      file,
      "create table copy as select * from listings; drop table listings; alter table copy rename to listings;",
    );
    const { marks } = await marksOf(file);
    expect(marks.status).toBe("fail");
    expect(marks.fix).toMatch(
      /^The rebuild left the table without the key FacetDB keys its records by: listings has no primary key;/,
    );
  });

  it("fails a question named after the application's own column as the application's, never as a rebuild", async () => {
    const file = withFile((db) =>
      db.exec("create table listings (id integer primary key, title text, verified integer)"),
    );
    const engine = createSqliteEngine();
    const plan = await engine.planInstall(target(), file.path, deps);
    if (!plan.ok) {
      throw new Error(plan.refusal.message);
    }
    await engine.run(target(), plan.plan, file.path, deps);
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
    expect((await marksOf(file, grown)).marks).toEqual({
      name: "marks",
      status: "fail",
      detail:
        "listings already has a column named verified that is the application's: FacetDB marks every column it adds (/* facetdb */ in the table's definition), and this one has no mark, so FacetDB neither writes nor drops it. Rename the question or the column.",
      fix: "rename the question in the config, or the application's column, then run facetdb migrate",
    });
  });

  it("passes the columns a table has when the question set needs more: the install check names those", async () => {
    const file = await installed();
    const grown = target({
      questionSet: {
        ...listings,
        questions: [
          ...listings.questions,
          { type: "noul", name: "is_spam", instructions: "Is this spam?", stakes: "low" },
        ],
      },
    });
    const { marks } = await marksOf(file, grown);
    expect(marks).toEqual({
      name: "marks",
      status: "ok",
      detail: "every column FacetDB writes that listings has carries FacetDB's mark",
    });
  });

  it("skips a table FacetDB is not installed on, another project's, and a missing one", async () => {
    const bare = withFile((db) =>
      db.exec("create table listings (id integer primary key, title text, is_scam integer)"),
    );
    expect((await marksOf(bare)).marks).toEqual({
      name: "marks",
      status: "skip",
      detail: "FacetDB is not installed on the table",
    });
    const theirs = await installed(target({ project: { id: "proj_other", name: "Other" } }));
    expect((await marksOf(theirs)).marks.detail).toBe("the table is another project's");
    const empty = withFile(() => undefined);
    expect((await marksOf(empty)).marks.detail).toBe("there is no table to check the marks of");
  });
});
