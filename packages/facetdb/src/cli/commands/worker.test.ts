import type { Clock } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { createStore, migrate, type Store } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import type { HttpHandler } from "../program.ts";
import { runInProcess } from "../program.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";
import { DEFAULT_PORT } from "./worker.ts";

/**
 * `facetdb worker` through the in-process runner on PGlite: the table is installed as `facetdb
 * migrate` would, an insert queues a record through the trigger, and the worker answers it with the
 * fake provider through the Postgres capture connector and writes the columns. `--no-http` binds
 * nothing, the default binds the check API on 7411, a missing key refuses to start, and the
 * heartbeat `facetdb doctor` reads advances with the clock while the worker runs until stopped.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: WORKER_URL,
      table: "listings",
      read: ["id", "title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

/** A clock whose sleeps end only when the test moves time past them: one step, one poll. */
class SteppedClock implements Clock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];
  constructor(start: number) {
    this.#time = start;
  }
  now(): number {
    return this.#time;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => {
      this.#sleepers.push({ due: this.#time + ms, wake });
    });
  }
  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;
let served: { readonly handler: HttpHandler; readonly port: number }[];
let closedListeners: number;

beforeEach(async () => {
  world = await createPgliteWorld();
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  served = [];
  closedListeners = 0;
  await world.client.query("create table public.listings (id text primary key, title text)");
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet: questionSetOf(config, source),
      project: projectRef(PROJECT_DIR),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
});

afterEach(async () => {
  await store.close();
  await world.close();
});

function run(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stop?: AbortSignal;
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: options.env ?? {
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        TYPESAFE_API_KEY: "ts-test-key",
      },
      loadConfig: () => Promise.resolve(config),
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: (handler, port) => {
        served.push({ handler, port });
        return Promise.resolve({
          port,
          close: () => {
            closedListeners += 1;
            return Promise.resolve();
          },
        });
      },
      ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
    },
    COMMANDS,
  );
}

async function listing(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await world.client.query(
    "select is_scam, is_scam_probability, facetdb_status from public.listings where id = $1",
    [id],
  );
  return rows[0];
}

async function heartbeat(): Promise<number | undefined> {
  return store.alerts.lastHeartbeat(projectRef(PROJECT_DIR).id);
}

describe("facetdb worker", () => {
  it("--once answers a queued record with the model and writes the columns", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    expect(provider.callCount).toBe(1);
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
    // The queue is empty afterwards: the claim was acked, not left held.
    const jobs = await world.client.query("select count(*)::int as n from facetdb.jobs");
    expect(jobs[0]?.["n"]).toBe(0);
    // The heartbeat doctor reads is saved under the project directory's name.
    expect(await heartbeat()).toBe(START);
  });

  it("--once with nothing queued asks nothing and exits 0", async () => {
    const result = await run(["worker", "--once", "--no-http", "--json"]);

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      http: null,
      sources: [{ source: "listings", answered: 0, failed: 0 }],
    });
  });

  it("--no-http binds nothing", async () => {
    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.code).toBe(0);
    expect(served).toEqual([]);
    expect(result.stdout).not.toContain("Serving");
  });

  it("serves the check API on port 7411 by default, and stops serving on exit", async () => {
    const result = await run(["worker", "--once"]);

    expect(result.code).toBe(0);
    expect(served.map((one) => one.port)).toEqual([DEFAULT_PORT]);
    expect(result.stdout).toContain(`Serving the check API on port ${DEFAULT_PORT}.`);
    expect(closedListeners).toBe(1);
    // The handler is the server's app: a check call without an API key is refused, not routed.
    const [listener] = served;
    const response = await listener?.handler(
      new Request("http://localhost/v1/check", { method: "POST", body: "{}" }),
    );
    expect(response?.status).toBe(401);
  });

  it("--port binds the given port, and refuses one that is not a port", async () => {
    const ok = await run(["worker", "--once", "--port", "8080"]);
    expect(ok.code).toBe(0);
    expect(served.map((one) => one.port)).toEqual([8080]);

    const bad = await run(["worker", "--once", "--port", "http"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--port is a port number from 0 to 65535, not "http"');
  });

  it("refuses to start without TYPESAFE_API_KEY, and says what to set", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once", "--no-http"], {
      env: { DATABASE_URL: "postgres://localhost:5432/facetdb" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
    expect(result.stderr).toContain("set TYPESAFE_API_KEY to your TypeSafe API key");
    expect(provider.callCount).toBe(0);
    expect(await listing("r1")).toMatchObject({ is_scam: null, facetdb_status: "pending" });
  });

  it("--dry-run starts nothing", async () => {
    const result = await run(["worker", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run: nothing was started.");
    expect(served).toEqual([]);
    expect(await heartbeat()).toBeUndefined();
  });

  it("@timing beats the heartbeat on every poll until stopped, then exits with every claim settled", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], { stop: stop.signal });

    await vi.waitFor(async () => expect(await heartbeat()).toBe(START), { timeout: 10_000 });
    clock.advance(2_000);
    await vi.waitFor(async () => expect(await heartbeat()).toBe(START + 2_000), {
      timeout: 10_000,
    });

    // A record that arrives while it runs is answered on the next wake-up.
    await world.client.query("insert into public.listings (id, title) values ('r2', 'A flat')");
    clock.advance(2_000);
    await vi.waitFor(
      async () => expect(await listing("r2")).toMatchObject({ facetdb_status: "done" }),
      { timeout: 10_000 },
    );
    await vi.waitFor(async () => expect(await heartbeat()).toBe(START + 4_000), {
      timeout: 10_000,
    });

    stop.abort();
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stopped: every claim was settled.");
    const held = await world.client.query(
      "select count(*)::int as n from facetdb.jobs where claimed_by is not null",
    );
    expect(held[0]?.["n"]).toBe(0);
  });
});
