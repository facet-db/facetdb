import { STATE_HASH_COLUMN } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  pollingEngines,
  resetPgliteWorld,
  type SqlConnect,
  SteppedClock,
  storeScript,
  storeStepStatements,
  WORKER_ROLE,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * A source with `connector: "polling"` on a Postgres host that forbids triggers, through the
 * in-process runner on PGlite: migrate prints the store's part (the store door's, since the polling
 * engine never plans the store) and the source's trigger-less script, and asks once for the one
 * database; uninstall finds the table by its mark and removes every column of FacetDB's; doctor
 * says the source polls every 10 seconds with no trigger. A polling source that reads DATABASE_URL,
 * the store's variable, is refused before anything connects.
 */

const ADMIN_URL = "postgres://admin:s3cret-admin-password@localhost:5432/app";
const WORKER_URL = `postgres://${WORKER_ROLE}:s3cret-worker-password@localhost:5432/app`;
/** The store's owner on the same database: the natural setup of a single Postgres. */
const STORE_URL = "postgres://owner:s3cret-owner-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const PROJECT_ID = "listings-app";
const START = 10_000_000;

/** The source as the loader makes it of `database: process.env.LISTINGS_URL, connector: "polling"`. */
function polling(databaseEnv = "LISTINGS_URL"): ProjectConfig {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        connector: "polling",
        table: "listings",
        read: ["title", "description"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
  return {
    ...config,
    sources: config.sources.map((source) => ({ ...source, databaseEnv })),
  };
}

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text, updated_at timestamptz not null default now())",
  );
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  options: {
    readonly config?: ProjectConfig;
    readonly answers?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly engineConnect?: SqlConnect;
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: options.env ?? { DATABASE_URL: STORE_URL },
      loadConfig: () => Promise.resolve(options.config ?? polling()),
      engines: pollingEngines(options.engineConnect ?? world.connect),
      connect: world.connect,
      // Its sleeps end only when moved: each doctor step's 10-second bound waits.
      clock: new SteppedClock(START),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

async function columns(): Promise<string[]> {
  const rows = await world.client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position",
  );
  return rows.map((row) => String(row["column_name"]));
}

async function stateHashMark(): Promise<string | null> {
  const rows = await world.client.query(
    `select col_description('public.listings'::regclass, a.attnum) as mark
       from pg_attribute a where a.attrelid = 'public.listings'::regclass and a.attname = $1`,
    [STATE_HASH_COLUMN],
  );
  const mark = rows[0]?.["mark"];
  return mark === undefined || mark === null ? null : String(mark);
}

const APP_COLUMNS = ["id", "title", "description", "updated_at"];

