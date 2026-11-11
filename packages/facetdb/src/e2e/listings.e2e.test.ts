import { fileURLToPath } from "node:url";
import {
  type Answer,
  type AnswerEntry,
  applyHumanDecision,
  type Clock,
  decideRecord,
  type LogEntry,
  reapplyThresholds,
  type ThresholdOverride,
} from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { createStore, queueKeyPrefix, type Store } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionSetOf } from "../cli/commands/database.ts";
import { COMMANDS } from "../cli/commands/index.ts";
import { runInProcess } from "../cli/program.ts";
import { openTableConnector } from "../cli/table-connector.ts";
import { loadConfig, type ProjectConfig, type SourceConfig } from "../config/index.ts";

/**
 * The local end-to-end. A `listings` table on PGlite, the project's own facetdb.config.ts loaded by
 * the loader, every command through the CLI as a user runs it, and the scripted fake provider in
 * place of TypeSafe:
 *
 *   migrate → 50 inserts → worker --once (every row done or needs_review, pipeline overhead within
 *   the local budget) → yesAbove tightened and re-applied (rows go to review, no model call) → a
 *   person decides through core's applyHumanDecision (written, reviewed, and it stands through a
 *   rewording that re-answers the record and through another threshold change) → explain prints the
 *   history → uninstall --dry-run prints the SQL and changes nothing.
 *
 * The steps share one database and run in order; each `it` starts where the previous one ended. Two
 * workers on one queue and a worker dying mid-batch need real connections, so they are in
 * packages/postgres/src/capture/capture.db.test.ts ("two workers on one queue"), not repeated here.
 */

const PROJECT_DIR = fileURLToPath(new URL("./fixtures/listings-app/", import.meta.url));
const ADMIN_URL = "postgres://admin:e2e-admin-password@localhost:5432/listings_app";
const REVIEWER = "ana@example.com";
const REWORDED = "Is this listing trying to cheat the buyer?";

/** Trigger to columns with the fake provider, median and 95th percentile, in milliseconds. */
const MEDIAN_BUDGET_MS = 300;
const P95_BUDGET_MS = 1_000;

/**
 * The real time, which the overhead is measured in: the connector stamps `facetdb_updated_at` from
 * this clock. Nothing here may wait on it (`worker --once` answers what is queued and exits; the
 * fake provider never fails, so nothing backs off), so a sleep never ends and a stray wait fails the
 * test at its timeout instead of passing slowly.
 */
const wallClock: Clock = {
  now: () => Date.now(),
  sleep: () => new Promise<void>(() => undefined),
};

// --- The fixture: 50 listings and what the fake model answers for each ---------------------------

const KEYS = Array.from({ length: 50 }, (_, index) => `l${String(index + 1).padStart(2, "0")}`);
const titleOf = (key: string) => `Listing ${key}`;
const numberOf = (key: string) => Number(key.slice(1));

const noScam: Answer = { type: "noul", probability: 0.02 };
const scam: Answer = { type: "noul", probability: 0.95 };
const unsureScam: Answer = { type: "noul", probability: 0.5 };
const car: Answer = { type: "choice", top: "car", probabilities: [0.9, 0.05, 0.05] };
const flat: Answer = { type: "choice", top: "flat", probabilities: [0.05, 0.9, 0.05] };
const unsureCategory: Answer = { type: "choice", top: "car", probabilities: [0.4, 0.35, 0.25] };

/**
 * l01–l30 sure no and a car; l31–l40 a sure scam (0.95 ≥ the high-stakes 0.90) and a flat; l41–l45
 * an even scam answer (needs review); l46–l50 not a scam but no clear category (confidence 0.1 <
 * 0.5, needs review). So 40 done and 10 waiting for a person after the first run.
 */
function scripted(key: string): Readonly<Record<string, Answer>> {
  const n = numberOf(key);
  if (n <= 30) {
    return { is_scam: noScam, category: car };
  }
  if (n <= 40) {
    return { is_scam: scam, category: flat };
  }
  if (n <= 45) {
    return { is_scam: unsureScam, category: car };
  }
  return { is_scam: noScam, category: unsureCategory };
}

