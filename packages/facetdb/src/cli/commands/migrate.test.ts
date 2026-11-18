import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig, type SourceInput } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess, runProgram } from "../program.ts";
import {
  createPgliteWorld,
  migrate,
  type PgliteWorld,
  postgresEngines,
  readingDatabaseUrl,
  resetPgliteWorld,
  type SqlConnect,
  sourceIdOf,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb migrate` and `facetdb uninstall` through the in-process runner, on PGlite: the commands'
 * own SQL runs on a real Postgres engine. Every test reads the catalog before and after, because
 * these commands change a customer's database.
 */

const ADMIN_URL = "postgres://admin:s3cret-admin-password@localhost:5432/app";
const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
/** The project directory's name is the project's name: what uninstall asks to have typed back. */
const PROJECT_DIR = "/work/listings-app";

function configWith(questions: SourceInput["questions"]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["title", "description"],
        questions,
      },
    ],
  });
}

const fullConfig = configWith({
  is_scam: noul("Is this listing a scam?"),
  category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
});

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
  await world.client.query("insert into public.listings (id, title) values ('1', 'A bike')");
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

async function columns(): Promise<string[]> {
  const rows = await world.client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position",
  );
  return rows.map((row) => String(row["column_name"]));
}

async function facetdbSchemaExists(): Promise<boolean> {
  const rows = await world.client.query(
    "select 1 from information_schema.schemata where schema_name = 'facetdb'",
  );
  return rows.length > 0;
}

/**
 * The `listings` source as the worker registers it on its first start (`ensureSource`), under the
 * project migrate installed: what `--purge` finds the log by.
 */
async function registerSource(): Promise<void> {
  const owners = await world.client.query(
    "select project_id from facetdb.table_owners where table_name = 'listings'",
  );
  const projectId = String(owners[0]?.["project_id"]);
  await world.client.query(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, 'listings', 'plugin')`,
    [sourceIdOf(projectId, "listings"), projectId],
  );
}

/** The connections the commands open, with the ones that ran a transaction marked. */
function recordingConnect(onConnect?: (index: number) => Promise<void>): {
  connect: SqlConnect;
  transactions: string[][];
} {
  const transactions: string[][] = [];
  let opened = 0;
  const connect: SqlConnect = (url) => {
    expect(url).toBe(ADMIN_URL);
    const index = opened++;
    const ready = onConnect?.(index) ?? Promise.resolve();
    return {
      query: async (text, params) => {
        await ready;
        return world.client.query(text, params);
      },
      transaction: async (work) => {
        await ready;
        const ran: string[] = [];
        transactions.push(ran);
        return world.client.transaction((query) =>
          work((text, params) => {
            ran.push(text);
            return query(text, params);
          }),
        );
      },
      pipeline: async (text, paramSets) => {
        await ready;
        return world.client.pipeline(text, paramSets);
      },
      close: () => Promise.resolve(),
    };
  };
  return { connect, transactions };
}

function run(
  argv: readonly string[],
  options: {
    readonly config?: ProjectConfig;
    readonly answers?: readonly string[];
    readonly connect?: SqlConnect;
  } = {},
) {
  const connect = options.connect ?? world.connect;
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {},
      // The source reads DATABASE_URL, as the loader records it: the store is its database.
      loadConfig: () => Promise.resolve(readingDatabaseUrl(options.config ?? fullConfig)),
      engines: postgresEngines(connect),
      connect,
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

/** Runs a command and records, at each prompt, everything printed so far: what the user had seen. */
async function runSeeingPrompts(
  argv: readonly string[],
  answers: readonly string[],
  config: ProjectConfig = fullConfig,
) {
  let stdout = "";
  let stderr = "";
  const seen: string[] = [];
  const left = [...answers];
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
          seen.push(`${stdout}${stderr}`);
          const answer = left.shift();
          return answer === undefined
            ? Promise.reject(new Error(`unexpected prompt: ${question}`))
            : Promise.resolve(answer);
        },
        answerable: () => Promise.resolve(true),
      },
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(readingDatabaseUrl(config)),
      engines: postgresEngines(world.connect),
      connect: world.connect,
      store: () => Promise.reject(new Error("no store")),
      provider: () => {
        throw new Error("no provider");
      },
      workspace: {
        exists: () => Promise.resolve(false),
        write: () => Promise.resolve(),
        hasClaudeCommand: () => false,
      },
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      backfill: () => Promise.reject(new Error("no backfill")),
      serve: () => Promise.reject(new Error("no HTTP server")),
      stopSignal: () => {
        throw new Error("no stop signal");
      },
      webhookFetch: () => Promise.reject(new Error("no webhook fetch")),
      abortAfter: () => {
        throw new Error("no timeout signal");
      },
      random: () => {
        throw new Error("no random numbers");
      },
      embedded: {
        open: () => Promise.reject(new Error("no embedded database")),
        wipe: () => Promise.reject(new Error("no embedded database")),
      },
      examples: { read: () => Promise.reject(new Error("no example projects")) },
    },
    COMMANDS,
  );
  return { code, stdout, stderr, seen };
}

