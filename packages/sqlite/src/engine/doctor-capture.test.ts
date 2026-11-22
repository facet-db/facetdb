import type {
  DatabaseEngine,
  DoctorCheck,
  EngineDeps,
  EngineTarget,
  QuestionSet,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSqliteClient } from "../connector/index.ts";
import { createLibsqlEngine, LIBSQL_DOCTOR_CHECKS } from "../libsql/index.ts";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import { createSqliteEngine, DOCTOR_CHECKS } from "./index.ts";

/**
 * The `capture` check beside `install`, on a SQLite file and through the libSQL engine over one: a
 * trigger dropped or the jobs table gone fails `capture`, which the worker raises Connector lost
 * access on, and passes `install`; a question added and not migrated yet fails `install` only,
 * which raises nothing. Each fact keeps the words it had, and the next migrate restores what
 * `capture` missed. SQLite has no way to disable a trigger (no `alter trigger … disable`), so only
 * a dropped one is told here.
 */

const START = Date.parse("2026-11-14T09:00:00.000Z");
const deps: EngineDeps = { clock: new FakeClock(START), allowInsecure: false, storeShared: false };
const TURSO = "libsql://listings-acme.turso.io";
const ENV = { LISTINGS_URL_AUTH_TOKEN: "a-test-token" };

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The same source with a question added in the file and not migrated yet. */
const withSpam: QuestionSet = {
  ...listings,
  questions: [
    ...listings.questions,
    { type: "noul", name: "is_spam", instructions: "Is this spam?", stakes: "low" },
  ],
};

function target(questionSet: QuestionSet = listings): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet,
    urlVariable: "LISTINGS_URL",
  };
}

const files: TemporaryDatabase[] = [];
afterEach(() => {
  for (const file of files.splice(0)) {
    file.remove();
  }
});

/** One engine over one file: SQLite's own, or libSQL's with its client on the same file. */
type World = {
  readonly engine: DatabaseEngine;
  readonly url: string;
  readonly file: TemporaryDatabase;
  /** The database's name in the words: the file's path, or the libSQL server's host. */
  readonly where: string;
};

function sqliteWorld(): World {
  const file = temporaryDatabase();
  files.push(file);
  return { engine: createSqliteEngine(), url: file.path, file, where: file.path };
}

function libsqlWorld(): World {
  const file = temporaryDatabase();
  files.push(file);
  const engine = createLibsqlEngine({ env: ENV, open: () => nodeSqliteClient(file.open()) });
  return { engine, url: TURSO, file, where: "the libSQL database at listings-acme.turso.io" };
}

