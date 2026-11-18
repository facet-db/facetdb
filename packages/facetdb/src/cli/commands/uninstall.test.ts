import type { EngineObject, EngineTarget, KeptObject, PlanResult } from "@facetdb/core";
import { FakeClock, FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceInput } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess, runProgram } from "../program.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  postgresEngines,
  readingDatabaseUrl,
  resetPgliteWorld,
  type SqlConnect,
  sourceIdOf,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * What `facetdb uninstall` says: every note the connector returns reaches the terminal, after the
 * script, on a dry run and a real one; before a real run the confirmation says what the script
 * removes and what it keeps, from the connector's plan; and "Removed FacetDB" stands alone only
 * when nothing of FacetDB is left behind. PGlite holds the database, installed by the real `facetdb
 * migrate`.
 */

const ADMIN_URL = "postgres://admin:s3cret-admin-password@localhost:5432/app";
const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
/** The project directory's name is the project's id and name: what uninstall asks to have typed back. */
const PROJECT_DIR = "/work/listings-market";
const PROJECT = "listings-market";
/** The id the worker keeps the `listings` source's log under. */
const LOG_ID = sourceIdOf(PROJECT, "listings");

const LISTINGS: SourceInput = {
  name: "listings",
  database: WORKER_URL,
  table: "listings",
  read: ["title", "description"],
  questions: { is_scam: noul("Is this listing a scam?") },
};

/** Every loader here reads it through `readingDatabaseUrl`: the store is the source's database. */
const config: ProjectConfig = facetdb({ model: "jev-1.14.0", sources: [LISTINGS] });

/** One engine for the file, emptied after every test: a boot per test cost 440 ms. */
let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text)",
  );
  expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

const q = (text: string, params?: readonly unknown[]) => world.client.query(text, params);

function run(
  argv: readonly string[],
  answers?: readonly string[],
  withConfig: ProjectConfig = config,
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(readingDatabaseUrl(withConfig)),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      ...(answers === undefined ? {} : { answers }),
    },
    COMMANDS,
  );
}

/** Runs a command and records, at each prompt, everything printed so far: what the user had seen. */
async function runSeeingPrompts(
  argv: readonly string[],
  answers: readonly string[],
  withConfig: ProjectConfig = config,
) {
  let stdout = "";
  let stderr = "";
  const seen: string[] = [];
  const left = [...answers];
  const unused = () => Promise.reject(new Error("this test gave the command no such dependency"));
  const code = await runProgram(
    argv,
    {
      io: {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        prompt: (question) => {
          seen.push(stdout);
          const answer = left.shift();
          return answer === undefined
            ? Promise.reject(new Error(`unexpected prompt: ${question}`))
            : Promise.resolve(answer);
        },
        answerable: () => Promise.resolve(true),
      },
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(readingDatabaseUrl(withConfig)),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      store: unused,
      provider: () => {
        throw new Error("no provider");
      },
      workspace: {
        exists: () => Promise.resolve(false),
        write: unused,
        hasClaudeCommand: () => false,
      },
      clock: { now: () => 0, sleep: unused },
      backfill: unused,
      serve: unused,
      stopSignal: () => {
        throw new Error("no stop signal");
      },
      webhookFetch: unused,
      abortAfter: () => {
        throw new Error("no timeout signal");
      },
      random: () => {
        throw new Error("no random numbers");
      },
      embedded: { open: unused, wipe: unused },
      examples: { read: unused },
    },
    COMMANDS,
  );
  return { code, stdout, stderr, seen };
}

/** The source as the worker registers it on its first start, with a decision log of its own. */
async function registerSourceWithLog(): Promise<void> {
  await q(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, 'listings', 'plugin')`,
    [LOG_ID, PROJECT],
  );
  for (const key of ["1", "2"]) {
    await q(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ($1, $2, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
      [LOG_ID, key],
    );
  }
  await q(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
    [LOG_ID],
  );
}

async function pendingDeliveries(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await q(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ($1, 'https://hooks.example.com/f', '{}', 1, 1)`,
      [PROJECT],
    );
  }
}

/** The notes the engine's plan carries for this table, read without the CLI. */
async function connectorNotes(purge: boolean): Promise<readonly string[]> {
  const [entry] = postgresEngines(world.connect);
  const [source] = config.sources;
  if (entry === undefined || source === undefined) {
    throw new Error("the test registers the Postgres engine and a source");
  }
  const engine = await entry.load();
  const result = await engine.planUninstall(
    {
      project: { id: PROJECT, name: PROJECT },
      source: "listings",
      table: "listings",
      storage: "inline",
      onChange: "reset",
      questionSet: questionSetOf(config, source),
    },
    ADMIN_URL,
    {
      clock: new FakeClock(0),
      allowInsecure: false,
      storeShared: true,
      purge,
      alsoUninstalling: [],
    },
  );
  if (!result.ok) {
    throw new Error(result.refusal.message);
  }
  return result.plan.notes;
}

