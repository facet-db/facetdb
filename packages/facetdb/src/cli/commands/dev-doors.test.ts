import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { DEFAULT_WORKER_LIMITS } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  loadConfig,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import {
  type EmbeddedDatabases,
  type HttpHandler,
  runInProcess,
  type Workspace,
} from "../program.ts";
import { freshPglite, pgliteClient, resetPglite, SteppedClock } from "../testing.ts";
import { DEV_URL } from "./dev.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb dev` with its doors, on the embedded database and the in-process surface as
 * worker-setup.test.ts drives it: `--seed` runs a SQL file into the dev database and the seeded
 * rows are answered, the ones whose text holds the marker word left for review; the setup flow
 * inspects, plans and installs through dev's door with dev's address as the admin connection
 * string, and the reload starts the source with no restart; Apply is offered; another admin string
 * is refused in words naming the one to use; a seed whose statement fails keeps nothing. The config
 * file is on disk in a project directory and loads through the real loader, since what the file
 * reads from DATABASE_URL is the point.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ANOTHER_ADMIN = "postgres://adminMARK:pwMARK@db.example.com:5432/app?sslmode=require";

const SEED = `-- Five listings: three honest, two written like the scams of the example's seed.
create table if not exists public.listings (
  id serial primary key,
  title text not null,
  description text
);

insert into public.listings (title, description) values
  ('Oak table', 'Collection only; happy to show it before you pay'),
  ('Trek bike #2', 'Good condition, a few scratches'),
  ('Studio to rent', 'Viewings by appointment'),
  ('VW Golf', 'URGENT. Owner abroad, pay the deposit by gift card today'),
  ('Room in a shared house', 'Urgent: deposit by crypto, contact only on WhatsApp');

create table if not exists public.sellers (id serial primary key, bio text);
insert into public.sellers (bio) values ('Selling my old bikes'), ('New here, cash only');
`;

const BAD_SEED = "create table public.t (id int primary key);\ninsert into nope values (1);\n";

const declared = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: DEV_URL,
      table: "listings",
      read: ["title", "description"],
      questions: { is_scam: noul("Is this listing a scam?", { stakes: "high" }) },
    },
  ],
});
/** The project as the loader reads `database: process.env.DATABASE_URL` under dev. */
const INITIAL: ProjectConfig = {
  ...declared,
  sources: declared.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
};

const DRAFT = {
  name: "sellers",
  table: "sellers",
  database: { env: "DATABASE_URL" },
  read: ["bio"],
  storage: "inline",
  questions: {
    is_fake: { type: "noul", instructions: "Is this seller a fake account?", stakes: "high" },
  },
  thresholds: {},
};

/** One engine for the file, emptied after every test. */
let engine: PGlite;
let scratch: string;
let projectDir: string;
let configPath: string;
let devDir: string;
/** What the process held in DATABASE_URL before dev set it, put back after the file. */
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  engine = await freshPglite();
  scratch = await mkdtemp(join(tmpdir(), "facetdb-dev-doors-"));
  projectDir = join(scratch, "listings-app");
  await mkdir(join(projectDir, "node_modules"), { recursive: true });
  await symlink(PACKAGE_DIR, join(projectDir, "node_modules", "facetdb"));
  configPath = join(projectDir, "facetdb.config.ts");
  devDir = join(projectDir, ".facetdb", "dev");
  previousDatabaseUrl = process.env["DATABASE_URL"];
});

afterAll(async () => {
  await engine.close();
  await rm(scratch, { recursive: true, force: true });
  if (previousDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = previousDatabaseUrl;
  }
});

/** The directory's database, kept across the command's opens and closes, as a disk would. */
class KeptDatabases implements EmbeddedDatabases {
  async open(dir: string) {
    if (dir !== devDir) {
      throw new Error(`dev opened ${dir}, not ${devDir}`);
    }
    return { pglite: engine, close: () => Promise.resolve() };
  }

  async wipe() {
    await resetPglite(engine);
  }

