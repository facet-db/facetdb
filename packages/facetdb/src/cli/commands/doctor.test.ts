import { HEARTBEAT_LOSS_MS } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { createStore, type SqlConnect, WORKER_ROLE } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  choice,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceInput,
} from "../../config/index.ts";
import { CliError, runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb doctor` through the in-process runner: PGlite holds the database (installed by the real
 * `facetdb migrate`, then damaged one way at a time), the store the worker would have made holds the
 * heartbeat (doctor reads it with one select and never opens the store),
 * a fake clock ages it, and a scripted fake provider stands in for the model. Each check has a
 * test that makes it, and only it, fail.
 */

const ADMIN_URL = "postgres://admin:s3cret-admin-password@localhost:5432/app";
const WORKER_URL = `postgres://${WORKER_ROLE}:s3cret-worker-password@localhost:5432/app`;
/** The project directory's name is the project's id: the heartbeat's key. */
const PROJECT_DIR = "/work/listings-app";
const PROJECT_ID = "listings-app";
const SECRET = "a-long-random-secret-for-doctor-tests";
const START = 10_000_000;

function configWith(
  source: Partial<SourceInput> = {},
  project: { readonly modelUrl?: string } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(project.modelUrl === undefined ? {} : { modelUrl: project.modelUrl }),
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["title", "description"],
        questions: {
          is_scam: noul("Is this listing a scam?"),
          category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
        },
        ...source,
      },
    ],
  });
}

let world: PgliteWorld;
const clock = new FakeClock(START);

/**
 * One installed database for the whole file, built once by the real `facetdb migrate` (installing
 * is the slow part): `listings` inline, `gadgets` in side-table mode. Each test runs inside a
 * transaction and damages the install in it, and the rollback after puts it back.
 */
beforeAll(async () => {
  world = await createPgliteWorld();
  await world.client.query(
    "create table public.listings (id text primary key, title text not null, description text)",
  );
  await world.client.query(
    "create table public.gadgets (id text primary key, title text not null, description text)",
  );
  const installed = [
    configWith(),
    configWith({ name: "gadgets", table: "gadgets", storage: "side-table" }),
  ];
  for (const config of installed) {
    await install(config);
  }
  // The store as its owner login made it; the operator then lets the worker login read the heartbeats.
  const store = await createStore({ pglite: world.db, secret: SECRET, clock });
  await store.close();
  await world.client.query(`grant select on facetdb.heartbeats to ${WORKER_ROLE}`);
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await world.db.exec("begin");
});

afterEach(async () => {
  await world.db.exec("rollback");
});

/** The connection a worker login would get: the same engine, with its privileges for the session. */
function asWorker(role: string | null = WORKER_ROLE): SqlConnect {
  return () => {
    let entered: Promise<unknown> | undefined;
    const enter = () => {
      entered ??= role === null ? Promise.resolve() : world.client.query(`set role ${role}`);
      return entered;
    };
    return {
      query: async (text, params) => {
        await enter();
        // The test wraps everything in one transaction; a savepoint lets a failed query leave the
        // connection usable, as it is on a real one.
        await world.client.query("savepoint doctor_query");
        try {
          const rows = await world.client.query(text, params);
          await world.client.query("release savepoint doctor_query");
          return rows;
        } catch (error) {
          await world.client.query("rollback to savepoint doctor_query");
          throw error;
        }
      },
      transaction: async (work) => {
        await enter();
        return world.client.transaction(work);
      },
      close: async () => {
        await world.client.query("reset role");
      },
    };
  };
}

/** Installs with the real `facetdb migrate`, as the admin. */
async function install(config: ProjectConfig): Promise<void> {
  const result = await runInProcess(
    ["migrate", "--yes", "--admin-url", ADMIN_URL],
    {
      projectDir: PROJECT_DIR,
      env: {},
      loadConfig: () => Promise.resolve(config),
      connect: world.connect,
    },
    COMMANDS,
  );
  expect(result.code, result.stderr).toBe(0);
}

/** A model that answers every question with certainty, so doctor's tiny question gets an answer. */
function fakeModel(script: Parameters<typeof createFakeProvider>[0] = {}): FakeProvider {
  return createFakeProvider({ defaults: { noul: 0.9 }, ...script });
}

