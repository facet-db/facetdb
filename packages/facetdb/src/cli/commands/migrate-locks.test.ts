import type { EnginePlan, PlanLock, PlanLocks, PlanResult } from "@facetdb/core";
import { FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig, sourceCall } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlConnect,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";
import { lockLine, lockSection } from "./migrate.ts";

/**
 * `facetdb migrate` names each lock it will take before it runs: from an engine's plans, the lines
 * it prints before the confirmation and in `--dry-run`, the same list under `--json`, no list for a
 * plan whose engine lists none, and a list that could not be made said in one line while the
 * migration goes on. A project whose sources read no table gets the store's list the same way. The
 * store is a Postgres of its own (PGlite), whose step's list the Postgres package reads; the source
 * is on core's fake engine, whose plans carry the locks a test gives them.
 */

const STORE_URL = "postgres://store-owner:s3cret-store-password@localhost:5432/facetdb";
const SOURCE_URL = "mysql://facetdb_worker:s3cret-worker@127.0.0.1:3306/shop";
const ADMIN_URL = "mysql://root:s3cret-admin@127.0.0.1:3306/shop";

/** The header, with the scripts' lock timeout. */
const HEADER =
  "Locks (each waits at most 10 s for the table; new queries queue behind it meanwhile; then migrate stops and changes nothing):";

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: SOURCE_URL,
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

const onOwnVariable: ProjectConfig = {
  ...config,
  sources: config.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
};

/** The GitHub triage example's shape: one plugin source, its records and answers in the store. */
const triage: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  plugins: { github: { token: env("GITHUB_TOKEN") } },
  sources: [
    {
      name: "issues",
      source: sourceCall("@facetdb/github", "issues", { repo: "acme/web" }),
      read: ["title", "body"],
      questions: { not_priority: noul("Is this low priority?") },
    },
  ],
});

const INSTALL_LOCKS: readonly PlanLock[] = [
  { step: "install", table: "listings", mode: "no reads or writes", rows: "none" },
  { step: "install", table: "facetdb_jobs", mode: "no reads or writes", rows: "empty" },
  { step: "install", table: "facetdb_owners", mode: "no reads or writes", rows: "empty" },
  { step: "install", table: "listings_history", mode: "no writes", rows: 1_234_567 },
];
const PRUNE_LOCKS: readonly PlanLock[] = [
  { step: "prune", table: "listings", mode: "no reads or writes", rows: "unknown" },
];

/** A plan of one statement, with `locks` when given (an engine that fills them). */
function plan(text: string, locks?: PlanLocks): PlanResult {
  const made: EnginePlan = {
    statements: [{ database: "source", purpose: "columns", text }],
    transactional: false,
    removes: [],
    keeps: [],
    notes: [],
  };
  return { ok: true, plan: locks === undefined ? made : { ...made, locks } };
}

function engine(
  install: PlanLocks | undefined,
  prune: PlanLocks | undefined = install === undefined ? undefined : { listed: PRUNE_LOCKS },
): FakeEngine {
  return new FakeEngine({
    name: "mysql",
    schemes: ["mysql"],
    plans: {
      install: () => plan("alter table listings add column is_scam boolean", install),
      prune: () => plan("alter table listings drop column is_spam", prune),
    },
  });
}

const listing = () => engine({ listed: INSTALL_LOCKS });

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

function migrate(
  source: FakeEngine,
  argv: readonly string[],
  more: {
    readonly answers?: readonly string[];
    readonly connect?: SqlConnect;
    readonly config?: ProjectConfig;
  } = {},
) {
  const connect = more.connect ?? world.connect;
  return runInProcess(
    more.config === undefined ? [...argv, "--admin-url", ADMIN_URL] : argv,
    {
      projectDir: "/work/listings-app",
      env: { DATABASE_URL: STORE_URL, FACETDB_SECRET: TEST_SECRET, GITHUB_TOKEN: "ghp_x" },
      loadConfig: () => Promise.resolve(more.config ?? onOwnVariable),
      engines: [...postgresEngines(connect), lazyEngine("mysql", () => Promise.resolve(source))],
      connect,
      ...(more.answers === undefined ? {} : { answers: more.answers }),
    },
    COMMANDS,
  );
}

/** The store brought to this version by a first migrate, so its step locks nothing after. */
async function currentStore(): Promise<void> {
  const first = await migrate(engine(undefined), ["migrate", "--yes"]);
  expect(first.code, first.stderr).toBe(0);
}