  /** The test's own door into the database, as `psql` would be. */
  query(sql: string) {
    return pgliteClient(engine).query(sql);
  }
}

/** The files `--seed` may name, read as the workspace reads a file; nothing else is a file here. */
function seedFiles(files: Readonly<Record<string, string>>): Workspace {
  const missing = () => {
    throw new Error("dev reaches the workspace for the seed file alone");
  };
  return {
    exists: missing,
    write: missing,
    writeParts: missing,
    hasClaudeCommand: missing,
    peek: (path) => {
      const text = files[path];
      return Promise.resolve(
        text === undefined
          ? { kind: "none" as const }
          : { kind: "file" as const, firstLine: text.split("\n")[0] ?? "" },
      );
    },
    async *lines(path) {
      for (const line of (files[path] ?? "").split("\n")) {
        yield line;
      }
    },
  };
}

let embedded: KeptDatabases;
/** The run's environment: dev sets DATABASE_URL in it and in the process, as main.ts's one object does. */
let env: Record<string, string | undefined>;
const file = { writes: 0 };

beforeEach(async () => {
  embedded = new KeptDatabases();
  env = {};
  file.writes = 0;
  await writeFile(configPath, configFileSource(INITIAL));
});

afterEach(async () => {
  await resetPglite(engine);
});

function devDeps(files: Readonly<Record<string, string>>) {
  const configFiles: ConfigFiles = {
    read: async () => ({ kind: "file", text: await readFile(configPath, "utf8") }),
    replace: async (_path, text) => {
      await writeFile(configPath, text);
      file.writes += 1;
    },
    gitState: () => Promise.resolve({ kind: "clean" }),
  };
  return {
    projectDir,
    env,
    setEnv: (name: string, value: string) => {
      env[name] = value;
      process.env[name] = value;
    },
    osUser: () => "alex",
    loadConfig: async (path: string, options?: { readonly quiet?: boolean }) =>
      (
        await loadConfig(path, {
          projectDir,
          env,
          stderr: { write: () => undefined },
          ...(options?.quiet === undefined ? {} : { quiet: options.quiet }),
        })
      ).config,
    configFiles,
    workspace: seedFiles(files),
    connect: () => {
      throw new Error("dev connected to a database outside the embedded one");
    },
    provider: () => {
      throw new Error("dev built the real model provider without --model-url");
    },
    random: () => 0.5,
    webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
    embedded,
  };
}

async function listings() {
  return embedded.query(
    "select title, facetdb_status::text as status, is_scam from public.listings order by id",
  );
}