const goodEnv = {
  DATABASE_URL: WORKER_URL,
  FACETDB_SECRET: SECRET,
  TYPESAFE_API_KEY: "tsk-s3cret-model-key",
};

type Setup = {
  readonly config?: ProjectConfig;
  readonly env?: Record<string, string | undefined>;
  readonly connect?: SqlConnect;
  readonly provider?: FakeProvider;
  readonly loadConfig?: () => Promise<ProjectConfig>;
  /** The project directory, whose name is the project's id; the default one has a heartbeat saved. */
  readonly projectDir?: string;
};

function doctor(argv: readonly string[], setup: Setup = {}) {
  const provider = setup.provider ?? fakeModel();
  return runInProcess(
    ["doctor", ...argv],
    {
      projectDir: setup.projectDir ?? PROJECT_DIR,
      env: setup.env ?? goodEnv,
      loadConfig: setup.loadConfig ?? (() => Promise.resolve(setup.config ?? configWith())),
      connect: setup.connect ?? asWorker(),
      provider: () => provider,
      clock,
    },
    COMMANDS,
  );
}

/** The report's lines, without the heading words: `["ok  config: …", …]`. */
function lines(stdout: string): string[] {
  return stdout.split("\n").filter((text) => text !== "");
}

function lineFor(stdout: string, label: string): string {
  const found = lines(stdout).find((text) => text.slice(6).startsWith(`${label}:`));
  if (found === undefined) {
    throw new Error(`no line for ${label} in:\n${stdout}`);
  }
  return found;
}

async function beat(msAgo: number): Promise<void> {
  await world.client.query(
    `insert into facetdb.heartbeats (project, at) values ($1, $2)
     on conflict (project) do update set at = excluded.at`,
    [PROJECT_ID, clock.now() - msAgo],
  );
}

describe("facetdb doctor, when everything is in place", () => {
  it("prints one ok line per check in order, exits 0, and asks the model one tiny question", async () => {
    await beat(30_000);
    const provider = fakeModel();
    const result = await doctor([], { provider });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const printed = lines(result.stdout);
    expect(
      printed.slice(0, -1).map((text) => text.slice(0, 6) + text.slice(6).split(":")[0]),
    ).toEqual([
      "ok    config",
      "ok    database",
      "ok    install",
      "ok    worker heartbeat",
      "ok    model key",
      "ok    model reachable",
      "ok    FACETDB_SECRET",
    ]);
    expect(printed.at(-1)).toBe("All 7 checks passed.");
    expect(lineFor(result.stdout, "worker heartbeat")).toContain("30 seconds ago");
    expect(lineFor(result.stdout, "database")).toContain(`logged in as ${WORKER_ROLE}`);
    expect(provider.callCount).toBe(1);
    expect(provider.requests[0]?.model).toBe("jev-1.14.0");
    expect(result.stderr).toBe("");
  });

  it("never prints a secret", async () => {
    await beat(0);
    const result = await doctor([]);
    const everything = result.stdout + result.stderr;
    for (const secret of ["s3cret-worker-password", "s3cret-model-key", SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("--json lists every check as data", async () => {
    await beat(1000);
    const result = await doctor(["--json"]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { id: string; status: string }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((check) => `${check.id}:${check.status}`)).toEqual([
      "config:ok",
      "database:ok",
      "install:ok",
      "worker:ok",
      "model-key:ok",
      "model-reachable:ok",
      "secret:ok",
    ]);
  });

  it("checks a side-table install on the side table's columns", async () => {
    const config = configWith({ name: "gadgets", table: "gadgets", storage: "side-table" });
    await beat(0);
    const result = await doctor([], { config });
    expect(result.code, result.stdout + result.stderr).toBe(0);

    await world.client.query("alter table facetdb.gadgets_answers drop column category cascade");
    const broken = await doctor([], { config });
    expect(broken.code).toBe(1);
    expect(lineFor(broken.stdout, "install")).toContain(
      "facetdb.gadgets_answers lacks the answer columns category",
    );
  });

  it("is fine with no table source at all: an API source has nothing to install", async () => {
    await beat(0);
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "tickets",
          api: true,
          read: ["subject"],
          questions: { urgent: noul("Is this urgent?") },
        },
      ],
    });
    const result = await doctor([], { config });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(lineFor(result.stdout, "database")).toContain("no source reads a table");
  });
});

