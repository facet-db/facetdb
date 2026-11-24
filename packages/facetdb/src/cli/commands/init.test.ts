import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { DoctorCheck } from "@facetdb/core";
import { FakeEngine } from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { diskExamples, EXAMPLE_ENGINES } from "../examples.ts";
import { type EngineEntry, type ExampleShelf, runInProcess, type Workspace } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  freshPglite,
  type PgliteWorld,
  type SqlConnect,
  SteppedClock,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb init` through the in-process runner, in a temporary project directory on the real disk:
 * the scaffold loads with the config loader, a Prisma or Drizzle schema recommends side-table mode
 * with a printed reason, Claude Code gets the skill offer with one install method, and `--dry-run`
 * writes nothing. The scheme is named as it is read and each engine is asked what it needs, one
 * question each (a MySQL user reaches a config doctor passes from the prompts alone), and
 * `--example listings --engine <name>` copies the example of every engine, whose seeds run.
 */

const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const DATABASE_URL = "postgres://facetdb_worker:s3cret-worker-password@db.example.com:5432/app";

let dir: string;
const scratch: string[] = [];
let originalDatabaseUrl: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "facetdb-init-"));
  scratch.push(dir);
  // What `pnpm add facetdb` would put in the project: the generated file imports "facetdb".
  await mkdir(join(dir, "node_modules"));
  await symlink(resolve(packageDir), join(dir, "node_modules", "facetdb"));
  originalDatabaseUrl = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = DATABASE_URL;
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalDatabaseUrl;
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function workspaceOf(root: string, claudeOnPath: boolean): Workspace {
  return {
    exists: (path) =>
      readFile(join(root, path)).then(
        () => true,
        // A directory (`.claude`) cannot be read as a file, but it exists.
        (error: NodeJS.ErrnoException) => error.code === "EISDIR",
      ),
    write: async (path, text, { overwrite }) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, { flag: overwrite ? "w" : "wx" });
    },
    writeParts: () => Promise.reject(new Error("init writes no file in parts")),
    peek: () => Promise.reject(new Error("init reads no file")),
    lines: () => {
      throw new Error("init reads no file");
    },
    hasClaudeCommand: () => claudeOnPath,
  };
}

function run(
  argv: readonly string[],
  options: {
    readonly answers?: readonly string[];
    readonly claudeOnPath?: boolean;
    readonly env?: Record<string, string | undefined>;
    readonly engines?: readonly EngineEntry[];
    readonly examples?: ExampleShelf;
    readonly interactive?: boolean;
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: dir,
      env: options.env ?? {},
      loadConfig: async (path) =>
        (await loadConfig(path, { projectDir: dir, env: process.env, stderr: process.stderr }))
          .config,
      ...(options.engines === undefined ? {} : { engines: options.engines }),
      ...(options.examples === undefined ? {} : { examples: options.examples }),
      ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
      connect: () => {
        throw new Error("init opens no database connection");
      },
      workspace: workspaceOf(dir, options.claudeOnPath ?? false),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

/** A Postgres source on a host that allows triggers, every answer given by a flag: nothing is asked. */
const flags = [
  "init",
  "--database-url",
  DATABASE_URL,
  "--table",
  "support_messages",
  "--triggers",
  "allowed",
] as const;

const configFile = () => readFile(join(dir, "facetdb.config.ts"), "utf8");

describe("facetdb init", () => {
  it("writes a config that loads: one source, one example question, nothing secret", async () => {
    const result = await run(flags);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Created facetdb.config.ts for support_messages on db.example.com",
    );

    const file = await configFile();
    expect(file).toContain('import { env, facetdb, noul } from "facetdb";');
    expect(file).toContain('database: env("DATABASE_URL")');
    expect(file).not.toContain("s3cret");
    expect(file).not.toContain("db.example.com");
    expect(result.stdout + result.stderr).not.toContain("s3cret");

    const { config, warnings } = await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    });
    expect(warnings).toEqual([]);
    expect(config.model).toBe("jev-1.14.0");
    expect(config.sources).toHaveLength(1);
    const source = config.sources[0];
    expect(source?.name).toBe("support_messages");
    expect(source?.table).toBe("support_messages");
    expect(source?.storage).toBe("inline");
    expect(source?.questions.map((question) => question.name)).toEqual(["is_urgent"]);
  });

  it("asks for the connection string (hidden) and the table when no flag gives them", async () => {
    const result = await run(["init"], { answers: [DATABASE_URL, "app.Orders-2024"] });
    // The table name is judged before anything is written.
    expect(result.code).toBe(2);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]).toContain("Database connection string");
    expect(result.prompts[1]).toContain("Which table");
    expect(result.stderr).toContain('"app.Orders-2024" is not a table name');
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/init-table");
    await expect(configFile()).rejects.toThrow();

    // Enter at the triggers question: the host allows them.
    const second = await run(["init"], { answers: [DATABASE_URL, "app.support_messages", ""] });
    expect(second.code, second.stderr).toBe(0);
    expect(second.prompts).toHaveLength(3);
    expect(second.prompts[2]).toContain("Does your database host forbid triggers?");
    expect(await configFile()).not.toContain("connector:");
    expect(await configFile()).toContain('table: "app.support_messages"');
    expect(await configFile()).toContain('name: "support_messages"');
  });

  it("takes the connection string from DATABASE_URL when it is set, and does not ask", async () => {
    const result = await run(["init", "--table", "listings", "--triggers", "allowed"], {
      env: { DATABASE_URL },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
  });

  it("refuses something that is not a Postgres connection string, without echoing it", async () => {
    const result = await run([
      "init",
      "--database-url",
      "mysql://root:hunter2@host/db",
      "--table",
      "t",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a Postgres connection string");
    expect(result.stderr).not.toContain("hunter2");
    await expect(configFile()).rejects.toThrow();
  });

  it("does not replace a config that exists, unless told to", async () => {
    await writeFile(join(dir, "facetdb.config.ts"), "// my own edits\n");
    const refused = await run(flags);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("facetdb.config.ts already exists");
    expect(refused.stderr).toContain(
      "fix: edit facetdb.config.ts by hand, or run facetdb init --force",
    );
    expect(await configFile()).toBe("// my own edits\n");

    const forced = await run([...flags, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await configFile()).toContain("export default facetdb(");
  });

  it("refuses a config path outside the project", async () => {
    const result = await run([...flags, "--config", "../elsewhere.config.ts"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outside the project directory");
  });

  it("--dry-run prints the file and writes nothing, and asks nothing about skills", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run([...flags, "--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("export default facetdb(");
    expect(result.stdout).toContain("dry run: nothing is written");
    await expect(configFile()).rejects.toThrow();
  });

  it("--json prints one document with the file and what was detected", async () => {
    const result = await run([...flags, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      created: true,
      table: "support_messages",
      storage: "inline",
      claudeCode: false,
    });
    expect(parsed["file"]).toBe(await configFile());
  });
});

describe("facetdb init detects an ORM", () => {
  it("recommends side-table mode on a Prisma schema, saying why, and the file still loads", async () => {
    await mkdir(join(dir, "prisma"));
    await writeFile(join(dir, "prisma", "schema.prisma"), "model Message { id Int @id }\n");
    const result = await run(flags);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Found Prisma (prisma/schema.prisma)");
    expect(result.stdout).toContain("chose side-table mode");
    expect(result.stdout).toContain("support_messages_with_answers");
    expect(await configFile()).toContain('storage: "side-table"');
    const { config } = await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    });
    expect(config.sources[0]?.storage).toBe("side-table");
  });

  it.each(["drizzle.config.ts", "drizzle.config.mjs"])(
    "recommends side-table mode on %s",
    async (name) => {
      await writeFile(join(dir, name), "export default {};\n");
      const result = await run(flags);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Found Drizzle (${name})`);
      expect(await configFile()).toContain('storage: "side-table"');
    },
  );

  it("keeps inline columns, and says nothing about an ORM, when there is none", async () => {
    const result = await run(flags);
    expect(result.stdout).not.toContain("side-table mode");
    expect(await configFile()).toContain('storage: "inline"');
  });

  it("names the ORM in --json", async () => {
    await mkdir(join(dir, "prisma"));
    await writeFile(join(dir, "prisma", "schema.prisma"), "");
    const parsed = JSON.parse((await run([...flags, "--json"])).stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ orm: "Prisma", storage: "side-table" });
    expect(String(parsed["reason"])).toContain("Prisma");
  });
});

