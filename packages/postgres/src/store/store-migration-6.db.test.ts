import type { QuestionSet } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../install/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";

/**
 * Store migration 6's rights on a real Postgres, what PGlite's one superuser connection cannot
 * show: the least-privilege worker login keeps the review queue and the run log row by row, reads
 * the reviewer accounts and writes none, and runs no DDL. The install uses the scratch database's
 * own role names (`roleSuffix`), which `scratch.drop` removes.
 */

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const PASSWORD = "a-long-random-password-for-tests";

let scratch: ScratchDatabase;
let admin: SqlClient;
let worker: SqlClient;
/** Every connection opened so far, closed in afterAll even when beforeAll stopped halfway. */
const open: SqlClient[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
  open.push(admin);
  await admin.query(
    `create table public.listings (id serial primary key, title text, description text)`,
  );
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      roleSuffix: scratch.roleSuffix,
      workerPassword: PASSWORD,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  // The admin makes the account, as `facetdb users add` will: a scrypt hash, never a password.
  await admin.query(
    `insert into facetdb.users (name, password_hash) values ('ana', 'scrypt$placeholder-hash')`,
  );
  worker = connectPostgres(scratch.as(scratch.workerRole, PASSWORD));
  open.push(worker);
});

afterAll(async () => {
  // Every step is tried whatever the ones before it did, and the first error is thrown once all
  // have been: no role stays on the shared server only because a close threw first.
  const errors: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  };
  // Newest first, so the worker's connection is gone before the scratch database is dropped.
  for (const connection of open.splice(0).reverse()) {
    await attempt(() => connection.close());
  }
  await attempt(() => scratch.drop());
  if (errors.length > 0) {
    throw errors[0];
  }
});

async function denied(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("store migration 6 and the worker login on a real Postgres", () => {
  it("inserts, updates and deletes a review card", async () => {
    await worker.query(
      `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
       values ('proj_listings:listings', '1', 'h1', '["is_scam"]', '{"is_scam": 0.58}', now())`,
    );
    await worker.query(
      `update facetdb.reviews set locked_by = 'ana', locked_until = now() + interval '10 minutes'
        where source_id = 'proj_listings:listings' and record_key = '1'`,
    );
    expect(await worker.query(`select record_key, locked_by from facetdb.reviews`)).toEqual([
      { record_key: "1", locked_by: "ana" },
    ]);
    await worker.query(
      `delete from facetdb.reviews where source_id = 'proj_listings:listings' and record_key = '1'`,
    );
    expect(await worker.query(`select count(*)::int as n from facetdb.reviews`)).toEqual([
      { n: 0 },
    ]);
  });

  it("inserts, updates and deletes a run, its id from the sequence", async () => {
    const inserted = await worker.query(
      `insert into facetdb.runs (source_id, started_at, ended_at, claimed, answered, to_review, errors, discarded, tokens)
       values ('proj_listings:listings', now() - interval '1 second', now(), 3, 2, 1, 0, 0, 1200)
       returning id::text as id`,
    );
    const id = String(inserted[0]?.["id"]);
    await worker.query(`update facetdb.runs set errors = 1 where id = $1::bigint`, [id]);
    expect(await worker.query(`select errors, tokens::int as tokens from facetdb.runs`)).toEqual([
      { errors: 1, tokens: 1200 },
    ]);
    await worker.query(`delete from facetdb.runs where id = $1::bigint`, [id]);
    expect(await worker.query(`select count(*)::int as n from facetdb.runs`)).toEqual([{ n: 0 }]);
  });

  it("reads the reviewer accounts and cannot write one", async () => {
    expect(await worker.query(`select name, password_hash from facetdb.users`)).toEqual([
      { name: "ana", password_hash: "scrypt$placeholder-hash" },
    ]);
    for (const statement of [
      `insert into facetdb.users (name, password_hash) values ('mallory', 'x')`,
      `update facetdb.users set password_hash = 'x' where name = 'ana'`,
      `delete from facetdb.users where name = 'ana'`,
      `truncate facetdb.users`,
    ]) {
      expect(await denied(() => worker.query(statement))).toContain("permission denied");
    }
    expect(
      await admin.query(
        `select privilege_type from information_schema.table_privileges
          where table_schema = 'facetdb' and table_name = 'users' and grantee = $1`,
        [scratch.workerRole],
      ),
    ).toEqual([{ privilege_type: "SELECT" }]);
  });

  it("cannot create a table, nor change the new ones", async () => {
    for (const statement of [
      `create table facetdb.reviews_copy (id int)`,
      `alter table facetdb.reviews add column note text`,
      `alter table facetdb.runs drop column tokens`,
      `drop table facetdb.users`,
      `create index runs_by_source on facetdb.runs (source_id)`,
    ]) {
      const message = await denied(() => worker.query(statement));
      expect(message).toMatch(/permission denied|must be owner/);
    }
    expect(
      await admin.query(
        `select has_database_privilege($1, current_database(), 'create') as database,
                has_schema_privilege($1, 'facetdb', 'create') as schema`,
        [scratch.workerRole],
      ),
    ).toEqual([{ database: false, schema: false }]);
  });
});
