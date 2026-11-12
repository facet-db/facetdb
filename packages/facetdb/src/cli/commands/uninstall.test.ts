import { type SqlConnect, uninstall } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceInput } from "../../config/index.ts";
import { runInProcess, runProgram } from "../program.ts";
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

const LISTINGS: SourceInput = {
  name: "listings",
  database: WORKER_URL,
  table: "listings",
  read: ["title", "description"],
  questions: { is_scam: noul("Is this listing a scam?") },
};

const config: ProjectConfig = facetdb({ model: "jev-1.14.0", sources: [LISTINGS] });

let world: PgliteWorld;

beforeEach(async () => {
  world = await createPgliteWorld();
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text)",
  );
  expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
});

afterEach(async () => {
  await world.close();
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
      loadConfig: () => Promise.resolve(withConfig),
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
      },
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(withConfig),
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
    },
    COMMANDS,
  );
  return { code, stdout, stderr, seen };
}

/** The source as the worker registers it on its first start, with a decision log of its own. */
async function registerSourceWithLog(): Promise<void> {
  await q(
    `insert into facetdb.sources (id, project_id, name, kind) values ('listings', $1, 'listings', 'plugin')`,
    [PROJECT],
  );
  for (const key of ["1", "2"]) {
    await q(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ('listings', $1, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
      [key],
    );
  }
  await q(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ('listings', 1, 'h', '{}')`,
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

/** The notes the connector itself returns for this table, read without the CLI. */
async function connectorNotes(purge: boolean): Promise<readonly string[]> {
  const result = await uninstall({
    adminUrl: ADMIN_URL,
    connect: world.connect,
    source: { table: "listings", sourceId: "listings" },
    purge,
    dryRun: true,
    print: () => undefined,
    confirm: () => Promise.reject(new Error("a dry run asks nothing")),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.notes;
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

  it("refuses a purge while another installed table may share the log, changing nothing", async () => {
    await registerSourceWithLog();
    await installOrders();
    const result = await run(
      ["uninstall", "--purge", "--source", "listings", "--admin-url", ADMIN_URL],
      [],
      twoTables,
    );
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain(
      `error: the decision log of source "listings" may be shared with public.orders (project ${PROJECT}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`,
    );
    expect(await q(`select count(*)::int as n from facetdb.decisions`)).toEqual([{ n: 2 }]);
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
      `note: the decision log of source "listings" stays (2 decision(s), 1 question-set version(s)); it can be purged once no other table is installed in this database (${LATER}).\n`,
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

describe("a run of several tables (the reviewer's case)", () => {
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
        loadConfig: () => Promise.resolve(twoTables),
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
        loadConfig: () => Promise.resolve(twoTables),
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
          loadConfig: () => Promise.resolve(sideConfig),
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
