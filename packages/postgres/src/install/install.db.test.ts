import type { QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgres, type SqlClient, type SqlQuery } from "../sql/index.ts";
import { createStore } from "../store/index.ts";
import { createScratchDatabase, type ScratchDatabase, TEST_SECRET } from "../testing/index.ts";
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
/** Every connection opened so far, closed in afterAll even when beforeAll stopped halfway. */
const open: SqlClient[] = [];

async function dropRole(): Promise<void> {
  await scratch.admin(`drop role if exists ${WORKER_ROLE}`).catch(() => undefined);
  await scratch.admin(`drop role if exists ${ENQUEUE_ROLE}`).catch(() => undefined);
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await dropRole();
  admin = connectPostgres(scratch.url);
  open.push(admin);
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
  open.push(worker);
});

afterAll(async () => {
  // Newest first, so the worker's connection is gone before the admin's and the scratch database
  // can be dropped; a beforeAll that failed before `worker` existed still cleans up what it opened.
  for (const connection of open.splice(0).reverse()) {
    await connection.close();
  }
  await scratch.drop();
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
    expect(queued.map((row) => row["record_key"])).toEqual(["t:15:public.listings:1"]);
    await worker.query(
      `update facetdb.jobs set claimed_at = now(), claimed_by = 'w1' where record_key = 't:15:public.listings:1'`,
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

  it("opens the store, records a heartbeat, appends a decision and claims a job: no create, no ownership", async () => {
    // The worker's first start on a database `migrate` installed. The login holds no CREATE on the
    // database or the schema and owns nothing, and the store issues no DDL.
    const rights = await admin.query(
      `select has_database_privilege($1, current_database(), 'create') as database,
              has_schema_privilege($1, 'facetdb', 'create') as schema,
              (select count(*)::int from pg_class c
                where c.relnamespace = 'facetdb'::regnamespace and c.relowner = $1::regrole) as owned`,
      [WORKER_ROLE],
    );
    expect(rights[0]).toEqual({ database: false, schema: false, owned: 0 });

    const base = connectPostgres(scratch.as(WORKER_ROLE, PASSWORD));
    const statements: string[] = [];
    const record =
      (query: SqlQuery): SqlQuery =>
      (text, params) => {
        statements.push(text);
        return query(text, params);
      };
    const recording: SqlClient = {
      query: record(base.query),
      transaction: (work) => base.transaction((query) => work(record(query))),
      pipeline: (text, paramSets) => base.pipeline(text, paramSets),
      close: () => base.close(),
    };
    const store = await createStore({
      url: scratch.as(WORKER_ROLE, PASSWORD),
      connect: () => recording,
      secret: TEST_SECRET,
      clock: new FakeClock(1_700_000_000_000),
      allowInsecure: true,
    });
    try {
      await store.ensureProject({ id: "proj_listings", name: "Listings" });
      await store.alerts.saveHeartbeat("proj_listings", 1_700_000_000_000);
      expect(await store.alerts.lastHeartbeat("proj_listings")).toBe(1_700_000_000_000);
      await store.log("src_listings").appendAnswer({
        kind: "answer",
        key: "1",
        version: 1,
        model: "jev-1.14.0",
        stateHash: "a".repeat(64),
        answers: { is_scam: { type: "noul", probability: 0.25 } },
        usage: { inputTokens: 10, outputTokens: 2 },
        at: new Date("2026-11-01T20:00:00Z"),
      });
      const queue = store.connector({
        sourceId: "src_listings",
        fields: ["title"],
        workerId: "w1",
      });
      await queue.enqueue(["k1"]);
      expect(await queue.claim(1)).toEqual(["k1"]);
      // The webhook outbox (@facetdb/server) is a store table too; the worker queues and claims
      // in it with the same login (a run on Supabase failed here: the worker had created it).
      const reserved = await recording.query(
        "select nextval(pg_get_serial_sequence('facetdb.webhook_outbox', 'id'))::text as id",
      );
      await recording.query(
        `insert into facetdb.webhook_outbox (id, project_id, endpoint, payload, created_at, next_attempt_at)
         values ($1::bigint, 'proj_listings', 'https://hooks.example.com/f', '{}', 1, 1)`,
        [reserved[0]?.["id"]],
      );
      const claimedRows = await recording.query(
        `update facetdb.webhook_outbox set attempts = attempts + 1, claimed_by = 'w1'
          where delivered_at is null returning id::text as id`,
      );
      expect(claimedRows).toEqual([{ id: String(reserved[0]?.["id"]) }]);
    } finally {
      await store.close();
    }
    expect(statements.length).toBeGreaterThan(0);
    expect(
      statements.filter((text) => /^\s*(create|alter|drop|grant|revoke)\b/i.test(text)),
    ).toEqual([]);
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
