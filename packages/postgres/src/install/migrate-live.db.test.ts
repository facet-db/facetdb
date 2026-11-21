import type {
  Clock,
  EngineDeps,
  EngineTarget,
  OpenConnector,
  QuestionSet,
  RecordDecision,
} from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresEngine } from "../engine/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";

/**
 * The install of one added question beside a live application and a working connector: what the
 * studio's Install button runs, and what `facetdb migrate` runs beside a live application, is the
 * engine's whole idempotent install again for the new set, as one transaction with a ten-second
 * lock limit on the customer's table. Here, on a real Postgres, a source installed with one
 * question has the application inserting rows and a connector of the old set claiming, reading,
 * writing and acking them while the plan for the set with one more question runs. The old set's
 * writes succeed before, during and after; the new columns exist and the worker login may write
 * them; a connector opened with the new set writes them; and the plan run a second time changes
 * nothing.
 */

const SCAM = {
  type: "noul",
  name: "is_scam",
  instructions: "Is this listing a scam?",
  stakes: "high",
} as const;
const VEHICLE = {
  type: "noul",
  name: "is_vehicle",
  instructions: "Is this listing a vehicle?",
  stakes: "low",
} as const;

const OLD: QuestionSet = {
  questions: [SCAM],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};
const NEW: QuestionSet = { ...OLD, questions: [SCAM, VEHICLE] };

const PASSWORD = "a-long-random-password-for-migrate-live";
/** Rounds the old connector keeps working once the plan has committed. */
const ROUNDS_AFTER = 5;
/** Rounds before the plan starts, so the run meets a connector already at work. */
const ROUNDS_BEFORE = 3;

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let scratch: ScratchDatabase;
/** The scratch database to drop: none when beforeAll stopped before it was made. */
const scratches: ScratchDatabase[] = [];
let admin: SqlClient;
let engine: ReturnType<typeof createPostgresEngine>;
/** Every connection and connector opened, closed in afterAll even when beforeAll stopped halfway. */
const clients: SqlClient[] = [];
const connectors: OpenConnector[] = [];

const deps: EngineDeps = { clock: realClock, allowInsecure: false, storeShared: true };

function target(questionSet: QuestionSet): EngineTarget {
  return {
    project: { id: "proj_live", name: "Live" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet,
  };
}

/** Plans the install of `questionSet` with the admin string and runs it as planned. */
async function install(questionSet: QuestionSet) {
  const planned = await engine.planInstall(target(questionSet), scratch.url, {
    ...deps,
    workerPassword: PASSWORD,
  });
  if (!planned.ok) {
    throw new Error(planned.refusal.message);
  }
  const result = await engine.run(target(questionSet), planned.plan, scratch.url, {
    ...deps,
    workerPassword: PASSWORD,
  });
  return { plan: planned.plan, script: engine.render(planned.plan), result };
}

async function opened(questionSet: QuestionSet, workerId: string): Promise<OpenConnector> {
  const connector = await engine.open(
    target(questionSet),
    scratch.as(scratch.workerRole, PASSWORD),
    { ...deps, workerId },
  );
  connectors.push(connector);
  return connector;
}

/** A decided "no" for each question named. */
function decided(names: readonly string[]): RecordDecision {
  return {
    decisions: Object.fromEntries(
      names.map((name) => [
        name,
        { kind: "decided" as const, value: false, probabilityOrConfidence: 0.1 },
      ]),
    ),
    status: "done",
  };
}

/** The application inserts a row; `connector` claims it, reads it, writes `names` and acks. */
async function oneRound(connector: OpenConnector, key: string, names: readonly string[]) {
  await admin.query(`insert into public.listings (id, title) values ($1, $2)`, [key, key]);
  const claimed = await connector.claim(5);
  expect(claimed).toEqual([key]);
  const { rows } = await connector.read([key]);
  const outcome = await connector.write(key, decided(names), rows[0]?.hash ?? "");
  await connector.ack([key]);
  return outcome.written;
}

/** What the install leaves on the table, for comparing two runs: columns, rights, triggers. */
async function installed(): Promise<unknown> {
  return {
    columns: await admin.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'listings'
        order by column_name`,
    ),
    rights: await admin.query(
      `select grantee, column_name, privilege_type
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'listings' and grantee = $1
        order by column_name, privilege_type`,
      [scratch.workerRole],
    ),
    triggers: await admin.query(
      `select tgname, pg_get_triggerdef(t.oid) as definition
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.listings'::regclass and not t.tgisinternal
        order by tgname`,
    ),
    comments: await admin.query(
      `select a.attname, col_description(a.attrelid, a.attnum) as comment
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.listings'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attname`,
    ),
    rows: await admin.query(
      `select id, is_scam, is_vehicle, facetdb_status from public.listings order by id`,
    ),
    queued: await admin.query(`select count(*)::int as n from facetdb.jobs`),
  };
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  scratches.push(scratch);
  admin = connectPostgres(scratch.url);
  clients.push(admin);
  engine = createPostgresEngine({
    connect: connectPostgres,
    pgHost: undefined,
    roleSuffix: scratch.roleSuffix,
  });
  await admin.query(`create table public.listings (id text primary key, title text)`);
  const first = await install(OLD);
  if (first.result.stopped !== undefined) {
    throw new Error(`the first install stopped: ${JSON.stringify(first.result.stopped)}`);
  }
});