describe("facetdb doctor names the first failing check and says how to fix it", () => {
  it("config: a config that does not load fails first, and the checks that need it are skipped", async () => {
    const result = await doctor([], {
      loadConfig: () =>
        Promise.reject(
          new ConfigError([{ path: "sources[0].questions.urgency", message: "is not a question" }]),
        ),
    });
    expect(result.code).toBe(1);
    const config = lineFor(result.stdout, "config");
    expect(config).toMatch(/^FAIL/);
    expect(config).toContain("sources[0].questions.urgency: is not a question");
    expect(config).toContain("Fix: do what each problem says in facetdb.config.ts");
    expect(lineFor(result.stdout, "database")).toMatch(/^skip.*the config did not load/);
    expect(lineFor(result.stdout, "install")).toMatch(/^skip/);
    expect(lineFor(result.stdout, "model reachable")).toMatch(/^skip/);
    // The secret needs no config, so it is still checked.
    expect(lineFor(result.stdout, "FACETDB_SECRET")).toMatch(/^ok/);
    expect(result.stderr).toContain("error: the config check failed:");
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/doctor-config");
  });

  it("config: a file that cannot be read says so", async () => {
    const result = await doctor([], {
      loadConfig: () => Promise.reject(new Error("no such file")),
    });
    expect(result.code).toBe(1);
    expect(lineFor(result.stdout, "config")).toContain("could not be read: no such file");
  });

  it("database: a connection that fails, with the password left out", async () => {
    const result = await doctor([], {
      connect: () => {
        throw new CliError("x", `connect ECONNREFUSED using ${WORKER_URL}`, "n/a");
      },
    });
    expect(result.code).toBe(1);
    const database = lineFor(result.stdout, "database");
    expect(database).toMatch(/^FAIL/);
    expect(database).toContain('"listings" cannot connect to localhost:5432/app');
    expect(database).toContain("ECONNREFUSED");
    expect(result.stdout + result.stderr).not.toContain("s3cret-worker-password");
    expect(result.stderr).toContain("error: the database check failed:");
    expect(lineFor(result.stdout, "install")).toMatch(/^skip.*database check did not pass/);
  });

  it("database: a pooler-suffixed worker login passes and the line names the suffix", async () => {
    await beat(0);
    const pooled = configWith({
      database: `postgres://${WORKER_ROLE}.jkqrabcd:s3cret-worker-password@aws-0.pooler.supabase.com:5432/postgres?sslmode=require`,
    });
    const result = await doctor([], { config: pooled });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const database = lineFor(result.stdout, "database");
    expect(database).toMatch(/^ok/);
    expect(database).toContain(
      `logged in as ${WORKER_ROLE} (through a pooler as ${WORKER_ROLE}.jkqrabcd)`,
    );
    expect(result.stdout + result.stderr).not.toContain("s3cret-worker-password");
  });

  it("database: a login that is not the worker's", async () => {
    const result = await doctor([], { connect: asWorker(null) });
    expect(result.code).toBe(1);
    const database = lineFor(result.stdout, "database");
    expect(database).toContain(
      `logs in as postgres on localhost:5432/app, not as the worker login ${WORKER_ROLE}`,
    );
    expect(database).toContain(
      `postgres://${WORKER_ROLE}:<a long random password>@<host>/<database>`,
    );
  });

  it("database: a connection string the environment does not hold", async () => {
    const { database: _written, ...rest } = configWith()
      .sources[0] as ProjectConfig["sources"][number];
    const config: ProjectConfig = {
      ...configWith(),
      sources: [{ ...rest, databaseEnv: "LISTINGS_URL" }],
    };
    const result = await doctor([], { config, env: { ...goodEnv, DATABASE_URL: undefined } });
    expect(result.code).toBe(1);
    expect(lineFor(result.stdout, "database")).toContain(
      'LISTINGS_URL is not set, so "listings" has no database to connect to',
    );
    expect(lineFor(result.stdout, "database")).toContain("Fix: set LISTINGS_URL to postgres://");
  });

  describe("install", () => {
    beforeEach(async () => {
      await beat(0);
    });

    async function installLine(config: ProjectConfig = configWith()): Promise<string> {
      const result = await doctor([], { config });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("error: the install check failed:");
      return lineFor(result.stdout, "install");
    }

    it("the schema is missing", async () => {
      await world.client.query("drop schema facetdb cascade");
      expect(await installLine()).toContain("listings: the facetdb schema does not exist");
    });

    it("the jobs table is missing", async () => {
      await world.client.query("drop table facetdb.jobs cascade");
      const line = await installLine();
      expect(line).toContain("listings: the jobs table facetdb.jobs does not exist");
      expect(line).toContain("Fix: run facetdb migrate");
    });

    it("the trigger is missing", async () => {
      await world.client.query("drop trigger facetdb_listings on public.listings");
      expect(await installLine()).toContain(
        "public.listings has no trigger facetdb_listings, so changes are not queued",
      );
    });

    it("the trigger is disabled", async () => {
      await world.client.query("alter table public.listings disable trigger facetdb_listings");
      expect(await installLine()).toContain(
        "the trigger facetdb_listings on public.listings is disabled",
      );
    });

    it("the trigger watches other columns than the questions read", async () => {
      expect(await installLine(configWith({ read: ["title"] }))).toContain(
        "the trigger on public.listings watches description,title, not the columns the questions read (title)",
      );
    });

    it("an answer column is missing", async () => {
      await world.client.query("alter table public.listings drop column category");
      expect(await installLine()).toContain("public.listings lacks the answer columns category");
    });

    it("the table itself is gone", async () => {
      await world.client.query("drop table public.listings cascade");
      expect(await installLine()).toContain("the table public.listings does not exist");
    });

    it("nothing was ever installed", async () => {
      await world.client.query("drop schema facetdb cascade");
      await world.client.query("drop trigger if exists facetdb_listings on public.listings");
      await world.client.query("alter table public.listings drop column category");
      const line = await installLine();
      expect(line).toContain("the facetdb schema does not exist");
      expect(line).toContain("has no trigger");
      expect(line).toContain("lacks the answer columns");
    });
  });

  describe("worker heartbeat", () => {
    beforeEach(async () => {});

    it("the worker has never reported", async () => {
      // A project directory no other test beats for: the store is shared across the file.
      const result = await doctor([], { projectDir: "/work/never-ran" });
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "worker heartbeat");
      expect(line).toMatch(/^FAIL/);
      expect(line).toContain("has never sent a heartbeat");
      expect(line).toContain("Fix: start it with facetdb worker");
      expect(result.stderr).toContain("error: the worker heartbeat check failed:");
    });

    it("the last heartbeat is older than two minutes", async () => {
      await beat(HEARTBEAT_LOSS_MS + 180_000);
      const result = await doctor([]);
      expect(result.code).toBe(1);
      expect(lineFor(result.stdout, "worker heartbeat")).toContain(
        "the last heartbeat was 5 minutes ago, and a worker counts as down after 2 minutes",
      );
    });

    it("exactly two minutes is already down; just under is alive", async () => {
      await beat(HEARTBEAT_LOSS_MS);
      expect((await doctor([])).code).toBe(1);
      await beat(HEARTBEAT_LOSS_MS - 1);
      expect((await doctor([])).code).toBe(0);
    });

    const schemaObjects =
      "select count(*)::int as n from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace where s.nspname = 'facetdb'";

    it("DATABASE_URL is not set: the check says so and what to set", async () => {
      const result = await doctor([], { env: { ...goodEnv, DATABASE_URL: undefined } });
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "worker heartbeat");
      expect(line).toMatch(/^FAIL.*DATABASE_URL is not set/);
      expect(line).toContain("Fix: set DATABASE_URL");
    });

    it("reads with one select as the worker login: no store is opened and nothing is created", async () => {
      await beat(30_000);
      // The runner's default `store` rejects when called, and the worker login cannot create
      // anything in the facetdb schema: the check passes only by reading.
      const before = await world.client.query(schemaObjects);
      const result = await doctor([]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(lineFor(result.stdout, "worker heartbeat")).toContain("30 seconds ago");
      expect(await world.client.query(schemaObjects)).toEqual(before);
    });

    it("an owner login does not create the store: with none yet, the check fails and the schema stays absent", async () => {
      await world.client.query("drop schema facetdb cascade");
      const result = await doctor([], { connect: asWorker(null) });
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "worker heartbeat");
      expect(line).toMatch(/^FAIL.*no heartbeats table/);
      expect(line).toContain("Fix: run facetdb migrate");
      const schema = await world.client.query("select to_regnamespace('facetdb')::text as name");
      expect(schema[0]?.["name"]).toBeNull();
    });

    it("a login that may not read the heartbeats: says so and what to grant", async () => {
      await world.client.query(`revoke select on facetdb.heartbeats from ${WORKER_ROLE}`);
      const result = await doctor([]);
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "worker heartbeat");
      expect(line).toMatch(/^FAIL.*may not read the store's heartbeats/);
      expect(line).toContain("Fix: grant select on facetdb.heartbeats");
    });

    it("the read fails some other way, with the connection string and secret left out", async () => {
      const worker = asWorker()(WORKER_URL);
      const result = await doctor([], {
        connect: () => ({
          ...worker,
          query: (text, params) =>
            text.includes("facetdb.heartbeats")
              ? Promise.reject(new Error(`connection to ${WORKER_URL} lost; key ${SECRET}`))
              : worker.query(text, params),
        }),
      });
      expect(result.code).toBe(1);
      expect(lineFor(result.stdout, "worker heartbeat")).toContain("the store could not be read");
      expect(result.stdout + result.stderr).not.toContain("s3cret-worker-password");
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    });

    it("needs no FACETDB_SECRET: it is still read, and only the secret check fails", async () => {
      await beat(0);
      const result = await doctor([], { env: { ...goodEnv, FACETDB_SECRET: undefined } });
      expect(result.code).toBe(1);
      expect(lineFor(result.stdout, "worker heartbeat")).toMatch(/^ok/);
      expect(lineFor(result.stdout, "FACETDB_SECRET")).toMatch(/^FAIL/);
      expect(result.stderr).toContain("error: the FACETDB_SECRET check failed:");
    });
  });

  describe("model", () => {
    beforeEach(async () => {
      await beat(0);
    });

    it("the model key is missing: the reachability check is not attempted", async () => {
      const provider = fakeModel();
      const result = await doctor([], {
        provider,
        env: { ...goodEnv, TYPESAFE_API_KEY: undefined },
      });
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "model key");
      expect(line).toMatch(/^FAIL/);
      expect(line).toContain("TYPESAFE_API_KEY is not set");
      expect(line).toContain("or set modelUrl in the config to a compatible server");
      expect(lineFor(result.stdout, "model reachable")).toMatch(
        /^skip.*model key check did not pass/,
      );
      expect(provider.callCount).toBe(0);
      expect(result.stderr).toContain("error: the model key check failed:");
    });

    it("an empty key counts as missing", async () => {
      const result = await doctor([], { env: { ...goodEnv, TYPESAFE_API_KEY: "" } });
      expect(result.code).toBe(1);
      expect(lineFor(result.stdout, "model key")).toMatch(/^FAIL/);
    });

    it("a compatible server needs no TypeSafe key", async () => {
      const provider = fakeModel();
      const result = await doctor([], {
        provider,
        config: configWith({}, { modelUrl: "http://localhost:11434" }),
        env: { ...goodEnv, TYPESAFE_API_KEY: undefined },
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(lineFor(result.stdout, "model key")).toContain("http://localhost:11434");
      expect(provider.callCount).toBe(1);
    });

    it("the provider cannot be reached, and the key is left out of the message", async () => {
      const failing = fakeModel({ failures: { 0: { kind: "timeout" } } });
      const result = await doctor([], { provider: failing });
      expect(result.code).toBe(1);
      const line = lineFor(result.stdout, "model reachable");
      expect(line).toMatch(/^FAIL/);
      expect(line).toContain("the model did not answer");
      expect(line).toContain("facetdb doctor --offline");
      expect(result.stderr).toContain("error: the model reachable check failed:");
      expect(result.stdout + result.stderr).not.toContain("s3cret-model-key");
    });

    it("a provider that throws because no key reached it is the same failure, in words", async () => {
      const result = await doctor([], {
        provider: {
          callCount: 0,
          requests: [],
          ask: () => Promise.reject(new Error("401 for key tsk-s3cret-model-key")),
        },
      });
      expect(result.code).toBe(1);
      expect(lineFor(result.stdout, "model reachable")).toContain("401 for key ***");
    });

    it("--offline leaves the network check out and passes", async () => {
      const provider = fakeModel({ failures: { 0: { kind: "timeout" } } });
      const result = await doctor(["--offline"], { provider });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(lineFor(result.stdout, "model reachable")).toMatch(/^skip.*--offline/);
      expect(provider.callCount).toBe(0);
    });
  });

  it("FACETDB_SECRET: not set", async () => {
    await beat(0);
    const result = await doctor([], { env: { ...goodEnv, FACETDB_SECRET: "" } });
    expect(result.code).toBe(1);
    const line = lineFor(result.stdout, "FACETDB_SECRET");
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("openssl rand -hex 32");
  });
});

