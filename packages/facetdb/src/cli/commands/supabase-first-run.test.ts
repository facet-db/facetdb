import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig, sourceCall } from "../../config/index.ts";
import { docsLink, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  postgresEngines,
  readingDatabaseUrl,
  resetPgliteWorld,
  type SqlConnect,
  SteppedClock,
  storeScript,
  storeStepStatements,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * The stops met on a first Supabase run, each with its fix in the words a user reads. Migrate says
 * whether it created the worker login or found it and kept its password, and gives the admin's
 * statement for a new one; doctor's fix for a refused worker password says the same, and on
 * Supabase's pooler that it may refuse a new password for a few minutes. A table another project
 * owns names this project's folder and the rename that mends a copy. A project whose sources read
 * no table gets the store's step alone, shown and confirmed. No line holds a password or a
 * connection string.
 */

const ADMIN_PASSWORD = "s3cret-admin-password";
const WORKER_PASSWORD = "s3cret-worker-password";
const STORE_PASSWORD = "s3cret-store-password";
const ADMIN_URL = `postgres://admin:${ADMIN_PASSWORD}@localhost:5432/app`;
const WORKER_URL = `postgres://facetdb_worker:${WORKER_PASSWORD}@localhost:5432/app`;
const STORE_URL = `postgres://postgres:${STORE_PASSWORD}@localhost:5432/facetdb`;
const SECRETS = [ADMIN_PASSWORD, WORKER_PASSWORD, STORE_PASSWORD, TEST_SECRET];

/** A project's name is its folder's, the last part of the path, never the path itself. */
const PROJECT_DIR = "/home/maya/work/listings-app";

const listings: ProjectConfig = readingDatabaseUrl(
  facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  }),
);

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

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await world.client.query("create table public.listings (id text primary key, title text)");
});

afterEach(async () => {
  await resetPgliteWorld(world);
  // The worker login is the server's, not the database's: a reset keeps it.
  await world.client.query("drop owned by facetdb_worker cascade").catch(() => undefined);
  await world.client.query("drop role if exists facetdb_worker");
});

function run(
  argv: readonly string[],
  options: {
    readonly config?: ProjectConfig;
    readonly projectDir?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly answers?: readonly string[];
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: options.projectDir ?? PROJECT_DIR,
      env: options.env ?? { FACETDB_SECRET: TEST_SECRET },
      loadConfig: () => Promise.resolve(options.config ?? listings),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

/** Text as a regular expression that matches it literally. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/postgres:\/\/[^\s<]*@/);
}

/** The worker login's stored verifier: what a password change would change. */
async function workerVerifier(): Promise<unknown> {
  const rows = await world.client.query(
    "select rolpassword from pg_catalog.pg_authid where rolname = 'facetdb_worker'",
  );
  return rows[0]?.["rolpassword"];
}

describe("migrate says what it did with the worker login (supabase-first-run)", () => {
  it("creates the login on the first install, then finds it, keeps its password and gives the admin's statement", async () => {
    const first = await run(["migrate", "--yes", "--admin-url", ADMIN_URL]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.slice(first.stdout.indexOf("Migrated the FacetDB store"))).toBe(
      "Migrated the FacetDB store on localhost:5432/app.\nInstalled on public.listings (source listings).\nCreated the worker login facetdb_worker with the password in DATABASE_URL.\n",
    );
    const created = await workerVerifier();
    expect(created).toMatch(/^SCRAM-SHA-256\$/);

    // The same config with another password in DATABASE_URL: the login is found and left alone.
    const moved = readingDatabaseUrl(
      facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "listings",
            database: WORKER_URL.replace(WORKER_PASSWORD, `${WORKER_PASSWORD}-new`),
            table: "listings",
            read: ["title"],
            questions: { is_scam: noul("Is this listing a scam?") },
          },
        ],
      }),
    );
    const again = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], { config: moved });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.slice(again.stdout.indexOf("The FacetDB store on"))).toBe(
      "The FacetDB store on localhost:5432/app was current: nothing ran there.\nInstalled on public.listings (source listings).\nFound the worker login facetdb_worker and kept its password. If DATABASE_URL has another one, run this as the admin: alter role facetdb_worker password '<the password in DATABASE_URL>';\n",
    );
    expect(await workerVerifier()).toBe(created);
    for (const result of [first, again]) {
      expectNoSecret(result.stdout + result.stderr);
      expect(result.stdout + result.stderr).not.toContain(`${WORKER_PASSWORD}-new`);
    }
  });

  it("says nothing of the login on a dry run, where nothing ran", async () => {
    const dry = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).not.toMatch(/^(Created|Found) the worker login/m);
    expect(await workerVerifier()).toBeUndefined();
  });
});

