import type { PGlite } from "@electric-sql/pglite";
import type { EnginePlan, EngineTarget, QuestionSet } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { freshPglite, resetPglite } from "../testing/index.ts";
import { createPostgresEngine } from "./index.ts";
import { withLocks } from "./plans.ts";

/**
 * A lock list that cannot be made never stops a plan: whatever the reader fails on is the plan's
 * `unlisted` reason, the statements unchanged. And the conditions it asks the database are read
 * under the literal rules the install script pins, so a table whose name ends in a backslash lists
 * as the script runs it on a login whose `standard_conforming_strings` is off.
 */

const SET: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "Scam?", stakes: "low" }],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** A table whose name ends in a backslash: inside a literal, it escapes the quote unless pinned. */
const BACKSLASHED = "listings\\";

const URL_ = "postgres://admin:pw@localhost:5432/app";

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.query("reset standard_conforming_strings");
  await resetPglite(db);
});

function target(table: string): EngineTarget {
  return {
    project: { id: "proj_locks", name: "Locks" },
    source: "listings",
    table,
    storage: "inline",
    onChange: "reset",
    questionSet: SET,
  };
}

const engine = () => createPostgresEngine({ connect: () => pgliteClient(db), pgHost: undefined });
const deps = { clock: { now: () => 0, sleep: () => Promise.resolve() }, allowInsecure: false };

describe("the lock list of a plan", () => {
  it("lists a table whose name ends in a backslash on a login with standard_conforming_strings off", async () => {
    await db.query(`create table public."${BACKSLASHED}" (id text primary key, title text)`);
    // The server's or the login's default, as the reviewer found it: the planning connection's.
    await db.query("set standard_conforming_strings = off");
    const planned = await engine().planInstall(target(BACKSLASHED), URL_, {
      ...deps,
      storeShared: false,
      workerPassword: "a-long-random-password",
    });
    if (!planned.ok) {
      throw new Error(planned.refusal.message);
    }
    expect(planned.plan.locks).toEqual({
      listed: [
        {
          step: "install",
          table: `public.${BACKSLASHED}`,
          mode: "no reads or writes",
          rows: "none",
        },
        { step: "install", table: "facetdb.projects", mode: "no reads or writes", rows: "empty" },
        { step: "install", table: "facetdb.jobs", mode: "no reads or writes", rows: "empty" },
        {
          step: "install",
          table: "facetdb.table_owners",
          mode: "no reads or writes",
          rows: "empty",
        },
      ],
    });
  });

  it("says why when a statement cannot be read, and leaves the plan's statements as they were", async () => {
    const plan: EnginePlan = {
      statements: [
        { database: "source", purpose: "settings", text: "set local lock_timeout = '10s'" },
        { database: "source", purpose: "columns", text: 'cluster "public"."listings"' },
      ],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
    };
    const listed = await withLocks(plan, pgliteClient(db), "install", false);
    expect(listed.statements).toEqual(plan.statements);
    expect(listed.locks).toEqual({
      unlisted:
        'the lock list cannot read this statement (a statement of an unknown kind (cluster)): cluster "public"."listings"',
    });
  });

  it("says why when the database cannot be read", async () => {
    const plan: EnginePlan = {
      statements: [
        {
          database: "source",
          purpose: "capture",
          text: 'drop trigger if exists "t" on "public"."x"',
        },
      ],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
    };
    const closed: Pick<SqlClient, "transaction"> = {
      transaction: () => Promise.reject(new Error("the connection was closed")),
    };
    expect((await withLocks(plan, closed, "prune", false)).locks).toEqual({
      unlisted: "the connection was closed",
    });
  });
});
