import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider, type FakeScript } from "@facetdb/model";
import { createStore } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb preview` through the in-process runner on PGlite, with the scripted fake provider. A
 * preview changes nothing: each test that reads rows compares the table and the decision log
 * before and after.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";

function configWith(
  extra: { readonly where?: string; readonly read?: readonly string[] } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["id", "title"],
        ...extra,
        questions: {
          is_scam: noul("Is this listing a scam?"),
          category: choice("Which category is this listing?", {
            car: "A car",
            flat: "A flat",
          }),
        },
      },
    ],
  });
}

let world: PgliteWorld;

beforeEach(async () => {
  world = await createPgliteWorld();
  await world.client.query(
    `create table public.listings (
       id text primary key, title text not null, created_at timestamptz not null default now())`,
  );
  // 25 rows; row "r25" is the newest.
  await world.client.query(
    `insert into public.listings (id, title, created_at)
     select 'r' || n, 'Listing ' || n, timestamptz '2026-01-01 00:00:00+00' + n * interval '1 minute'
       from generate_series(1, 25) as n`,
  );
});

afterEach(async () => {
  await world.close();
});

async function tableSnapshot(): Promise<string> {
  const rows = await world.client.query("select * from public.listings order by id");
  return JSON.stringify(rows);
}

function run(
  argv: readonly string[],
  provider: FakeProvider,
  config: ProjectConfig = configWith(),
  connect = world.connect,
) {
  return runInProcess(
    argv,
    {
      projectDir: "/work/listings-app",
      env: {},
      loadConfig: () => Promise.resolve(config),
      connect,
      provider: () => provider,
    },
    COMMANDS,
  );
}

/** A scam at 58% (unsure) and a certain car for r25; every other row is a certain non-scam car. */
const SCRIPT: FakeScript = {
  keyField: "id",
  answers: {
    r25: {
      is_scam: { type: "noul", probability: 0.58 },
      category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
    },
    r24: {
      is_scam: { type: "noul", probability: 0.02 },
      category: { type: "choice", top: "flat", probabilities: [0.3, 0.7] },
    },
  },
  defaults: { noul: 0.02, choice: 0 },
};

describe("facetdb preview", () => {
  it("answers the 20 most recent rows and changes neither the table nor the decision log", async () => {
    const store = await createStore({
      pglite: world.db,
      secret: TEST_SECRET,
      clock: new FakeClock(0),
    });
    const decisions = async () =>
      (await world.client.query("select count(*)::int as n from facetdb.decisions"))[0]?.["n"];
    const rowsBefore = await tableSnapshot();
    expect(await decisions()).toBe(0);
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["preview"], provider);

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(20);
    // Newest first: r25 down to r6; r5 and older are not read.
    expect(provider.requests.map((request) => request.state["id"])).toEqual(
      Array.from({ length: 20 }, (_, index) => `r${25 - index}`),
    );
    expect(await tableSnapshot()).toBe(rowsBefore);
    expect(await decisions()).toBe(0);
    await store.close();
  });

  it("prints words, not numbers: the top option, the confidence and where the row would go", async () => {
    const result = await run(["preview", "--limit", "2"], createFakeProvider(SCRIPT));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nothing was written");
    // r25: a 58% scam is between the thresholds, so the row goes to review.
    expect(result.stdout).toContain("Row r25: would go to review");
    expect(result.stdout).toContain("is scam: 58% likely yes -> needs review");
    expect(result.stdout).toContain("category: car, 90% sure -> car");
    // r24: both questions are sure enough (the choice's 70/30 is a 40% confidence: below 50%).
    expect(result.stdout).toContain("is scam: 2% likely yes -> no");
    expect(result.stdout).toContain("category: flat, 40% sure -> needs review");
    expect(result.stdout).toContain("Row r24: would go to review");
    expect(result.stdout).toContain("0 of 2 answered rows would be decided automatically");
    // No raw decimal ever reaches the screen.
    expect(result.stdout).not.toMatch(/0\.\d/);
  });

  it("marks a row that every question decides as decided", async () => {
    const result = await run(
      ["preview", "--limit", "1"],
      createFakeProvider({
        keyField: "id",
        answers: {
          r25: {
            is_scam: { type: "noul", probability: 0.01 },
            category: { type: "choice", top: "flat", probabilities: [0.05, 0.95] },
          },
        },
      }),
    );

    expect(result.stdout).toContain("Row r25: would be decided");
    expect(result.stdout).toContain("1 of 1 answered rows would be decided automatically");
  });

  it("skips a row with nothing to read and a row the where filter leaves out, without a model call", async () => {
    await world.client.query("update public.listings set title = '   ' where id = 'r25'");
    const provider = createFakeProvider(SCRIPT);

    const result = await run(
      ["preview", "--limit", "2"],
      provider,
      configWith({ where: "id <> 'r24'", read: ["title"] }),
    );

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("Row r25: skipped (nothing to read: every field is empty)");
    expect(result.stdout).toContain("Row r24: skipped (left out by the source's where filter)");
  });

  it("--dry-run asks nothing and opens no connection", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["preview", "--dry-run"], provider, configWith(), () => {
      throw new Error("a dry run opened a connection");
    });

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("Dry run");
    expect(result.stdout).toContain("20 most recent rows");
  });

  it("refuses a limit that is not a whole number of rows, as a bad invocation", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["preview", "--limit", "0"], provider);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--limit");
    expect(result.stderr).toContain("fix:");
    expect(provider.callCount).toBe(0);
  });

  it("reports a failed model call as an error with the fix, and writes nothing", async () => {
    const rowsBefore = await tableSnapshot();

    const result = await run(
      ["preview", "--limit", "1"],
      createFakeProvider({ ...SCRIPT, failures: { 0: { kind: "503" } } }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the model did not answer for row r25");
    expect(result.stderr).toContain("facetdb doctor");
    expect(await tableSnapshot()).toBe(rowsBefore);
  });

  it("says so when the table has no rows", async () => {
    await world.client.query("delete from public.listings");
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["preview"], provider);

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("no rows yet");
  });
});
