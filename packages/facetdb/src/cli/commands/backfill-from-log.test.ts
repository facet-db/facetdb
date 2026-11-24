import { type AnswerEntry, type HumanEntry, stateHash } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, webhook } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { fromLogEnd } from "./backfill-left.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb backfill --from-log` through the in-process runner, the Postgres engine and the store on
 * PGlite: after a rebuild that emptied FacetDB's columns, the count comes first, a yes writes each
 * answered record's latest logged decision back (a person's included) with no model call and no
 * action, a record changed since is left for a plain backfill, and the closing line says so. A
 * second run writes nothing; `--dry-run` writes nothing at all.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const LOG_ID = sourceIdOf(projectRef(PROJECT_DIR).id, "listings");
const ENV = { DATABASE_URL: "postgres://localhost:5432/facetdb" };
const HOOK = "https://hooks.example.com/facetdb";

/** A source whose every write would send a webhook: a write-back must queue none of them. */
const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: WORKER_URL,
      table: "listings",
      read: ["id", "title"],
      questions: { is_scam: noul("Is this listing a scam?") },
      actions: [webhook({ url: HOOK })],
    },
  ],
});
const [source] = config.sources;
if (source === undefined) {
  throw new Error("the test config has a source");
}
const questionSet = questionSetOf(config, source);

const TITLES: Record<string, string> = {
  r1: "A car",
  r2: "A flat",
  r3: "A bike",
  r4: "A boat",
  r5: "A van",
};

function hashOf(key: string, title: string): string {
  return stateHash(questionSet.read, { id: key, title });
}

function answer(key: string, title: string, probability: number): AnswerEntry {
  return {
    kind: "answer",
    key,
    version: 1,
    model: "jev-1.14.0",
    stateHash: hashOf(key, title),
    answers: { is_scam: { type: "noul", probability } },
    usage: { inputTokens: 40, outputTokens: 0, asked: ["is_scam"] },
    at: new Date("2026-11-01T10:00:00Z"),
  };
}

function human(key: string, value: boolean): HumanEntry {
  return {
    kind: "human",
    key,
    question: "is_scam",
    value,
    reviewer: "amara",
    stateHash: hashOf(key, TITLES[key] ?? ""),
    version: 1,
    at: new Date("2026-11-01T11:00:00Z"),
  };
}

let world: PgliteWorld;
let store: Store;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet,
      project: projectRef(PROJECT_DIR),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
  for (const [key, title] of Object.entries(TITLES)) {
    await world.client.query("insert into public.listings (id, title) values ($1, $2)", [
      key,
      title,
    ]);
  }
  // r3 was edited after its answer, while the rebuilt table had no trigger to queue it.
  await world.client.query("update public.listings set title = 'A red bike' where id = 'r3'");
  // The rows came back from a rebuild: FacetDB's columns empty, nothing queued.
  await world.client.query("delete from facetdb.jobs");
  const log = store.log(LOG_ID);
  // r1: sure. r2: unsure, then a person said yes. r3: answered at its old title. r4: never
  // answered. r5: unsure, waiting for review.
  await log.appendAnswer(answer("r1", "A car", 0.93));
  await log.appendAnswer(answer("r2", "A flat", 0.55));
  await log.appendHuman(human("r2", true));
  await log.appendAnswer(answer("r3", "A bike", 0.95));
  await log.appendAnswer(answer("r5", "A van", 0.5));
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(argv: readonly string[], answers: readonly string[] = []) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      loadConfig: () => Promise.resolve(config),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      clock: new FakeClock(1_000),
      // No provider and no backfill setup: a write-back that reached for either fails the run.
      answers,
    },
    COMMANDS,
  );
}

async function rows() {
  return world.client.query(
    "select id, is_scam, is_scam_probability, facetdb_status, facetdb_reviewed from public.listings order by id",
  );
}

async function count(table: string): Promise<number> {
  const found = await world.client.query(`select count(*)::int as n from ${table}`);
  return Number(found[0]?.["n"]);
}

const COUNT_LINE =
  "Write back from the decision log, public.listings (source listings): 4 records have a logged answer.";
const WHAT_LINE =
  "Each gets its latest logged decision, a person's included, unless it changed since. No model call and no action, so no cost.";

