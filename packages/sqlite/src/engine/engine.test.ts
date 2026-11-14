import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EngineDeps,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { planInstall, sqliteQuery } from "../install/index.ts";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import { atLeast, createSqliteEngine, DOCTOR_CHECKS, ENGINE_NAME, sqlitePath } from "./index.ts";

/**
 * The SQLite engine: connection strings to paths, the install plans through a read-only handle and
 * its run, a missing file refused and never created, the log-only purge, doctor, and one handle per
 * file shared by the connectors of its tables.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const PROJECT = { id: "proj_listings", name: "Listings" };

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

function target(table = "listings"): EngineTarget {
  return {
    project: PROJECT,
    source: table,
    table,
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    urlVariable: "LISTINGS_URL",
  };
}

const files: TemporaryDatabase[] = [];
afterEach(() => {
  for (const file of files.splice(0)) {
    file.remove();
  }
});

function fileWith(...tables: readonly string[]): TemporaryDatabase {
  const file = temporaryDatabase();
  files.push(file);
  const db = file.open();
  for (const table of tables) {
    db.exec(`create table ${table} (id integer primary key, title text)`);
  }
  db.close();
  return file;
}

const clock = new FakeClock(START);
const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };

function planOf(result: PlanResult) {
  if (!result.ok) {
    throw new Error(result.refusal.message);
  }
  return result.plan;
}

async function installed(file: TemporaryDatabase, ...tables: readonly string[]): Promise<void> {
  const engine = createSqliteEngine();
  for (const table of tables) {
    const plan = planOf(await engine.planInstall(target(table), file.path, deps));
    const result = await engine.run(target(table), plan, file.path, deps);
    expect(result.stopped).toBeUndefined();
  }
}

describe("the connection string names the file", () => {
  it.each([
    ["sqlite:///var/lib/app.db", "/var/lib/app.db"],
    ["sqlite://./data/app.db", "./data/app.db"],
    ["sqlite:app.db", "app.db"],
    ["file:///var/lib/my%20app.db", "/var/lib/my app.db"],
    ["file:./app.db?mode=ro", "./app.db"],
    ["./data/app.db", "./data/app.db"],
    ["/var/lib/app.sqlite3", "/var/lib/app.sqlite3"],
  ])("%s is %s", (url, path) => {
    expect(sqlitePath(url)).toBe(path);
  });

  it("refuses a string that names no file, and nothing else: no password travels", () => {
    const engine = createSqliteEngine();
    expect(engine.checkUrl(target(), "sqlite:", { allowInsecure: false })).toEqual({
      code: "sqlite-path",
      message: "LISTINGS_URL names no SQLite file",
      fix: "set LISTINGS_URL to the file's path: sqlite:///absolute/path/app.db, file:./app.db, or a path ending in .db, .sqlite or .sqlite3",
    });
    expect(engine.checkUrl(target(), "sqlite:///var/lib/app.db", { allowInsecure: false })).toBe(
      undefined,
    );
  });

  it("is the engine of sqlite: and file:, with one worker and inline columns", () => {
    const engine = createSqliteEngine();
    expect(engine.name).toBe(ENGINE_NAME);
    expect(engine.schemes).toEqual(["sqlite", "file"]);
    expect(engine.capabilities).toMatchObject({ multipleWorkers: false, sideTable: false });
    expect(engine.checks.map((check) => check.name)).toEqual(DOCTOR_CHECKS.map((c) => c.name));
  });
});

describe("plans and runs", () => {
  it("plans the install through a read-only handle, runs it, and plans nothing new after", async () => {
    const file = fileWith("listings");
    const engine = createSqliteEngine();
    const url = `file://${file.path}`;
    const plan = planOf(await engine.planInstall(target(), url, deps));
    const db = file.open({ readOnly: true });
    const direct = await planInstall(target(), sqliteQuery(db));
    db.close();
    expect(plan).toEqual(planOf(direct));
    expect(engine.render(plan)).toContain("pragma journal_mode = wal;\n\nbegin immediate;");

    expect((await engine.run(target(), plan, url, deps)).stopped).toBeUndefined();
    const again = planOf(await engine.planInstall(target(), url, deps));
    expect(again.statements.filter((one) => one.purpose === "columns")).toEqual([]);
  });

  it("refuses a missing file and never creates one: planning, running or opening", async () => {
    const file = fileWith();
    const missing = join(file.path, "..", "missing.db");
    const engine = createSqliteEngine();

    const planned = await engine.planInstall(target(), missing, deps);
    expect(planned).toMatchObject({ ok: false, refusal: { code: "no-file" } });
    const opened = await engine.open(target(), missing, { ...deps, workerId: "w1" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(opened).toBeInstanceOf(EngineRefusal);
    expect((opened as EngineRefusal).refusal.code).toBe("no-file");
    const checks = await engine.doctor(target(), missing, deps);
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["file", "fail"],
      ["wal", "skip"],
      ["sqlite", "skip"],
      ["install", "skip"],
      ["lock", "skip"],
    ]);
    expect(existsSync(missing)).toBe(false);
  });

  it("uninstall --purge of a table no longer installed plans the store's part alone, the source typed back", async () => {
    const file = fileWith("listings");
    await installed(file, "listings");
    const engine = createSqliteEngine();
    const uninstall = planOf(
      await engine.planUninstall(target(), file.path, {
        ...deps,
        purge: false,
        alsoUninstalling: [],
      }),
    );
    expect(uninstall.confirm).toEqual({ kind: "project", name: "Listings" });
    expect((await engine.run(target(), uninstall, file.path, deps)).stopped).toBeUndefined();

    const purge = planOf(
      await engine.planUninstall(target(), file.path, {
        ...deps,
        purge: true,
        alsoUninstalling: [],
      }),
    );
    expect(purge).toEqual({
      statements: [],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [
        "FacetDB is not installed on listings (facetdb_table_owners has no row for it); run migrate first, or check the source's table: nothing is removed from the SQLite file, and only the decision log of source listings in the FacetDB store is deleted.",
      ],
      confirm: { kind: "source", name: "listings" },
    });
    // Without --purge there is nothing to do, and it says so as the install does.
    expect(
      await engine.planUninstall(target(), file.path, {
        ...deps,
        purge: false,
        alsoUninstalling: [],
      }),
    ).toMatchObject({ ok: false, refusal: { code: "uninstall-refused" } });
  });
});

describe("the runtime connector through the engine", () => {
  it("opens the tables of one file on one shared handle, so their transactions never wait on each other", async () => {
    const file = fileWith("listings", "offers");
    await installed(file, "listings", "offers");
    const app = file.open();
    for (let id = 1; id <= 20; id += 1) {
      app.prepare("insert into listings (id, title) values (?, ?)").run(id, `listing ${id}`);
      app.prepare("insert into offers (id, title) values (?, ?)").run(id, `offer ${id}`);
    }
    app.close();
    const engine = createSqliteEngine();
    const options = { ...deps, workerId: "w1" };
    const a = await engine.open(target("listings"), file.path, options);
    const b = await engine.open(target("offers"), file.path, options);

    // Both tables' passes at once, as the worker runs every source's loop side by side.
    const pass = async (connector: typeof a) => {
      const keys = await connector.claim(20);
      const { rows } = await connector.read(keys);
      await Promise.all(
        rows.map((row) =>
          connector.write(
            row.key,
            {
              decisions: {
                is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.99 },
              },
              status: "done",
            },
            row.hash,
          ),
        ),
      );
      await connector.ack(keys);
      return keys.length;
    };
    expect(await Promise.all([pass(a), pass(b)])).toEqual([20, 20]);
    await a.close();
    // The handle stays open for the other table's connector until it closes too.
    expect(await b.claim(10)).toEqual([]);
    await b.close();

    const check = file.open();
    expect(
      check.prepare("select count(*) as n from listings where facetdb_status = 'done'").get(),
    ).toEqual({ n: 20 });
    expect(check.prepare("select count(*) as n from facetdb_jobs").get()).toEqual({ n: 0 });
    check.close();
  });
});

describe("doctor", () => {
  it("checks the file, WAL, the SQLite version, the install and the worker lock", async () => {
    const file = fileWith("listings");
    const engine = createSqliteEngine();
    const before = await engine.doctor(target(), file.path, deps);
    expect(before.map((check) => [check.name, check.status])).toEqual([
      ["file", "ok"],
      ["wal", "fail"],
      ["sqlite", "ok"],
      ["install", "fail"],
      ["lock", "skip"],
    ]);
    expect(before[3]?.detail).toBe(
      "FacetDB is not installed on listings: facetdb_jobs, the marker row of listings in facetdb_table_owners, facetdb_listings_ins, facetdb_listings_upd missing",
    );

    await installed(file, "listings");
    const after = await engine.doctor(target(), file.path, deps);
    expect(after.every((check) => check.status === "ok")).toBe(true);
    expect(after.at(-1)?.detail).toBe("no worker holds the lock; the next facetdb worker takes it");

    const connector = await engine.open(target(), file.path, { ...deps, workerId: "w1" });
    await connector.claim(1);
    expect((await engine.doctor(target(), file.path, deps)).at(-1)?.detail).toBe(
      `worker w1 holds the lock (on listings), renewed at ${new Date(START).toISOString()}`,
    );
    const later = { ...deps, clock: new FakeClock(START + 3 * 60_000) };
    expect((await engine.doctor(target(), file.path, later)).at(-1)?.detail).toContain(
      "over 2 minutes ago: it stopped, and the next worker takes the lock over",
    );
    await connector.close();
  });

  it("compares SQLite versions part by part", () => {
    expect(atLeast("3.35.0", [3, 35, 0])).toBe(true);
    expect(atLeast("3.50.4", [3, 35, 0])).toBe(true);
    expect(atLeast("3.34.9", [3, 35, 0])).toBe(false);
    expect(atLeast("4.0.0", [3, 35, 0])).toBe(true);
  });
});