/** The lines a source's locks print, in the order of the run: its prune, then its install. */
const SOURCE_LINES = [
  "  prune of listings, listings: blocks reads and writes until the prune ends; every row (the database has no estimate yet)",
  "  install of listings: creates 2 tables",
  "  install of listings, listings: blocks reads and writes until the install ends; no rows",
  "  install of listings, listings_history: blocks writes until the install ends; about 1.2M rows (the database's estimate)",
].join("\n");

describe("the lock list migrate prints before it runs", () => {
  it("prints the store's step first, its new tables in one line, then each step's locks, before the confirmation", async () => {
    // A fresh store: its step makes every table, so they are one line.
    const refused = await migrate(listing(), ["migrate", "--prune"], { answers: ["no"] });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the SQL was not confirmed, so nothing was run");
    const at = refused.stdout.indexOf(`${HEADER}\n`);
    expect(at).toBeGreaterThan(refused.stdout.indexOf("-- facetdb migrate: listings (listings)"));
    expect(refused.stdout.slice(at)).toMatch(
      new RegExp(
        `^${literally(HEADER)}\n {2}store step: creates \\d+ tables in facetdb\n${literally(SOURCE_LINES)}\n$`,
      ),
    );
  });

  it("prints the same list in --dry-run, and --json carries it", async () => {
    await currentStore();
    const dry = await migrate(listing(), ["migrate", "--prune", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`\n${HEADER}\n${SOURCE_LINES}\nDry run: nothing was changed.\n`);
    const json = await migrate(listing(), ["migrate", "--prune", "--dry-run", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    // Under --json the words go to stderr, and the list is plain data on stdout.
    expect(json.stderr).toContain(`${HEADER}\n${SOURCE_LINES}\n`);
    const parsed = JSON.parse(json.stdout) as {
      store: { locks: PlanLocks };
      sources: { locks?: { prune?: PlanLocks; install?: PlanLocks } }[];
    };
    expect(parsed.store.locks).toEqual({ listed: [] });
    expect(parsed.sources[0]?.locks).toEqual({
      prune: { listed: PRUNE_LOCKS },
      install: { listed: INSTALL_LOCKS },
    });
  });

  it("prints no list from a plan without one, and says so only beside a list that is printed", async () => {
    await currentStore();
    const dry = await migrate(engine(undefined), ["migrate", "--prune", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain("Locks");
    expect(dry.stdout).not.toContain("not listed");
    const json = await migrate(engine(undefined), ["migrate", "--dry-run", "--json"]);
    expect((JSON.parse(json.stdout) as { sources: object[] }).sources[0]).not.toHaveProperty(
      "locks",
    );
    // Beside the store's list on a fresh store, the plan's silence is said, never read as none.
    await resetPgliteWorld(world);
    const fresh = await migrate(engine(undefined), ["migrate", "--dry-run"]);
    expect(fresh.stdout).toContain(
      "  install of listings: not listed (the mysql engine does not list its locks yet)\nDry run",
    );
  });

  it("puts no row's content and no secret in a lock line", async () => {
    const dry = await migrate(listing(), ["migrate", "--prune", "--dry-run"]);
    const at = dry.stdout.indexOf(`${HEADER}\n`);
    const section = dry.stdout.slice(at, dry.stdout.indexOf("Dry run: nothing was changed."));
    for (const secret of ["s3cret", "root", "store-owner", "facetdb_worker", "127.0.0.1"]) {
      expect(section).not.toContain(secret);
    }
    // A line holds the step, the table, the mode in words and a count: nothing read from a row.
    for (const line of section.split("\n").slice(1, -1)) {
      expect(line).toMatch(
        /^ {2}(store step|prune of listings|install of listings)(: creates \d+ tables?( in \w+)?|, [\w.]+: blocks (reads and writes|writes) until the (store step|prune|install) ends; .+)$/,
      );
    }
  });
});

describe("a list that cannot be made never stops a migration", () => {
  it("says why for the step in one line, its secrets hidden, and the migration runs", async () => {
    await currentStore();
    const source = engine(
      { unlisted: `the lock list cannot read the catalog on ${ADMIN_URL}` },
      undefined,
    );
    const run = await migrate(source, ["migrate", "--yes"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `${HEADER}\n  install of listings: could not list this step's locks: the lock list cannot read the catalog on ***\n`,
    );
    expect(run.stdout).not.toContain("s3cret");
    expect(source.runs.map((one) => one.source)).toEqual(["listings"]);
    const json = await migrate(
      engine({ unlisted: `the lock list cannot read the catalog on ${ADMIN_URL}` }, undefined),
      ["migrate", "--dry-run", "--json"],
    );
    expect(JSON.parse(json.stdout).sources[0].locks).toEqual({
      install: { unlisted: "the lock list cannot read the catalog on ***" },
    });
  });

  it("the store's step too: a store whose catalog the list cannot read is still migrated", async () => {
    // The listing's own read-only transaction fails; the step's run does not.
    const failing: SqlConnect = (url, options) => {
      const client = world.connect(url, options);
      return {
        ...client,
        transaction: (work) =>
          client.transaction((query) =>
            work((text, params) =>
              text === "set transaction read only"
                ? Promise.reject(new Error(`permission denied on ${STORE_URL}`))
                : query(text, params),
            ),
          ),
      };
    };
    const run = await migrate(engine({ listed: [] }), ["migrate", "--yes"], { connect: failing });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `${HEADER}\n  store step: could not list this step's locks: permission denied on ***\n`,
    );
    expect(run.stdout).toContain("Migrated the FacetDB store on localhost:5432/facetdb.");
    expect(run.stdout).not.toContain("s3cret");
  });
});

describe("a project whose sources read no table is told the store's locks", () => {
  it("prints them before the confirmation and in --dry-run, and --json carries them", async () => {
    const first = await migrate(engine(undefined), ["migrate", "--yes"], { config: triage });
    expect(first.code, first.stderr).toBe(0);
    // The store as it stood before migration 6 built its time index on a log of 240 decisions.
    await world.client.query("drop index facetdb.decisions_by_time");
    await world.client.query("delete from facetdb.store_migrations where version = 6");
    await world.client.query(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       select 'p:issues', g::text, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now() from generate_series(1, 240) g`,
    );
    await world.client.query("analyze facetdb.decisions");
    const line =
      "  store step, facetdb.decisions: blocks writes until the store step ends; about 240 rows (Postgres's estimate)";
    const dry = await migrate(engine(undefined), ["migrate", "--dry-run"], { config: triage });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`\n${HEADER}\n${line}\nDry run: nothing was changed.\n`);
    const refused = await migrate(engine(undefined), ["migrate"], {
      config: triage,
      answers: ["no"],
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout.endsWith(`${HEADER}\n${line}\n`)).toBe(true);
    const json = await migrate(engine(undefined), ["migrate", "--dry-run", "--json"], {
      config: triage,
    });
    expect(JSON.parse(json.stdout).store.locks).toEqual({
      listed: [{ step: "store", table: "facetdb.decisions", mode: "no writes", rows: 240 }],
    });
  });
});

describe("the words of a lock line", () => {
  it.each([
    [{ rows: 0 }, "about 0 rows (Postgres's estimate)"],
    [{ rows: 1 }, "about 1 row (Postgres's estimate)"],
    [{ rows: 12_400 }, "about 12,400 rows (Postgres's estimate)"],
    [{ rows: 999_999 }, "about 999,999 rows (Postgres's estimate)"],
    [{ rows: 1_000_000 }, "about 1M rows (Postgres's estimate)"],
    [{ rows: 1_250_000 }, "about 1.3M rows (Postgres's estimate)"],
    [{ rows: 3_000_000_000 }, "about 3B rows (Postgres's estimate)"],
    [{ rows: "none" }, "no rows"],
    [{ rows: "unknown" }, "every row (Postgres has no estimate yet)"],
  ] as const)("%o: %s", ({ rows }, words) => {
    expect(lockLine({ step: "store", table: "facetdb.decisions", mode: "no writes", rows })).toBe(
      `  store step, facetdb.decisions: blocks writes until the store step ends; ${words}`,
    );
  });

  it("folds a step's new tables into one line, by schema", () => {
    const made = (table: string): PlanLock => ({
      step: "install",
      table,
      mode: "no reads or writes",
      rows: "empty",
    });
    const install: EnginePlan = {
      statements: [],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
      locks: {
        listed: [made("facetdb.listings_answers"), made("public.listings_with_answers")],
      },
    };
    expect(
      lockSection({ listed: [] }, [{ source: "listings", prune: undefined, install }], "postgres"),
    ).toEqual([HEADER, "  install of listings: creates 1 table in facetdb and 1 in public"]);
  });

  it("says none when every step lists its locks and none takes one", () => {
    const empty: EnginePlan = {
      statements: [],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
      locks: { listed: [] },
    };
    expect(
      lockSection(
        { listed: [] },
        [{ source: "listings", prune: undefined, install: empty }],
        "postgres",
      ),
    ).toEqual(["Locks: none."]);
  });
});

/** Text as a regular expression that matches it literally. */
function literally(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