afterAll(async () => {
  for (const connector of connectors.splice(0)) {
    await connector.close();
  }
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const made of scratches.splice(0)) {
    await made.drop();
  }
});

describe("installing one added question beside a working connector", () => {
  it("keeps the old set's writes succeeding before, during and after the plan's run", async () => {
    const old = await opened(OLD, "old-set");
    const written: boolean[] = [];
    const state = { migrated: false, after: 0 };
    let round = 0;
    const work = (async () => {
      while (!state.migrated || state.after < ROUNDS_AFTER) {
        // A bound on a run that never finishes: the plan's lock limit is ten seconds.
        expect(round).toBeLessThan(2_000);
        const ran = state.migrated;
        written.push(await oneRound(old, `old-${String(round).padStart(4, "0")}`, ["is_scam"]));
        round += 1;
        if (ran) {
          state.after += 1;
        }
      }
    })();
    while (written.length < ROUNDS_BEFORE) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const added = await install(NEW);
    state.migrated = true;
    await work;

    expect(added.result.stopped).toBeUndefined();
    expect(added.plan.transactional).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(ROUNDS_BEFORE + ROUNDS_AFTER);
    expect(written.every((one) => one)).toBe(true);
    expect(
      await admin.query(
        `select count(*)::int as n from public.listings
          where id like 'old-%' and facetdb_status = 'done' and is_scam = false`,
      ),
    ).toEqual([{ n: written.length }]);
  });

  it("leaves the new columns in the table and the worker login's rights on them", async () => {
    expect(
      await admin.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'listings'
            and column_name in ('is_vehicle', 'is_vehicle_probability')
          order by column_name`,
      ),
    ).toEqual([
      { column_name: "is_vehicle", data_type: "boolean" },
      { column_name: "is_vehicle_probability", data_type: "real" },
    ]);
    const role = scratch.workerRole;
    for (const column of ["is_vehicle", "is_vehicle_probability"]) {
      expect(
        await admin.query(
          `select has_column_privilege($1, 'public.listings', $2, 'UPDATE') as update,
                  has_column_privilege($1, 'public.listings', $2, 'SELECT') as select`,
          [role, column],
        ),
      ).toEqual([{ update: true, select: true }]);
    }
    // Still not the application's own columns beyond the state.
    expect(
      await admin.query(
        `select has_column_privilege($1, 'public.listings', 'title', 'UPDATE') as u`,
        [role],
      ),
    ).toEqual([{ u: false }]);
  });

  it("lets a connector opened with the new set write the new columns", async () => {
    const fresh = await opened(NEW, "new-set");
    expect(await oneRound(fresh, "new-0001", ["is_scam", "is_vehicle"])).toBe(true);
    expect(
      await admin.query(
        `select is_scam, is_vehicle, is_vehicle_probability, facetdb_status
           from public.listings where id = 'new-0001'`,
      ),
    ).toEqual([
      {
        is_scam: false,
        is_vehicle: false,
        is_vehicle_probability: expect.closeTo(0.1, 5),
        facetdb_status: "done",
      },
    ]);
  });

  it("changes nothing when the plan for the new set runs a second time", async () => {
    const before = await installed();
    const again = await install(NEW);
    expect(again.result.stopped).toBeUndefined();
    expect(await installed()).toEqual(before);
  });
});