describe("facetdb backfill --from-log", () => {
  it("shows the count, asks, and writes each record's latest logged decision back, a person's included", async () => {
    const result = await run(["backfill", "--from-log"], ["yes"]);

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Write them back? Type yes to continue: "]);
    expect(result.stdout).toBe(
      [
        COUNT_LINE,
        WHAT_LINE,
        "Pace: at most 50 records written per second.",
        "Done: 3 written. 1 changed since its answer: run facetdb backfill --source listings to queue it, and any record never answered.",
        "",
      ].join("\n"),
    );
    expect(await rows()).toEqual([
      {
        id: "r1",
        is_scam: true,
        is_scam_probability: 0.93,
        facetdb_status: "done",
        facetdb_reviewed: false,
      },
      {
        id: "r2",
        is_scam: true,
        is_scam_probability: 0.55,
        facetdb_status: "done",
        facetdb_reviewed: true,
      },
      {
        id: "r3",
        is_scam: null,
        is_scam_probability: null,
        facetdb_status: "pending",
        facetdb_reviewed: false,
      },
      {
        id: "r4",
        is_scam: null,
        is_scam_probability: null,
        facetdb_status: "pending",
        facetdb_reviewed: false,
      },
      {
        id: "r5",
        is_scam: null,
        is_scam_probability: null,
        facetdb_status: "needs_review",
        facetdb_reviewed: false,
      },
    ]);
    // The unsure record is on the review screen; the decided ones are not.
    const cards = await world.client.query(
      "select record_key, state_hash from facetdb.reviews where source_id = $1",
      [LOG_ID],
    );
    expect(cards).toEqual([{ record_key: "r5", state_hash: hashOf("r5", "A van") }]);
  });

  it("asks no model and runs no action: no webhook or notification queued, nothing queued for the worker, nothing logged", async () => {
    const before = await count("facetdb.decisions");

    const result = await run(["backfill", "--from-log", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(await count("facetdb.webhook_outbox")).toBe(0);
    expect(await count("facetdb.jobs")).toBe(0);
    expect(await count("facetdb.decisions")).toBe(before);
  });

  it("a second run writes nothing and says so", async () => {
    await run(["backfill", "--from-log", "--yes"]);
    const after = await rows();

    const again = await run(["backfill", "--from-log", "--yes"]);

    expect(again.stdout).toContain(
      "Done: nothing written, 3 already current. 1 changed since its answer: run facetdb backfill --source listings to queue it, and any record never answered.",
    );
    expect(await rows()).toEqual(after);
  });

  it("--dry-run shows the counts, asks nothing and writes nothing", async () => {
    const before = await rows();

    const result = await run(["backfill", "--from-log", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toBe(
      [
        COUNT_LINE,
        WHAT_LINE,
        "Dry run, nothing written: 3 to write. 1 changed since its answer: run facetdb backfill --source listings to queue it, and any record never answered.",
        "",
      ].join("\n"),
    );
    expect(await rows()).toEqual(before);
    expect(await count("facetdb.reviews")).toBe(0);
  });

  it("a no writes nothing and says how to start", async () => {
    const before = await rows();

    const result = await run(["backfill", "--from-log"], ["no"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Nothing was written. Run the command again and type yes (or pass --yes) to start.",
    );
    expect(await rows()).toEqual(before);
  });

  it("is refused with --question, before anything is read", async () => {
    const result = await run(["backfill", "--from-log", "--question", "is_scam"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "--from-log writes back every question the log answered, so it does not take --question",
    );
  });

  it("is refused without DATABASE_URL: the log lives in the store", async () => {
    const result = await runInProcess(
      ["backfill", "--from-log", "--yes"],
      {
        projectDir: PROJECT_DIR,
        env: {},
        loadConfig: () => Promise.resolve(config),
        engines: postgresEngines(world.connect),
        connect: world.connect,
      },
      COMMANDS,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "DATABASE_URL is not set, so FacetDB has no decision log to write back from",
    );
  });
});

describe("the closing line of a write-back (fromLogEnd)", () => {
  const none = { written: [], current: [], changed: [], incomplete: [], kept: [], gone: [] };
  const keys = (n: number) => Array.from({ length: n }, (_, at) => `k${at}`);

  it.each([
    [
      "every part, plural",
      {
        written: keys(1200),
        current: keys(2),
        changed: keys(3),
        incomplete: keys(2),
        kept: keys(2),
        gone: keys(4),
      },
      false,
      "Done: 1,200 written, 2 already current, 2 left with the worker's later status (error, unchecked or skipped), 4 no longer in the source. 3 changed since their answer and 2 answered before a question was added: run facetdb backfill --source listings to queue them, and any record never answered.",
    ],
    [
      "one record answered before a question was added",
      { ...none, written: keys(1), incomplete: keys(1) },
      false,
      "Done: 1 written. 1 answered before a question was added: run facetdb backfill --source listings to queue it, and any record never answered.",
    ],
    [
      "nothing left but the never answered",
      { ...none, written: keys(2) },
      false,
      "Done: 2 written. Run facetdb backfill --source listings to queue any record never answered.",
    ],
    [
      "an empty log",
      none,
      false,
      "Done: nothing written. Run facetdb backfill --source listings to queue any record never answered.",
    ],
    [
      "a dry run",
      { ...none, current: keys(1) },
      true,
      "Dry run, nothing written: nothing to write, 1 already current. Run facetdb backfill --source listings to queue any record never answered.",
    ],
  ])("%s", (_name, report, dryRun, line) => {
    expect(fromLogEnd(report, "listings", dryRun)).toBe(line);
  });
});