// --- The world -----------------------------------------------------------------------------------

let world: PgliteWorld;
let store: Store;
let provider: FakeProvider;
/** The project's config as the loader read it from the fixture's facetdb.config.ts. */
let loaded: ProjectConfig;
/** The config in force: the loaded one, then edited as a user edits the file. */
let current: ProjectConfig;

beforeAll(async () => {
  world = await createPgliteWorld();
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: wallClock });
  provider = createFakeProvider({
    keyField: "title",
    answers: Object.fromEntries(KEYS.map((key) => [titleOf(key), scripted(key)])),
  });
  // The app's table, before FacetDB: listings with its state columns.
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text)",
  );
  loaded = (
    await loadConfig("facetdb.config.ts", {
      projectDir: PROJECT_DIR,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    })
  ).config;
  current = loaded;
});

afterAll(async () => {
  await store.close();
  await world.close();
});

/** Runs `facetdb <argv>` in this process against the world, with the config in force. */
function facetdb(argv: readonly string[]) {
  const config = current;
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: { DATABASE_URL: process.env["DATABASE_URL"], TYPESAFE_API_KEY: "ts-e2e-not-used" },
      loadConfig: () => Promise.resolve(config),
      connect: world.connect,
      // The command closes the store it is given; the suite's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock: wallClock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no action sends a webhook in the e2e")),
      serve: () => Promise.reject(new Error("the e2e runs the worker with --no-http")),
    },
    COMMANDS,
  );
}

function listingsSource(config: ProjectConfig): SourceConfig {
  const source = config.sources.find((candidate) => candidate.name === "listings");
  if (source === undefined) {
    throw new Error("the fixture's config has a listings source");
  }
  return source;
}

/** The config with the listings source changed, as editing facetdb.config.ts would change it. */
function edited(
  config: ProjectConfig,
  change: (source: SourceConfig) => Partial<SourceConfig>,
): ProjectConfig {
  return {
    ...config,
    sources: config.sources.map((source) =>
      source.name === "listings" ? { ...source, ...change(source) } : source,
    ),
  };
}

function withThresholds(
  config: ProjectConfig,
  thresholds: Readonly<Record<string, ThresholdOverride>>,
): ProjectConfig {
  return edited(config, () => ({ thresholds }));
}

type Listing = {
  readonly id: string;
  readonly is_scam: boolean | null;
  readonly category: string | null;
  readonly facetdb_status: string;
  readonly facetdb_reviewed: boolean;
  readonly written_ms: number | null;
};

async function listings(): Promise<Map<string, Listing>> {
  const rows = await world.client.query(
    `select id, is_scam, category, facetdb_status, facetdb_reviewed,
            extract(epoch from facetdb_updated_at) * 1000 as written_ms
       from public.listings order by id`,
  );
  return new Map(
    rows.map((row) => {
      const listing: Listing = {
        id: String(row["id"]),
        is_scam: row["is_scam"] as boolean | null,
        category: row["category"] as string | null,
        facetdb_status: String(row["facetdb_status"]),
        facetdb_reviewed: row["facetdb_reviewed"] === true,
        written_ms: row["written_ms"] === null ? null : Number(row["written_ms"]),
      };
      return [listing.id, listing];
    }),
  );
}

async function listing(key: string): Promise<Listing> {
  const row = (await listings()).get(key);
  if (row === undefined) {
    throw new Error(`no listing ${key}`);
  }
  return row;
}

function keysWithStatus(rows: Map<string, Listing>, status: string): string[] {
  return [...rows.values()].filter((row) => row.facetdb_status === status).map((row) => row.id);
}

/** The keys from `from` to `to` inclusive (l31 to l40 is `range(31, 40)`). */
function range(from: number, to: number): string[] {
  return KEYS.filter((key) => numberOf(key) >= from && numberOf(key) <= to);
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("a percentile of nothing");
  }
  return value;
}