describe("facetdb doctor, TLS to a remote database", () => {
  const REMOTE_PLAIN = `postgres://${WORKER_ROLE}:s3cret-worker-password@db.example.com/x`;

  /** Every URL a connection was opened to, wrapped around the real fake database. */
  function watching(): { readonly connect: SqlConnect; readonly urls: string[] } {
    const urls: string[] = [];
    const inner = asWorker();
    return {
      urls,
      connect: (url) => {
        urls.push(url);
        return inner(url);
      },
    };
  }

  it("fails the database check on a plaintext remote URL, naming the variable, before connecting", async () => {
    const seen = watching();
    const result = await doctor(["--offline"], {
      config: configWith({ database: REMOTE_PLAIN }),
      connect: seen.connect,
    });
    expect(result.code).toBe(1);
    const database = lineFor(result.stdout, "database");
    expect(database).toMatch(/^FAIL/);
    expect(database).toContain(
      '"listings": DATABASE_URL reaches db.example.com without TLS, so the password in it would travel in the clear',
    );
    expect(database).toContain(
      "Fix: add ?sslmode=require to DATABASE_URL, or pass --allow-insecure if that network is trusted.",
    );
    // The store's own words ("set allowInsecure") are not a CLI instruction.
    expect(database).not.toContain("set allowInsecure");
    expect(lineFor(result.stdout, "install")).toMatch(/^skip/);
    expect(seen.urls.filter((url) => url.includes("db.example.com"))).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("s3cret-worker-password");
  });

  it("names the variable the source reads, not DATABASE_URL, when the config says another", async () => {
    // What the loader makes of `database: process.env.LISTINGS_URL`: the variable's name, and the value read.
    const base = configWith();
    const config: ProjectConfig = {
      ...base,
      sources: base.sources.map(({ database: _database, ...source }) => ({
        ...source,
        database: REMOTE_PLAIN,
        databaseEnv: "LISTINGS_URL",
      })),
    };
    const result = await doctor(["--offline"], { config });
    const database = lineFor(result.stdout, "database");
    expect(database).toContain('"listings": LISTINGS_URL reaches db.example.com without TLS');
    expect(database).toContain(
      "Fix: add ?sslmode=require to LISTINGS_URL, or pass --allow-insecure if that network is trusted.",
    );
  });

  it("fails the worker heartbeat check when DATABASE_URL is a plaintext remote URL", async () => {
    const seen = watching();
    const result = await doctor(["--offline"], {
      env: { ...goodEnv, DATABASE_URL: REMOTE_PLAIN },
      connect: seen.connect,
    });
    expect(result.code).toBe(1);
    const heartbeat = lineFor(result.stdout, "worker heartbeat");
    expect(heartbeat).toMatch(/^FAIL/);
    expect(heartbeat).toContain("DATABASE_URL reaches db.example.com without TLS");
    expect(heartbeat).toContain("Fix: add ?sslmode=require to DATABASE_URL");
    expect(seen.urls).not.toContain(REMOTE_PLAIN);
  });

  it("passes with ?sslmode=require, and on a loopback host without it", async () => {
    await beat(0);
    const remote = await doctor([], {
      config: configWith({ database: `${REMOTE_PLAIN}?sslmode=require` }),
      env: { ...goodEnv, DATABASE_URL: `${REMOTE_PLAIN}?sslmode=require` },
    });
    expect(remote.code, remote.stdout + remote.stderr).toBe(0);
    expect(lineFor(remote.stdout, "database")).toContain("listings on db.example.com/x");
    const local = await doctor([]);
    expect(local.code, local.stdout + local.stderr).toBe(0);
  });

  it("--allow-insecure passes a plaintext remote URL on a trusted network", async () => {
    await beat(0);
    const result = await doctor(["--allow-insecure"], {
      config: configWith({ database: REMOTE_PLAIN }),
      env: { ...goodEnv, DATABASE_URL: REMOTE_PLAIN },
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(lineFor(result.stdout, "database")).toMatch(/^ok/);
  });
});

/** The connection of `asWorker`, whose `select 1` round trips take the given milliseconds on the fake clock. */
function farAway(trips: readonly number[]): SqlConnect {
  const inner = asWorker();
  return (url) => {
    const connection = inner(url);
    let taken = 0;
    return {
      ...connection,
      query: (text, params) => {
        if (text === "select 1") {
          clock.advance(trips[taken % trips.length] ?? 0);
          taken += 1;
        }
        return connection.query(text, params);
      },
    };
  };
}

describe("facetdb doctor, how far the database is", () => {
  it("prints the median of three round trips on the database line, with no warning when near", async () => {
    await beat(0);
    const result = await doctor([], { connect: farAway([12]) });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(lineFor(result.stdout, "database")).toContain(
      "listings on localhost:5432/app (round trip 12 ms)",
    );
    expect(lines(result.stdout).some((text) => text.startsWith("warn"))).toBe(false);
    expect(lines(result.stdout).at(-1)).toBe("All 7 checks passed.");
  });

  it("takes the median, so one slow trip does not decide", async () => {
    await beat(0);
    const result = await doctor([], { connect: farAway([300, 12, 14]) });
    expect(lineFor(result.stdout, "database")).toContain("round trip 14 ms");
    expect(lines(result.stdout).some((text) => text.startsWith("warn"))).toBe(false);
  });

  it("at 190 ms adds a warn line after the database line, and the exit code stays 0", async () => {
    await beat(0);
    const result = await doctor([], { connect: farAway([190]) });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(lineFor(result.stdout, "database")).toMatch(/^ok.*round trip 190 ms/);
    const printed = lines(result.stdout);
    const warn = printed.findIndex((text) => text.startsWith("warn"));
    expect(printed[warn]).toBe(
      "warn  distance: the database is 190 ms away; run the worker next to it, the 1 second target assumes a same-region link",
    );
    expect(printed[warn - 1]).toMatch(/^ok\s+database:/);
    expect(printed.at(-1)).toBe("All 7 checks passed.");
    expect(result.stderr).toBe("");
  });

  it("100 ms is not far; 101 ms is", async () => {
    await beat(0);
    const edge = await doctor([], { connect: farAway([100]) });
    expect(lines(edge.stdout).some((text) => text.startsWith("warn"))).toBe(false);
    const over = await doctor([], { connect: farAway([101]) });
    expect(lines(over.stdout).some((text) => text.startsWith("warn"))).toBe(true);
  });

  it("does not count the warning as a check, a failure or a reason to exit 1", async () => {
    await beat(0);
    const failing = await doctor([], {
      connect: farAway([190]),
      env: { DATABASE_URL: WORKER_URL, TYPESAFE_API_KEY: "tsk-s3cret-model-key" },
    });
    expect(failing.code).toBe(1);
    expect(lines(failing.stdout).at(-1)).toBe("1 of 7 checks failed.");
    expect(lines(failing.stdout).some((text) => text.startsWith("warn  distance"))).toBe(true);
    const json = await doctor(["--json"], { connect: farAway([190]) });
    expect(json.code, json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      checks: { id: string; status: string }[];
      warnings: { id: string; status: string; detail: string }[];
    };
    // A warning is not a check: it has a field of its own, and `checks` holds only the 7 checks.
    expect(parsed.checks.map((check) => check.id)).toEqual([
      "config",
      "database",
      "install",
      "worker",
      "model-key",
      "model-reachable",
      "secret",
    ]);
    expect(parsed.checks.every((check) => check.status === "ok")).toBe(true);
    expect(parsed.warnings).toEqual([
      {
        id: "distance",
        label: "distance",
        status: "warn",
        detail:
          "the database is 190 ms away; run the worker next to it, the 1 second target assumes a same-region link",
      },
    ]);
  });

  it("a failing run lists the warning beside the checks in --json too", async () => {
    await beat(0);
    const result = await doctor(["--json"], {
      connect: farAway([190]),
      env: { DATABASE_URL: WORKER_URL, TYPESAFE_API_KEY: "tsk-s3cret-model-key" },
    });
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      details: { checks: { id: string }[]; warnings: { id: string }[] };
    };
    expect(parsed.details.checks).toHaveLength(7);
    expect(parsed.details.warnings.map((warning) => warning.id)).toEqual(["distance"]);
  });

  it("a select 1 that fails while timing is a database failure, not swallowed", async () => {
    const inner = asWorker();
    const connect: SqlConnect = (url) => {
      const connection = inner(url);
      let trips = 0;
      return {
        ...connection,
        query: (text, params) => {
          if (text === "select 1" && ++trips === 2) {
            return Promise.reject(new Error("connection terminated mid round trip"));
          }
          return connection.query(text, params);
        },
      };
    };
    const result = await doctor([], { connect });
    expect(result.code).toBe(1);
    const database = lineFor(result.stdout, "database");
    expect(database).toMatch(/^FAIL/);
    expect(database).toContain('"listings" cannot connect to localhost:5432/app');
    expect(database).toContain("connection terminated mid round trip");
    expect(lineFor(result.stdout, "install")).toMatch(/^skip/);
    expect(lines(result.stdout).some((text) => text.startsWith("warn"))).toBe(false);
  });
});

describe("facetdb doctor reports the first failure, whatever else fails", () => {
  it("names the earliest failing check in the error, counts them all, and lists them under --json", async () => {
    // Nothing installed and nothing set: the database is the first failure, then the rest.
    await world.client.query("drop schema facetdb cascade");
    await world.client.query("alter table public.listings drop column category cascade");
    const result = await doctor([], { env: {} });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: the install check failed:");
    expect(lineFor(result.stdout, "install")).toMatch(/^FAIL/);
    expect(lineFor(result.stdout, "worker heartbeat")).toMatch(/^FAIL.*DATABASE_URL is not set/);
    expect(lineFor(result.stdout, "model key")).toMatch(/^FAIL/);
    expect(lineFor(result.stdout, "FACETDB_SECRET")).toMatch(/^FAIL/);
    expect(lines(result.stdout).at(-1)).toBe("4 of 7 checks failed.");

    const json = await doctor(["--json"], { env: {} });
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.stdout) as {
      ok: boolean;
      error: { code: string };
      details: { checks: { id: string; status: string; fix?: string }[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("doctor-install");
    expect(
      parsed.details.checks.filter((check) => check.status === "fail").map((c) => c.id),
    ).toEqual(["install", "worker", "model-key", "secret"]);
    expect(parsed.details.checks.find((check) => check.id === "install")?.fix).toContain(
      "facetdb migrate",
    );
  });

  it("--dry-run says what each check would look at, and looks at nothing", async () => {
    const provider = fakeModel();
    const result = await doctor(["--dry-run"], {
      provider,
      connect: () => {
        throw new Error("a dry run opens no connection");
      },
      loadConfig: () => Promise.reject(new Error("a dry run loads no config")),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(lines(result.stdout)).toHaveLength(8);
    expect(result.stdout).toContain("1. config:");
    expect(result.stdout).toContain("7. FACETDB_SECRET:");
    expect(result.stdout).toContain("Dry run: nothing was checked.");
    expect(provider.callCount).toBe(0);
  });
});
