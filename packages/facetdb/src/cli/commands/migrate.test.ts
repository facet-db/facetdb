import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import type { SqlConnect } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig, type SourceInput } from "../../config/index.ts";
import { runInProcess, runProgram } from "../program.ts";
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

let world: PgliteWorld;

beforeEach(async () => {
  world = await createPgliteWorld();
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text)",
  );
  await world.client.query("insert into public.listings (id, title) values ('1', 'A bike')");
});

afterEach(async () => {
  await world.close();
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
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(options.config ?? fullConfig),
      connect: options.connect ?? world.connect,
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

/** Runs a command and records, at each prompt, everything printed so far: what the user had seen. */
async function runSeeingPrompts(argv: readonly string[], answers: readonly string[]) {
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
      },
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(fullConfig),
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
    // Connections: 0 checks the worker role, 1 is the dry run, 2 the run; before 2, the key changes.
    const { connect, transactions } = recordingConnect(async (index) => {
      if (index === 2) {
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

  it("never prints a raw probability", async () => {
    const result = await run(["migrate", "--dry-run", "--admin-url", ADMIN_URL]);
    expect(result.stdout).not.toContain("noul=");
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
    const kept = await run(["uninstall", "--dry-run", "--admin-url", ADMIN_URL]);
    const purged = await run(["uninstall", "--dry-run", "--purge", "--admin-url", ADMIN_URL]);
    expect(kept.stdout).not.toContain("delete from facetdb.decisions");
    expect(purged.stdout).toContain("delete from facetdb.decisions");
  });
});