async function schemaExists(): Promise<boolean> {
  return (await q("select 1 from pg_namespace where nspname = 'facetdb'")).length > 0;
}

/** What the listings table's own script removes, as the catalog shows it after `migrate`. */
const REMOVES_TABLE =
  "from public.listings: 5 FacetDB columns (is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed), the trigger facetdb_listings, the policies facetdb_reads and facetdb_writes, its queued jobs and the facetdb_worker login's rights on it";
/** The last script in the schema takes the worker's usage of it: a run-wide removal. */
const USAGE = "the facetdb_worker login's usage of schema public";
const FUNCTIONS = "the enqueue trigger functions (no trigger uses them any more)";
const QUEUE = "the jobs table and the table-ownership marks (facetdb.jobs, facetdb.table_owners)";
const SHARED = "the shared FacetDB tables and the alert history in them (no project remains)";
const WORKER =
  "the facetdb_worker and facetdb_enqueue logins (uninstall never drops them: every project on the server may share them)";
const LOG_SIZE = "2 decisions, 1 question-set version";
const LATER = "facetdb uninstall --purge --source listings";

describe("a plain uninstall while another project remains", () => {
  beforeEach(async () => {
    await registerSourceWithLog();
    await q(`insert into facetdb.projects (id, name) values ('listings-admin', 'listings-admin')`);
    await q(
      `insert into facetdb.usage (project_id, month, input_tokens) values ('listings-admin', '2026-11', 4200)`,
    );
  });

  const REMOVES = `${REMOVES_TABLE}; ${USAGE}; ${FUNCTIONS}`;
  const KEEPS = `the decision log of source listings (${LOG_SIZE}): run \`${LATER}\` later to delete it; the shared FacetDB tables, because the FacetDB store still registers a source, a credential or an API key and project listings-admin remains; ${WORKER}`;

  it("says before the confirmation what goes and what stays, and names what it kept after", async () => {
    const notes = await connectorNotes(false);
    expect(notes).toEqual([
      `the decision log of source "listings" stays (2 decision(s), 1 question-set version(s)); to delete it later: ${LATER}`,
    ]);
    const result = await runSeeingPrompts(["uninstall", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.seen).toHaveLength(1);
    const before = result.seen[0] ?? "";
    expect(before).toContain(`This removes: ${REMOVES}.\n`);
    expect(before).toContain(`This keeps: ${KEEPS}.\n`);
    for (const note of notes) {
      expect(before).toContain(`note: ${note}\n`);
    }
    const after = result.stdout.slice(before.length);
    expect(after).toBe(
      `Removed ${REMOVES}.\nRemoved FacetDB from public.listings; kept: ${KEEPS}.\n`,
    );
    expect(result.stdout).not.toContain("Removed FacetDB from public.listings.");
    expect(await q(`select count(*)::int as n from facetdb.decisions`)).toEqual([{ n: 2 }]);
  });

  it("a dry run prints the same words and every note, and asks nothing", async () => {
    const notes = await connectorNotes(false);
    const result = await run(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain(`This removes: ${REMOVES}.\n`);
    expect(result.stdout).toContain(`This keeps: ${KEEPS}.\n`);
    for (const note of notes) {
      expect(result.stdout).toContain(`note: ${note}\n`);
    }
    // The notes come after the script they are about.
    expect(result.stdout.indexOf("note: ")).toBeGreaterThan(result.stdout.indexOf("commit;"));
    expect(result.stdout).toContain("Dry run: nothing was changed.");
  });

  it("under --json, the words and the notes are in the result too", async () => {
    const notes = await connectorNotes(false);
    const result = await run(["uninstall", "--dry-run", "--json", "--admin-url", ADMIN_URL]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      removes: string[];
      keeps: string[];
      sources: { notes: string[] }[];
    };
    expect(parsed.removes).toEqual([REMOVES_TABLE, USAGE, FUNCTIONS]);
    expect(parsed.keeps.join("; ")).toBe(KEEPS);
    expect(parsed.sources[0]).toMatchObject({ notes });
    for (const note of notes) {
      expect(result.stderr).toContain(`note: ${note}\n`);
    }
  });
});

describe("the last table, with a project row kept by its heartbeat", () => {
  it("says the shared tables stay and why, and never says Removed FacetDB alone", async () => {
    await q(`insert into facetdb.heartbeats (project, at) values ($1, 1)`, [PROJECT]);
    await pendingDeliveries(3);
    const notes = await connectorNotes(false);
    expect(notes).toEqual([
      `3 webhook deliveries of project ${PROJECT} still pending: the project and the webhook outbox stay until each is delivered or given up (retried for 24 hours).`,
    ]);
    const keeps = `the decision log tables (only --purge deletes a log); the shared FacetDB tables, because project ${PROJECT} still has worker heartbeats and 3 pending webhook deliveries; ${WORKER}`;
    // No store use and no other table: the queue and the ownership marks go, the rest stays.
    const removes = `${REMOVES_TABLE}; ${USAGE}; ${FUNCTIONS}; ${QUEUE}`;
    const result = await runSeeingPrompts(["uninstall", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    const before = result.seen[0] ?? "";
    expect(before).toContain(`This removes: ${removes}.\n`);
    expect(before).toContain(`This keeps: ${keeps}.\n`);
    for (const note of notes) {
      expect(before).toContain(`note: ${note}\n`);
    }
    expect(result.stdout.slice(before.length)).toBe(
      `Removed ${removes}.\nRemoved FacetDB from public.listings; kept: ${keeps}.\n`,
    );
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: PROJECT }]);
    expect(await q(`select count(*)::int as n from facetdb.webhook_outbox`)).toEqual([{ n: 3 }]);
  });
});

describe("uninstall --purge", () => {
  it("names the log it deletes, and says Removed FacetDB once nothing is left", async () => {
    await registerSourceWithLog();
    const forecast = await connectorNotes(true);
    expect(forecast).toEqual([
      `purge: will delete 2 decision(s) and 1 question-set version(s) of source "listings".`,
    ]);
    const result = await runSeeingPrompts(
      ["uninstall", "--purge", "--admin-url", ADMIN_URL],
      [PROJECT],
    );
    expect(result.code, result.stderr).toBe(0);
    const before = result.seen[0] ?? "";
    const removes = `${REMOVES_TABLE}; the decision log of source listings (${LOG_SIZE}); ${USAGE}; ${FUNCTIONS}; ${QUEUE}; ${SHARED}; the decision log tables, now empty; the facetdb schema, now empty`;
    expect(before).toContain(`This removes: ${removes}.\n`);
    expect(before).toContain(`This keeps: ${WORKER}.\n`);
    for (const note of forecast) {
      expect(before).toContain(`note: ${note}\n`);
    }
    // What the run did, in its own words: the past tense of the forecast, printed once.
    expect(result.stdout.slice(before.length)).toBe(
      [
        `Removed ${removes}.`,
        `note: purge: deleted 2 decision(s) and 1 question-set version(s) of source "listings".`,
        `Removed FacetDB from public.listings; only ${WORKER} stay.`,
        "",
      ].join("\n"),
    );
    expect(await schemaExists()).toBe(false);
  });

  it("a log a plain uninstall left is purged later with the command it named", async () => {
    await registerSourceWithLog();
    const plain = await run(["uninstall", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toContain(`run \`${LATER}\` later to delete it`);

    const later = await runSeeingPrompts(
      ["uninstall", "--purge", "--source", "listings", "--admin-url", ADMIN_URL],
      ["listings"],
    );
    expect(later.code, later.stderr).toBe(0);
    const before = later.seen[0] ?? "";
    // Before the run in the present tense, after it in the past.
    expect(before).toContain(
      "note: public.listings has no FacetDB install left; only the decision log is purged.\n",
    );
    // The plain uninstall left the queue and the marks for the registered source; they go now.
    const removes = `the decision log of source listings (${LOG_SIZE}); ${QUEUE}; ${SHARED}; the decision log tables, now empty; the facetdb schema, now empty`;
    expect(before).toContain(`This removes: ${removes}.\n`);
    expect(before).toContain(`This keeps: ${WORKER}.\n`);
    expect(later.stdout.slice(before.length)).toBe(
      [
        `Removed ${removes}.`,
        "note: public.listings has no FacetDB install left; only the decision log was purged.",
        `note: purge: deleted 2 decision(s) and 1 question-set version(s) of source "listings".`,
        `Purged the decision log of source listings; only ${WORKER} stay.`,
        "",
      ].join("\n"),
    );
    expect(await schemaExists()).toBe(false);
  });

  it("asks for the source's name on a log-only purge, and a wrong one changes nothing", async () => {
    await registerSourceWithLog();
    expect((await run(["uninstall", "--admin-url", ADMIN_URL], [PROJECT])).code).toBe(0);
    const result = await run(["uninstall", "--purge", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual(["Type the source name (listings) to continue: "]);
    expect(result.stderr).toContain("the name typed is not the source's name (listings)");
    expect(await q(`select count(*)::int as n from facetdb.decisions`)).toEqual([{ n: 2 }]);
  });
});

describe("what the purge's checks say, through the CLI", () => {
  /** The same project with a second table, `orders`: a log may be shared while it is installed. */
  const twoTables: ProjectConfig = facetdb({
    model: "jev-1.14.0",
    sources: [
      LISTINGS,
      {
        name: "orders",
        database: WORKER_URL,
        table: "orders",
        read: ["title"],
        questions: { is_scam: noul("Is this order a scam?") },
      },
    ],
  });

  async function installOrders(): Promise<void> {
    await q("create table public.orders (id text primary key, title text not null)");
    const installed = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], [], twoTables);
    expect(installed.code, installed.stderr).toBe(0);
  }

  it("purges the table's log while another table of the project is installed: its log has its own id", async () => {
    await registerSourceWithLog();
    await installOrders();
    const result = await run(
      ["uninstall", "--purge", "--source", "listings", "--admin-url", ADMIN_URL],
      [PROJECT],
      twoTables,
    );
    expect(result.code, result.stderr).toBe(0);
    // Its rows were the log's last, so the emptied log table went with them.
    expect(await q(`select to_regclass('facetdb.decisions') is null as gone`)).toEqual([
      { gone: true },
    ]);
    expect(await q(`select table_name from facetdb.table_owners order by table_name`)).toEqual([
      { table_name: "orders" },
    ]);
  });

  it("a plain uninstall says the log stays because another table may share it", async () => {
    await registerSourceWithLog();
    await installOrders();
    const result = await run(
      ["uninstall", "--dry-run", "--source", "listings", "--admin-url", ADMIN_URL],
      [],
      twoTables,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `This keeps: the decision log of source listings (${LOG_SIZE}), which public.orders may share: run \`${LATER}\` once no other table is installed to delete it; the shared FacetDB tables, because project ${PROJECT} still has another installed table (public.orders) and the FacetDB store still registers a source, a credential or an API key; ${WORKER}.\n`,
    );
    // The other table's trigger keeps the enqueue functions, and the schema keeps its usage.
    expect(result.stdout).toContain(
      "This removes: from public.listings: 5 FacetDB columns (is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed), the trigger facetdb_listings, the policies facetdb_reads and facetdb_writes, its queued jobs and the facetdb_worker login's rights on it.\n",
    );
    expect(result.stdout).toContain(
      `note: the decision log of source "listings" stays (2 decision(s), 1 question-set version(s)); it can be purged once no other table of its project is installed in this database (${LATER}).\n`,
    );
  });

  it("prints the stale-cursor note and names the run that keeps the shared tables", async () => {
    await q(`insert into facetdb.cursors (run, cursor, done) values ('v1', 'c-17', false)`);
    const notes = await connectorNotes(false);
    expect(notes).toEqual([
      `the project ${PROJECT} and the store's shared tables stay because of an unfinished backfill cursor (run v1); it keeps the shared tables until the backfill finishes or the cursor is deleted.`,
    ]);
    const result = await run(["uninstall", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    for (const note of notes) {
      expect(result.stdout).toContain(`note: ${note}\n`);
    }
    const keeps = `the decision log tables (only --purge deletes a log); the shared FacetDB tables, because a backfill is unfinished (run v1; it finishes, or its cursor is deleted); ${WORKER}`;
    expect(result.stdout).toContain(`This keeps: ${keeps}.\n`);
    expect(result.stdout).toContain(`Removed FacetDB from public.listings; kept: ${keeps}.\n`);
  });

  it("prints that nothing was ever logged for a purged source, and removes everything", async () => {
    const notes = await connectorNotes(true);
    expect(notes).toEqual([
      `purge: no decisions were ever logged for source "listings", nothing to purge.`,
    ]);
    const result = await run(["uninstall", "--purge", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`note: ${notes[0]}\n`);
    expect(result.stdout).toContain(
      `This removes: ${REMOVES_TABLE}; ${USAGE}; ${FUNCTIONS}; ${QUEUE}; ${SHARED}; the decision log tables, now empty; the facetdb schema, now empty.\n`,
    );
    expect(result.stdout).toContain(`Removed FacetDB from public.listings; only ${WORKER} stay.\n`);
    expect(await schemaExists()).toBe(false);
  });

  it("a trigger with no owner row keeps the queue and its functions, and the words say so", async () => {
    await installOrders();
    // The other table lost its owner row by hand; its trigger still writes to the queue.
    await q(`delete from facetdb.table_owners where table_name = 'orders'`);
    const result = await run(
      ["uninstall", "--source", "listings", "--admin-url", ADMIN_URL],
      [PROJECT],
      twoTables,
    );
    expect(result.code, result.stderr).toBe(0);
    const kept =
      "the jobs table and the enqueue functions (a trigger on public.orders still uses them)";
    expect(result.stdout).toContain(
      `This removes: ${REMOVES_TABLE}; ${USAGE}; the table-ownership marks (facetdb.table_owners); ${SHARED}.\n`,
    );
    expect(result.stdout).toContain(
      `This keeps: the decision log tables (only --purge deletes a log); ${kept}; ${WORKER}.\n`,
    );
    expect(result.stdout).not.toContain(`only ${WORKER} stay`);
    expect(result.stdout).toContain(`Removed FacetDB from public.listings; kept: `);
    expect(await q(`select to_regclass('facetdb.jobs') is not null as present`)).toEqual([
      { present: true },
    ]);
  });
});

describe("a run of several tables", () => {
  const twoTables: ProjectConfig = facetdb({
    model: "jev-1.14.0",
    sources: [
      LISTINGS,
      {
        name: "orders",
        database: WORKER_URL,
        table: "orders",
        read: ["title"],
        questions: { is_scam: noul("Is this order a scam?") },
      },
    ],
  });

  const REMOVES_ORDERS =
    "from public.orders: 5 FacetDB columns (is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed), the trigger facetdb_orders, the policies facetdb_reads and facetdb_writes, its queued jobs and the facetdb_worker login's rights on it";

  beforeEach(async () => {
    await q("create table public.orders (id text primary key, title text not null)");
    const installed = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], [], twoTables);
    expect(installed.code, installed.stderr).toBe(0);
    await q(`insert into facetdb.alert_history (record) values ('{"kind": "outage"}')`);
  });

  it("says once, before the prompt, that the shared tables go, and after the last table that they went", async () => {
    const result = await runSeeingPrompts(
      ["uninstall", "--admin-url", ADMIN_URL],
      [PROJECT],
      twoTables,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.seen).toHaveLength(1);
    const before = result.seen[0] ?? "";
    const removes = `${REMOVES_TABLE}; ${REMOVES_ORDERS}; ${USAGE}; ${FUNCTIONS}; ${QUEUE}; ${SHARED}`;
    const keeps = `the decision log tables (only --purge deletes a log); ${WORKER}`;
    expect(before.match(/^This removes: /gm)).toHaveLength(1);
    expect(before).toContain(`This removes: ${removes}.\n`);
    expect(before).toContain(`This keeps: ${keeps}.\n`);
    expect(before).not.toContain("still has another installed table");
    expect(result.stdout.slice(before.length)).toBe(
      [
        // Each table's run says what it removed; the run-wide removals happen in the last one.
        `Removed ${REMOVES_TABLE}.`,
        `Removed ${REMOVES_ORDERS}; ${USAGE}; ${FUNCTIONS}; ${QUEUE}; ${SHARED}.`,
        `Removed FacetDB from public.listings, public.orders; kept: ${keeps}.`,
        "",
      ].join("\n"),
    );
    expect(await q(`select to_regclass('facetdb.alert_history') is null as gone`)).toEqual([
      { gone: true },
    ]);
  });

  it("a later table refused after an earlier one went says which were removed, in --json too", async () => {
    // After the first table's run, the second table is renamed: its run finds nothing to uninstall.
    let transactions = 0;
    const connect: SqlConnect = (url) => {
      const inner = world.connect(url);
      return {
        ...inner,
        transaction: async (work) => {
          const done = await inner.transaction(work);
          transactions += 1;
          if (transactions === 1) {
            await q("alter table public.orders rename to orders_old");
          }
          return done;
        },
      };
    };
    const result = await runInProcess(
      ["uninstall", "--json", "--admin-url", ADMIN_URL],
      {
        projectDir: PROJECT_DIR,
        env: {},
        loadConfig: () => Promise.resolve(readingDatabaseUrl(twoTables)),
        engines: postgresEngines(connect),
        connect,
        answers: [PROJECT],
      },
      COMMANDS,
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
      details: { removed: string[] };
    };
    expect(parsed.error.message).toContain(
      "Already removed in this run, before this: public.listings.",
    );
    expect(parsed.details).toEqual({ removed: ["public.listings"] });
  });

  it("a raw database error in a later table's script still says what went and what did not", async () => {
    // The second script fails as a customer's view on orders.is_scam would make it (2BP01).
    let transactions = 0;
    const connect: SqlConnect = (url) => {
      const inner = world.connect(url);
      return {
        ...inner,
        transaction: async (work) => {
          transactions += 1;
          if (transactions === 2) {
            throw Object.assign(
              new Error(
                "cannot drop column is_scam of table orders because other objects depend on it",
              ),
              { code: "2BP01" },
            );
          }
          return inner.transaction(work);
        },
      };
    };
    const result = await runInProcess(
      ["uninstall", "--json", "--admin-url", ADMIN_URL],
      {
        projectDir: PROJECT_DIR,
        env: {},
        loadConfig: () => Promise.resolve(readingDatabaseUrl(twoTables)),
        engines: postgresEngines(connect),
        connect,
        answers: [PROJECT],
      },
      COMMANDS,
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      error: { code: string; message: string };
      details: { removed: string[] };
    };
    expect(parsed.error.code).toBe("unexpected");
    expect(parsed.error.message).toBe(
      `cannot drop column is_scam of table orders because other objects depend on it Already removed in this run, before this: public.listings. The run-wide removals "This removes" listed did not happen: ${USAGE}; ${FUNCTIONS}; ${QUEUE}; ${SHARED}.`,
    );
    expect(parsed.details).toEqual({ removed: ["public.listings"] });
  });

  it("refuses, before asking, sources whose tables ask for different names (exit 1)", async () => {
    await q(`insert into facetdb.projects (id, name) values ('orders-app', 'orders-app')`);
    await q(
      `update facetdb.table_owners set project_id = 'orders-app' where table_name = 'orders'`,
    );
    const result = await run(["uninstall", "--admin-url", ADMIN_URL], [], twoTables);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain(
      `error: these sources ask for different names to be typed back (${PROJECT}, orders-app); nothing was changed`,
    );
    expect(result.stderr).toContain("run facetdb uninstall once per source with --source <name>");
  });
});

describe("with the store in its own database", () => {
  const STORE_URL = "postgres://store-owner:s3cret-store-password@localhost:5432/facetdb";
  /** The source on its own variable, as the loader makes of `database: process.env.LISTINGS_URL`. */
  const ownVariable: ProjectConfig = {
    ...config,
    sources: config.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
  };

  function runWithStore(argv: readonly string[], answers?: readonly string[]) {
    return runInProcess(
      argv,
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: STORE_URL },
        loadConfig: () => Promise.resolve(ownVariable),
        engines: postgresEngines(world.connect),
        connect: world.connect,
        ...(answers === undefined ? {} : { answers }),
      },
      COMMANDS,
    );
  }

  it("--purge prints the source's script and the store's under their headers, then purges the store after the source", async () => {
    await registerSourceWithLog();
    const dry = await runWithStore(["uninstall", "--purge", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    const source = dry.stdout.indexOf(
      "-- source listings: localhost:5432/app\n-- facetdb uninstall --purge: listings (public.listings)\nbegin;\n",
    );
    const store = dry.stdout.indexOf("-- store: localhost:5432/facetdb\nbegin;\n");
    expect(source).toBe(0);
    expect(store).toBeGreaterThan(source);
    // The engine's script is the source's side alone; the log goes in the store's part.
    expect(dry.stdout.slice(source, store)).not.toContain("delete from facetdb.decisions");
    expect(dry.stdout.slice(store)).toContain("delete from facetdb.decisions");
    expect(dry.stdout).toContain(
      `This removes: ${REMOVES_TABLE}; the decision log of source listings (${LOG_SIZE});`,
    );
    expect(dry.stdout + dry.stderr).not.toContain("s3cret-store-password");
    expect(await q(`select count(*)::int as n from facetdb.decisions`)).toEqual([{ n: 2 }]);

    const real = await runWithStore(["uninstall", "--purge", "--admin-url", ADMIN_URL], [PROJECT]);
    expect(real.code, real.stderr).toBe(0);
    expect(real.stdout).toContain(
      `Removed ${REMOVES_TABLE}; the decision log of source listings (${LOG_SIZE});`,
    );
    expect(
      await q(`select count(*)::int as n from facetdb.decisions where source_id = $1`, [LOG_ID]),
    ).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from facetdb.question_set_versions`)).toEqual([
      { n: 0 },
    ]);
    expect(
      await q(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position",
      ),
    ).toEqual([{ column_name: "id" }, { column_name: "title" }, { column_name: "description" }]);
  });

  it.each([
    [
      "the store unreachable",
      "unexpected",
      "connect ECONNREFUSED 10.0.0.5:5432",
      (): Promise<unknown> => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")),
    ],
    [
      "the store's guard refusing",
      "uninstall-refused",
      `the decision log of source "listings" is shared with the store source "listings" of project ${PROJECT}, which holds records and is live`,
      // A store source of the same id starts writing the log between the show and the run.
      async (): Promise<unknown> => {
        await q(
          `insert into facetdb.records (source_id, record_key, state, hash, status) values ($1, 'r1', '{}', 'h', 'pending')`,
          [LOG_ID],
        );
        return undefined;
      },
    ],
  ])(
    "--purge says both halves when the store's purge fails after the source's run: %s",
    async (_name, code, why, beforePurge) => {
      await registerSourceWithLog();
      // The second connection to the store is the run's purge (the first read the log to show it).
      let storeConnections = 0;
      const connect: SqlConnect = (url, options) => {
        const inner = world.connect(url, options);
        if (url !== STORE_URL) {
          return inner;
        }
        storeConnections += 1;
        if (storeConnections !== 2) {
          return inner;
        }
        return {
          ...inner,
          transaction: async (work) => {
            await beforePurge();
            return inner.transaction(work);
          },
        };
      };
      const result = await runInProcess(
        ["uninstall", "--purge", "--json", "--admin-url", ADMIN_URL],
        {
          projectDir: PROJECT_DIR,
          env: { DATABASE_URL: STORE_URL },
          loadConfig: () => Promise.resolve(ownVariable),
          engines: postgresEngines(connect),
          connect,
          answers: [PROJECT],
        },
        COMMANDS,
      );
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        error: { code: string; message: string; fix: string };
        details: unknown;
      };
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.message).toBe(
        `the FacetDB install on public.listings was removed; the decision log of source listings in the FacetDB store on localhost:5432/facetdb was not purged: ${why}.`,
      );
      expect(parsed.error.fix).toBe(
        "fix what the message says, then run facetdb uninstall --purge --source listings again: with the install gone, it purges the log alone",
      );
      expect(parsed.details).toEqual({ removed: ["public.listings"], notPurged: ["listings"] });
      // Both halves as said: the source's side gone, the log still in the store.
      expect(
        await q(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' and column_name = 'is_scam'",
        ),
      ).toEqual([]);
      expect(
        await q(`select count(*)::int as n from facetdb.decisions where source_id = $1`, [LOG_ID]),
      ).toEqual([{ n: 2 }]);
    },
  );

  it("without --purge keeps the log in the store, and says so", async () => {
    await registerSourceWithLog();
    const dry = await runWithStore(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain("-- store:");
    expect(dry.stdout).toContain(
      "This keeps: the decision log of source listings in the FacetDB store (only --purge deletes a log);",
    );
  });
});

describe("what is left in place on purpose", () => {
  it("prints the connector's note and keeps Removed FacetDB from standing alone", async () => {
    const sideConfig: ProjectConfig = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "gadgets",
          database: WORKER_URL,
          table: "gadgets",
          storage: "side-table",
          read: ["title"],
          questions: { is_scam: noul("Is this gadget a scam?") },
        },
      ],
    });
    await q("create table public.gadgets (id text primary key, title text not null)");
    const runSide = (argv: readonly string[], answers?: readonly string[]) =>
      runInProcess(
        argv,
        {
          projectDir: PROJECT_DIR,
          env: {},
          loadConfig: () => Promise.resolve(readingDatabaseUrl(sideConfig)),
          engines: postgresEngines(world.connect),
          connect: world.connect,
          ...(answers === undefined ? {} : { answers }),
        },
        COMMANDS,
      );
    expect((await runSide(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const fk = await q(
      `select conname from pg_constraint where conrelid = 'facetdb.gadgets_answers'::regclass and contype = 'f'`,
    );
    await q(`alter table facetdb.gadgets_answers drop constraint "${String(fk[0]?.["conname"])}"`);
    const result = await runSide(
      ["uninstall", "--source", "gadgets", "--admin-url", ADMIN_URL],
      [PROJECT],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `note: left in place: "facetdb"."gadgets_answers" is FacetDB's side table but has no foreign key to public.gadgets`,
    );
    expect(result.stdout).toContain("facetdb.gadgets_answers, left in place (see the note above)");
    expect(result.stdout).not.toContain("Removed FacetDB from public.gadgets.");
  });
});

/**
 * On every engine the words name the table as the engine does and the objects as its plan does,
 * with core's fake engine standing in for a schema-less database (SQLite's names, nothing kept) and
 * a schema-bearing one (SQL Server's dbo, its Change Tracking turned off), and MongoDB's role and
 * user.
 */
describe("the words of an engine that is not Postgres", () => {
  const STORE_URL = "postgres://store-owner:s3cret-store-password@localhost:5432/facetdb";

  /** A plan as the engine's uninstall makes it: no statement of the store's, since it is elsewhere. */
  function uninstallPlan(
    removes: readonly EngineObject[],
    keeps: readonly KeptObject[],
  ): (target: EngineTarget) => PlanResult {
    return (target) => ({
      ok: true,
      plan: {
        statements: [
          { database: "source", purpose: "columns", text: `alter table ${target.table} drop x` },
        ],
        transactional: true,
        removes,
        keeps,
        notes: [],
        confirm: { kind: "project", name: target.project.name },
      },
    });
  }

  /** `uninstall` on one engine, the source on its own variable and the store in its own Postgres. */
  function runOn(
    engine: FakeEngine,
    key: string,
    url: string,
    argv: readonly string[],
    answers?: readonly string[],
  ) {
    const onEngine: ProjectConfig = {
      ...config,
      sources: config.sources.map((source) => ({
        ...source,
        database: url,
        databaseEnv: "LISTINGS_URL",
      })),
    };
    return runInProcess(
      [...argv, "--admin-url", url],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: STORE_URL },
        loadConfig: () => Promise.resolve(onEngine),
        engines: [
          ...postgresEngines(world.connect),
          lazyEngine(key, () => Promise.resolve(engine)),
        ],
        connect: world.connect,
        ...(answers === undefined ? {} : { answers }),
      },
      COMMANDS,
    );
  }

  it("a schema-less engine: the bare table, its own queue and marks, and no kept line when nothing stays", async () => {
    const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
      kind,
      name,
      of: "listings",
      scope: "source",
    });
    const sqlite = new FakeEngine({
      name: "sqlite",
      schemes: ["sqlite", "file"],
      plans: {
        uninstall: uninstallPlan(
          [
            own("column", "is_scam"),
            own("trigger", "facetdb_listings_ins"),
            own("jobs-table", "facetdb_jobs"),
            { kind: "jobs-table", name: "facetdb_jobs", scope: "run" },
            { kind: "marker", name: "facetdb_table_owners", scope: "run" },
          ],
          [],
        ),
      },
    });
    const url = "sqlite:///work/listings-market/app.db";
    const result = await runOn(sqlite, "sqlite", url, ["uninstall", "--purge"], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("-- facetdb uninstall --purge: listings (listings)\n");
    expect(result.stdout).toContain(
      "This removes: from listings: 1 FacetDB column (is_scam), the trigger facetdb_listings_ins and its queued jobs; the decision log of source listings (0 decisions, 0 question-set versions); the jobs table and the table-ownership marks (facetdb_jobs, facetdb_table_owners).\n",
    );
    expect(result.stdout).not.toContain("This keeps");
    expect(result.stdout).toMatch(/\nRemoved FacetDB from listings\.\n$/);
    expect(result.stdout).not.toContain("kept: .");
    // Without --purge the store keeps the log: that is said, and it is all that stays.
    const kept = await runOn(sqlite, "sqlite", url, ["uninstall"], [PROJECT]);
    expect(kept.code, kept.stderr).toBe(0);
    expect(kept.stdout).toContain(
      "This keeps: the decision log of source listings in the FacetDB store (only --purge deletes a log).\n",
    );
    for (const words of [result.stdout, kept.stdout]) {
      expect(words).not.toContain("public.");
      expect(words).not.toContain("facetdb.jobs");
      expect(words).not.toContain("facetdb.table_owners");
    }
  });

  it("a schema-bearing engine: dbo.listings, its Change Tracking turned off, and only its login staying", async () => {
    const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
      kind,
      name,
      of: "dbo.listings",
      scope: "source",
    });
    const mssql = new FakeEngine({
      name: "mssql",
      schemes: ["mssql", "sqlserver"],
      label: (target) => `${target.schema ?? "dbo"}.${target.table}`,
      plans: {
        uninstall: uninstallPlan(
          [
            own("column", "is_scam"),
            { ...own("change-tracking", "dbo.listings"), reason: "FacetDB's install turned it on" },
            own("jobs-table", "dbo.facetdb_jobs"),
            own("marker", "dbo.facetdb_table_owners"),
            own("grant", "facetdb_worker"),
            { kind: "jobs-table", name: "dbo.facetdb_jobs", scope: "run" },
            { kind: "marker", name: "dbo.facetdb_table_owners", scope: "run", reason: "now empty" },
          ],
          [
            {
              kind: "login",
              name: "facetdb_worker",
              scope: "run",
              reason: "uninstall never drops it: every project on the server may share it",
            },
          ],
        ),
      },
    });
    const url = "mssql://facetdb_worker:s3cret-worker@127.0.0.1:1433/shop";
    const result = await runOn(mssql, "mssql", url, ["uninstall", "--purge"], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("-- facetdb uninstall --purge: listings (dbo.listings)\n");
    expect(result.stdout).toContain(
      "This removes: from dbo.listings: 1 FacetDB column (is_scam), its Change Tracking (turned off: FacetDB's install turned it on), its queued jobs, its table-ownership mark and the facetdb_worker login's rights on it; the decision log of source listings (0 decisions, 0 question-set versions); the jobs table and the table-ownership marks (dbo.facetdb_jobs, dbo.facetdb_table_owners).\n",
    );
    expect(result.stdout).toContain(
      "This keeps: the facetdb_worker login (uninstall never drops it: every project on the server may share it).\n",
    );
    expect(result.stdout).toContain(
      "Removed FacetDB from dbo.listings; only the facetdb_worker login (uninstall never drops it: every project on the server may share it) stays.\n",
    );
    expect(result.stdout).not.toContain("public.");
    const json = await runOn(mssql, "mssql", url, ["uninstall", "--dry-run", "--json"]);
    expect((JSON.parse(json.stdout) as { sources: { table: string }[] }).sources).toMatchObject([
      { table: "dbo.listings" },
    ]);
  });

  it("MongoDB: the collection, its role and its user", async () => {
    const mongodb = new FakeEngine({
      name: "mongodb",
      schemes: ["mongodb", "mongodb+srv"],
      plans: {
        uninstall: uninstallPlan(
          [
            { kind: "field", name: "facetdb", of: "app.listings", scope: "source" },
            { kind: "jobs-table", name: "facetdb_jobs", of: "app.listings", scope: "source" },
            {
              kind: "login",
              name: "facetdb_worker_listings",
              of: "app.listings",
              scope: "source",
              noun: "role",
            },
          ],
          [
            {
              kind: "login",
              name: "facetdb_worker",
              scope: "run",
              noun: "user",
              reason: "uninstall never drops it",
            },
          ],
        ),
      },
    });
    const url = "mongodb://facetdb_worker:s3cret-worker@127.0.0.1:27017/app";
    const result = await runOn(mongodb, "mongodb", url, ["uninstall", "--purge"], [PROJECT]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("-- facetdb uninstall --purge: listings (listings)\n");
    expect(result.stdout).toContain(
      "This removes: from app.listings: 1 FacetDB field (facetdb), the role facetdb_worker_listings and its queued jobs;",
    );
    expect(result.stdout).toContain(
      "Removed FacetDB from listings; only the facetdb_worker user (uninstall never drops it) stays.\n",
    );
    expect(result.stdout).not.toContain("login");
  });
});
