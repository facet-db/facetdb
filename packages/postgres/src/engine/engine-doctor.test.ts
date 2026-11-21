import type {
  Clock,
  EngineDeps,
  EnginePlan,
  EngineTarget,
  PlanResult,
  QuestionSet,
} from "@facetdb/core";
import { EngineRefusal } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlConnect } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * The engine's doctor and `open` on PGlite: the checks the CLI's doctor.ts computes for a table
 * source, with the same names, details, fixes and statuses (the variable that holds the URL is the
 * one word the engine cannot know), the list `doctor --dry-run` prints, and the connector `open`
 * hands out once it read the key from the catalog, where the CLI used to read it.
 */

const listings: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "Scam?", stakes: "high" }],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const ADMIN = "postgres://admin@localhost/app";
const WORKER_URL = "postgres://facetdb_worker:a-long-random-password@localhost/app";
const START = 10_000_000;
const clock = new FakeClock(START);
const shared: EngineDeps = { clock, allowInsecure: false, storeShared: true };

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

/** The admin's engine: PGlite's one superuser connection. */
const admin = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});

/** The worker login's connection: every statement runs as `role` on the same engine. */
function as(role: string): SqlConnect {
  return () => ({
    query: async (text, params) => {
      await world.client.query(`set role ${role}`);
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
}

const worker = createPostgresEngine({ connect: as("facetdb_worker"), pgHost: undefined });

function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    ...overrides,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** `public.listings`, installed through the engine as `facetdb migrate` will. */
async function installed(overrides: Partial<EngineTarget> = {}): Promise<void> {
  await world.client.query(
    "create table public.listings (id text primary key, title text, description text)",
  );
  const options = { ...shared, workerPassword: "a-long-random-password" };
  const plan = planOf(await admin.planInstall(target(overrides), ADMIN, options));
  expect((await admin.run(target(overrides), plan, ADMIN, options)).stopped).toBeUndefined();
}

async function beat(msAgo: number): Promise<void> {
  await world.client.query(`insert into facetdb.heartbeats (project, at) values ($1, $2)`, [
    "proj_listings",
    clock.now() - msAgo,
  ]);
}

const DATABASE_OK = {
  name: "database",
  status: "ok",
  detail: "logged in as facetdb_worker: listings on localhost/app (round trip 0 ms)",
};
const POOLER_OK = {
  name: "pooler",
  status: "ok",
  detail: `prepared statements stay on one server session on "listings" (a direct connection or a session pooler)`,
};
const INSTALL_OK = {
  name: "install",
  status: "ok",
  detail: "facetdb schema, jobs table, trigger and answer columns are in place",
};
const REINSTALL = "run facetdb migrate: it prints the SQL first and installs what is missing";

describe("checks", () => {
  it("lists the checks doctor --dry-run prints for a source, with what each looks at", () => {
    expect(admin.checks).toEqual([
      {
        name: "database",
        looksAt:
          "connects to each table source with its own connection string, checks the login, and times three round trips",
      },
      {
        name: "pooler",
        looksAt:
          "runs one prepared statement twice on each connection the worker opens, to find a transaction-mode pooler",
      },
      {
        name: "install",
        looksAt:
          "reads the catalog for the facetdb schema, the jobs table, the trigger and the answer columns",
      },
      { name: "worker", looksAt: "reads the worker's last heartbeat from the FacetDB store" },
    ]);
  });
});

describe("doctor", () => {
  it("passes every check of a fresh install but the heartbeat, which no worker has sent yet", async () => {
    await installed();
    expect(await worker.doctor(target(), WORKER_URL, shared)).toEqual([
      DATABASE_OK,
      POOLER_OK,
      INSTALL_OK,
      {
        name: "worker",
        status: "fail",
        detail: "the worker has never sent a heartbeat for this project",
        fix: "start it with facetdb worker, and leave it running",
      },
    ]);
    await beat(30_000);
    expect((await worker.doctor(target(), WORKER_URL, shared)).at(-1)).toEqual({
      name: "worker",
      status: "ok",
      detail: "the last heartbeat was 30 seconds ago",
    });
  });

  it("calls a worker silent for two minutes down", async () => {
    await installed();
    await beat(5 * 60_000);
    expect((await worker.doctor(target(), WORKER_URL, shared)).at(-1)).toEqual({
      name: "worker",
      status: "fail",
      detail: "the last heartbeat was 5 minutes ago, and a worker counts as down after 2 minutes",
      fix: "start the worker with facetdb worker, or restart it, and read its log for why it stopped",
    });
  });

  it("leaves the heartbeat to the store's own check when the store is another database", async () => {
    await installed();
    expect(
      (await worker.doctor(target(), WORKER_URL, { ...shared, storeShared: false })).at(-1),
    ).toEqual({
      name: "worker",
      status: "skip",
      detail: "not checked here: the worker's heartbeat is in the FacetDB store, another database",
    });
  });

  it("names what the install is missing: the trigger, an answer column", async () => {
    await installed();
    await world.client.query("drop trigger facetdb_listings on public.listings");
    await world.client.query("alter table public.listings drop column is_scam_probability");
    const install = (await worker.doctor(target(), WORKER_URL, shared))[2];
    expect(install).toEqual({
      name: "install",
      status: "fail",
      detail:
        "listings: public.listings has no trigger facetdb_listings, so changes are not queued; listings: public.listings lacks the answer columns is_scam_probability",
      fix: REINSTALL,
    });
  });

  it("checks a side-table install on the side table's columns", async () => {
    await installed({ storage: "side-table" });
    expect((await worker.doctor(target({ storage: "side-table" }), WORKER_URL, shared))[2]).toEqual(
      INSTALL_OK,
    );
  });

  it("fails a login that is not the worker's, and skips what needed it", async () => {
    await installed();
    const checks = await admin.doctor(target(), WORKER_URL, shared);
    expect(checks.slice(0, 3)).toEqual([
      {
        name: "database",
        status: "fail",
        detail: `"listings" logs in as postgres on localhost/app, not as the worker login facetdb_worker`,
        fix: "set the source's connection string to postgres://facetdb_worker:<a long random password>@<host>/<database>; facetdb migrate creates that login with the password in it, and it is the only login the worker needs",
      },
      { name: "pooler", status: "skip", detail: "not checked: the database check did not pass" },
      { name: "install", status: "skip", detail: "not checked: the database check did not pass" },
    ]);
  });

  it("warns of a far database on a line of its own, never as a failure", async () => {
    await installed();
    // A clock that moves 150 ms from one reading to the next: each round trip takes 150 ms.
    let now = START;
    const slow: Clock = {
      now: () => {
        now += 150;
        return now;
      },
      sleep: () => Promise.resolve(),
    };
    const checks = await worker.doctor(target(), WORKER_URL, { ...shared, clock: slow });
    expect(checks.slice(0, 2)).toEqual([
      {
        name: "database",
        status: "ok",
        detail: "logged in as facetdb_worker: listings on localhost/app (round trip 150 ms)",
      },
      {
        name: "distance",
        status: "warn",
        detail:
          "the database is 150 ms away; run the worker next to it, the 1 second target assumes a same-region link",
      },
    ]);
  });

  it("fails a plaintext URL to another machine before it connects, and never shows its password", async () => {
    const never = createPostgresEngine({
      connect: () => {
        throw new Error("a connection was opened");
      },
      pgHost: undefined,
    });
    const remote = "postgres://facetdb_worker:s3cret-worker-password@db.example.com/app";
    const checks = await never.doctor(target(), remote, shared);
    expect(checks).toEqual([
      {
        name: "database",
        status: "fail",
        detail: `"listings": the source's connection string reaches db.example.com without TLS, so the password in it would travel in the clear`,
        fix: "add ?sslmode=require to the source's connection string, or pass --allow-insecure if that network is trusted",
      },
      { name: "pooler", status: "skip", detail: "not checked: the database check did not pass" },
      { name: "install", status: "skip", detail: "not checked: the database check did not pass" },
      {
        name: "worker",
        status: "fail",
        detail:
          "DATABASE_URL reaches db.example.com without TLS, so the password in it would travel in the clear",
        fix: "add ?sslmode=require to DATABASE_URL, or pass --allow-insecure if that network is trusted",
      },
    ]);
    expect(JSON.stringify(checks)).not.toContain("s3cret-worker-password");
    // A connection that fails names the database, never the password in the URL.
    const failing = await never.doctor(target(), remote, { ...shared, allowInsecure: true });
    expect(failing[0]).toEqual({
      name: "database",
      status: "fail",
      detail: `"listings" cannot connect to db.example.com/app: a connection was opened`,
      fix: "check the host, port, user and password in the source's connection string, and that the database accepts connections from this machine (a firewall or an allow-list)",
      // No answer at all: a reading of the install behind it tells nothing and may be asked again.
      unreachable: true,
    });
    // With the variable the CLI read the URL from, the words name it where they said the phrase.
    const named = await never.doctor({ ...target(), urlVariable: "LISTINGS_URL" }, remote, shared);
    expect(named[0]).toEqual({
      name: "database",
      status: "fail",
      detail: `"listings": LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear`,
      fix: "add ?sslmode=require to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
    });
  });
});

describe("open", () => {
  it("reads the key from the catalog and hands out the capture connector, with the engine's capabilities", async () => {
    await installed();
    await world.client.query(
      "insert into public.listings (id, title, description) values ('a1', 'A car', 'Cheap')",
    );
    const connector = await admin.open(target(), WORKER_URL, { ...shared, workerId: "w1" });
    try {
      expect(connector.capabilities).toEqual(admin.capabilities);
      const read = await connector.read(["a1"]);
      expect(read.rows.map((row) => [row.key, row.state])).toEqual([
        ["a1", { title: "A car", description: "Cheap" }],
      ]);
      expect(await connector.claim(10)).toEqual(["a1"]);
    } finally {
      await connector.close();
    }
  });

  it("refuses a table without a single-column primary key, and a plaintext URL, in today's words", async () => {
    await world.client.query("create table public.nokey (title text)");
    await expect(admin.open(target({ table: "nokey" }), WORKER_URL, shared)).rejects.toEqual(
      new EngineRefusal({
        code: "primary-key",
        message: "public.nokey needs a single-column primary key, and has none, or does not exist",
        fix: "run facetdb migrate first; a table needs a primary key (or a surrogate key), FacetDB keys its answers by it",
      }),
    );
    const refused = await admin
      .open(target(), "postgres://facetdb_worker:pw@db.example.com/app", shared)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(EngineRefusal);
    expect(refused instanceof EngineRefusal && refused.refusal).toEqual({
      code: "database-url-tls",
      message:
        "the source's connection string reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      fix: "add ?sslmode=require to the source's connection string, or pass --allow-insecure if that network is trusted",
    });
  });
});
