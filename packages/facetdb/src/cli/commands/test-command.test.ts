import { stateHash } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider, type FakeScript } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb test` through the in-process runner on PGlite, with the scripted fake provider. The
 * store holds version 1 (is_scam decides at 70% and 30%) with the answers it logged and two
 * decisions by a person; the draft in the config file makes is_scam a high-stakes question (90%
 * and 10%). A test writes nothing: each test that runs it compares the table, the log and the
 * versions before and after.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const LOG_ID = sourceIdOf("listings-app", "listings");
const FIELDS = ["id", "title"];

function configWith(stakes: "low" | "high"): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: FIELDS,
        questions: {
          is_scam: noul("Is this listing a scam?", { stakes }),
          category: choice("Which category is this listing?", {
            car: "A car",
            flat: "A flat",
          }),
        },
      },
    ],
  });
}

function setOf(config: ProjectConfig) {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has no source");
  }
  return questionSetOf(config, source);
}

let world: PgliteWorld;
let store: Store;

// One engine for the file, emptied after every test: a boot per test cost 440 ms.
beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

const title = (n: number) => `Listing ${n}`;
const stateOf = (n: number) => ({ id: `r${n}`, title: title(n) });

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
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
  await store.close();
  await resetPgliteWorld(world);
});

/** What the version in force said of is_scam at each record's present state. */
const LOGGED: Readonly<Record<number, number>> = {
  25: 0.5,
  24: 0.8,
  23: 0.95,
  22: 0.5,
  21: 0.02,
  2: 0.2,
};

async function seedVersionOne(options: { readonly people?: boolean } = {}): Promise<void> {
  const version = await store.questionSets.record(LOG_ID, setOf(configWith("low")));
  expect(version.version).toBe(1);
  const log = store.log(LOG_ID);
  for (const [n, probability] of Object.entries(LOGGED)) {
    await log.appendAnswer({
      kind: "answer",
      key: `r${n}`,
      version: 1,
      model: "jev-1.14.0",
      stateHash: stateHash(FIELDS, stateOf(Number(n))),
      answers: {
        is_scam: { type: "noul", probability },
        category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
      },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date(0),
    });
  }
  // r2 (old) and r23 (in the sample) were decided by a person.
  for (const [n, value] of options.people === false
    ? []
    : ([
        [2, false],
        [23, true],
      ] as const)) {
    await log.appendHuman({
      kind: "human",
      key: `r${n}`,
      question: "is_scam",
      value,
      reviewer: "maya",
      stateHash: stateHash(FIELDS, stateOf(n)),
      version: 1,
      at: new Date(0),
    });
  }
}

const CAR = { type: "choice", top: "car", probabilities: [0.95, 0.05] } as const;
const noulAnswer = (probability: number) => ({ type: "noul", probability }) as const;

/** What the draft's model says: see the expectations below for where each record moves. */
const SCRIPT: FakeScript = {
  keyField: "id",
  answers: {
    r25: { is_scam: noulAnswer(0.97), category: CAR },
    r24: { is_scam: noulAnswer(0.8), category: CAR },
    r23: { is_scam: noulAnswer(0.95), category: CAR },
    r22: { is_scam: noulAnswer(0.5), category: CAR },
    r21: { is_scam: noulAnswer(0.95), category: CAR },
    r2: { is_scam: noulAnswer(0.5), category: CAR },
  },
};

/** The fake provider with a token count a little denser than the estimate's four characters. */
function realistic(script: FakeScript = SCRIPT): FakeProvider {
  const inner = createFakeProvider(script);
  return {
    get callCount() {
      return inner.callCount;
    },
    get requests() {
      return inner.requests;
    },
    ask: async (request) => {
      const response = await inner.ask(request);
      return {
        ...response,
        usage: {
          inputTokens: Math.round(JSON.stringify(request).length / 3.6),
          outputTokens: 4,
        },
      };
    },
  };
}

function run(
  argv: readonly string[],
  provider: FakeProvider,
  options: { readonly config?: ProjectConfig; readonly answers?: readonly string[] } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: { DATABASE_URL: "postgres://localhost:5432/app" },
      loadConfig: () => Promise.resolve(options.config ?? configWith("high")),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      clock: new FakeClock(0),
      random: () => 0.5,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      answers: options.answers ?? [],
    },
    COMMANDS,
  );
}

async function count(table: string): Promise<number> {
  const rows = await world.client.query(`select count(*)::int as n from ${table}`);
  return Number(rows[0]?.["n"]);
}

async function tableSnapshot(): Promise<string> {
  return JSON.stringify(await world.client.query("select * from public.listings order by id"));
}

describe("facetdb test", () => {
  it("prints the estimate, asks, then says per question what would change and how agreement moves", async () => {
    await seedVersionOne();
    const provider = realistic();
    const rowsBefore = await tableSnapshot();
    const [decisionsBefore, versionsBefore] = [
      await count("facetdb.decisions"),
      await count("facetdb.question_set_versions"),
    ];

    const result = await run(["test", "--sample", "5"], provider, { answers: ["yes"] });

    expect(result.code, result.stderr).toBe(0);
    // The cost comes first, and the question after it.
    expect(result.stdout).toContain("against version 1 of listings");
    expect(result.stdout).toContain(
      "5 newest records and 2 records a person decided: 6 model requests, about",
    );
    expect(result.stdout).toContain("can differ from this by up to 25%");
    expect(result.prompts).toEqual(["Run the test? Type yes to continue: "]);
    expect(result.stdout.indexOf("6 model requests")).toBeLessThan(
      result.stdout.indexOf("is scam:"),
    );
    // r25 unsure -> decided, r24 decided -> unsure, r21 no -> yes; r22 unsure both ways; r23 is a
    // person's and stays.
    expect(result.stdout).toContain(
      "is scam: 3 of 4 answers would change (1 move from unsure to a decision, 1 the other way, 1 to another value).",
    );
    expect(result.stdout).toContain("1 record keeps a person's decision whatever the draft says");
    // r2 (no) and r23 (yes): the version in force agreed with both; the draft agrees with r23 and
    // leaves r2 unsure.
    expect(result.stdout).toContain(
      "Agreement with reviewers (2 records a person decided): 100% now, 100% (1 left unsure) with the draft.",
    );
    // Nobody decided category: no number, and it says why.
    expect(result.stdout).toContain("category: none of 5 answers would change.");
    expect(result.stdout).toContain(
      "no record a person decided on this question was tested, so there is no number.",
    );
    // The two next steps, and the plain statement that nothing changed.
    expect(result.stdout).toContain("Nothing was changed: the worker still runs version 1.");
    expect(result.stdout).toContain("commit facetdb.config.ts and restart facetdb worker");
    expect(result.stdout).toContain("facetdb backfill");
    // No raw decimal ever reaches the screen.
    expect(result.stdout).not.toMatch(/(?<!\$)0\.\d/);

    // The model was asked once per record, newest first, the older reviewed one last.
    expect(provider.requests.map((request) => request.state["id"])).toEqual([
      "r25",
      "r24",
      "r23",
      "r22",
      "r21",
      "r2",
    ]);
    // Nothing was written: not a row, not a decision, not a version.
    expect(await tableSnapshot()).toBe(rowsBefore);
    expect(await count("facetdb.decisions")).toBe(decisionsBefore);
    expect(await count("facetdb.question_set_versions")).toBe(versionsBefore);
  });

  it("the cost printed before the run is within the estimate's margin of the usage counted after it", async () => {
    await seedVersionOne();

    const result = await run(["test", "--sample", "5", "--yes", "--json"], realistic());

    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      readonly estimate: { readonly inputTokens: number };
      readonly cost: { readonly inputTokens: number };
    };
    const off =
      Math.abs(json.cost.inputTokens - json.estimate.inputTokens) / json.estimate.inputTokens;
    expect(off).toBeLessThanOrEqual(0.25);
  });

  it("--yes runs without a prompt, and --json carries the same result as the table", async () => {
    await seedVersionOne();

    const result = await run(["test", "--sample", "5", "--yes", "--json"], realistic());

    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      source: "listings",
      version: 1,
      sample: { records: 5, asked: 5 },
      reviewed: { records: 2, asked: 2 },
      questions: [
        {
          question: "is_scam",
          compared: 4,
          changed: 3,
          toDecided: 1,
          toReview: 1,
          toAnotherValue: 1,
          keptForPeople: 1,
          agreement: { kind: "measured", records: 2 },
        },
        { question: "category", changed: 0, agreement: { kind: "none" } },
      ],
    });
  });

  it("gives no agreement number when nobody has decided anything", async () => {
    await seedVersionOne({ people: false });
    const provider = realistic();

    const result = await run(["test", "--sample", "5", "--yes"], provider);

    expect(result.code, result.stderr).toBe(0);
    expect(provider.callCount).toBe(5);
    expect(result.stdout).toContain("5 newest records and no record a person decided");
    expect(result.stdout).not.toContain("Agreement with reviewers (");
    expect(result.stdout).toContain(
      "no record a person decided on this question was tested, so there is no number.",
    );
  });

  it("a declined estimate asks the model nothing", async () => {
    await seedVersionOne();
    const provider = realistic();

    const result = await run(["test", "--sample", "5"], provider, { answers: ["no"] });

    expect(result.code, result.stderr).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("Nothing was asked and nothing was changed.");
    expect(result.stdout).not.toContain("is scam:");
  });

  it("without a terminal and without --yes it stops, naming the flag", async () => {
    await seedVersionOne();
    const provider = realistic();

    const result = await runInProcess(
      ["test", "--sample", "5"],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: "postgres://localhost:5432/app" },
        loadConfig: () => Promise.resolve(configWith("high")),
        engines: postgresEngines(world.connect),
        connect: world.connect,
        clock: new FakeClock(0),
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        interactive: false,
      },
      COMMANDS,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pass --yes");
    expect(provider.callCount).toBe(0);
  });

  it("says so, and asks nothing, when the file says what the version in force says", async () => {
    await seedVersionOne();
    const provider = realistic();

    const result = await run(["test", "--yes"], provider, { config: configWith("low") });

    expect(result.code, result.stderr).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("the thresholds are the same, so nothing would change");
  });

  it("compares the file with the set the worker runs, not with the version's row, after a stakes-only restart (store migration 8)", async () => {
    await seedVersionOne();
    // The worker restarted with high stakes: the content hash leaves stakes out, so the version
    // stays 1 and its row keeps low; the worker's row of what it runs says high.
    const high = setOf(configWith("high"));
    const recorded = await store.questionSets.record(LOG_ID, high);
    expect(recorded.version).toBe(1);
    await store.questionSets.run(LOG_ID, recorded.version, high);

    const same = realistic();
    const unchanged = await run(["test", "--yes"], same, { config: configWith("high") });
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("the thresholds are the same, so nothing would change");
    expect(same.callCount).toBe(0);

    // The file put back to the version's row: that is a change from what the worker runs.
    const back = realistic();
    const tested = await run(["test", "--sample", "5", "--yes"], back, {
      config: configWith("low"),
    });
    expect(tested.code, tested.stderr).toBe(0);
    expect(tested.stdout).not.toContain("nothing would change");
    expect(back.callCount).toBeGreaterThan(0);
  });

  it("explains that there is no version to test against before the worker has run", async () => {
    const provider = realistic();

    const result = await run(["test", "--yes"], provider);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no saved version");
    expect(result.stderr).toContain("fix:");
    expect(provider.callCount).toBe(0);
  });

  it("refuses a failed model call as an error, with no result", async () => {
    await seedVersionOne();
    const provider = realistic({ ...SCRIPT, failures: { 2: { kind: "503" } } });

    const result = await run(["test", "--sample", "5", "--yes"], provider);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the model did not answer for record");
    expect(result.stdout).not.toContain("is scam:");
  });

  it("--sample takes a whole number from 1 to 1,000", async () => {
    for (const bad of ["0", "1001", "ten", "2.5"]) {
      const result = await run(["test", "--sample", bad], realistic());
      expect(result.code, bad).toBe(2);
      expect(result.stderr).toContain("--sample is a number of records from 1 to 1,000");
    }
  });

  it("--dry-run opens no store and asks nothing", async () => {
    const provider = realistic();

    const result = await runInProcess(
      ["test", "--dry-run"],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: "postgres://localhost:5432/app" },
        loadConfig: () => Promise.resolve(configWith("high")),
        engines: postgresEngines(world.connect),
        connect: world.connect,
        // runInProcess refuses a store nobody gave: a dry run must not reach for one.
      },
      COMMANDS,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run: would read the 1,000 newest records");
    expect(result.prompts).toEqual([]);
    expect(provider.callCount).toBe(0);
  });
});
