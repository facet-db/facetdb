import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKER_LIMITS } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import type { SqlConnect } from "@facetdb/postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  loadConfig,
  noul,
  type ProjectConfig,
  planApply,
} from "../../config/index.ts";
import { sharePools } from "../pools.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";
import { STORE_CURRENT } from "./migrate.ts";

/**
 * Adding a source through `facetdb worker`'s own wiring, the Postgres engine on PGlite: the
 * studio's setup routes inspect the tables and a table's rows, preview the draft, plan the install
 * and run it as shown, write facetdb.config.ts and reload the worker, whose own check of the
 * database under the worker login finds the install and starts the new source. The admin connection
 * string's marked parts appear in no answer, no line the worker printed and no file it wrote.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const MARK_USER = "adminMARKuser";
const MARK_PASSWORD = "pwMARK-31f";
const ADMIN = `postgres://${MARK_USER}:${MARK_PASSWORD}@localhost:5432/app`;
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
/**
 * The new source's variable holds the same string as the one the file already names, as a store and
 * a source in one database do: the loader names a variable by its value and reads the file's
 * `process.env.SELLERS_URL` back as LISTINGS_URL, which the reload's match of the install run must
 * see past.
 */
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  LISTINGS_URL: WORKER_URL,
  SELLERS_URL: WORKER_URL,
  TYPESAFE_API_KEY: "ts-test-key",
};
/** What the config file reads when the real loader imports it: the process's own environment. */
const FILE_ENV = { LISTINGS_URL: WORKER_URL, SELLERS_URL: WORKER_URL };

const declared = facetdb({
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
});
/**
 * As the loader reads the file the exporter writes, `database: env("LISTINGS_URL")`: the name is the
 * file's own (`databaseEnvNamed`), so Apply keeps it though SELLERS_URL holds the same string.
 */
const INITIAL: ProjectConfig = {
  ...declared,
  sources: declared.sources.map((source) => ({
    ...source,
    databaseEnv: "LISTINGS_URL",
    databaseEnvNamed: true as const,
  })),
};

/**
 * PGlite is one superuser connection, and the worker's doctor asks to be logged in as the worker
 * login (its first check): a query on the worker login's URL runs as `facetdb_worker`, as the
 * engine's own doctor test does; the admin's URL and the store stay the superuser's. The role is
 * set inside one transaction with the query (PGlite runs a transaction whole, other callers of the
 * connection waiting), so no statement of another caller runs as the worker login by landing
 * between the switch and the query.
 */
function asWorkerLogin(connect: SqlConnect): SqlConnect {
  return (url, options) => {
    const client = connect(url, options);
    if (!url.startsWith("postgres://facetdb_worker:")) {
      return client;
    }
    return {
      ...client,
      query: (text, params) =>
        client.transaction(async (query) => {
          await query("set local role facetdb_worker");
          return query(text, params);
        }),
    };
  };
}

const DRAFT = {
  name: "sellers",
  table: "sellers",
  database: { env: "SELLERS_URL" },
  read: ["bio"],
  storage: "inline",
  questions: {
    is_fake: { type: "noul", instructions: "Is this seller a fake account?", stakes: "high" },
  },
  thresholds: {},
};

let world: PgliteWorld;
let store: Store;
let provider: FakeProvider;
/**
 * A project directory on disk, so the worker's reload loads the file the setup wrote through the
 * real loader (the config imports `facetdb`, found through a link beside it), never a config object
 * the test holds: what the loader makes of the written file is the point.
 */