describe("a table another project owns names this project's folder (supabase-first-run)", () => {
  it("says the project is named after its folder and that a copy is renamed back to the owner's name", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const before = await world.client.query(
      "select project_id from facetdb.table_owners where table_name = 'listings'",
    );

    const copy = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], {
      projectDir: "/home/maya/work/listings-copy",
    });
    expect(copy.code).toBe(1);
    expect(copy.stderr).toBe(
      `error: public.listings already carries FacetDB columns from another project (listings-app); one table belongs to one project. Uninstall there first, or point this project at another table.\nfix: this project is named after its folder (listings-copy): if it is listings-app under another folder name, rename the folder back to listings-app and run facetdb migrate again\nsee: ${docsLink("migrate-refused")}\n`,
    );
    // The folders by name alone: the path the user never wrote is not in the words.
    expect(copy.stdout + copy.stderr).not.toContain("/home/maya");
    expectNoSecret(copy.stdout + copy.stderr);
    expect(
      await world.client.query(
        "select project_id from facetdb.table_owners where table_name = 'listings'",
      ),
    ).toEqual(before);
  });
});

describe("a project whose sources read no table migrates the store alone (supabase-first-run)", () => {
  const storeEnv = { DATABASE_URL: STORE_URL, FACETDB_SECRET: TEST_SECRET, GITHUB_TOKEN: "ghp_x" };

  it("shows the store's step, runs it once confirmed, and a second run finds the store current", async () => {
    const dry = await run(["migrate", "--dry-run"], { config: triage, env: storeEnv });
    expect(dry.code, dry.stderr).toBe(0);
    // The store's step, then what it locks: a fresh store's tables, all new.
    expect(dry.stdout).toMatch(
      new RegExp(
        `^${escapeRegExp(`-- store: localhost:5432/facetdb\n${storeScript(storeStepStatements())}`)}Locks \\(.+\\):\n {2}store step: creates \\d+ tables in facetdb\nDry run: nothing was changed\\.\n$`,
      ),
    );
    expect(dry.prompts).toEqual([]);
    expect(
      await world.client.query("select 1 from pg_namespace where nspname = 'facetdb'"),
    ).toEqual([]);

    const first = await run(["migrate"], { config: triage, env: storeEnv, answers: ["yes"] });
    expect(first.code, first.stderr).toBe(0);
    // No admin connection string is asked for: no source's database is touched.
    expect(first.prompts).toEqual([
      "Run the SQL above on localhost:5432/facetdb? Type yes to continue: ",
    ]);
    expect(first.stdout.slice(first.stdout.indexOf("Migrated"))).toBe(
      "Migrated the FacetDB store on localhost:5432/facetdb.\n",
    );
    expect(first.stderr).toBe("");
    const versions = await world.client.query(
      "select count(*)::int as n from facetdb.store_migrations",
    );
    expect(versions[0]?.["n"]).toBeGreaterThan(0);

    const second = await run(["migrate"], { config: triage, env: storeEnv });
    expect(second.code, second.stderr).toBe(0);
    expect(second.prompts).toEqual([]);
    expect(second.stdout).toBe(
      "-- store: localhost:5432/facetdb\n-- the FacetDB store is current: nothing to run there\nThe FacetDB store on localhost:5432/facetdb was current: nothing ran there.\n",
    );
    const json = await run(["migrate", "--json"], { config: triage, env: storeEnv });
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      dryRun: false,
      store: {
        database: "localhost:5432/facetdb",
        current: true,
        sql: "",
        applied: false,
        locks: { listed: [] },
      },
      sources: [],
    });
    for (const result of [dry, first, second, json]) {
      expectNoSecret(result.stdout + result.stderr);
    }
  });

  it("runs nothing when the store's step is not confirmed", async () => {
    const result = await run(["migrate"], { config: triage, env: storeEnv, answers: ["no"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `error: the SQL was not confirmed, so nothing was run\nfix: run facetdb migrate again and type yes, or pass --yes once you have read the SQL\nsee: ${docsLink("not-confirmed")}\n`,
    );
    expect(
      await world.client.query("select 1 from pg_namespace where nspname = 'facetdb'"),
    ).toEqual([]);
  });

  it("refuses with no DATABASE_URL, before anything connects", async () => {
    const result = await run(["migrate", "--yes"], {
      config: triage,
      env: { FACETDB_SECRET: TEST_SECRET },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `error: DATABASE_URL is not set, so FacetDB has no database for its store\nfix: set DATABASE_URL to the connection string of the database FacetDB keeps its store in\nsee: ${docsLink("database-url")}\n`,
    );
  });
});

describe("doctor's fix for a refused worker password (supabase-first-run)", () => {
  /** What postgres.js throws when the server refuses the password: its code, the user quoted. */
  const refused = (user: string) =>
    Object.assign(new Error(`password authentication failed for user "${user}"`), {
      code: "28P01",
    });

  /** A driver whose every connection is refused, as a server with another password refuses it. */
  const refusing =
    (user: string): SqlConnect =>
    () => ({
      query: () => Promise.reject(refused(user)),
      transaction: () => Promise.reject(refused(user)),
      pipeline: () => Promise.reject(refused(user)),
      close: () => Promise.resolve(),
    });

  function doctor(url: string, user: string) {
    const connect = refusing(user);
    return runInProcess(
      ["doctor", "--offline"],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: url, FACETDB_SECRET: TEST_SECRET },
        loadConfig: () =>
          Promise.resolve(
            readingDatabaseUrl(
              facetdb({
                model: "jev-1.14.0",
                sources: [
                  {
                    name: "listings",
                    database: url,
                    table: "listings",
                    read: ["title"],
                    questions: { is_scam: noul("Is this listing a scam?") },
                  },
                ],
              }),
            ),
          ),
        engines: postgresEngines(connect),
        connect,
        clock: new SteppedClock(1_700_000_000_000),
      },
      COMMANDS,
    );
  }

  const databaseLine = (stdout: string) =>
    stdout.split("\n").find((line) => line.slice(6).startsWith("database:"));

  it("on Supabase's pooler: the admin's statement, and that the pooler may refuse a new password for a few minutes", async () => {
    const host = "aws-0-eu-central-1.pooler.supabase.com:5432";
    const url = `postgres://facetdb_worker.abcdefgh:${WORKER_PASSWORD}@${host}/postgres?sslmode=require`;
    const result = await doctor(url, "facetdb_worker.abcdefgh");
    expect(result.code).toBe(1);
    expect(databaseLine(result.stdout)).toBe(
      `FAIL  database: "listings" cannot connect to ${host}/postgres: password authentication failed for user "facetdb_worker.abcdefgh" Fix: facetdb migrate keeps the password of a worker login it finds; if DATABASE_URL has another one, run this as the admin: alter role facetdb_worker password '<the password in DATABASE_URL>' (Supabase's pooler may refuse the new password for a few minutes after that). See ${docsLink("doctor-database")}`,
    );
    expectNoSecret(result.stdout + result.stderr);
  });

  it("on a direct connection: the admin's statement alone", async () => {
    const host = "db.abcdefgh.supabase.co:5432";
    const url = `postgres://facetdb_worker:${WORKER_PASSWORD}@${host}/postgres?sslmode=require`;
    const result = await doctor(url, "facetdb_worker");
    expect(databaseLine(result.stdout)).toBe(
      `FAIL  database: "listings" cannot connect to ${host}/postgres: password authentication failed for user "facetdb_worker" Fix: facetdb migrate keeps the password of a worker login it finds; if DATABASE_URL has another one, run this as the admin: alter role facetdb_worker password '<the password in DATABASE_URL>'. See ${docsLink("doctor-database")}`,
    );
    expectNoSecret(result.stdout + result.stderr);
  });

  it("keeps the general fix for a refused login that is not the worker's", async () => {
    const host = "db.abcdefgh.supabase.co:5432";
    const url = `postgres://postgres:${STORE_PASSWORD}@${host}/postgres?sslmode=require`;
    const result = await doctor(url, "postgres");
    expect(databaseLine(result.stdout)).toBe(
      `FAIL  database: "listings" cannot connect to ${host}/postgres: password authentication failed for user "postgres" Fix: check the host, port, user and password in DATABASE_URL, and that the database accepts connections from this machine (a firewall or an allow-list). See ${docsLink("doctor-database")}`,
    );
  });
});