describe('facetdb migrate with connector: "polling"', () => {
  it("prints the store's part, then the source's trigger-less script, and asks once for the one database", async () => {
    const dry = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(
      dry.stdout.startsWith(`-- store: localhost:5432/app\n${storeScript(storeStepStatements())}`),
    ).toBe(true);
    // The trigger scripts' header and the table's lock, then the pinned column statements.
    const at = dry.stdout.indexOf(
      `-- source listings: localhost:5432/app\n-- facetdb migrate: listings (public.listings)\nbegin;\n\nset local standard_conforming_strings = on;\n\nset local lock_timeout = '10s';\n\nlock table "public"."listings" in share row exclusive mode;\n\nalter table "public"."listings"\n  add column if not exists "is_scam" boolean,`,
    );
    expect(at).toBeGreaterThan(0);
    expect(dry.stdout).toContain(
      "note: FacetDB polls public.listings every 10 seconds by updated_at: the application must set updated_at on every insert and every update, or a change it makes is never noticed\n",
    );
    const source = dry.stdout.slice(at);
    expect(source).toContain(
      `comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:${PROJECT_ID}'`,
    );
    expect(source).not.toMatch(/create trigger|facetdb\.jobs|facetdb\.decisions/);
    expect(dry.stdout + dry.stderr).not.toMatch(/s3cret/);
    expect(await columns()).toEqual(APP_COLUMNS);

    const real = await run(["migrate", "--admin-url", ADMIN_URL], { answers: ["yes"] });
    expect(real.code, real.stderr).toBe(0);
    expect(real.prompts).toEqual([
      "Run the SQL above on localhost:5432/app? Type yes to continue: ",
    ]);
    expect(real.stdout).toContain(
      "Migrated the FacetDB store on localhost:5432/app.\nInstalled on public.listings (source listings).\n",
    );
    expect(await columns()).toEqual([
      ...APP_COLUMNS,
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
      STATE_HASH_COLUMN,
    ]);
    expect(await stateHashMark()).toBe(`facetdb:${PROJECT_ID}`);
    const triggers = await world.client.query(
      "select count(*)::int as n from pg_trigger where not tgisinternal",
    );
    expect(triggers[0]?.["n"]).toBe(0);
  });

  it("names the one database once when the store's string and the admin's differ but reach it alike", async () => {
    // localhost/app and localhost:5432/app read differently and are one database (port 5432).
    const result = await run(
      ["migrate", "--admin-url", "postgres://admin:s3cret-admin-password@localhost/app"],
      { answers: ["yes"] },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual(["Run the SQL above on localhost/app? Type yes to continue: "]);
  });

  it("says, before it asks, when the table has no column to poll by", async () => {
    await world.client.query("alter table public.listings drop column updated_at");
    const dry = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      "note: public.listings has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour;",
    );
  });

  it("refuses one run over a polled table and a table its scheme's engine watches: each runs alone", async () => {
    const [listings] = polling().sources;
    if (listings === undefined) {
      throw new Error("the config has its source");
    }
    const { connector: _polling, ...triggered } = listings;
    const mixed: ProjectConfig = {
      ...polling(),
      sources: [listings, { ...triggered, name: "orders", table: "orders" }],
    };
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], {
      config: mixed,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'error: the sources listings, orders are watched in different ways (some with connector: "polling", some by their scheme\'s own engine), and one run plans with one engine',
    );
    expect(result.stderr).toContain("fix: run the command once per source with --source <name>");
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("refuses, before anything connects, a polling source that reaches the store's database as the store's own login, whichever variable holds it", async () => {
    const noConnection: SqlConnect = (url) => {
      throw new Error(`a connection was opened to ${url}`);
    };
    const migrateWith = (databaseEnv: string) =>
      runInProcess(
        ["migrate", "--dry-run", "--admin-url", ADMIN_URL],
        {
          projectDir: PROJECT_DIR,
          // One login for both: the source's string is DATABASE_URL's.
          env: { DATABASE_URL: WORKER_URL },
          loadConfig: () => Promise.resolve(polling(databaseEnv)),
          engines: pollingEngines(noConnection),
          connect: noConnection,
        },
        COMMANDS,
      );
    // Read from the store's variable, or from a variable of its own that holds the same string:
    // decided by where the strings connect, never by the variable's name.
    for (const databaseEnv of ["DATABASE_URL", "LISTINGS_URL"]) {
      const result = await migrateWith(databaseEnv);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `error: the source "listings" has connector: "polling" and connects to the FacetDB store's database as the store's own login (the one in DATABASE_URL); the polling connector installs the table's columns and none of the store's tables, so the source and the store need two logins`,
      );
      expect(result.stderr).toContain(
        "fix: keep the two credentials apart: set LISTINGS_URL to the worker login's connection string, postgres://facetdb_worker:<a long random password>@<host>/<database>, named with database: env(\"LISTINGS_URL\") in facetdb.config.ts, and keep the store owner's connection string in DATABASE_URL; the same database is fine",
      );
      expect(result.stdout + result.stderr).not.toContain("s3cret");
    }
  });
});