/** The schema objects and grants FacetDB owns, to prove a dry run changed none of them. */
async function catalog(): Promise<readonly unknown[]> {
  return world.client.query(
    `select 'column' as kind, table_schema || '.' || table_name || '.' || column_name as name
       from information_schema.columns where table_schema in ('public', 'facetdb')
     union all
     select 'trigger', event_object_table || '.' || trigger_name || '.' || event_manipulation
       from information_schema.triggers
     union all
     select 'function', n.nspname || '.' || p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'facetdb'
     union all
     select 'role', rolname from pg_roles where rolname like 'facetdb%'
     union all
     select 'grant', grantee || ':' || table_schema || '.' || table_name || ':' || privilege_type
       from information_schema.role_table_grants where grantee like 'facetdb%'
     order by 1, 2`,
  );
}

/** Opens the source's capture connector, as the worker does, for the writes core's functions make. */
async function withConnector<Result>(
  config: ProjectConfig,
  work: (connector: Awaited<ReturnType<typeof openTableConnector>>) => Promise<Result>,
): Promise<Result> {
  const source = listingsSource(config);
  const connector = await openTableConnector({
    source,
    url: source.database ?? "",
    connect: world.connect,
    questionSet: questionSetOf(config, source),
    clock: wallClock,
    workerId: "e2e-review",
  });
  try {
    return await work(connector);
  } finally {
    await connector.close();
  }
}

function latestAnswer(history: readonly LogEntry[]): AnswerEntry {
  const answers = history.filter((entry): entry is AnswerEntry => entry.kind === "answer");
  const latest = answers.at(-1);
  if (latest === undefined) {
    throw new Error("the record has no logged answer");
  }
  return latest;
}

// --- The run -------------------------------------------------------------------------------------