describe("under --json, the SQL is shown before the confirmation", () => {
  it("migrate prints its SQL on stderr before asking, and stdout stays JSON", async () => {
    const result = await runSeeingPrompts(["migrate", "--json", "--admin-url", ADMIN_URL], ["yes"]);
    expect(result.code, result.stderr).toBe(0);
    const sql = (JSON.parse(result.stdout) as { sources: { sql: string }[] }).sources[0]?.sql;
    expect(sql).toContain("is_scam");
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]).toContain(sql);
  });

  it("uninstall --purge prints its SQL on stderr before asking for the name", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    await registerSource();
    const result = await runSeeingPrompts(
      ["uninstall", "--json", "--purge", "--admin-url", ADMIN_URL],
      ["listings-app"],
    );
    expect(result.code, result.stderr).toBe(0);
    const sql = (JSON.parse(result.stdout) as { sources: { sql: string }[] }).sources[0]?.sql;
    expect(sql).toContain("delete from facetdb.decisions");
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]).toContain(sql);
    expect(result.seen[0]).toContain('drop column "is_scam"');
  });
});

describe("facetdb migrate", () => {
  it("prints the SQL on a dry run and changes nothing", async () => {
    const before = await columns();
    const { connect, transactions } = recordingConnect();
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], { connect });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("begin;");
    expect(result.stdout).toContain("is_scam");
    expect(result.stdout).toContain("Dry run: nothing was changed.");
    expect(result.prompts).toEqual([]);
    expect(transactions).toEqual([]);
    expect(await columns()).toEqual(before);
    expect(await facetdbSchemaExists()).toBe(false);
  });

  it("installs once confirmed, running the SQL it printed", async () => {
    const { connect, transactions } = recordingConnect();
    const result = await run(["migrate", "--admin-url", ADMIN_URL], {
      connect,
      answers: ["yes"],
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([
      "Run the SQL above on localhost:5432/app? Type yes to continue: ",
    ]);
    expect(await columns()).toEqual(
      expect.arrayContaining(["is_scam", "category", "facetdb_status", "facetdb_reviewed"]),
    );
    // One transaction ran, and each statement it ran appears in the printed script.
    expect(transactions).toHaveLength(1);
    for (const text of transactions[0] ?? []) {
      if (!text.includes("$1")) {
        expect(result.stdout).toContain(text);
      }
    }
  });

  it("prints the same SQL string it runs, under --json too", async () => {
    const dry = await run(["migrate", "--dry-run", "--json", "--admin-url", ADMIN_URL]);
    const printed = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    const applied = await run(["migrate", "--yes", "--json", "--admin-url", ADMIN_URL]);
    const shown = JSON.parse(dry.stdout) as { sources: { sql: string; applied: boolean }[] };
    const ran = JSON.parse(applied.stdout) as { sources: { sql: string; applied: boolean }[] };
    expect(shown.sources[0]?.applied).toBe(false);
    expect(ran.sources[0]?.applied).toBe(true);
    expect(ran.sources[0]?.sql).toBe(shown.sources[0]?.sql);
    expect(printed.stdout).toContain(shown.sources[0]?.sql);
  });

  it("runs nothing when the answer is not yes", async () => {
    const before = await columns();
    const result = await run(["migrate", "--admin-url", ADMIN_URL], { answers: ["no"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing was run");
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/not-confirmed");
    expect(await columns()).toEqual(before);
  });

  it("runs nothing when the database changed after the SQL was shown", async () => {
    const before = await columns();
    // Connections: 0 is the engine's plan shown, 1 the plan made again at the run (the engine plans
    // and runs on its own connections); before 1, the key changes.
    const { connect, transactions } = recordingConnect(async (index) => {
      if (index === 1) {
        await world.client.query("alter table public.listings rename column id to listing_id");
      }
    });
    const result = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], { connect });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/database-changed");
    expect(transactions).toEqual([]);
    expect(await columns()).toEqual(before.map((c) => (c === "id" ? "listing_id" : c)));
  });

  it("asks for the admin connection string with the input hidden, and writes it nowhere", async () => {
    const result = await run(["migrate", "--dry-run"], { answers: [ADMIN_URL] });
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([
      "Admin connection string (used for this run only, never stored): ",
    ]);
    expect(result.stdout).not.toContain("s3cret-admin-password");
    expect(result.stderr).not.toContain("s3cret-admin-password");
    const installed = await run(["migrate", "--yes", "--json"], { answers: [ADMIN_URL] });
    expect(installed.code).toBe(0);
    expect(installed.stdout).not.toContain("s3cret-admin-password");
    expect(installed.stdout).not.toContain("worker-password");
  });

  it("says how to name the worker login when the source does not log in as it", async () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "postgres://app:app@localhost/app",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], { config });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fix: set DATABASE_URL to postgres://facetdb_worker:");
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/worker-login");
  });

  function configLoggingInAs(database: string): ProjectConfig {
    return facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database,
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
  }

  it("accepts a pooler-suffixed worker login on the first install and takes the password from it", async () => {
    const config = configLoggingInAs(
      "postgres://facetdb_worker.jkqrabcd:pooled-password@aws-0.pooler.supabase.com:5432/postgres",
    );
    const bound: unknown[] = [];
    const connect: SqlConnect = (url) => {
      const inner = world.connect(url);
      return {
        ...inner,
        transaction: (work) =>
          inner.transaction((query) =>
            work((text, params) => {
              bound.push(...(params ?? []));
              return query(text, params);
            }),
          ),
      };
    };
    const result = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], { config, connect });
    expect(result.code, result.stderr).toBe(0);
    // The password never reaches the server: the install binds a SCRAM verifier of it. Recompute the
    // verifier from the salt the install chose, with the password written in the URL.
    const verifier = bound.find(
      (value): value is string => typeof value === "string" && value.startsWith("SCRAM-SHA-256$"),
    );
    expect(verifier).toBeDefined();
    const salt = Buffer.from(String(verifier).split("$")[1]?.split(":")[1] ?? "", "base64");
    const salted = pbkdf2Sync("pooled-password", salt, 4096, 32, "sha256");
    const storedKey = createHash("sha256")
      .update(createHmac("sha256", salted).update("Client Key").digest())
      .digest("base64");
    expect(verifier).toContain(`$${storedKey}:`);
    const roles = await world.client.query(
      "select 1 from pg_catalog.pg_roles where rolname = 'facetdb_worker'",
    );
    expect(roles).toHaveLength(1);
    expect(result.stdout).not.toContain("pooled-password");
  });

  it.each([
    ["an empty suffix", "postgres://facetdb_worker.:pw-pw-pw@localhost/app"],
    ["a longer role name", "postgres://facetdb_workerx:pw-pw-pw@localhost/app"],
    ["a longer role name with a suffix", "postgres://facetdb_workerx.abc:pw-pw-pw@localhost/app"],
    ["two dots", "postgres://facetdb_worker.a.b:pw-pw-pw@localhost/app"],
    ["the admin through the pooler", "postgres://postgres.jkqrabcd:pw-pw-pw@localhost/app"],
  ])("refuses %s as the worker login, showing both accepted forms", async (_name, database) => {
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL], {
      config: configLoggingInAs(database),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fix: set DATABASE_URL to postgres://facetdb_worker:");
    expect(result.stderr).toContain("postgres://facetdb_worker.<suffix>:");
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/worker-login");
    expect(await facetdbSchemaExists()).toBe(false);
  });

  it("drops a removed question's columns with --prune, after showing it", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const smaller = configWith({ is_scam: noul("Is this listing a scam?") });
    const withoutPrune = await run(["migrate", "--yes", "--admin-url", ADMIN_URL], {
      config: smaller,
    });
    expect(withoutPrune.code).toBe(0);
    expect(await columns()).toContain("category");
    const dry = await run(["migrate", "--prune", "--dry-run", "--admin-url", ADMIN_URL], {
      config: smaller,
    });
    expect(dry.stdout).toContain('drop column "category"');
    expect(await columns()).toContain("category");
    const pruned = await run(["migrate", "--prune", "--yes", "--admin-url", ADMIN_URL], {
      config: smaller,
    });
    expect(pruned.code).toBe(0);
    expect(await columns()).not.toContain("category");
    expect(await columns()).toContain("is_scam");
  });

  it("--prune names each column to drop, kept or revoked with the reason, before and after the run", async () => {
    const configReading = (read: readonly string[], storeProbabilities: boolean, urgent: boolean) =>
      facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "listings",
            database: WORKER_URL,
            table: "listings",
            read: [...read],
            questions: {
              is_scam: noul("Is this listing a scam?"),
              category: choice(
                "Which category is this listing?",
                { car: "A car", flat: "A flat" },
                { storeProbabilities },
              ),
              ...(urgent ? { urgent: noul("Does this listing need a reply today?") } : {}),
            },
          },
        ],
      });
    const before = configReading(["title", "description"], true, true);
    expect(
      (await run(["migrate", "--yes", "--admin-url", ADMIN_URL], { config: before })).code,
    ).toBe(0);
    expect(await columns()).toContain("category_probabilities");
    const after = configReading(["title"], false, false);
    const lines = (done: boolean) =>
      [
        `${done ? "Pruned" : "Prune of"} public.listings:`,
        `  urgent: ${done ? "dropped" : "to drop"} (no question asks it any more)`,
        `  urgent_probability: ${done ? "dropped" : "to drop"} (no question asks it any more)`,
        "  category_probabilities: kept (storeProbabilities is off)",
        `  description: the worker login's read ${done ? "revoked" : "to revoke"} (read no longer lists it)`,
        "",
      ].join("\n");
    const dry = await run(["migrate", "--prune", "--dry-run", "--admin-url", ADMIN_URL], {
      config: after,
    });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`revoke select ("description")`);
    expect(dry.stdout).toContain(lines(false));
    expect(dry.stdout).not.toContain("Pruned public.listings");
    // The column list comes after the prune script it describes.
    expect(dry.stdout.indexOf("Prune of")).toBeGreaterThan(dry.stdout.indexOf("revoke select"));
    const pruned = await runSeeingPrompts(
      ["migrate", "--prune", "--admin-url", ADMIN_URL],
      ["yes"],
      after,
    );
    expect(pruned.code, pruned.stderr).toBe(0);
    // Before the confirmation, what is to happen; after the run, what happened.
    expect(pruned.seen[0]).toContain(lines(false));
    expect(pruned.seen[0]).not.toContain("Pruned public.listings");
    expect(pruned.stdout.slice(pruned.seen[0]?.length)).toContain(lines(true));
    expect(await columns()).toContain("category_probabilities");
    expect(await columns()).not.toContain("urgent");
    // Nothing left to drop or revoke: the kept column is still named, with no script for it.
    const again = await run(["migrate", "--prune", "--dry-run", "--admin-url", ADMIN_URL], {
      config: after,
    });
    expect(again.stdout).not.toContain("-- facetdb migrate --prune");
    expect(again.stdout).toContain(
      "Prune of public.listings:\n  category_probabilities: kept (storeProbabilities is off)\n",
    );
  });

  it("--prune prints the connector's notes, and a revoked column another role still grants says so", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    // A DBA granted the worker the same column on its own: FacetDB's revoke cannot take that back.
    await world.client.query("create role table_dba");
    await world.client.query(
      "grant select (description) on public.listings to table_dba with grant option",
    );
    await world.client.query("set role table_dba");
    try {
      await world.client.query("grant select (description) on public.listings to facetdb_worker");
    } finally {
      await world.client.query("reset role");
    }
    const titleOnly = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: WORKER_URL,
          table: "listings",
          read: ["title"],
          questions: {
            is_scam: noul("Is this listing a scam?"),
            category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
          },
        },
      ],
    });
    const result = await run(["migrate", "--prune", "--yes", "--admin-url", ADMIN_URL], {
      config: titleOnly,
    });
    expect(result.code, result.stderr).toBe(0);
    for (const prefix of ["Prune of", "Pruned"]) {
      expect(result.stdout).toContain(
        [
          `${prefix} public.listings:`,
          `  description: FacetDB's grant ${prefix === "Pruned" ? "revoked" : "to revoke"} (a grant by table_dba remains, see note)`,
          "note: description: a grant by table_dba remains; only that role can revoke it",
          "",
        ].join("\n"),
      );
    }
    expect(result.stdout).not.toContain("description: the worker login's read");
  });

  it("never prints a raw probability", async () => {
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.stdout).not.toContain("noul=");
  });
});