describe("facetdb init offers the agent skills", () => {
  it("says nothing about skills when Claude Code is not there", async () => {
    const result = await run(flags);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).not.toContain("claude plugin");
    expect(result.stdout).not.toContain("skills add");
  });

  it("detects a .claude directory, prints both skills' commands and asks for one method", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run(flags, { answers: ["plugin"] });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual(["Which one install method? Type plugin, npx or none: "]);
    // The offer: TypeSafe's two commands and FacetDB's, and the npx alternative.
    expect(result.stdout).toContain("claude plugin marketplace add typesafe-ai/skills");
    expect(result.stdout).toContain("claude plugin install typesafe@typesafe-ai");
    expect(result.stdout).toContain("claude plugin marketplace add facet-db/facetdb");
    expect(result.stdout).toContain("claude plugin install facetdb@facetdb");
    expect(result.stdout).toContain("npx skills add typesafe-ai/skills --skill typesafe-ai");
    expect(result.stdout).toContain("npx skills add facet-db/facetdb --skill facetdb");
    expect(result.stdout).toContain("TypeSafe asks for one install method per project");
    // After the answer, only the chosen method is repeated, as the thing to run.
    const chosen = result.stdout.slice(result.stdout.indexOf("Install the skills with the plugin"));
    expect(chosen).toContain("claude plugin install facetdb@facetdb");
    expect(chosen).not.toContain("npx skills add");
    expect(chosen).toContain("runs none of them");
  });

  it("detects the claude command on the PATH", async () => {
    const result = await run(flags, { answers: ["npx"], claudeOnPath: true });
    expect(result.code, result.stderr).toBe(0);
    const chosen = result.stdout.slice(result.stdout.indexOf("Install the skills with the npx"));
    expect(chosen).toContain("npx skills add facet-db/facetdb --skill facetdb");
    expect(chosen).not.toContain("claude plugin");
  });

  it("installs nothing when the answer is none", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run(flags, { answers: ["none"] });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Install the skills with");
  });

  it("does not ask when --skills gives the method", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run([...flags, "--skills", "npx"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("Install the skills with the npx method");
  });

  it("refuses a method that is not one of the three", async () => {
    await mkdir(join(dir, ".claude"));
    const flagged = await run([...flags, "--skills", "both"]);
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain("pass --skills plugin, --skills npx or --skills none");
    expect((await run(flags, { answers: ["both"] })).code).toBe(2);
  });
});