describe("the local end-to-end: listings on PGlite with the fake provider", () => {
  it("loads the project's facetdb.config.ts and installs the listings source with migrate", async () => {
    const source = listingsSource(loaded);
    expect(source.read).toEqual(["title", "description"]);
    expect(source.questions.map((question) => [question.name, question.type])).toEqual([
      ["is_scam", "noul"],
      ["category", "choice"],
    ]);
    expect(source.questions[0]?.stakes).toBe("high");

    const result = await facetdb(["migrate", "--yes", "--admin-url", ADMIN_URL]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const columns = await world.client.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position",
    );
    expect(columns.map((row) => row["column_name"])).toEqual(
      expect.arrayContaining([
        "is_scam",
        "is_scam_probability",
        "category",
        "category_confidence",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ]),
    );
  });

  it("answers 50 inserted listings with worker --once, within the local pipeline budget", async () => {
    // The app saves each listing as it always has: one statement, one commit. The time is taken
    // before the statement, so the overhead measured is an upper bound on trigger to columns.
    const committed = new Map<string, number>();
    for (const key of KEYS) {
      committed.set(key, Date.now());
      await world.client.query(
        "insert into public.listings (id, title, description) values ($1, $2, $3)",
        [key, titleOf(key), `For sale, number ${numberOf(key)}`],
      );
    }
    const queued = await world.client.query("select count(*)::int as n from facetdb.jobs");
    expect(queued[0]?.["n"]).toBe(50);

    const result = await facetdb(["worker", "--once", "--no-http"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(50);
    // One request per record, carrying the state and both questions.
    expect(provider.requests[0]?.questions.map((question) => question.name)).toEqual([
      "is_scam",
      "category",
    ]);
    const rows = await listings();
    expect(keysWithStatus(rows, "done").sort()).toEqual(range(1, 40));
    expect(keysWithStatus(rows, "needs_review").sort()).toEqual(range(41, 50));
    expect(rows.get("l01")).toMatchObject({ is_scam: false, category: "car" });
    expect(rows.get("l31")).toMatchObject({ is_scam: true, category: "flat" });
    // An unsure question leaves its value empty; the sure one is still written.
    expect(rows.get("l41")).toMatchObject({ is_scam: null, category: "car" });
    expect(rows.get("l46")).toMatchObject({ is_scam: false, category: null });
    const jobs = await world.client.query("select count(*)::int as n from facetdb.jobs");
    expect(jobs[0]?.["n"]).toBe(0);

    // The overhead FacetDB adds from the app's write to the answer columns, with a model that
    // answers at once, over the whole run: the worker's start and the queue wait of a 50-row burst
    // included (measured 2026-11-01: about 6.5 ms per record on PGlite, median 230 ms, 95th 380 ms).
    const overheads = KEYS.map((key) => {
      const written = rows.get(key)?.written_ms;
      const start = committed.get(key);
      if (written === null || written === undefined || start === undefined) {
        throw new Error(`listing ${key} has no write time`);
      }
      return written - start;
    }).sort((a, b) => a - b);
    const median = percentile(overheads, 0.5);
    const p95 = percentile(overheads, 0.95);
    console.log(
      `pipeline overhead over ${overheads.length} records: median ${median.toFixed(0)} ms, 95th ${p95.toFixed(0)} ms`,
    );
    expect(median).toBeLessThan(MEDIAN_BUDGET_MS);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });

  it("re-applies a tightened yesAbove from the log: the sure scams go to review, no model call", async () => {
    const before = provider.callCount;
    const tightened = withThresholds(current, { is_scam: { yesAbove: 0.97 } });
    const source = listingsSource(current);

    const report = await withConnector(tightened, (connector) =>
      reapplyThresholds(
        questionSetOf(current, source),
        listingsSource(tightened).thresholds,
        store.log("listings"),
        (key, decision, hash) => connector.write(key, decision, hash),
      ),
    );
    current = tightened;

    expect(provider.callCount).toBe(before);
    expect(report.examined).toBe(50);
    expect([...report.written].sort()).toEqual(range(31, 40));
    expect(report.stale).toEqual([]);
    const rows = await listings();
    expect(keysWithStatus(rows, "done").sort()).toEqual(range(1, 30));
    expect(keysWithStatus(rows, "needs_review").sort()).toEqual(range(31, 50));
    expect(rows.get("l31")).toMatchObject({ is_scam: null, category: "flat" });

    // The worker under the new thresholds finds nothing to ask: a threshold change queues nothing.
    const worker = await facetdb(["worker", "--once", "--no-http"]);
    expect(worker.code).toBe(0);
    expect(provider.callCount).toBe(before);
  });

  it("writes a person's decision through core, and it survives a rewording and a threshold change", async () => {
    const source = listingsSource(current);
    const log = store.log("listings");
    const key = "l41";

    // The review screen's card for l41: its state as read now, and the model's answers behind it.
    const decided = await withConnector(current, async (connector) => {
      const { rows } = await connector.read([key]);
      const [row] = rows;
      if (row === undefined) {
        throw new Error(`${key} is gone`);
      }
      const history = await log.history(key);
      const answer = latestAnswer(history);
      const questionSet = questionSetOf(current, source);
      const decisions = decideRecord(questionSet, questionSet.thresholds, answer, history);
      if (decisions === undefined) {
        throw new Error(`${key}'s answer lacks a question`);
      }
      return applyHumanDecision(
        {
          kind: "human",
          key,
          question: "is_scam",
          value: false,
          reviewer: REVIEWER,
          note: "seller is verified",
          stateHash: row.hash,
          version: answer.version,
          at: new Date(wallClock.now()),
        },
        {
          key,
          hash: row.hash,
          status: "needs_review",
          questions: source.questions,
          decisions,
          answers: answer.answers,
        },
        log,
        (target, decision, hash) => connector.write(target, decision, hash),
      );
    });

    expect(decided).toEqual({ written: true, status: "done" });
    expect(await listing(key)).toMatchObject({
      is_scam: false,
      category: "car",
      facetdb_status: "done",
      facetdb_reviewed: true,
    });

    // A rewording makes a new question-set version and asks nothing by itself …
    const reworded = edited(current, (listingsConfig) => ({
      questions: listingsConfig.questions.map((question) =>
        question.name === "is_scam" ? { ...question, instructions: REWORDED } : question,
      ),
    }));
    current = reworded;
    const calls = provider.callCount;
    const quiet = await facetdb(["worker", "--once", "--no-http"]);
    expect(quiet.code).toBe(0);
    expect(provider.callCount).toBe(calls);
    const versions = await world.client.query(
      "select version from facetdb.question_set_versions order by version",
    );
    expect(versions.map((row) => row["version"])).toEqual([1, 2]);

    // … and when the record is asked again under it ("re-answer existing records"), the model's
    // new answer is logged but the person's decision on this unchanged state stands.
    await world.client.query("insert into facetdb.jobs (record_key) values ($1)", [
      `${queueKeyPrefix({ schema: "public", table: "listings" })}${key}`,
    ]);
    const reasked = await facetdb(["worker", "--once", "--no-http"]);
    expect(reasked.stderr).toBe("");
    expect(reasked.code).toBe(0);
    expect(provider.callCount).toBe(calls + 1);
    expect(provider.requests.at(-1)?.questions[0]?.instructions).toBe(REWORDED);
    expect(latestAnswer(await log.history(key)).version).toBe(2);
    expect(await listing(key)).toMatchObject({
      is_scam: false,
      facetdb_status: "done",
      facetdb_reviewed: true,
    });

    // A threshold change under which the model's 0.5 would be a yes leaves the person's no alone,
    // while it decides the other even answers (l42–l45) and the scams again, without a model call.
    const loosened = withThresholds(current, { is_scam: { yesAbove: 0.5 } });
    const report = await withConnector(loosened, (connector) =>
      reapplyThresholds(
        questionSetOf(current, listingsSource(current)),
        listingsSource(loosened).thresholds,
        log,
        (target, decision, hash) => connector.write(target, decision, hash),
      ),
    );
    current = loosened;
    expect(provider.callCount).toBe(calls + 1);
    expect(report.written).not.toContain(key);
    expect([...report.written].sort()).toEqual([...range(31, 40), ...range(42, 45)]);
    const rows = await listings();
    expect(rows.get(key)).toMatchObject({
      is_scam: false,
      facetdb_status: "done",
      facetdb_reviewed: true,
    });
    expect(rows.get("l42")).toMatchObject({ is_scam: true, facetdb_status: "done" });
    expect(keysWithStatus(rows, "needs_review").sort()).toEqual(range(46, 50));
  });

  it("explains the record's history: the model's answers, the person's decision, the row now", async () => {
    const result = await facetdb(["explain", "listings", "l41"]);

    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
    const first = at(/· jev-1\.14\.0 · question set v1$/);
    const human = at(new RegExp(`question set v1 · .* decided no by ${REVIEWER}`));
    const second = at(/· jev-1\.14\.0 · question set v2$/);
    expect(first).toBeGreaterThan(-1);
    expect(human).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(human);
    // Each answer in the wording of its own version: the first unsure, so it needed review.
    expect(lines[first + 1]).toBe('    "Is this listing a scam?" 50% likely yes → needs review');
    expect(lines[human]).toContain('"Is this listing a scam?" decided no by ana@example.com');
    expect(lines[human]).toContain("note: seller is verified");
    expect(result.stdout).toContain(`"${REWORDED}" 50% likely yes`);
    expect(result.stdout).toContain(
      "Now: is_scam: no · category: car · status: done · reviewed: yes",
    );
  });

  it("prints the uninstall SQL on a dry run and changes nothing", async () => {
    const catalogBefore = await catalog();
    const rowsBefore = await listings();

    const result = await facetdb(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toMatch(/drop trigger/i);
    expect(result.stdout).toContain("Dry run: nothing was changed.");
    expect(await catalog()).toEqual(catalogBefore);
    expect(await listings()).toEqual(rowsBefore);
  });
});