describe("facetdb dev --seed", () => {
  it("runs the file into the dev database, queues its rows, and leaves the marked ones for review", async () => {
    const result = await runInProcess(
      ["dev", "--seed", "seed.sql", "--once", "--no-http"],
      { ...devDeps({ "seed.sql": SEED }), clock: new SteppedClock(1_700_000_000_000) },
      COMMANDS,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("seed.sql: public.listings now holds 5 rows.");
    expect(result.stdout).toContain("seed.sql: public.sellers now holds 2 rows.");
    expect(result.stdout).toContain("Installed listings on public.listings in .facetdb/dev/.");
    expect(result.stdout).toContain("Queued the 5 rows of public.listings for answering.");
    expect(result.stdout).toContain(
      "a record whose text holds URGENT is answered unsure (50%) on every yes-or-no question and waits for review",
    );
    expect(result.stdout).toContain("listings: answered 5, already answered 0, failed 0");
    expect(result.stdout).toContain(
      `DATABASE_URL holds ${DEV_URL} for this run, so facetdb.config.ts reads the embedded database.`,
    );
    expect(await listings()).toEqual([
      { title: "Oak table", status: "done", is_scam: false },
      { title: "Trek bike #2", status: "done", is_scam: false },
      { title: "Studio to rent", status: "done", is_scam: false },
      { title: "VW Golf", status: "needs_review", is_scam: null },
      { title: "Room in a shared house", status: "needs_review", is_scam: null },
    ]);
    // Dev's address is the file's and the loader's for the run.
    expect(env["DATABASE_URL"]).toBe(DEV_URL);
    expect(process.env["DATABASE_URL"]).toBe(DEV_URL);
  });

  it("takes the marker from --unsure", async () => {
    const result = await runInProcess(
      ["dev", "--seed", "seed.sql", "--unsure", "crypto", "--once", "--no-http"],
      { ...devDeps({ "seed.sql": SEED }), clock: new SteppedClock(1_700_000_000_000) },
      COMMANDS,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("a record whose text holds crypto is answered unsure");
    expect((await listings()).map((row) => row["status"])).toEqual([
      "done",
      "done",
      "done",
      "done",
      "needs_review",
    ]);
  });

  it("keeps nothing when a statement fails, and names it with the database's words", async () => {
    const result = await runInProcess(
      ["dev", "--seed", "bad.sql", "--once", "--no-http"],
      { ...devDeps({ "bad.sql": BAD_SEED }), clock: new SteppedClock(1_700_000_000_000) },
      COMMANDS,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'error: statement 2 of bad.sql (insert into nope values (1)) failed: relation "nope" does not exist; the transaction was rolled back, so nothing was seeded\n',
    );
    expect(result.stderr).toContain(
      "fix: fix that statement in bad.sql, then run facetdb dev --seed bad.sql again, or pass --reset to start from an empty database\n",
    );
    expect(await embedded.query("select to_regclass('public.t') as t")).toEqual([{ t: null }]);
  });

  it("refuses a file that is not there as a bad invocation", async () => {
    const result = await runInProcess(
      ["dev", "--seed", "missing.sql", "--once", "--no-http"],
      { ...devDeps({}), clock: new SteppedClock(1_700_000_000_000) },
      COMMANDS,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("error: --seed names missing.sql, and there is no such file\n");
  });
});

describe("the studio's doors under facetdb dev", () => {
  it("adds a source through the setup flow with dev's address, starts it on the reload, offers Apply, and refuses another connection string", async () => {
    const stop = new AbortController();
    const answers: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const texts: string[] = [];
    const clock = new SteppedClock(1_700_000_000_000);
    let handle: HttpHandler | undefined;
    const run = runInProcess(
      ["dev", "--seed", "seed.sql"],
      {
        ...devDeps({ "seed.sql": SEED }),
        clock,
        stopSignal: () => stop.signal,
        serve: (handler, port) => {
          handle = handler;
          return Promise.resolve({ port, close: () => Promise.resolve() });
        },
      },
      COMMANDS,
    );
    const ask = async (name: string, path: string, body?: unknown) => {
      if (handle === undefined) {
        throw new Error("dev does not serve yet");
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
    /** A look at the database per poll of the clock, until `expectation` holds. */
    const settle = (expectation: () => Promise<void>) =>
      vi.waitFor(
        async () => {
          clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
          await expectation();
        },
        { timeout: 15_000 },
      );
    await vi.waitFor(() => expect(handle).toBeDefined(), { timeout: 15_000 });
    // The seeded listings are answered from the worker's own queue, the two marked ones for review.
    await settle(async () => {
      expect((await listings()).map((row) => row["status"])).toEqual([
        "done",
        "done",
        "done",
        "needs_review",
        "needs_review",
      ]);
    });
    await ask("cards", "review/queue?source=listings");
    await ask("access", "sources/setup");
    await ask("another", "sources/inspect", { admin: ANOTHER_ADMIN });
    await ask("tables", "sources/inspect", { admin: DEV_URL });
    await ask("table", "sources/inspect", { admin: DEV_URL, table: "sellers" });
    const plan = await ask("plan", "sources/plan", { admin: DEV_URL, source: DRAFT });
    await ask("install", "sources/install", {
      admin: DEV_URL,
      source: DRAFT,
      token: plan.body["token"],
    });
    // The started source answers a change at once, with no restart; the marked one waits for review.
    await embedded.query(
      "insert into public.sellers (bio) values ('URGENT: gift cards only, DM me')",
    );
    await settle(async () => {
      const rows = await embedded.query(
        "select facetdb_status::text as status from public.sellers where bio like 'URGENT%'",
      );
      expect(rows[0]?.["status"]).toBe("needs_review");
    });
    await ask("sellerCards", "review/queue?source=sellers");
    await ask("apply", "apply", {
      source: {
        ...DRAFT,
        questions: {
          is_fake: {
            type: "noul",
            instructions: "Is this seller a fake or a bot?",
            stakes: "high",
          },
        },
      },
    });
    await ask("config", "config");
    stop.abort();
    const result = await run;

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Add a source in the studio with the connection string ${DEV_URL}.`,
    );
    expect(answers["cards"]).toMatchObject({ status: 200, body: { count: 2 } });
    expect(answers["access"]).toEqual({ status: 200, body: { open: true } });
    // Another connection string: refused in words naming dev's address, the string in none of them.
    expect(answers["another"]).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "dev-address",
          message: `facetdb dev reaches its embedded database alone, under the connection string ${DEV_URL}, and this connection string is another; nothing was connected`,
          fix: expect.stringContaining(`paste ${DEV_URL} as the connection string`),
        },
      },
    });
    expect(answers["tables"]).toMatchObject({
      status: 200,
      body: {
        database: "PGlite",
        tables: ["listings", "sellers"],
        sharedWith: { source: "listings", variable: "DATABASE_URL" },
      },
    });
    expect(answers["table"]).toMatchObject({
      status: 200,
      body: { table: { name: "sellers", key: "id", rows: [{ id: "2" }, { id: "1" }] } },
    });
    expect(answers["plan"]).toMatchObject({
      status: 200,
      body: { table: "public.sellers", transactional: true, storeElsewhere: false },
    });
    expect(String(answers["plan"]?.body["sql"])).toContain('"is_fake"');
    expect(answers["install"]).toMatchObject({
      status: 200,
      body: {
        installed: true,
        table: "public.sellers",
        reload: {
          loaded: true,
          sources: expect.arrayContaining([
            { source: "sellers", outcome: "started", version: 1, message: expect.any(String) },
          ]),
        },
      },
    });
    expect(result.stdout).toContain(
      "sellers: its install is in its database and the worker login may write its columns, so it started",
    );
    expect(answers["sellerCards"]).toMatchObject({
      status: 200,
      body: { count: 1, cards: [{ source: "sellers", open: [{ name: "is_fake", figure: 0.5 }] }] },
    });
    // Apply stands: the diff of a wording change, nothing written by the look.
    expect(answers["apply"]).toMatchObject({
      status: 200,
      body: { written: false, changed: true, path: "facetdb.config.ts" },
    });
    expect(answers["config"]).toMatchObject({
      status: 200,
      body: {
        sources: [
          { name: "listings", database: { env: "DATABASE_URL" } },
          { name: "sellers", database: { env: "DATABASE_URL" } },
        ],
      },
    });
    // The install wrote the file once, reading the new source from the one address, as every file does.
    expect(file.writes).toBe(1);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain('name: "sellers"');
    expect(written.split("process.env.DATABASE_URL")).toHaveLength(3);
    for (const text of [...texts, result.stdout, result.stderr, written]) {
      expect(text).not.toContain("MARK");
    }
  }, 60_000);
});

/** Dev serving the surface, with the seed: `ask` as a browser on this machine, `stop` for the run. */
async function served(
  argv: readonly string[],
  extra: Partial<Parameters<typeof runInProcess>[1]> = {},
) {
  const stop = new AbortController();
  let handle: HttpHandler | undefined;
  const run = runInProcess(
    argv,
    {
      ...devDeps({ "seed.sql": SEED }),
      clock: new SteppedClock(1_700_000_000_000),
      stopSignal: () => stop.signal,
      serve: (handler, port) => {
        handle = handler;
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      ...extra,
    },
    COMMANDS,
  );
  await vi.waitFor(() => expect(handle).toBeDefined(), { timeout: 15_000 });
  const texts: string[] = [];
  return {
    texts,
    ask: async (path: string, body: unknown) => {
      if (handle === undefined) {
        throw new Error("dev does not serve yet");
      }
      const response = await handle(
        new Request(`http://127.0.0.1:4040/v1/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        THIS_MACHINE,
      );
      const text = await response.text();
      texts.push(text);
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    },
    stop: () => {
      stop.abort();
      return run;
    },
  };
}

describe("the doors' words and judgements under facetdb dev", () => {
  it("under --model-url, a reload says nothing of modelUrl: the file is read with dev's server in place", async () => {
    const dev = await served(
      ["dev", "--seed", "seed.sql", "--model-url", "http://localhost:11434"],
      {
        provider: () => createFakeProvider({ defaults: { noul: 0 } }),
      },
    );
    const reload = await dev.ask("reload", {});
    const result = await dev.stop();

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Asking the model server at http://localhost:11434.");
    expect(reload).toMatchObject({ status: 200, body: { loaded: true, notes: [] } });
    expect(result.stdout).not.toContain("modelUrl");
  }, 60_000);

  it("refuses a second source on a table dev installed whatever string the file reads it from, and says step five in dev's terms", async () => {
    const real = "postgres://facetdb_worker:pwMARK@db.example.com:5432/app?sslmode=require";
    env["LISTINGS_URL"] = real;
    process.env["LISTINGS_URL"] = real;
    try {
      await writeFile(
        configPath,
        configFileSource({
          ...INITIAL,
          sources: INITIAL.sources.map((source) => ({
            ...source,
            database: real,
            databaseEnv: "LISTINGS_URL",
          })),
        }),
      );
      const dev = await served(["dev", "--seed", "seed.sql"]);
      const taken = await dev.ask("sources/plan", {
        admin: DEV_URL,
        source: { ...DRAFT, name: "listings_again", table: "listings", read: ["title"] },
      });
      const inspected = await dev.ask("sources/inspect", { admin: DEV_URL, table: "sellers" });
      const unset = await dev.ask("sources/plan", {
        admin: DEV_URL,
        source: { ...DRAFT, database: { env: "SELLERS_URL" } },
      });
      const other = await dev.ask("sources/plan", {
        admin: DEV_URL,
        source: { ...DRAFT, database: { env: "LISTINGS_URL" } },
      });
      const result = await dev.stop();

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Installed listings on public.listings");
      expect(taken).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "table-taken",
            message: expect.stringContaining(
              'public.listings is already the table of the source "listings" in facetdb.config.ts',
            ),
          },
        },
      });
      // A source reading a real server's string is not the one to suggest under dev.
      expect(inspected).toMatchObject({ status: 200, body: { sharedWith: null } });
      expect(unset).toMatchObject({
        status: 400,
        body: {
          error: {
            message: expect.stringContaining(
              "SELLERS_URL is not set where the worker runs; under facetdb dev every source reads the embedded database, so name DATABASE_URL, which holds dev's address for this run; to read SELLERS_URL instead, set it to the same address (facetdb dev prints it when it starts), restart facetdb dev, then show the SQL again",
            ),
          },
        },
      });
      expect(other).toMatchObject({
        status: 400,
        body: {
          error: {
            message: expect.stringContaining(
              "LISTINGS_URL is set where the worker runs, and does not hold a connection string of a database FacetDB reads; under facetdb dev every source reads the embedded database, so name DATABASE_URL",
            ),
          },
        },
      });
      for (const text of [...dev.texts, result.stdout, result.stderr]) {
        expect(text).not.toContain("MARK");
      }
    } finally {
      delete env["LISTINGS_URL"];
      delete process.env["LISTINGS_URL"];
    }
  }, 60_000);
});