describe('facetdb uninstall with connector: "polling"', () => {
  it("finds the table by its mark, says what goes and what stays, and removes every column of FacetDB's", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const result = await run(["uninstall", "--admin-url", ADMIN_URL], {
      answers: [PROJECT_ID],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([`Type the project name (${PROJECT_ID}) to continue: `]);
    expect(result.stdout).toContain(
      `-- source listings: localhost:5432/app\n-- facetdb uninstall: listings (public.listings)\nbegin;\n\nset local standard_conforming_strings = on;\n\nset local lock_timeout = '10s';\n\nlock table "public"."listings" in share row exclusive mode;\n\ndrop policy if exists`,
    );
    expect(result.stdout).toContain(
      "This removes: from public.listings: 6 FacetDB columns (is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed, facetdb_state_hash), the policies facetdb_reads and facetdb_writes and the facetdb_worker login's rights on it.",
    );
    expect(result.stdout).toContain(
      "This keeps: the decision log of source listings in the FacetDB store (only --purge deletes a log); the rights of the login facetdb_worker on public, because another FacetDB table in the schema may still need it; the facetdb_worker login (uninstall never drops it: every project on the server may share it).",
    );
    expect(result.stdout).toContain("Removed FacetDB from public.listings; kept: ");
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("with --purge, removes the install and then the source's log from the store", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const result = await run(["uninstall", "--purge", "--admin-url", ADMIN_URL], {
      answers: [PROJECT_ID],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("-- store: localhost:5432/app");
    expect(result.stdout).toContain("delete from facetdb.decisions");
    expect(await columns()).toEqual(APP_COLUMNS);
  });
});

describe('facetdb doctor with connector: "polling"', () => {
  /** The worker login's connection: every statement as the worker, on the same engine. */
  const asWorker: SqlConnect = () => ({
    query: async (text, params) => {
      await world.client.query(`set role ${WORKER_ROLE}`);
      try {
        return await world.client.query(text, params);
      } finally {
        await world.client.query("reset role");
      }
    },
    transaction: (work) => world.client.transaction(work),
    pipeline: (text, paramSets) => world.client.pipeline(text, paramSets),
    close: () => Promise.resolve(),
  });

  it("says the source polls every 10 seconds with no trigger, and checks the store in its own group", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    await world.client.query("insert into facetdb.heartbeats (project, at) values ($1, $2)", [
      PROJECT_ID,
      START - 30_000,
    ]);
    const result = await run(["doctor", "--offline"], {
      env: {
        DATABASE_URL: STORE_URL,
        FACETDB_SECRET: "a-long-random-secret-for-doctor-tests",
        TYPESAFE_API_KEY: "a-test-key",
      },
      engineConnect: asWorker,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'source listings:\n      engine: polling, for Postgres (connector: "polling")\nok    database: logged in as facetdb_worker: listings on localhost:5432/app (round trip 0 ms)\nok    pooler:',
    );
    expect(result.stdout).toContain(
      "ok    install: the answer columns and facetdb_state_hash are in place; FacetDB polls public.listings every 10 seconds by updated_at; no trigger\n",
    );
    expect(result.stdout).toContain("store:\nok    store: the FacetDB store on localhost:5432/app");
    expect(result.stdout).toContain(
      "ok    worker heartbeat: the last heartbeat was 30 seconds ago",
    );
  });
});

describe("facetdb migrate with lastChanged on a polled source", () => {
  /** The polled source with `lastChanged` as the config file would say it. */
  function naming(lastChanged: string | false): ProjectConfig {
    const config = polling();
    return {
      ...config,
      sources: config.sources.map((source) => ({ ...source, lastChanged })),
    };
  }

  it("says which column the poll compares, the one lastChanged names", async () => {
    await world.client.query(
      "alter table public.listings add column changed_on timestamptz not null default now()",
    );
    const dry = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], {
      config: naming("changed_on"),
    });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      "note: FacetDB polls public.listings every 10 seconds by changed_on, the column lastChanged names: the application must set changed_on on every insert and every update, or a change it makes is never noticed\n",
    );
  });

  it("with false, says the table is read whole every hour, and warns of nothing", async () => {
    const dry = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], {
      config: naming(false),
    });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      "note: FacetDB reads public.listings whole every hour, as lastChanged: false says, so a change is noticed within the hour;",
    );
    expect(dry.stdout).not.toContain("has no last-changed column");
  });

  it("refuses a column the table lacks before any statement, with the fix", async () => {
    const result = await run(["migrate", "--admin-url", ADMIN_URL], {
      config: naming("nope"),
      answers: ["yes"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "error: public.listings has no column nope, which lastChanged names as the column FacetDB polls by",
    );
    expect(result.stderr).toContain(
      "fix: name a column of public.listings that holds a time, NOT NULL, set by the application on every insert and every update, in lastChanged, or write lastChanged: false to read the whole table every hour on purpose",
    );
    expect(result.prompts).toEqual([]);
    expect(result.stdout).not.toContain('alter table "public"."listings"');
    expect(await columns()).toEqual(APP_COLUMNS);
  });
});
