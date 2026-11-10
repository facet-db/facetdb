import type { QuestionSet } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/postgres.ts";
import { migrate } from "./migrate.ts";
import { ENQUEUE_ROLE, WORKER_ROLE } from "./sql.ts";

/**
 * The install against a real Postgres, for what PGlite cannot prove: the worker login exists with
 * the least permission that works. The role is cluster-wide, so the test drops it at the end and a
 * stale one from an aborted run at the start.
 */

const listings: QuestionSet = {
  questions: [
    {
      type: "noul",
      name: "is_scam",
      instructions: "Is this listing likely a scam?",
      stakes: "high",
    },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const PASSWORD = "a-long-random-password-for-tests";

let scratch: ScratchDatabase;
let admin: SqlClient;
let worker: SqlClient;

async function dropRole(): Promise<void> {
  await scratch.admin(`drop role if exists ${WORKER_ROLE}`).catch(() => undefined);
  await scratch.admin(`drop role if exists ${ENQUEUE_ROLE}`).catch(() => undefined);
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await dropRole();
  admin = connectPostgres(scratch.url);
  await admin.query(
    `create table public.listings (id serial primary key, title text, description text, secret text)`,
  );
  await admin.query(
    `insert into public.listings (title, description, secret) values ('a', 'b', 'c')`,
  );
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      workerPassword: PASSWORD,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  worker = connectPostgres(scratch.as(WORKER_ROLE, PASSWORD));
});

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await scratch?.drop();
  await dropRole();
});

async function denied(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("the worker login on a real Postgres", () => {
  it("reads the key, the state columns and FacetDB's own columns", async () => {
    const rows = await worker.query(
      `select id, title, description, facetdb_status, facetdb_reviewed, is_scam from public.listings`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["facetdb_status"]).toBe("pending");
  });

  it("cannot read a column outside the state", async () => {
    expect(await denied(() => worker.query(`select secret from public.listings`))).toContain(
      "permission denied",
    );
  });

  it("updates its own columns only", async () => {
    await worker.query(
      `update public.listings set is_scam = true, is_scam_probability = 0.97, facetdb_status = 'done', facetdb_updated_at = now() where id = 1 and facetdb_reviewed = false`,
    );
    const rows = await admin.query(
      `select is_scam, facetdb_status from public.listings where id = 1`,
    );
    expect(rows[0]).toMatchObject({ is_scam: true, facetdb_status: "done" });
    expect(
      await denied(() => worker.query(`update public.listings set title = 'x' where id = 1`)),
    ).toContain("permission denied");
    expect(
      await denied(() => worker.query(`update public.listings set secret = 'x' where id = 1`)),
    ).toContain("permission denied");
  });

  it("works the queue and nothing else in the facetdb schema", async () => {
    await admin.query(`update public.listings set title = 'changed' where id = 1`);
    const queued = await worker.query(`select record_key from facetdb.jobs`);
    expect(queued.map((row) => row["record_key"])).toEqual(["15:public.listings:1"]);
    await worker.query(
      `update facetdb.jobs set claimed_at = now(), claimed_by = 'w1' where record_key = '15:public.listings:1'`,
    );
    await worker.query(`delete from facetdb.jobs where claimed_by = 'w1'`);
    expect(await worker.query(`select record_key from facetdb.jobs`)).toEqual([]);
    expect(await denied(() => worker.query(`select * from facetdb.table_owners`))).toContain(
      "permission denied",
    );
    expect(await denied(() => worker.query(`drop table facetdb.jobs`))).toContain("must be owner");
  });

  it("needs no superuser and the role is not one", async () => {
    const rows = await admin.query(
      `select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = $1`,
      [WORKER_ROLE],
    );
    expect(rows[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });

  it("runs the trigger as the enqueue role, which cannot log in", async () => {
    const owners = await admin.query(
      `select proname, proowner::regrole::text as owner from pg_proc where pronamespace = 'facetdb'::regnamespace order by proname`,
    );
    expect(owners).toEqual([
      { proname: "enqueue", owner: ENQUEUE_ROLE },
      { proname: "enqueue_keep", owner: ENQUEUE_ROLE },
    ]);
    const login = connectPostgres(scratch.as(ENQUEUE_ROLE, "anything"));
    try {
      await expect(login.query("select 1")).rejects.toThrow(
        /not permitted to log in|authentication failed/,
      );
    } finally {
      await login.close();
    }
  });

  it("a password given on a later run is the one that logs in", async () => {
    const result = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table: "listings" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
        workerPassword: "a-second-long-random-password",
      },
    });
    expect(result).toMatchObject({ ok: true, workerPasswordApplied: true });
    const stale = connectPostgres(scratch.as(WORKER_ROLE, PASSWORD));
    const fresh = connectPostgres(scratch.as(WORKER_ROLE, "a-second-long-random-password"));
    try {
      await expect(stale.query("select 1")).rejects.toThrow();
      expect(await fresh.query("select 1 as one")).toEqual([{ one: 1 }]);
    } finally {
      await stale.close();
      await fresh.close();
    }
  });
});
