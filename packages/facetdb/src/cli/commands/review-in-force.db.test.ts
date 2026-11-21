import { FakeClock, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import { connectPostgres, migrate, type SqlClient } from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import { createStore, sourceIdOf, TEST_SECRET } from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb review` judges by what the worker runs, on a real Postgres store opened as the worker
 * login (store migration 8). A threshold-only change makes no new question-set version (the content
 * hash leaves thresholds out), so the version's row keeps the old thresholds; the worker's own row
 * of the set it runs is what tells. Both directions: after a restart with the new thresholds the
 * review passes with the new file and refuses the old one, and a file edited back to the version's
 * values is refused while the worker runs the new ones. The worker login's insert and update of
 * that row go through the grants the install gave it, which PGlite's superuser cannot show.
 */

const PASSWORD = "a-long-random-password-for-tests";
const PROJECT_DIR = "/work/acme-app";
const URL_OF_SOURCE = "mysql://facetdb_worker:worker-password@localhost:3306/app";
const LOG_ID = sourceIdOf("acme-app", "listings");

function configWith(thresholds: Record<string, { yesAbove: number }>): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: URL_OF_SOURCE,
        table: "listings",
        read: ["body"],
        questions: { scam: noul("Is this listing likely a scam?") },
        thresholds,
      },
    ],
  });
}

const asMade = configWith({});
const retuned = configWith({ scam: { yesAbove: 0.5 } });

let scratch: ScratchDatabase;
let admin: SqlClient;
const clock = new FakeClock(Date.parse("2026-11-12T10:00:00Z"));
const database = new FakeDatabase({ fields: ["body"], clock });
const engine = new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"], database });

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
  // The install that creates the store and the worker login with its grants; the table is only
  // what the install needs to name, the source the commands run is the fake engine's.
  await admin.query("create table public.placeholder (id text primary key, body text)");
  const installed = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "placeholder" },
      questionSet: {
        questions: [{ type: "noul", name: "spam", instructions: "Is it spam?", stakes: "low" }],
        read: ["body"],
        model: "jev-1.14.0",
        thresholds: {},
      },
      project: { id: "proj_other", name: "Other" },
      workerPassword: PASSWORD,
      roleSuffix: scratch.roleSuffix,
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
  database.install();
  database.edit("r1", { body: "Cheap car, wire only" });
});

afterAll(async () => {
  await admin.close();
  await scratch.drop();
});

/** One command against the store as the worker login opens it, the file on disk being `onDisk`. */
function run(argv: readonly string[], onDisk: ProjectConfig) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {
        // The worker's own pool reads it too: the store as the worker login reaches it.
        DATABASE_URL: scratch.as(scratch.workerRole, PASSWORD),
        FACETDB_SECRET: TEST_SECRET,
        TYPESAFE_API_KEY: "ts-test-key",
      },
      loadConfig: () => Promise.resolve(onDisk),
      engines: [lazyEngine("mysql", () => Promise.resolve(engine))],
      connect: connectPostgres,
      store: () =>
        createStore({
          url: scratch.as(scratch.workerRole, PASSWORD),
          pgHost: undefined,
          secret: TEST_SECRET,
          clock,
        }),
      provider: () => createFakeProvider({ defaults: { noul: 0.6 } }),
      clock,
      random: () => 0.5,
      osUser: () => "alex",
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in this test")),
      stopSignal: () => new AbortController().signal,
    },
    COMMANDS,
  );
}

async function inForce(): Promise<unknown> {
  const rows = await admin.query(
    "select version, question_set->'thresholds' as thresholds from facetdb.question_sets_in_force where source_id = $1",
    [LOG_ID],
  );
  return rows;
}

async function versions(): Promise<unknown> {
  return admin.query("select version from facetdb.question_set_versions where source_id = $1", [
    LOG_ID,
  ]);
}

describe("facetdb review against what the worker runs, on a real Postgres", () => {
  it("passes with the file the worker runs, refuses any other, and follows a restart with new thresholds", async () => {
    const first = await run(["worker", "--once", "--no-http"], asMade);
    expect(first.code, first.stderr).toBe(0);
    expect(await inForce()).toEqual([{ version: 1, thresholds: {} }]);

    const same = await run(["review", "--json"], asMade);
    expect(same.code, same.stderr).toBe(0);
    // The new thresholds before any restart: the worker does not run them yet.
    const ahead = await run(["review", "--json"], retuned);
    expect(ahead.code).toBe(1);
    expect(JSON.parse(ahead.stdout)).toMatchObject({
      ok: false,
      error: { code: "config-differs" },
    });

    // The restart with the threshold-only change: no new version, and the worker's row says so.
    const restarted = await run(["worker", "--once", "--no-http"], retuned);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(await versions()).toEqual([{ version: 1 }]);
    expect(await inForce()).toEqual([{ version: 1, thresholds: { scam: { yesAbove: 0.5 } } }]);

    const now = await run(["review", "--json"], retuned);
    expect(now.code, now.stderr).toBe(0);

    // The file edited back to the version's values: the version's row agrees with it, the worker
    // does not, and the review says so with the restart as the fix.
    const back = await run(["review", "--json"], asMade);
    expect(back.code).toBe(1);
    const refusal = JSON.stringify(JSON.parse(back.stdout));
    expect(JSON.parse(back.stdout)).toMatchObject({ error: { code: "config-differs" } });
    expect(refusal).toContain("the worker is not running what facetdb.config.ts says");
    expect(refusal).toContain("listings runs version 1, and the file differs in the thresholds");
    expect(refusal).toContain("restart facetdb worker with this file");
  });
});