function edit(world: World, sql: string): void {
  const db = world.file.open();
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** `facetdb migrate` for the target: the install, or what it lacks. */
async function migrate(world: World, questionSet: QuestionSet = listings): Promise<void> {
  const plan = await world.engine.planInstall(target(questionSet), world.url, deps);
  if (!plan.ok) {
    throw new Error(plan.refusal.message);
  }
  const ran = await world.engine.run(target(questionSet), plan.plan, world.url, deps);
  expect(ran.stopped).toBeUndefined();
}

async function installed(world: World): Promise<World> {
  edit(world, "create table listings (id integer primary key, title text)");
  await migrate(world);
  return world;
}

async function checksOf(world: World, questionSet: QuestionSet = listings) {
  const checks = await world.engine.doctor(target(questionSet), world.url, deps);
  const named = (name: string): DoctorCheck | undefined =>
    checks.find((check) => check.name === name);
  return { capture: named("capture"), install: named("install"), checks };
}

const CAPTURE_OK: DoctorCheck = {
  name: "capture",
  status: "ok",
  detail: "the jobs table and the two triggers of listings are there",
};
const INSTALL_OK: DoctorCheck = {
  name: "install",
  status: "ok",
  detail: "the marker of listings and every column the question set needs are there",
};

/** The first failing check: what the worker's verdict names the source's state by. */
const firstFailure = (checks: readonly DoctorCheck[]) =>
  checks.find((check) => check.status === "fail")?.name;

describe("doctor-capture: the SQLite and libSQL checks", () => {
  it("lists capture before install on both engines, saying what each reads", () => {
    for (const checks of [DOCTOR_CHECKS, LIBSQL_DOCTOR_CHECKS]) {
      const names = checks.map((check) => check.name);
      expect(names.indexOf("capture")).toBe(names.indexOf("install") - 1);
      expect(checks.find((check) => check.name === "capture")?.looksAt).toBe(
        "reads that changes are still queued: the table, the jobs table and the two triggers, present",
      );
      expect(checks.find((check) => check.name === "install")?.looksAt).toBe(
        "reads the project's marker row and that the table has every column the question set needs",
      );
    }
  });
});

for (const [engine, made] of [
  ["sqlite", sqliteWorld],
  ["libsql", libsqlWorld],
] as const) {
  describe(`doctor-capture on ${engine}: the install gone fails capture, an install behind the file fails install`, () => {
    it("passes both on a fresh install", async () => {
      const world = await installed(made());
      const { capture, install, checks } = await checksOf(world);
      expect(capture).toEqual(CAPTURE_OK);
      expect(install).toEqual(INSTALL_OK);
      expect(firstFailure(checks)).toBeUndefined();
    });

    it("a dropped trigger fails capture in its words and passes install; the next migrate restores it", async () => {
      const world = await installed(made());
      edit(world, "drop trigger facetdb_listings_upd");
      const dropped = await checksOf(world);
      expect(dropped.capture).toEqual({
        name: "capture",
        status: "fail",
        detail: "FacetDB is not installed on listings: facetdb_listings_upd missing",
        fix: "run facetdb migrate",
      });
      expect(dropped.install).toEqual(INSTALL_OK);
      expect(firstFailure(dropped.checks)).toBe("capture");
      // Nothing to hold a lock on while changes are not queued, as before the split.
      expect(dropped.checks.find((check) => check.name === "lock")?.status).toBe("skip");

      await migrate(world);
      const restored = await checksOf(world);
      expect(restored.capture).toEqual(CAPTURE_OK);
      expect(firstFailure(restored.checks)).toBeUndefined();
    });

    it("both triggers dropped fail capture, naming each", async () => {
      const world = await installed(made());
      edit(world, "drop trigger facetdb_listings_ins; drop trigger facetdb_listings_upd");
      const { capture, install } = await checksOf(world);
      expect(capture).toEqual({
        name: "capture",
        status: "fail",
        detail:
          "FacetDB is not installed on listings: facetdb_listings_ins, facetdb_listings_upd missing",
        fix: "run facetdb migrate",
      });
      expect(install).toEqual(INSTALL_OK);
    });

    it("a dropped jobs table fails capture and passes install; the next migrate makes it again", async () => {
      const world = await installed(made());
      edit(world, "drop table facetdb_jobs");
      const gone = await checksOf(world);
      expect(gone.capture).toEqual({
        name: "capture",
        status: "fail",
        detail: "FacetDB is not installed on listings: facetdb_jobs missing",
        fix: "run facetdb migrate",
      });
      expect(gone.install).toEqual(INSTALL_OK);

      await migrate(world);
      expect((await checksOf(world)).capture).toEqual(CAPTURE_OK);
    });

    it("a table that is gone fails capture, and the install is not looked at", async () => {
      const world = await installed(made());
      edit(world, "drop table listings");
      const { capture, install } = await checksOf(world);
      expect(capture).toEqual({
        name: "capture",
        status: "fail",
        detail: `listings is not a table of ${world.where}`,
        fix: "point the source at the table, and run facetdb migrate on it",
      });
      expect(install).toEqual({
        name: "install",
        status: "skip",
        detail: "there is no table to check the install of",
      });
    });

    it("an added question fails install only, and the migrate that installs it passes both", async () => {
      const world = await installed(made());
      const behind = await checksOf(world, withSpam);
      expect(behind.capture).toEqual(CAPTURE_OK);
      expect(behind.install).toEqual({
        name: "install",
        status: "fail",
        detail: "listings has no column is_spam, is_spam_probability, which the question set needs",
        fix: "run facetdb migrate: it adds the columns the table lacks, each marked as FacetDB's",
      });
      // The marks of the columns it has hold, and the lock is read as ever: only install fails.
      expect(behind.checks.filter((check) => check.status === "fail").map((c) => c.name)).toEqual([
        "install",
      ]);

      await migrate(world, withSpam);
      const forward = await checksOf(world, withSpam);
      expect(forward.capture).toEqual(CAPTURE_OK);
      expect(forward.install).toEqual(INSTALL_OK);
    });

    it("a dropped trigger on an install also behind the file fails capture first", async () => {
      const world = await installed(made());
      edit(world, "drop trigger facetdb_listings_ins");
      const { checks } = await checksOf(world, withSpam);
      expect(checks.filter((check) => check.status === "fail").map((c) => c.name)).toEqual([
        "capture",
        "install",
      ]);
    });
  });
}