describe("facetdb init asks for the store's Postgres only for a source that is not Postgres", () => {
  const MYSQL_URL = "mysql://facetdb_worker:s3cret-mysql-password@db.example.com:3306/shop";
  const STORE_URL = "postgres://store:s3cret-store-password@store.example.com:5432/facetdb";
  /** A MySQL engine registered as main.ts registers engines: by its key, loaded on first use. */
  const mysql = lazyEngine("mysql", () =>
    Promise.resolve(new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"] })),
  );
  const STORE_PROMPT =
    "Store connection string, a Postgres (checked, never written to the file; the store is DATABASE_URL): ";

  it("says why in one sentence, asks for the store, and reads the source from a variable of its own", async () => {
    const result = await run(["init", "--database-url", MYSQL_URL, "--table", "orders"], {
      answers: [STORE_URL],
      engines: [mysql],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([STORE_PROMPT]);
    expect(result.stdout).toContain(
      "FacetDB keeps the decision log, usage and alerts in a Postgres of yours; a free Supabase or Neon project is enough.",
    );
    expect(result.stdout).toContain(
      "Created facetdb.config.ts for orders on db.example.com:3306/shop, with the store on store.example.com:5432/facetdb.",
    );
    expect(result.stdout).toContain(
      "Set ORDERS_URL to the source's connection string, and DATABASE_URL to the store's Postgres",
    );
    const file = await configFile();
    expect(file).toContain('database: env("ORDERS_URL"),');
    expect(file + result.stdout + result.stderr).not.toContain("s3cret");

    const flagged = await run(
      [
        "init",
        "--force",
        "--database-url",
        MYSQL_URL,
        "--store-url",
        STORE_URL,
        "--table",
        "orders",
      ],
      { engines: [mysql] },
    );
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.prompts).toEqual([]);
  });

  it("never names the source's variable DATABASE_URL, the store's: a table named database reads DATABASE_SOURCE_URL", async () => {
    const result = await run(
      ["init", "--database-url", MYSQL_URL, "--store-url", STORE_URL, "--table", "database"],
      { engines: [mysql] },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(await configFile()).toContain('database: env("DATABASE_SOURCE_URL"),');
    expect(result.stdout).toContain(
      "Set DATABASE_SOURCE_URL to the source's connection string, and DATABASE_URL to the store's Postgres",
    );
  });

  it("never asks for a store when the source is Postgres: its database holds the store", async () => {
    const result = await run(flags, { engines: [mysql] });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).not.toContain("a Postgres of yours");
    expect(await configFile()).toContain('database: env("DATABASE_URL"),');
  });

  it("refuses a store that is not a Postgres, a PGlite one included, without echoing it", async () => {
    const mysqlStore = await run(["init", "--database-url", MYSQL_URL, "--table", "orders"], {
      answers: ["mysql://root:hunter2@store/facetdb"],
      engines: [mysql],
    });
    expect(mysqlStore.code).toBe(2);
    expect(mysqlStore.stderr).toContain(
      "error: the store's connection string is not a Postgres connection string",
    );
    expect(mysqlStore.stderr).not.toContain("hunter2");
    const pglite = await run(["init", "--database-url", MYSQL_URL, "--table", "orders"], {
      answers: ["pglite://.facetdb/dev"],
      engines: [mysql],
    });
    expect(pglite.code).toBe(2);
    expect(pglite.stderr).toContain(
      "error: a PGlite store is for facetdb dev; point DATABASE_URL at a Postgres",
    );
    await expect(configFile()).rejects.toThrow();
  });
});

/** Loads the written config as the worker would, with `variables` set in the environment it reads. */
async function loadWritten(variables: Record<string, string>): Promise<ProjectConfig> {
  const saved = Object.entries(variables).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, variables);
  try {
    const loaded = await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    });
    return loaded.config;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** An engine registered as main.ts registers it, over core's fake engine. */
function fakeEntry(
  key: string,
  schemes: readonly string[],
  checks: readonly DoctorCheck[] = [],
): EngineEntry {
  return lazyEngine(key, () =>
    Promise.resolve(
      new FakeEngine({
        name: key,
        schemes,
        checks: checks.map((check) => ({ name: check.name, looksAt: `checks ${check.name}` })),
        doctor: () => checks,
      }),
    ),
  );
}

const STORE_PROMPT =
  "Store connection string, a Postgres (checked, never written to the file; the store is DATABASE_URL): ";

describe("a MySQL user reaches a config and a green doctor from the prompts alone", () => {
  const MYSQL_URL = "mysql://facetdb_worker:s3cret-mysql-password@localhost:3306/shop";
  const STORE_URL = "postgres://facetdb_store:s3cret-store-password@localhost:5432/facetdb";
  const SECRET = "a-long-random-secret-for-the-init-tests";
  // Its sleeps end only when moved: each doctor step's 10-second bound waits.
  const clock = new SteppedClock(10_000_000);
  /** What the MySQL engine's doctor reports on a healthy install, under its own check names. */
  const MYSQL_CHECKS: readonly DoctorCheck[] = [
    {
      name: "database",
      status: "ok",
      detail: '"orders" on localhost:3306/shop: logged in as facetdb_worker, 1 ms away',
    },
    { name: "version", status: "ok", detail: "MySQL 8.4.3" },
    { name: "install", status: "ok", detail: "the answer columns, facetdb_jobs and the triggers" },
    { name: "grants", status: "ok", detail: "facetdb_worker holds what it needs and no more" },
    { name: "queue", status: "ok", detail: "no job waiting" },
  ];
  let world: PgliteWorld;

  beforeAll(async () => {
    world = await createPgliteWorld();
    const store = await createStore({ pglite: world.db, secret: SECRET, clock });
    await store.close();
  });

  afterAll(async () => {
    await world.close();
  });

  /** The store's Postgres on PGlite, each connection one the caller may close. */
  function storeConnect(): SqlConnect {
    return () => ({
      query: (text, params) => world.client.query(text, params),
      transaction: (work) => world.client.transaction(work),
      pipeline: (text, paramSets) => world.client.pipeline(text, paramSets),
      close: () => Promise.resolve(),
    });
  }

  it("answers three prompts, sets the two variables the steps name, and doctor passes", async () => {
    const mysql = fakeEntry("mysql", ["mysql", "mariadb"], MYSQL_CHECKS);
    // The answers a user types: the connection string, the store's Postgres, the table.
    const init = await run(["init"], {
      answers: [MYSQL_URL, STORE_URL, "orders"],
      engines: [mysql],
    });
    expect(init.code, init.stderr).toBe(0);
    expect(init.prompts).toEqual([
      "Database connection string (checked, never written to the file; the config reads it from the environment): ",
      STORE_PROMPT,
      "Which table should get answers? (for example support_messages): ",
    ]);
    expect(init.stdout).toContain(
      "That is a MySQL or MariaDB connection string (mysql:): FacetDB reads it with its mysql engine.",
    );
    expect(init.stdout).toContain(
      "2. Set ORDERS_URL to the source's connection string, and DATABASE_URL to the store's Postgres",
    );
    expect(init.stdout).toContain(
      'use mysql://facetdb_worker:<a long random password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}',
    );
    expect(init.stdout).toContain("log_bin_trust_function_creators");
    expect(init.stdout + init.stderr).not.toContain("s3cret");

    // What the steps say to set; the config is the file init wrote, through the real loader.
    const config = await loadWritten({ ORDERS_URL: MYSQL_URL });
    expect(config.sources[0]).toMatchObject({
      name: "orders",
      table: "orders",
      databaseEnv: "ORDERS_URL",
      storage: "inline",
    });
    await world.client.query("insert into facetdb.heartbeats (project, at) values ($1, $2)", [
      basename(dir),
      clock.now() - 5_000,
    ]);
    const doctor = await runInProcess(
      ["doctor"],
      {
        projectDir: dir,
        env: {
          ORDERS_URL: MYSQL_URL,
          DATABASE_URL: STORE_URL,
          FACETDB_SECRET: SECRET,
          TYPESAFE_API_KEY: "tsk-a-test-key",
        },
        loadConfig: () => Promise.resolve(config),
        engines: [mysql],
        connect: storeConnect(),
        provider: () => createFakeProvider({ defaults: { noul: 0.9 } }),
        clock,
      },
      COMMANDS,
    );
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    const printed = doctor.stdout.split("\n").filter((text) => text !== "");
    expect(printed.map((text) => (text.endsWith(":") ? text : text.split(":")[0]))).toEqual([
      "ok    config",
      "ok    model key",
      "ok    model reachable",
      "source orders:",
      "      engine",
      "ok    database",
      "ok    version",
      "ok    install",
      "ok    grants",
      "ok    queue",
      "store:",
      "ok    store",
      "ok    pooler",
      "ok    worker heartbeat",
      "ok    FACETDB_SECRET",
      "All 12 checks passed.",
    ]);
    expect(printed[4]).toBe("      engine: mysql, for MySQL or MariaDB; the server is MySQL 8.4.3");
    expect(doctor.stdout + doctor.stderr).not.toContain("s3cret");
  });
});

describe("facetdb init names the engine and asks what it needs, one question each", () => {
  const STORE_URL = "postgres://store:s3cret-store-password@store.example.com:5432/facetdb";
  const engines: readonly EngineEntry[] = [
    fakeEntry("mysql", ["mysql", "mariadb"]),
    fakeEntry("mssql", ["mssql", "sqlserver"]),
    fakeEntry("sqlite", ["sqlite", "file"]),
    fakeEntry("libsql", ["libsql"]),
    fakeEntry("mongodb", ["mongodb", "mongodb+srv"]),
    fakeEntry("cockroachdb", ["cockroachdb"]),
    fakeEntry("oracle", ["oracle"]),
  ];
  /** init for a source of another kind, the store given: the questions left are the engine's. */
  const initFor = (url: string, answers: readonly string[], more: readonly string[] = []) =>
    run(["init", "--database-url", url, "--store-url", STORE_URL, ...more], { answers, engines });

  it("Postgres on a host that forbids triggers: connector polling, and a variable of its own", async () => {
    const result = await run(["init", "--database-url", DATABASE_URL, "--table", "listings"], {
      answers: ["yes"],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([
      "Does your database host forbid triggers? FacetDB notices a changed row with a trigger it adds to the table; most hosts allow one, and where none is allowed it polls the table instead. Type yes or no (Enter for no): ",
    ]);
    const file = await configFile();
    expect(file).toContain('connector: "polling",');
    expect(file).toContain('database: env("LISTINGS_URL"),');
    expect(result.stdout).toContain('No trigger, then: the config says connector: "polling"');
    expect(result.stdout).toContain(
      "2. Set LISTINGS_URL to the worker login's connection string and DATABASE_URL to the store owner's (the same database is fine)",
    );
    const worker = `${DATABASE_URL}?sslmode=require`;
    const config = await loadWritten({ LISTINGS_URL: worker });
    expect(config.sources[0]).toMatchObject({ connector: "polling", databaseEnv: "LISTINGS_URL" });

    // The flag answers it, and an ORM gets no side table from the polling connector.
    await mkdir(join(dir, "prisma"));
    await writeFile(join(dir, "prisma", "schema.prisma"), "");
    const flagged = await run([...flags.slice(0, -1), "forbidden", "--force"]);
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.prompts).toEqual([]);
    expect(flagged.stdout).toContain("the polling connector has no side-table mode");
    expect(await configFile()).toContain('storage: "inline"');
  });

  it("SQL Server on a host that forbids triggers: capture change-tracking; Azure SQL asks for the database", async () => {
    const azure = "mssql://facetdb_worker:s3cret-mssql@shop.database.windows.net:1433";
    const result = await initFor(azure, ["yes", "shop"], ["--table", "dbo.orders"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]).toContain("it reads SQL Server's Change Tracking instead");
    expect(result.prompts[1]).toContain(
      "Which database on this Azure SQL server holds the table? FacetDB's worker is a contained user of that one database",
    );
    expect(await configFile()).toContain('capture: "change-tracking",');
    expect(result.stdout).toContain("creates facetdb_worker as a contained user");
    expect(result.stdout).toContain(
      "mssql://facetdb_worker:<a long random password>@<host>:1433/shop",
    );
    const config = await loadWritten({ ORDERS_URL: azure });
    expect(config.sources[0]).toMatchObject({ capture: "change-tracking", table: "dbo.orders" });
    expect(result.stdout + result.stderr).not.toContain("s3cret");

    // A server that names its database and allows triggers is asked the one question.
    const plain = await initFor(
      "sqlserver://facetdb_worker:s3cret-mssql@db.example.com:1433/shop",
      [""],
      ["--table", "orders", "--force"],
    );
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.prompts).toHaveLength(1);
    expect(await configFile()).not.toContain("capture:");
  });

  it("MongoDB asks for the replica set unless the string says one, and says how to start one", async () => {
    const result = await initFor(
      "mongodb://facetdb_worker:s3cret-mongo@db.example.com:27017/shop",
      ["no"],
      ["--table", "orders"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([
      "Does this MongoDB run as a replica set? FacetDB watches changes with change streams, which need one: Atlas has one; a self-hosted server needs --replSet. Type yes or no (Enter for yes): ",
    ]);
    expect(result.stdout).toContain(
      "Restart mongod as a one-node replica set (mongod --replSet rs0",
    );
    expect(result.stdout).toContain("add ?replicaSet=rs0 to ORDERS_URL");
    expect(await configFile()).toContain(
      'table: "orders", // the collection whose documents get answers',
    );

    for (const url of [
      "mongodb+srv://facetdb_worker:s3cret-mongo@cluster0.abcde.mongodb.net/shop",
      "mongodb://facetdb_worker:s3cret-mongo@db.example.com:27017/shop?replicaSet=rs0",
    ]) {
      const said = await initFor(url, [], ["--table", "orders", "--force"]);
      expect(said.code, said.stderr).toBe(0);
      expect(said.prompts).toEqual([]);
      expect(said.stdout).not.toContain("Restart mongod");
    }
  });

  it("SQLite says where the file is read and that it goes to WAL mode, and asks nothing more", async () => {
    const result = await initFor("sqlite:./data/app.db", [], ["--table", "orders"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("That is a SQLite connection string (sqlite:)");
    expect(result.stdout).toContain("a relative path is read from the directory it runs in");
    expect(result.stdout).toContain("facetdb migrate puts the file in WAL mode");
    expect(result.stdout).toContain(
      "SQLite has no logins: the file's path is the connection string",
    );
    const bare = await initFor("./data/app.db", [], ["--table", "orders", "--force"]);
    expect(bare.stdout).toContain("That is a SQLite connection string (a file path)");
  });

  it("libSQL names the auth token's variable; a server that is not Turso's is asked whether it needs one", async () => {
    const turso = await initFor("libsql://shop-acme.turso.io", [], ["--table", "orders"]);
    expect(turso.code, turso.stderr).toBe(0);
    expect(turso.prompts).toEqual([]);
    expect(turso.stdout).toContain("Set ORDERS_URL_AUTH_TOKEN to the database's auth token");

    const local = await initFor(
      "http://libsql.internal:8080",
      ["no"],
      ["--table", "orders", "--force"],
    );
    expect(local.code, local.stderr).toBe(0);
    expect(local.prompts).toHaveLength(1);
    expect(local.prompts[0]).toContain("Does this libSQL server need an auth token?");
    expect(local.stdout).not.toContain("_AUTH_TOKEN to");
  });

  it("Oracle asks for the service and the schema the string and the table leave out", async () => {
    const result = await initFor(
      "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484?protocol=tcps",
      ["listings", "FREEPDB1", "app"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0]).toContain(
      "Type it as Oracle stores it, usually in capitals unless the table was created with quotes",
    );
    expect(result.prompts[1]).toContain("Which Oracle service holds the table?");
    expect(result.prompts[2]).toContain("Which schema (the user) owns listings?");
    expect(result.prompts[2]).toContain("usually in capitals unless it was created with quotes");
    // Typed without quotes in lower case: written as Oracle stores it, and said.
    const file = await configFile();
    expect(file).toContain('table: "APP.LISTINGS",');
    expect(file).toContain('read: ["SUBJECT", "BODY"]');
    expect(result.stdout).toContain(
      "init wrote the table as APP.LISTINGS: Oracle stores a name created without quotes in capitals.",
    );
    expect(result.stdout).toContain("@<host>:2484/FREEPDB1?protocol=tcps");

    // In quotes: kept as written, without the quotes, and nothing to say about its case.
    const quoted = await initFor(
      "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484/FREEPDB1",
      ['"listings"', "APP"],
      ["--force"],
    );
    expect(quoted.code, quoted.stderr).toBe(0);
    expect(await configFile()).toContain('table: "APP.listings",');
    expect(quoted.stdout).not.toContain("init wrote the table as");
    const config = await loadWritten({ LISTINGS_URL: "oracle://example-oracle" });
    expect(config.sources[0]).toMatchObject({ name: "listings", table: "APP.listings" });

    const named = await initFor(
      "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484/FREEPDB1",
      [],
      ["--table", "APP.LISTINGS", "--force"],
    );
    expect(named.code, named.stderr).toBe(0);
    expect(named.prompts).toEqual([]);
    const refused = await initFor(
      "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484/FREEPDB1",
      ["app-owner"],
      ["--table", "listings", "--force"],
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('"app-owner" is not a schema name');
  });

  it("CockroachDB says it polls by a last-changed column, and asks nothing more", async () => {
    const result = await initFor(
      "cockroachdb://facetdb_worker:s3cret-crdb@db.example.com:26257/shop?sslmode=verify-full",
      [],
      ["--table", "orders"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("CockroachDB: the worker reads orders every 10 seconds");
    expect(result.stdout).toContain("an ON UPDATE now() default does it");
  });

  it("refuses an answer that is not yes or no, and a --triggers that is neither answer", async () => {
    const answer = await run(["init", "--database-url", DATABASE_URL, "--table", "t"], {
      answers: ["maybe"],
    });
    expect(answer.code).toBe(2);
    expect(answer.stderr).toContain('"maybe" is not yes or no');
    const flag = await run([...flags, "--triggers", "sometimes"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain("pass --triggers allowed, or --triggers forbidden");
    await expect(configFile()).rejects.toThrow();
  });

  it.each([
    ['APP."my table"', "APP.my table", "my_table"],
    ['APP."order-items"', "APP.order-items", "order_items"],
    ["APP.LIST#ING", "APP.LIST#ING", "list_ing"],
    ["APP.LIST$ING", "APP.LIST$ING", "list_ing"],
    ['APP."Listings"', "APP.Listings", "listings"],
  ])(
    "an Oracle table %s keeps its name in table: and gives a source name and variable the loader takes",
    async (typed, table, name) => {
      const result = await initFor(
        "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484/FREEPDB1",
        [],
        ["--table", typed],
      );
      expect(result.code, result.stderr).toBe(0);
      const variable = `${name.toUpperCase()}_URL`;
      expect(await configFile()).toContain(`database: env("${variable}"),`);
      const config = await loadWritten({ [variable]: "oracle://example-oracle" });
      expect(config.sources[0]).toMatchObject({ name, table, databaseEnv: variable });
    },
  );

  it("refuses a table that leaves no source name, and writes nothing", async () => {
    const result = await initFor(
      "oracle://facetdb_worker:s3cret-oracle@db.example.com:2484/FREEPDB1",
      [],
      ["--table", 'APP."2024"'],
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the table 2024 gives no source name");
    await expect(configFile()).rejects.toThrow();
  });

  it("reads every answer from a pipe in a terminal's order, the triggers question included", async () => {
    // printf 'url\ntable\nyes\n' | facetdb init: no terminal, three lines.
    const piped = await run(["init"], {
      interactive: false,
      answers: [DATABASE_URL, "listings", "yes"],
    });
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.prompts).toHaveLength(3);
    expect(piped.prompts[2]).toContain("Does your database host forbid triggers?");
    expect(piped.stdout).not.toContain("No answer came");
    expect(await configFile()).toContain('connector: "polling",');

    // Two lines: the pipe is empty at the triggers question, so its default is taken and said.
    const short = await run(["init", "--force"], {
      interactive: false,
      answers: [DATABASE_URL, "listings"],
    });
    expect(short.code, short.stderr).toBe(0);
    expect(short.prompts).toHaveLength(2);
    expect(short.stdout).toContain("No answer came to whether the host forbids triggers");
    expect(await configFile()).not.toContain("connector:");
  });

  it("with no terminal and nothing piped, takes triggers as allowed and says so; --triggers still decides", async () => {
    const result = await run(["init", "--database-url", DATABASE_URL, "--table", "listings"], {
      interactive: false,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain(
      "No answer came to whether the host forbids triggers (no terminal, and nothing left on standard input), so init takes them as allowed; on a host that forbids them, run facetdb init again with --triggers forbidden.",
    );
    expect(await configFile()).not.toContain("connector:");

    const flagged = await run([...flags.slice(0, -1), "forbidden", "--force"], {
      interactive: false,
    });
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.stdout).not.toContain("No answer came");
    expect(await configFile()).toContain('connector: "polling",');
  });

  it("refuses --engine without --example, naming the pair, and writes nothing", async () => {
    const result = await run([...flags, "--engine", "mysql"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "error: --engine picks the database of an example, and goes with --example",
    );
    expect(result.stderr).toContain("run facetdb init --example listings --engine mysql");
    expect(result.stderr).not.toContain("s3cret");
    await expect(configFile()).rejects.toThrow();
  });

  it("--json says which engine and what the answers put in the config", async () => {
    const result = await run([...flags.slice(0, -1), "forbidden", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      engine: "postgres",
      connector: "polling",
      variable: "SUPPORT_MESSAGES_URL",
    });
  });
});

describe("facetdb init --example listings copies the example of every engine", () => {
  /** The rows a seed makes, as its database counts them: all, and those written like a scam. */
  type Seeded = { readonly rows: number; readonly scams: number };
  const SCAM = "URGENT.%";

  async function seededOnPglite(sql: string): Promise<Seeded> {
    const db = await freshPglite();
    try {
      await db.exec(sql);
      const result = await db.query<{ rows: number; scams: number }>(
        "select count(*)::int as rows, count(*) filter (where description like $1)::int as scams from public.listings",
        [SCAM],
      );
      const [row] = result.rows;
      return { rows: row?.rows ?? 0, scams: row?.scams ?? 0 };
    } finally {
      await db.close();
    }
  }

  function seededOnSqlite(sql: string): Seeded {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
      const row = db
        .prepare("select count(*) as rows, sum(description like ?) as scams from listings")
        .get(SCAM);
      return { rows: Number(row?.["rows"]), scams: Number(row?.["scams"]) };
    } finally {
      db.close();
    }
  }

  /** A mongosh script run against a `db` that records what it was asked to insert. */
  function seededByMongosh(script: string): Seeded {
    const inserted: { readonly description: string; readonly title: string }[] = [];
    runInNewContext(script, {
      db: {
        listings: {
          insertMany: (documents: typeof inserted) => {
            inserted.push(...documents);
          },
        },
      },
    });
    return {
      rows: inserted.length,
      scams: inserted.filter((document) => document.description.startsWith("URGENT.")).length,
    };
  }

  it.each(EXAMPLE_ENGINES.map((engine) => [engine.name, engine] as const))(
    "copies listings-%s: a config the loader takes, reading its variable, and its two seeds",
    async (name, engine) => {
      const result = await run(["init", "--example", "listings", "--engine", name], {
        examples: diskExamples,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.prompts).toEqual([]);
      const seeds =
        name === "mongodb" ? ["seed-quick.js", "seed.js"] : ["seed-quick.sql", "seed.sql"];
      expect(result.stdout).toContain(
        `Copied the listings example for ${engine.label}: facetdb.config.ts, ${seeds.join(", ")}.`,
      );
      expect(result.stdout).toContain(engine.seed.replace("seed.sql", seeds[1] ?? ""));
      expect(result.stdout).toContain(`Set ${engine.variable} to ${engine.workerUrl}`);
      // What the engine needs besides its variable: libSQL's token, MongoDB's replica set.
      expect(engine.step !== undefined).toBe(name === "libsql" || name === "mongodb");
      if (engine.step !== undefined) {
        expect(result.stdout).toContain(`3. ${engine.step}`);
        expect(result.stdout).toContain("4. facetdb doctor checks the setup");
      }
      for (const seed of seeds) {
        expect(await readFile(join(dir, seed), "utf8")).not.toBe("");
      }
      const scheme = engine.workerUrl.slice(0, engine.workerUrl.indexOf(":"));
      const config = await loadWritten({ [engine.variable]: `${scheme}://example-${name}` });
      expect(config.model).toBe("jev-1.14.0");
      const [source] = config.sources;
      expect(source?.name).toBe("listings");
      expect(source?.databaseEnv).toBe(engine.variable);
      expect(source?.questions.map((question) => question.name)).toEqual(["is_scam", "category"]);
    },
  );

  it("the seeds make 2,000 rows and 100, one in twenty written like a scam, where they can run here", async () => {
    const seed = (name: string, file: string) =>
      readFile(join(packageDir, "examples", `listings-${name}`, file), "utf8");
    for (const name of ["postgres"]) {
      expect(await seededOnPglite(await seed(name, "seed.sql"))).toEqual({
        rows: 2000,
        scams: 100,
      });
      expect(await seededOnPglite(await seed(name, "seed-quick.sql"))).toEqual({
        rows: 100,
        scams: 5,
      });
    }
    for (const name of ["sqlite", "libsql"]) {
      expect(seededOnSqlite(await seed(name, "seed.sql"))).toEqual({ rows: 2000, scams: 100 });
      expect(seededOnSqlite(await seed(name, "seed-quick.sql"))).toEqual({ rows: 100, scams: 5 });
    }
    // sqlplus runs Oracle's seeds and stops at their exit, on the worker's TLS listener.
    for (const file of ["seed.sql", "seed-quick.sql"]) {
      expect((await seed("oracle", file)).trimEnd().endsWith("\ncommit;\n\nexit")).toBe(true);
    }
    expect(EXAMPLE_ENGINES.find((engine) => engine.name === "oracle")?.seed).toContain(
      "@tcps://<host>:2484/<service>",
    );
    expect(seededByMongosh(await seed("mongodb", "seed.js"))).toEqual({ rows: 2000, scams: 100 });
    expect(seededByMongosh(await seed("mongodb", "seed-quick.js"))).toEqual({
      rows: 100,
      scams: 5,
    });
  });

  it("--dry-run prints the config and writes nothing; a file there is kept unless --force", async () => {
    const dry = await run(["init", "--example", "listings", "--engine", "mysql", "--dry-run"], {
      examples: diskExamples,
    });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("dry run: nothing is written");
    expect(dry.stdout).toContain('env("LISTINGS_URL")');
    await expect(configFile()).rejects.toThrow();

    await writeFile(join(dir, "seed.sql"), "-- my own seed\n");
    const kept = await run(["init", "--example", "listings", "--engine", "mysql"], {
      examples: diskExamples,
    });
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain("seed.sql already exists");
    await expect(configFile()).rejects.toThrow();
    const forced = await run(["init", "--example", "listings", "--engine", "mysql", "--force"], {
      examples: diskExamples,
    });
    expect(forced.code, forced.stderr).toBe(0);
    expect(await readFile(join(dir, "seed.sql"), "utf8")).toContain("engine = InnoDB");
  });

  it("refuses an engine or an example there is none of, and flags an example would ignore", async () => {
    const engine = await run(["init", "--example", "listings", "--engine", "db2"], {
      examples: diskExamples,
    });
    expect(engine.code).toBe(2);
    expect(engine.stderr).toContain(
      "pass --engine with one of postgres, mysql, mariadb, mssql, sqlite, libsql, mongodb, cockroachdb, oracle",
    );
    const example = await run(["init", "--example", "shop"], { examples: diskExamples });
    expect(example.code).toBe(2);
    expect(example.stderr).toContain("pass --example listings");
    const flagged = await run(["init", "--example", "listings", "--table", "orders"], {
      examples: diskExamples,
    });
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain(
      "--example copies a finished project, so --table would change nothing",
    );
  });
});
