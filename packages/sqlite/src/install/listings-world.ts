import type { DatabaseSync } from "node:sqlite";
import type { EnginePlan, EngineTarget, PlanResult, QuestionSet, RunResult } from "@facetdb/core";
import type { TemporaryDatabase } from "../testing/index.ts";
import { type SqliteQuery, sqliteQuery } from "./catalog.ts";
import { planInstall } from "./install.ts";
import { run } from "./run.ts";

/**
 * The world the install, uninstall and prune tests share: the listings example as a SQLite source,
 * each test on a temporary file of its own.
 */

export const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The listings set with a choice question that stores its probabilities, for prune's tests. */
export const withCategory: QuestionSet = {
  ...listings,
  questions: [
    ...listings.questions,
    {
      type: "choice",
      name: "category",
      instructions: "Which category is it?",
      options: [
        { name: "car", description: "A car" },
        { name: "flat", description: "A flat" },
      ],
      stakes: "low",
      storeProbabilities: true,
    },
  ],
};

export const project = { id: "proj_listings", name: "Listings" };

export function target(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project,
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    ...changes,
  };
}

/** The application's table: the listings, with a price no question reads. */
export const LISTINGS =
  "create table listings (id integer primary key, title text, description text, price real)";

/** Runs the application's own SQL on the file, through a handle closed after it. */
export function execute(file: TemporaryDatabase, sql: string): void {
  const db = file.open();
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Reads the file through a handle of its own, as the engine plans: closed once the plan is made. */
export async function reading<T>(
  file: TemporaryDatabase,
  work: (query: SqliteQuery) => Promise<T>,
): Promise<T> {
  const db = file.open();
  try {
    return await work(sqliteQuery(db));
  } finally {
    db.close();
  }
}

export function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused (${result.refusal.code}): ${result.refusal.message}`);
  }
  return result.plan;
}

/** Runs a plan that must finish, as the CLI does after printing it. */
export function ran(source: EngineTarget, plan: EnginePlan, file: TemporaryDatabase): RunResult {
  const result = run(source, plan, file.path);
  if (result.stopped !== undefined) {
    throw new Error(`the run stopped: ${JSON.stringify(result.stopped)}`);
  }
  return result;
}

/** Installs a source on the file as `facetdb migrate` does: the plan, then its run. */
export async function install(
  file: TemporaryDatabase,
  source: EngineTarget = target(),
): Promise<EnginePlan> {
  const plan = planned(await reading(file, (query) => planInstall(source, query)));
  ran(source, plan, file);
  return plan;
}

/** All rows of a query on a handle, as plain objects. */
export function rows(db: DatabaseSync, sql: string): readonly Record<string, unknown>[] {
  return db.prepare(sql).all();
}

/** The queue as the trigger left it, without the time it was queued. */
export function jobs(db: DatabaseSync): readonly Record<string, unknown>[] {
  return rows(
    db,
    "select table_name, record_key, claimed_by, claimed_at from facetdb_jobs order by table_name, record_key",
  );
}

/** One record's FacetDB status. */
export function status(db: DatabaseSync, table = "listings", id = 1): unknown {
  return db.prepare(`select facetdb_status from ${table} where rowid = ?`).get(id)?.[
    "facetdb_status"
  ];
}

/** Everything a file holds that an install could change: its schema, its rows, its journal mode. */
export function snapshot(file: TemporaryDatabase): unknown {
  const db = file.open();
  try {
    const schema = rows(
      db,
      "select type, name, tbl_name, sql from sqlite_master order by type, name",
    );
    const tables = rows(
      db,
      "select name from sqlite_master where type = 'table' order by name",
    ).map((row) => String(row["name"]));
    // Sorted here, not by rowid: a WITHOUT ROWID table (FTS5's shadow tables among them) has none.
    const sorted = (name: string) =>
      rows(db, `select * from "${name}"`)
        .map((row) => JSON.stringify(row))
        .sort();
    return {
      schema,
      data: Object.fromEntries(tables.map((name) => [name, sorted(name)])),
      journal: db.prepare("pragma journal_mode").get(),
    };
  } finally {
    db.close();
  }
}

/** Every object FacetDB put in the file, by its prefix. */
export function facetdbObjects(file: TemporaryDatabase): readonly string[] {
  const db = file.open();
  try {
    return rows(
      db,
      "select name from sqlite_master where substr(name, 1, 8) = 'facetdb_' order by name",
    ).map((row) => String(row["name"]));
  } finally {
    db.close();
  }
}

/** The table's columns, in table order. */
export function columns(file: TemporaryDatabase, table = "listings"): readonly string[] {
  const db = file.open();
  try {
    return rows(db, `select name from pragma_table_xinfo('${table}') order by cid`).map((row) =>
      String(row["name"]),
    );
  } finally {
    db.close();
  }
}