let scratch: string;
let projectDir: string;
let configPath: string;
const previousEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  world = await createPgliteWorld();
  scratch = await mkdtemp(join(tmpdir(), "facetdb-worker-setup-"));
  projectDir = join(scratch, "listings-app");
  await mkdir(join(projectDir, "node_modules"), { recursive: true });
  await symlink(PACKAGE_DIR, join(projectDir, "node_modules", "facetdb"));
  configPath = join(projectDir, "facetdb.config.ts");
  for (const [name, value] of Object.entries(FILE_ENV)) {
    previousEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(async () => {
  await world.close();
  await rm(scratch, { recursive: true, force: true });
  for (const name of Object.keys(FILE_ENV)) {
    const previous = previousEnv[name];
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  provider = createFakeProvider({ defaults: { noul: 0.02 } });
  await world.client.query("create table public.listings (id text primary key, title text)");
  await world.client.query("create table public.sellers (id serial primary key, bio text)");
  await world.client.query(
    "insert into public.sellers (bio) values ('Selling my old bikes'), ('New here, cash only')",
  );
  const [source] = INITIAL.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet: questionSetOf(INITIAL, source),
      project: projectRef(projectDir),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

describe("adding a source on a running facetdb worker", () => {
  it("inspects, previews, plans and installs through migrate's plan, writes the file, and the reload starts the source", async () => {
    const file = { text: configFileSource(INITIAL), writes: 0 };
    await writeFile(configPath, file.text);
    const applied = planApply(
      { path: "facetdb.config.ts", text: file.text, config: INITIAL },
      { source: DRAFT },
      ENV,
      { variable: "SELLERS_URL" },
    );
    if (!applied.ok) {
      throw new Error(`the draft is valid: ${JSON.stringify(applied.issues)}`);
    }
    // The file on disk: the setup door reads and replaces it there, and the reload loads it from
    // there through the real loader.
    const files: ConfigFiles = {
      read: async () => ({ kind: "file", text: await readFile(configPath, "utf8") }),
      replace: async (_path, text) => {
        await writeFile(configPath, text);
        file.text = text;
        file.writes += 1;
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    const loadFile = async (path: string, options?: { readonly quiet?: boolean }) => {
      const loaded = await loadConfig(path, {
        projectDir,
        env: ENV,
        stderr: { write: () => undefined },
        ...(options?.quiet === undefined ? {} : { quiet: options.quiet }),
      });
      return loaded.config;
    };

    // What `facetdb migrate --dry-run` prints for the same source, the store being another database
    // here (DATABASE_URL names it): run before anything is installed, as the plan is.
    const dry = await runInProcess(
      ["migrate", "--dry-run", "--source", "sellers", "--admin-url", ADMIN],
      {
        projectDir: projectDir,
        env: ENV,
        loadConfig: () => Promise.resolve(applied.plan.config),
        engines: postgresEngines(sharePools(world.connect)),
        connect: sharePools(world.connect),
      },
      COMMANDS,
    );
    expect(dry.code, dry.stderr).toBe(0);

    const stop = new AbortController();
    const answers: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const texts: string[] = [];
    const connect = sharePools(world.connect);
    // The loops run on a clock the test steps: a poll per step, nothing spinning meanwhile.
    const clock = new SteppedClock(1_700_000_000_000);
    // The surface's handler, once the worker serves: the requests are made from here while the
    // worker runs its loops, as a browser would, so the started source is seen answering.
    let handle: HttpHandler | undefined;
    const run = runInProcess(
      ["worker"],
      {
        projectDir: projectDir,
        env: ENV,
        osUser: () => "alex",
        loadConfig: loadFile,
        configFiles: files,
        engines: postgresEngines(asWorkerLogin(connect)),
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        clock,
        random: () => 0.5,
        stopSignal: () => stop.signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        serve: (handler, port) => {
          handle = handler;
          return Promise.resolve({ port, close: () => Promise.resolve() });
        },
      },
      COMMANDS,
    );
    const ask = async (name: string, path: string, body?: unknown) => {
      if (handle === undefined) {
        throw new Error("the worker does not serve yet");
      }
      const response = await handle(
        new Request(`http://127.0.0.1:4040/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        THIS_MACHINE,
      );
      const text = await response.text();
      texts.push(text);
      answers[name] = {
        status: response.status,
        body: JSON.parse(text) as Record<string, unknown>,
      };
      return answers[name];
    };
    await vi.waitFor(() => expect(handle).toBeDefined(), { timeout: 10_000 });
    await ask("access", "sources/setup");
    await ask("tables", "sources/inspect", { admin: ADMIN });
    await ask("table", "sources/inspect", { admin: ADMIN, table: "sellers" });
    await ask("preview", "sources/preview", { admin: ADMIN, source: DRAFT });
    const plan = await ask("plan", "sources/plan", { admin: ADMIN, source: DRAFT });
    answers["writesAfterPlan"] = { status: file.writes, body: {} };
    await ask("reviewBefore", "review/queue?source=sellers");
    await ask("install", "sources/install", {
      admin: ADMIN,
      source: DRAFT,
      token: plan.body["token"],
    });
    // The Review page opens a card of the new source without a restart.
    await ask("reviewAfter", "review/queue?source=sellers");
    // The started source answers a change at once, with no restart.
    const asked = provider.callCount;
    await world.client.query("insert into public.sellers (bio) values ('Gift cards only, DM me')");
    await vi.waitFor(
      async () => {
        // A poll per look, so the answer does not hang on NOTIFY reaching the loop's LISTEN.
        clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
        const rows = await world.client.query(
          "select facetdb_status::text as status from public.sellers where bio = 'Gift cards only, DM me'",
        );
        expect(rows[0]?.["status"]).toBe("done");
      },
      { timeout: 10_000 },
    );
    expect(provider.callCount).toBe(asked + 1);
    stop.abort();
    const result = await run;

    expect(result.code, result.stderr).toBe(0);
    expect(answers["access"]).toEqual({ status: 200, body: { open: true } });
    expect(answers["tables"]?.body["tables"]).toEqual(["listings", "sellers"]);
    expect(answers["table"]).toMatchObject({
      status: 200,
      body: {
        database: "Postgres",
        table: {
          name: "sellers",
          key: "id",
          columns: [
            { name: "id", type: "integer" },
            { name: "bio", type: "text" },
          ],
          rows: [
            { id: "2", bio: "New here, cash only" },
            { id: "1", bio: "Selling my old bikes" },
          ],
        },
      },
    });
    expect(answers["preview"]).toMatchObject({ status: 200, body: { decided: 2, review: 0 } });
    expect(answers["plan"]).toMatchObject({
      status: 200,
      body: {
        table: "public.sellers",
        transactional: true,
        backfill: { records: 2, command: "facetdb backfill --source sellers" },
      },
    });
    const sql = String(answers["plan"]?.body["sql"]);
    expect(sql.startsWith("-- facetdb migrate: sellers (public.sellers)\nbegin;\n")).toBe(true);
    // Byte for byte the source's part of the dry run: above it, migrate prints the store's part
    // (current, so nothing to run) and the line naming the source's database by its host, which
    // the page leaves out and says so (storeElsewhere).
    expect(answers["plan"]?.body["storeElsewhere"]).toBe(true);
    // Below it, the lock list, which the page does not show: the store is current, so only the
    // install's lock on the table.
    const tail = `Locks (each waits at most 10 s for the table; new queries queue behind it meanwhile; then migrate stops and changes nothing):\n  install of sellers, public.sellers: blocks reads and writes until the install ends; no rows\nDry run: nothing was changed.\n`;
    expect(dry.stdout.endsWith(`${sql}${tail}`)).toBe(true);
    const above = dry.stdout.slice(0, dry.stdout.length - sql.length - tail.length);
    expect(above.split("\n")).toEqual([
      expect.stringMatching(/^-- store: /),
      STORE_CURRENT,
      expect.stringMatching(/^-- source sellers: /),
      "",
    ]);
    expect(sql).toContain('"is_fake"');
    // Nothing was written by the plan; the install wrote the file once, then ran the script.
    expect(answers["writesAfterPlan"].status).toBe(0);
    expect(answers["install"]).toMatchObject({
      status: 200,
      body: {
        installed: true,
        table: "public.sellers",
        reload: {
          loaded: true,
          sources: expect.arrayContaining([
            {
              source: "sellers",
              outcome: "started",
              version: 1,
              message: expect.any(String),
            },
          ]),
        },
      },
    });
    expect(result.stdout).toContain(
      "sellers: its install is in its database and the worker login may write its columns, so it started: it answers every change from now on with version 1.",
    );
    // Unknown to the review endpoints before the install, a source of theirs right after.
    expect(answers["reviewBefore"]).toMatchObject({
      body: { error: { code: "unknown_source" } },
    });
    expect(answers["reviewAfter"]).toMatchObject({ status: 200, body: { count: 0, cards: [] } });
    expect(file.writes).toBe(1);
    expect(file.text).toBe(configFileSource(applied.plan.config));
    expect(file.text).toContain('database: env("SELLERS_URL")');
    expect(await readFile(configPath, "utf8")).toBe(file.text);
    const columns = await world.client.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sellers' order by ordinal_position",
    );
    expect(columns.map((row) => row["column_name"])).toEqual(
      expect.arrayContaining(["is_fake", "is_fake_probability", "facetdb_status"]),
    );
    for (const text of [...texts, result.stdout, result.stderr, file.text]) {
      for (const mark of [ADMIN, MARK_USER, MARK_PASSWORD]) {
        expect(text).not.toContain(mark);
      }
    }
  });

  describe("a source the file names whose install never ran", () => {
    function configWithSellers(): ProjectConfig {
      const applied = planApply(
        { path: "facetdb.config.ts", text: configFileSource(INITIAL), config: INITIAL },
        { source: DRAFT },
        ENV,
        { variable: "SELLERS_URL" },
      );
      if (!applied.ok) {
        throw new Error("the draft is valid");
      }
      return applied.plan.config;
    }

    function once(config: ProjectConfig) {
      const connect = sharePools(world.connect);
      return runInProcess(
        ["worker", "--once", "--no-http"],
        {
          projectDir: projectDir,
          env: ENV,
          osUser: () => "alex",
          loadConfig: () => Promise.resolve(config),
          engines: postgresEngines(connect),
          connect,
          store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
          provider: () => provider,
          clock: new FakeClock(1_700_000_000_000),
          random: () => 0.5,
          stopSignal: () => new AbortController().signal,
          webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        },
        COMMANDS,
      );
    }

    it("leaves the start as it was: beside an installed source, the worker runs both and asks nothing of it", async () => {
      await world.client.query("insert into public.listings (id, title) values ('r1', 'A bike')");
      const result = await once(configWithSellers());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("listings: answered r1");
      expect(result.stdout).toContain("sellers: answered 0, already answered 0, failed 0");
    });

    it("names the source, and how to see what is missing, when a table or column it uses is not there", async () => {
      // A database where nothing is installed yet: the claim finds no jobs table.
      await world.client.query("drop table facetdb.jobs cascade");
      const config = configWithSellers();
      const result = await once({
        ...config,
        sources: config.sources.filter((source) => source.name === "sellers"),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'error: the source "sellers" stopped: a table or a column it uses is not there (relation "facetdb.jobs" does not exist)\n',
      );
      expect(result.stderr).toContain(
        'fix: run facetdb migrate --source sellers --dry-run on this machine to see what the install is missing, then facetdb migrate --source sellers; or, if a column of your own table was renamed or dropped, change read or where for "sellers" in facetdb.config.ts\n',
      );
      expect(provider.callCount).toBe(0);
    });
  });
});
