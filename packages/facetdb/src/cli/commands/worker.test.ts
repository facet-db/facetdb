import type { Clock } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { createStore, migrate, type SqlConnect, type Store } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import type { HttpHandler } from "../program.ts";
import { runInProcess } from "../program.ts";
import { openTableConnector } from "../table-connector.ts";
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
/** Whether each store the commands asked for was allowed to be plaintext. */
let storeAsked: boolean[];

beforeEach(async () => {
  world = await createPgliteWorld();
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  served = [];
  closedListeners = 0;
  storeAsked = [];
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
    readonly config?: ProjectConfig;
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
      loadConfig: () => Promise.resolve(options.config ?? config),
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: (storeOptions) => {
        storeAsked.push(storeOptions?.allowInsecure === true);
        return Promise.resolve({ ...store, close: () => Promise.resolve() });
      },
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

  it("--allow-insecure is passed to the store, and is off without it", async () => {
    await run(["worker", "--once", "--no-http"]);
    await run(["worker", "--once", "--no-http", "--allow-insecure"]);
    expect(storeAsked).toEqual([false, true]);
  });

  describe("refuses the worker's password in the clear to another machine", () => {
    const REMOTE_PLAIN = "postgres://facetdb_worker:s3cret-worker-password@db.example.com/x";
    const REMOTE_TLS = `${REMOTE_PLAIN}?sslmode=require`;
    const goodEnv = { DATABASE_URL: REMOTE_TLS, TYPESAFE_API_KEY: "ts-test-key" };

    /** What the loader makes of `database: process.env.LISTINGS_URL`: the value read, and the variable. */
    function ownUrl(url: string): ProjectConfig {
      return {
        ...config,
        sources: config.sources.map(({ database: _database, ...source }) => ({
          ...source,
          database: url,
          databaseEnv: "LISTINGS_URL",
        })),
      };
    }

    /** A driver that fails the test when anything connects. */
    const noConnection: SqlConnect = (url) => {
      throw new Error(`a connection was opened to ${url}`);
    };

    async function refused(argv: readonly string[], options: Parameters<typeof run>[1]) {
      const result = await runInProcess(
        argv,
        {
          projectDir: PROJECT_DIR,
          env: options?.env ?? {},
          loadConfig: () => Promise.resolve(options?.config ?? config),
          connect: noConnection,
          store: (storeOptions) => {
            storeAsked.push(storeOptions?.allowInsecure === true);
            return Promise.reject(new Error("the store must not be opened"));
          },
          provider: () => provider,
          clock,
          random: () => 0.5,
        },
        COMMANDS,
      );
      return result;
    }

    it("a plaintext remote DATABASE_URL is refused before the store opens", async () => {
      const result = await refused(["worker", "--once", "--no-http"], {
        env: { DATABASE_URL: REMOTE_PLAIN, TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "error: DATABASE_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      );
      expect(result.stderr).toContain(
        "fix: add ?sslmode=require to DATABASE_URL, or pass --allow-insecure if that network is trusted",
      );
      expect(result.stderr).not.toContain("s3cret-worker-password");
      expect(storeAsked).toEqual([]);
    });

    it("a source's own plaintext remote URL is refused even when DATABASE_URL has TLS, naming its variable", async () => {
      const result = await refused(["worker", "--once", "--no-http"], {
        env: goodEnv,
        config: ownUrl(REMOTE_PLAIN),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "error: LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear",
      );
      expect(result.stderr).toContain("fix: add ?sslmode=require to LISTINGS_URL");
      expect(storeAsked).toEqual([]);
    });

    it("the connector refuses it too, before it connects, whoever opens it", async () => {
      await expect(
        openTableConnector({
          source: ownUrl(REMOTE_PLAIN).sources[0] as SourceConfig,
          url: REMOTE_PLAIN,
          connect: noConnection,
          questionSet: questionSetOf(config, config.sources[0] as SourceConfig),
          clock,
          workerId: "w",
          allowInsecure: false,
        }),
      ).rejects.toThrow(/LISTINGS_URL reaches db.example.com without TLS/);
    });

    it("--allow-insecure lets both through to the store", async () => {
      const result = await run(["worker", "--once", "--no-http", "--allow-insecure"], {
        env: { DATABASE_URL: REMOTE_PLAIN, TYPESAFE_API_KEY: "ts-test-key" },
        config: ownUrl(WORKER_URL),
      });
      expect(result.stderr).not.toContain("without TLS");
      expect(storeAsked).toEqual([true]);
    });
  });

  it("its description says it runs next to the database", async () => {
    const help = await run(["worker", "--help"]);
    // Commander wraps the description to the terminal's width.
    const text = help.stdout.replace(/\s+/g, " ");
    expect(text).toContain("run it next to the database, in the same region");
    expect(text).toContain("--allow-insecure");
  });

  it("--once counts a record queued again at a state already answered apart from the answered ones, with no model call", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    expect((await run(["worker", "--once", "--no-http"])).code).toBe(0);
    // The app writes the same title again: the trigger queues the record, its state is unchanged.
    await world.client.query("update public.listings set title = 'A red car' where id = 'r1'");

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "listings: already answered r1 at this state, so the model was not asked again",
    );
    expect(result.stdout).toContain("listings: answered 0, already answered 1, failed 0");
    expect(provider.callCount).toBe(1);
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
    const jobs = await world.client.query("select count(*)::int as n from facetdb.jobs");
    expect(jobs[0]?.["n"]).toBe(0);
  });

  it("--once with nothing queued asks nothing and exits 0", async () => {
    const result = await run(["worker", "--once", "--no-http", "--json"]);

    expect(result.code).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      http: null,
      sources: [{ source: "listings", answered: 0, alreadyAnswered: 0, failed: 0 }],
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