describe("the store is the Postgres DATABASE_URL names", () => {
  const STORE_URL = "postgres://store-owner:s3cret-store-password@localhost:5432/facetdb";

  /** A source reading its own variable, as the loader makes of `database: process.env.LISTINGS_URL`. */
  const ownVariable: ProjectConfig = {
    ...fullConfig,
    sources: fullConfig.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
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

  it("prints today's one script, with no header, when the store is the source's database", async () => {
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.code, result.stderr).toBe(0);
    // The pre-058 path's dry run on the same database: the oracle, byte for byte.
    const today = await migrate({
      adminUrl: ADMIN_URL,
      connect: world.connect,
      print: () => undefined,
      dryRun: true,
      plan: {
        source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
        questionSet: {
          questions: fullConfig.sources[0]?.questions ?? [],
          read: ["title", "description"],
          model: "jev-1.14.0",
          thresholds: {},
        },
        project: { id: "listings-app", name: "listings-app" },
        workerPassword: "worker-password",
      },
    });
    if (!today.ok) {
      throw new Error(today.reason);
    }
    expect(result.stdout).toBe(
      `-- facetdb migrate: listings (public.listings)\n${today.sql}Dry run: nothing was changed.\n`,
    );
    expect(result.stdout).not.toContain("-- store:");
    expect(result.stdout).not.toContain("-- source ");
  });

  it("prints the store's part and the source's part under the database each runs in, and asks once", async () => {
    const dry = await runWithStore(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(
      dry.stdout.startsWith(
        '-- store: localhost:5432/facetdb\nbegin;\n\ncreate schema if not exists "facetdb";',
      ),
    ).toBe(true);
    const source = dry.stdout.indexOf(
      "-- source listings: localhost:5432/app\n-- facetdb migrate: listings (public.listings)\nbegin;\n",
    );
    expect(source).toBeGreaterThan(0);
    // The store's tables are in the store's part alone; the source's part holds its own objects.
    const storePart = dry.stdout.slice(0, source);
    const sourcePart = dry.stdout.slice(source);
    expect(storePart).toContain("facetdb.decisions");
    expect(sourcePart).not.toContain("facetdb.decisions");
    expect(sourcePart).toContain('"is_scam"');
    expect(dry.stdout + dry.stderr).not.toContain("s3cret-store-password");
    expect(await facetdbSchemaExists()).toBe(false);

    const json = await runWithStore(["migrate", "--dry-run", "--json", "--admin-url", ADMIN_URL]);
    const parsed = JSON.parse(json.stdout) as {
      store: { database: string; current: boolean; sql: string; applied: boolean };
      sources: { sql: string }[];
    };
    expect(parsed.store).toMatchObject({
      database: "localhost:5432/facetdb",
      current: false,
      applied: false,
    });
    expect(parsed.store.sql).toContain("create table if not exists facetdb.decisions");
    expect(parsed.sources[0]?.sql).not.toContain("facetdb.decisions");

    const real = await runWithStore(["migrate", "--admin-url", ADMIN_URL], ["yes"]);
    expect(real.code, real.stderr).toBe(0);
    expect(real.prompts).toEqual([
      "Run the SQL above on localhost:5432/facetdb and localhost:5432/app? Type yes to continue: ",
    ]);
    // Each part is said as it runs: the store's first, then the source's.
    const after = real.stdout.slice(real.stdout.indexOf("Migrated the FacetDB store"));
    expect(after).toBe(
      "Migrated the FacetDB store on localhost:5432/facetdb.\nInstalled on public.listings (source listings).\n",
    );
    expect(await columns()).toEqual(expect.arrayContaining(["is_scam", "category"]));
    const versions = await world.client.query(
      "select count(*)::int as n from facetdb.store_migrations",
    );
    expect(versions[0]?.["n"]).toBeGreaterThan(0);
  });

  it("says a current store is current instead of showing DDL that will not run, and never reports it applied", async () => {
    expect((await runWithStore(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const dry = await runWithStore(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(
      dry.stdout.startsWith(
        "-- store: localhost:5432/facetdb\n-- the FacetDB store is current: nothing to run there\n-- source listings: localhost:5432/app\n",
      ),
    ).toBe(true);
    expect(dry.stdout).not.toContain("create table if not exists facetdb.decisions");

    const real = await runWithStore(["migrate", "--json", "--admin-url", ADMIN_URL], ["yes"]);
    expect(real.code, real.stderr).toBe(0);
    // Nothing runs on the store, so the confirmation names the source's database alone.
    expect(real.prompts).toEqual([
      "Run the SQL above on localhost:5432/app? Type yes to continue: ",
    ]);
    expect(real.stderr).toContain(
      "The FacetDB store on localhost:5432/facetdb was current: nothing ran there.",
    );
    const parsed = JSON.parse(real.stdout) as {
      store: { current: boolean; sql: string; applied: boolean };
      sources: { applied: boolean }[];
    };
    expect(parsed.store).toEqual({
      database: "localhost:5432/facetdb",
      current: true,
      sql: "",
      applied: false,
    });
    expect(parsed.sources[0]?.applied).toBe(true);
  });

  it("refuses a store newer than this FacetDB before the confirmation, and runs nothing", async () => {
    expect((await runWithStore(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const newest = await world.client.query(
      "select max(version)::int as v from facetdb.store_migrations",
    );
    const newer = Number(newest[0]?.["v"]) + 1;
    await world.client.query("insert into facetdb.store_migrations (version) values ($1)", [newer]);
    const result = await runWithStore(["migrate", "--admin-url", ADMIN_URL], ["yes"]);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain(
      `error: the FacetDB store on localhost:5432/facetdb is at schema version ${newer}, newer than this FacetDB knows (${newer - 1}); nothing was run`,
    );
    expect(result.stderr).toContain(
      "fix: upgrade FacetDB to the version that wrote the store, then run facetdb migrate again",
    );
    expect(result.stdout).not.toContain("-- store:");
  });

  it("a source refused after the store's migration ran says the store moved", async () => {
    // The second connection to the store is the run's; once it closes, the source's table is
    // renamed, so the source's part is refused after the store's part has committed.
    let storeConnections = 0;
    const connect: SqlConnect = (url, options) => {
      const inner = world.connect(url, options);
      if (url !== STORE_URL) {
        return inner;
      }
      storeConnections += 1;
      const runStep = storeConnections === 2;
      return {
        ...inner,
        close: async () => {
          await inner.close();
          if (runStep) {
            await world.client.query("alter table public.listings rename to listings_old");
          }
        },
      };
    };
    const result = await runInProcess(
      ["migrate", "--yes", "--json", "--admin-url", ADMIN_URL],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: STORE_URL },
        loadConfig: () => Promise.resolve(ownVariable),
        engines: postgresEngines(connect),
        connect,
      },
      COMMANDS,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Migrated the FacetDB store on localhost:5432/facetdb.");
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
      details: unknown;
    };
    expect(parsed.error.message).toContain(
      "Already run in this run, before this, and kept: the FacetDB store's migration on localhost:5432/facetdb.",
    );
    expect(parsed.error.message).not.toContain("nothing was run");
    expect(parsed.details).toEqual({ storeMigrated: "localhost:5432/facetdb", installed: [] });
    const versions = await world.client.query(
      "select count(*)::int as n from facetdb.store_migrations",
    );
    expect(versions[0]?.["n"]).toBeGreaterThan(0);
  });

  it("refuses a source of another kind that reads DATABASE_URL, the store's variable, before anything connects", async () => {
    const MYSQL_URL = "mysql://facetdb_worker:s3cret-mysql@db.example.com/shop";
    const mysql = lazyEngine("mysql", () =>
      Promise.resolve(new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"] })),
    );
    const noConnection: SqlConnect = (url) => {
      throw new Error(`a connection was opened to ${url}`);
    };
    const readsStore: ProjectConfig = {
      ...fullConfig,
      sources: fullConfig.sources.map((source) => ({
        ...source,
        database: MYSQL_URL,
        databaseEnv: "DATABASE_URL",
      })),
    };
    const result = await runInProcess(
      ["migrate", "--dry-run", "--admin-url", "mysql://root:s3cret-root@db.example.com/shop"],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: MYSQL_URL },
        loadConfig: () => Promise.resolve(readsStore),
        engines: [...postgresEngines(noConnection), mysql],
        connect: noConnection,
      },
      COMMANDS,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `error: the source "listings" reads DATABASE_URL, the store's variable, and its database is not a Postgres (mysql); the FacetDB store is always a Postgres, so a source of another kind reads a variable of its own`,
    );
    expect(result.stderr).toContain(
      "fix: write database: process.env.LISTINGS_URL for the source in facetdb.config.ts, set LISTINGS_URL to its connection string, and point DATABASE_URL at the store's Postgres",
    );
    expect(result.stdout + result.stderr).not.toContain("s3cret");
  });

  it("refuses a source on its own variable with no DATABASE_URL, and a PGlite store, before anything connects", async () => {
    const noConnection: SqlConnect = (url) => {
      throw new Error(`a connection was opened to ${url}`);
    };
    const unset = await runInProcess(
      ["migrate", "--dry-run", "--admin-url", ADMIN_URL],
      {
        projectDir: PROJECT_DIR,
        env: {},
        loadConfig: () => Promise.resolve(ownVariable),
        engines: postgresEngines(noConnection),
        connect: noConnection,
      },
      COMMANDS,
    );
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain(
      "error: DATABASE_URL is not set, so FacetDB has no database for its store",
    );
    const pglite = await runInProcess(
      ["migrate", "--dry-run", "--admin-url", ADMIN_URL],
      {
        projectDir: PROJECT_DIR,
        env: { DATABASE_URL: "pglite://.facetdb/dev" },
        loadConfig: () => Promise.resolve(ownVariable),
        engines: postgresEngines(noConnection),
        connect: noConnection,
      },
      COMMANDS,
    );
    expect(pglite.code).toBe(1);
    expect(pglite.stderr).toContain(
      "error: a PGlite store is for facetdb dev; point DATABASE_URL at a Postgres",
    );
  });
});

describe("the admin password never travels in the clear to another machine", () => {
  const REMOTE_PLAIN = "postgres://admin:s3cret-admin-password@db.example.com/x";

  /** A driver that fails the test when anything connects: the refusal comes before any connection. */
  const noConnection: SqlConnect = (url) => {
    throw new Error(`a connection was opened to ${url}`);
  };

  it.each([
    ["migrate", ["migrate", "--yes"]],
    ["migrate --dry-run", ["migrate", "--dry-run"]],
    ["uninstall", ["uninstall"]],
  ])("%s refuses a plaintext remote admin URL before any connection", async (_name, argv) => {
    const result = await run([...argv, "--admin-url", REMOTE_PLAIN], { connect: noConnection });
    expect(result.code, result.stdout).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "error: the admin connection string reaches db.example.com without TLS, so the admin password would travel in the clear; no connection was made",
    );
    expect(result.stderr).toContain("?sslmode=require");
    expect(result.stderr).toContain("--allow-insecure");
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/admin-url-tls");
    expect(result.stderr).not.toContain("s3cret-admin-password");
    expect(await facetdbSchemaExists()).toBe(false);
  });

  it("refuses a URL typed at the prompt too", async () => {
    const result = await run(["migrate", "--yes"], {
      connect: noConnection,
      answers: [REMOTE_PLAIN],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("would travel in the clear");
  });

  it("asks for TLS with sslmode=require, and with ssl=true", async () => {
    for (const query of ["?sslmode=require", "?sslmode=verify-full", "?ssl=true"]) {
      const result = await run(["migrate", "--dry-run", "--admin-url", `${REMOTE_PLAIN}${query}`]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  it("is not asked of a loopback host", async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const result = await run([
        "migrate",
        "--dry-run",
        "--admin-url",
        `postgres://admin:s3cret-admin-password@${host}:5432/app`,
      ]);
      expect(result.code, result.stderr).toBe(0);
    }
  });

  it("--allow-insecure turns the rule off, dry run and real run alike", async () => {
    const dry = await run([
      "migrate",
      "--dry-run",
      "--allow-insecure",
      "--admin-url",
      REMOTE_PLAIN,
    ]);
    expect(dry.code, dry.stderr).toBe(0);
    const real = await run(["migrate", "--yes", "--allow-insecure", "--admin-url", REMOTE_PLAIN]);
    expect(real.code, real.stderr).toBe(0);
    expect(await columns()).toEqual(expect.arrayContaining(["is_scam", "category"]));
  });

  it("--allow-insecure on uninstall lets a trusted network through", async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
    const result = await run(
      ["uninstall", "--dry-run", "--allow-insecure", "--admin-url", REMOTE_PLAIN],
      {},
    );
    expect(result.code, result.stderr).toBe(0);
  });
});

describe("facetdb uninstall", () => {
  beforeEach(async () => {
    expect((await run(["migrate", "--yes", "--admin-url", ADMIN_URL])).code).toBe(0);
  });

  it("runs nothing when the typed name is not the project's", async () => {
    const before = await columns();
    const { connect, transactions } = recordingConnect();
    const result = await run(["uninstall", "--admin-url", ADMIN_URL], {
      connect,
      answers: ["listings"],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('drop column "is_scam"');
    expect(result.prompts[0]).toContain("Type the project name (listings-app)");
    expect(result.stderr).toContain("nothing was changed");
    expect(result.stderr).toContain("https://docs.facetdb.dev/fix/not-confirmed");
    expect(transactions).toEqual([]);
    expect(await columns()).toEqual(before);
  });

  it("prints and stops on a dry run", async () => {
    const before = await columns();
    const result = await run(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("Dry run: nothing was changed.");
    expect(await columns()).toEqual(before);
  });

  it("removes what install added once the project name is typed back", async () => {
    const result = await run(["uninstall", "--admin-url", ADMIN_URL], {
      answers: ["listings-app"],
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await columns()).toEqual(["id", "title", "description"]);
  });

  it("passes --purge through to the script", async () => {
    await registerSource();
    const kept = await run(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);
    const purged = await run(["uninstall", "--dry-run", "--purge", "--admin-url", ADMIN_URL]);
    expect(kept.stdout).not.toContain("delete from facetdb.decisions");
    expect(purged.stdout).toContain("delete from facetdb.decisions");
  });
});
