import { DEFAULT_WORKER_LIMITS, monthOf } from "@facetdb/core";
import { FakeClock, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { DEFAULT_FETCH_TIMEOUT_MS, GIVE_UP_AFTER_MS, RETRY_FIRST_MS } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { engineFor, lazyEngine, openConnector } from "../engines.ts";
import { runEnding } from "../pipe.ts";
import { sharePools } from "../pools.ts";
import type { EngineEntry, HttpHandler } from "../program.ts";
import { EXIT_USAGE, runInProcess } from "../program.ts";
import { hashPassword, storeSourceId } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlClient,
  type SqlConnect,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { engineTarget, projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  deliverUntil,
  installMissing,
  limitsFor,
  WORKER_CONNECTIONS,
} from "./worker.ts";

/**
 * `facetdb worker` through the in-process runner on PGlite: the table is installed as `facetdb
 * migrate` would, an insert queues a record through the trigger, and the worker answers it with the
 * fake provider through the Postgres capture connector and writes the columns. `--no-http` binds
 * nothing, the default binds the HTTP surface on 127.0.0.1:4040, a missing key refuses to start, and the
 * heartbeat `facetdb doctor` reads advances with the clock while the worker runs until stopped.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
/** The socket a request on this machine's loopback address arrives on. */
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };

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

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;
let served: {
  readonly handler: HttpHandler;
  readonly port: number;
  readonly host: string;
}[];
let closedListeners: number;
/** Whether each store the commands asked for was allowed to be plaintext. */
let storeAsked: boolean[];
/**
 * Whether each store was handed a client to borrow, and every client the commands opened, with the
 * pool it asked for (undefined: the driver's default).
 */
let poolsAsked: {
  readonly store: boolean[];
  readonly clients: { readonly url: string; readonly max: number | undefined }[];
};

// One engine for the file, emptied after every test: a boot per test cost 440 ms.
beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  served = [];
  closedListeners = 0;
  storeAsked = [];
  poolsAsked = { store: [], clients: [] };
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
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stop?: AbortSignal;
    readonly config?: ProjectConfig;
    readonly abortAfter?: (ms: number) => AbortSignal;
    /**
     * Records every statement the command sends, the store's included: the store is then opened
     * over the client the command hands it, as `facetdb worker` opens it, not the test's own.
     */
    readonly record?: string[];
    /** The engines registered; the Postgres engine over the test's driver when absent. */
    readonly engines?: readonly EngineEntry[];
    /** Opens the store as the composition root does, with the `warn` the command hands it. */
    readonly warnings?: boolean;
    /** Calls the surface the moment it is bound, while the command is still running. */
    readonly whileServing?: (handler: HttpHandler) => Promise<void>;
  } = {},
) {
  const { record } = options;
  const recorded = (client: SqlClient): SqlClient =>
    record === undefined
      ? client
      : {
          ...client,
          query: (text, params) => {
            record.push(text);
            return client.query(text, params);
          },
          transaction: (work) =>
            client.transaction((query) =>
              work((text, params) => {
                record.push(text);
                return query(text, params);
              }),
            ),
          pipeline: (text, paramSets) => {
            record.push(text);
            return client.pipeline(text, paramSets);
          },
        };
  // The composition root's wiring: the store and the engine share one driver, pools by URL.
  const connect = sharePools((url, connectOptions) => {
    poolsAsked.clients.push({ url, max: connectOptions?.max });
    return recorded(world.connect(url, connectOptions));
  });
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      // The store's secret is set unless a test says `FACETDB_SECRET: undefined`.
      env: {
        FACETDB_SECRET: TEST_SECRET,
        ...(options.env ?? {
          DATABASE_URL: "postgres://localhost:5432/facetdb",
          TYPESAFE_API_KEY: "ts-test-key",
        }),
      },
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(options.config ?? config),
      engines: options.engines ?? postgresEngines(connect),
      connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: (storeOptions) => {
        storeAsked.push(storeOptions?.allowInsecure === true);
        poolsAsked.store.push(storeOptions?.connect !== undefined);
        if (options.warnings === true) {
          return createStore({
            pglite: world.db,
            secret: TEST_SECRET,
            clock,
            ...(storeOptions?.warn === undefined ? {} : { warn: storeOptions.warn }),
          });
        }
        if (record !== undefined && storeOptions?.connect !== undefined) {
          return createStore({
            url: "postgres://localhost:5432/facetdb",
            pgHost: undefined,
            connect: storeOptions.connect,
            secret: TEST_SECRET,
            clock,
          });
        }
        return Promise.resolve({ ...store, close: () => Promise.resolve() });
      },
      provider: () => provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: async (handler, port, host) => {
        served.push({ handler, port, host });
        await options.whileServing?.(handler);
        return Promise.resolve({
          port,
          close: () => {
            closedListeners += 1;
            return Promise.resolve();
          },
        });
      },
      ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
      ...(options.abortAfter === undefined ? {} : { abortAfter: options.abortAfter }),
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

  it("starts and answers with no DDL and no grant: `facetdb migrate` gave the login its rights", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const statements: string[] = [];
    const result = await run(["worker", "--once", "--no-http"], { record: statements });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    // The store (opened over the command's own client), the outbox and the table source all spoke.
    expect(statements.some((text) => text.includes("facetdb.store_migrations"))).toBe(true);
    expect(statements.some((text) => text.includes("facetdb.heartbeats"))).toBe(true);
    expect(
      statements.filter((text) => /^\s*(create|alter|drop|grant|revoke)\b/i.test(text)),
    ).toEqual([]);
  });

  describe("opens a connection per lane plus two, and one pool per database", () => {
    it("a table source on the store's database shares the store's pool: one client in all", async () => {
      const result = await run(["worker", "--once", "--no-http"], {
        env: { DATABASE_URL: WORKER_URL, TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(WORKER_CONNECTIONS).toBe(DEFAULT_WORKER_LIMITS.maxInFlight + 2);
      // The store, the outbox, the primary-key probe and the source's connector all borrow it.
      expect(poolsAsked.clients).toEqual([{ url: WORKER_URL, max: WORKER_CONNECTIONS }]);
      expect(poolsAsked.store).toEqual([true]);
    });

    it("--connections and FACETDB_CONNECTIONS size every pool, and a count under three is refused", async () => {
      // Seen in a real run: a Supabase session pooler's 15 sessions per login, filled by one studio
      // with its backfill beside a process just closed.
      const flagged = await run(["worker", "--once", "--no-http", "--connections", "6"], {
        env: { DATABASE_URL: WORKER_URL, TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(flagged.code, flagged.stderr).toBe(0);
      expect(poolsAsked.clients).toEqual([{ url: WORKER_URL, max: 6 }]);

      poolsAsked = { store: [], clients: [] };
      const fromEnv = await run(["worker", "--once", "--no-http"], {
        env: {
          DATABASE_URL: WORKER_URL,
          TYPESAFE_API_KEY: "ts-test-key",
          FACETDB_CONNECTIONS: "7",
        },
      });
      expect(fromEnv.code, fromEnv.stderr).toBe(0);
      expect(poolsAsked.clients).toEqual([{ url: WORKER_URL, max: 7 }]);

      const refused = await run(["worker", "--once", "--no-http", "--connections", "2"], {
        env: { DATABASE_URL: WORKER_URL, TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(refused.code).toBe(EXIT_USAGE);
      expect(refused.stderr).toContain(
        '--connections is a whole number of connections from 3 to 1000, not "2"',
      );
      expect(limitsFor(6)).toMatchObject({ maxInFlight: 4 });
      expect(limitsFor(100)).toMatchObject({ maxInFlight: DEFAULT_WORKER_LIMITS.maxInFlight });
    });

    it("says a database with no connection left in its own words, with the budget as the fix", () => {
      const refusal = installMissing(
        "listings",
        "facetdb.config.ts",
        Object.assign(new Error("max clients reached in session mode"), {
          code: "EMAXCONNSESSION",
        }),
      );
      expect(refusal).toMatchObject({
        code: "too-many-connections",
        message:
          'the source "listings" stopped: its database allows no more connections for the worker login (max clients reached in session mode)',
      });
      expect(
        installMissing(
          "listings",
          "facetdb.config.ts",
          Object.assign(new Error("x"), { code: "53300" }),
        ),
      ).toMatchObject({ code: "too-many-connections" });
    });

    it("a table source on another database gets a pool of its own, and the probe the default", async () => {
      const storeUrl = "postgres://localhost:5432/facetdb";
      const result = await run(["worker", "--once", "--no-http"], {
        env: { DATABASE_URL: storeUrl, TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(poolsAsked.clients).toEqual([
        { url: storeUrl, max: WORKER_CONNECTIONS },
        { url: WORKER_URL, max: undefined },
        { url: WORKER_URL, max: WORKER_CONNECTIONS },
      ]);
      expect(poolsAsked.store).toEqual([true]);
    });
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
          engines: postgresEngines(noConnection),
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
      // Through the engine, as the worker, backfill, preview and explain open it.
      const own = ownUrl(REMOTE_PLAIN);
      const source = own.sources[0] as SourceConfig;
      const engine = await engineFor(postgresEngines(noConnection), REMOTE_PLAIN);
      await expect(
        openConnector(
          engine,
          engineTarget(
            own,
            { source, schema: "public", table: "listings" },
            projectRef(PROJECT_DIR),
          ),
          REMOTE_PLAIN,
          { clock, allowInsecure: false, storeShared: false, workerId: "w" },
        ),
      ).rejects.toThrow(/LISTINGS_URL reaches db.example.com without TLS/);
    });

    it("a URL whose host the driver and the check would read differently is refused, saying how to encode it", async () => {
      const result = await refused(["worker", "--once", "--no-http"], {
        env: {
          DATABASE_URL: "postgres://x@evil.com,y@localhost/app",
          TYPESAFE_API_KEY: "ts-test-key",
        },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "error: DATABASE_URL has more than one @ before the path, so its host cannot be read for sure",
      );
      expect(result.stderr).toContain("fix: percent-encode every @ in the user and password");
      expect(storeAsked).toEqual([]);
    });

    it("a URL with no host goes where the driver goes: PGHOST's host is refused naming PGHOST, its socket is not", async () => {
      // The password comes from PGPASSWORD here: a URL with credentials needs a host to parse.
      const noHost = "postgres:///app?user=facetdb_worker";
      const remote = await refused(["worker", "--once", "--no-http"], {
        env: { DATABASE_URL: noHost, PGHOST: "db.example.com", TYPESAFE_API_KEY: "ts-test-key" },
      });
      expect(remote.code).toBe(1);
      expect(remote.stderr).toContain(
        "error: DATABASE_URL names no host, so the driver reaches PGHOST (db.example.com) without TLS",
      );
      expect(remote.stderr).toContain(
        "fix: add ?sslmode=require to DATABASE_URL, point PGHOST at this machine or a socket directory, or pass --allow-insecure",
      );
      expect(storeAsked).toEqual([]);
      const socket = await run(["worker", "--once", "--no-http"], {
        env: {
          DATABASE_URL: noHost,
          PGHOST: "/var/run/postgresql",
          TYPESAFE_API_KEY: "ts-test-key",
        },
      });
      expect(socket.code, socket.stderr).toBe(0);
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

  describe("on an engine whose keys carry a type tag", () => {
    const HEX = "65f1a2b3c4d5e6f708192a3b";

    /** A fake MongoDB with an ObjectId and a number document queued, and the worker's options. */
    function mongoWorld() {
      const database = new FakeDatabase({ fields: ["title"] });
      database.install();
      database.edit(`oid:${HEX}`, { title: "A red car" });
      database.edit("n:1", { title: "A flat" });
      const mongo = new FakeEngine({
        name: "mongodb",
        schemes: ["mongodb", "mongodb+srv"],
        database,
        keyText: {
          toText: (key) => key.replace(/^(?:oid|n):/, ""),
          fromText: (text) => text,
          form: "the document's _id as you write it",
        },
      });
      const mongoConfig = facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "listings",
            database: "mongodb://facetdb_worker:worker-password@localhost:27017/app",
            table: "listings",
            read: ["title"],
            questions: { is_scam: noul("Is this listing a scam?") },
          },
        ],
      });
      return {
        database,
        options: {
          config: mongoConfig,
          engines: [lazyEngine("mongodb", () => Promise.resolve(mongo))],
        },
      };
    }

    it("prints its keys as the user writes them in the answered lines, never its tags", async () => {
      const { database, options } = mongoWorld();

      const first = await run(["worker", "--once", "--no-http"], options);

      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(new RegExp(`listings: answered (${HEX}, 1|1, ${HEX})\\n`));
      // Queued again at the same state: the already-answered line speaks the same form.
      database.queue("n:1");
      const again = await run(["worker", "--once", "--no-http"], options);
      expect(again.stdout).toContain(
        "listings: already answered 1 at this state, so the model was not asked again",
      );
      expect(`${first.stdout}${again.stdout}`).not.toMatch(/oid:|n:1/);
    });

    it("names a record that failed by the key as the user writes it", async () => {
      const { options } = mongoWorld();
      // The first call's answer does not parse: that record fails at the model call.
      provider = createFakeProvider({
        defaults: { noul: 0.01 },
        failures: { 0: { kind: "malformed" } },
      });

      const result = await run(["worker", "--once", "--no-http"], options);

      expect(result.stdout).toMatch(new RegExp(`listings: (${HEX}|1) failed at ask: .+`));
      expect(result.stdout).not.toMatch(/oid:|n:1/);
    });

    it("prints a string _id 1001 bare where the marker records strings, as explain reads it", async () => {
      const { options } = mongoWorld();
      const database = new FakeDatabase({ fields: ["title"] });
      database.install();
      database.edit("1001", { title: "A boat" });
      const asked: string[] = [];
      const mongo = new FakeEngine({
        name: "mongodb",
        schemes: ["mongodb", "mongodb+srv"],
        database,
        // the untyped rule alone: a numeric string prints with its escape.
        keyText: {
          toText: (key) => (/^[0-9]+$/.test(key) ? `s:${key}` : key),
          fromText: (text) => text,
          form: "the document's _id as you write it",
        },
        keyTextOf: (target) => {
          asked.push(target.table);
          return { toText: (key) => key, fromText: (text) => text, form: "a string as itself" };
        },
      });

      const result = await run(["worker", "--once", "--no-http"], {
        ...options,
        engines: [lazyEngine("mongodb", () => Promise.resolve(mongo))],
      });

      expect(result.code).toBe(0);
      expect(asked).toEqual(["listings"]);
      expect(result.stdout).toContain("listings: answered 1001\n");
      expect(result.stdout).not.toContain("s:1001");
    });
  });

  it("--once names the decision log when the lookup of a batch's prior answers fails", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    await world.client.query("alter table facetdb.decisions rename to decisions_gone");

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.stdout).toMatch(/listings: the decision log could not be read: .+/);
    expect(result.stdout).not.toContain("the pass failed at");
    expect(result.stdout).not.toContain("failed at log");
    expect(provider.callCount).toBe(0);
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

  it("serves on 127.0.0.1 port 4040 by default, and stops serving on exit", async () => {
    const result = await run(["worker", "--once"]);

    expect(result.code).toBe(0);
    expect(served.map((one) => [one.host, one.port])).toEqual([[DEFAULT_HOST, DEFAULT_PORT]]);
    expect([DEFAULT_HOST, DEFAULT_PORT]).toEqual(["127.0.0.1", 4040]);
    expect(result.stdout).toContain(
      `Serving the check API and the studio's endpoints on http://${DEFAULT_HOST}:${DEFAULT_PORT}.`,
    );
    expect(closedListeners).toBe(1);
    // The handler is the server's app: a check call without an API key is refused, not routed.
    const [listener] = served;
    const response = await listener?.handler(
      new Request("http://localhost/v1/check", { method: "POST", body: "{}" }),
      THIS_MACHINE,
    );
    expect(response?.status).toBe(401);
  });

  it("opens the studio's routes to this machine as the OS user, and to nobody else without a session", async () => {
    await run(["worker", "--once"]);
    const [listener] = served;
    const get = (peer: { readonly remoteAddress: string | undefined }) =>
      listener?.handler(new Request("http://127.0.0.1:4040/v1/reviewers"), peer);

    const here = await get(THIS_MACHINE);
    expect(here?.status).toBe(200);
    expect(await here?.json()).toEqual({ reviewers: [] });
    const elsewhere = await get({ remoteAddress: "203.0.113.7" });
    expect(elsewhere?.status).toBe(401);
    expect(await elsewhere?.json()).toMatchObject({ error: { code: "sign-in" } });
  });

  it("--host on another address refuses to start until an account exists, and starts once one does", async () => {
    const refused = await run(["worker", "--once", "--host", "0.0.0.0"]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--host 0.0.0.0 opens the review screen to other machines");
    expect(refused.stderr).toContain("facetdb users add <name>");
    expect(served).toEqual([]);
    expect(await heartbeat()).toBeUndefined();

    await store.users.add("maya", await hashPassword("a long enough password"));
    const started = await run(["worker", "--once", "--host", "0.0.0.0"]);

    expect(started.code, started.stderr).toBe(0);
    expect(served.map((one) => one.host)).toEqual(["0.0.0.0"]);
    // The loopback host and --no-http never need an account.
    await store.users.remove("maya");
    expect((await run(["worker", "--once", "--host", "localhost"])).code).toBe(0);
    expect((await run(["worker", "--once", "--no-http", "--host", "::"])).code).toBe(0);
  });

  it("refuses to start without FACETDB_SECRET before anything is served, in the store door's words", async () => {
    const result = await run(["worker", "--once"], {
      env: {
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        FACETDB_SECRET: undefined,
        TYPESAFE_API_KEY: "ts-test-key",
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FACETDB_SECRET is not set");
    expect(result.stderr).toContain("openssl rand -hex 32");
    expect(served).toEqual([]);
  });

  it("wires a reviewer account's unreadable hash to stderr, never the hash itself", async () => {
    await world.client.query(
      "insert into facetdb.users (name, password_hash) values ('maya', 'not-a-hash-NEEDLE')",
    );
    let status: number | undefined;
    const result = await run(["worker", "--once"], {
      warnings: true,
      whileServing: async (handler) => {
        const response = await handler(
          new Request("http://127.0.0.1/v1/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "maya", password: "a long enough password" }),
          }),
          THIS_MACHINE,
        );
        status = response.status;
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(status).toBe(401);
    expect(result.stderr).toContain('the reviewer account "maya" has a stored password hash');
    expect(result.stderr).not.toContain("NEEDLE");
  });

  it("serves the project JSON, a draft's judgement and the preview of a running source", async () => {
    // What the loader makes of `database: process.env.LISTINGS_URL`: the value, and the variable.
    const loaded: ProjectConfig = {
      ...config,
      sources: config.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
    };
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const result = await run(["worker", "--once"], {
      config: loaded,
      env: {
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        LISTINGS_URL: WORKER_URL,
        TYPESAFE_API_KEY: "ts-test-key",
      },
    });
    expect(result.code, result.stderr).toBe(0);
    const [listener] = served;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await listener?.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        THIS_MACHINE,
      );
      return { status: response?.status, json: (await response?.json()) as unknown };
    };

    const json = await call("GET", "/v1/config");
    expect(json.status).toBe(200);
    expect(json.json).toMatchObject({
      model: "jev-1.14.0",
      sources: [{ name: "listings", database: { env: "LISTINGS_URL" }, table: "listings" }],
    });
    // The export names the variable, never the connection string.
    expect(JSON.stringify(json.json)).not.toContain("worker-password");

    const judged = await call("POST", "/v1/config/validate", {
      source: {
        name: "listings",
        questions: {
          is_scam: {
            type: "noul",
            instructions: "Does it cost more than 500 euros?",
            stakes: "low",
          },
        },
      },
    });
    expect(judged).toMatchObject({
      status: 200,
      json: {
        valid: true,
        issues: [],
        warnings: [{ source: "listings", question: "is_scam", code: "counting" }],
      },
    });

    const broken = await call("POST", "/v1/config/validate", {
      source: { name: "listings", model: "jev-latest" },
    });
    expect(broken).toMatchObject({
      status: 200,
      json: { valid: false, issues: [{ path: "sources[0].model" }] },
    });

    const asked = provider.callCount;
    const usage = () => store.usage.total(projectRef(PROJECT_DIR).id, monthOf(clock.now()));
    const usedBefore = await usage();
    const previewed = await call("POST", "/v1/preview", {
      source: { name: "listings", thresholds: { is_scam: { noBelow: 0.001 } } },
    });
    expect(previewed).toMatchObject({
      status: 200,
      json: {
        rows: [
          {
            key: "r1",
            kind: "answered",
            answers: { is_scam: { type: "noul", probability: 0.01 } },
            decisions: { is_scam: { kind: "needs_review" } },
          },
        ],
        decided: 0,
        review: 1,
      },
    });
    expect(provider.callCount).toBe(asked + 1);
    // Counted against the project like the worker's own requests: the store-backed gate, not an
    // unmetered one.
    const { cost } = previewed.json as { readonly cost: { readonly inputTokens: number } };
    expect(cost.inputTokens).toBeGreaterThan(0);
    expect(await usage()).toBe(usedBefore + cost.inputTokens);
    // The preview wrote nothing: the row keeps the decision the worker wrote, not the draft's.
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
  });

  it("logs each pass that claimed a record in the run log and serves it newest first", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once"]);

    expect(result.code, result.stderr).toBe(0);
    const { secret } = await store.apiKeys.create(projectRef(PROJECT_DIR).id, "studio");
    const [listener] = served;
    const response = await listener?.handler(
      new Request("http://localhost/v1/runs?source=listings", {
        headers: { authorization: `Bearer ${secret}` },
      }),
      THIS_MACHINE,
    );
    expect(response?.status).toBe(200);
    // One pass claimed r1 and answered it; the pass that found the queue empty wrote no row.
    expect(await response?.json()).toMatchObject({
      runs: [
        {
          source: "listings",
          kind: "pass",
          claimed: 1,
          answered: 1,
          toReview: 0,
          errors: 0,
          discarded: 0,
        },
      ],
      page: 1,
      more: false,
    });
  });

  it("serves the review of a record the model was unsure about, decided under the OS user", async () => {
    provider = createFakeProvider({ defaults: { noul: 0.5 } });
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const result = await run(["worker", "--once"]);
    expect(result.code, result.stderr).toBe(0);
    expect(await listing("r1")).toMatchObject({ facetdb_status: "needs_review" });
    const [listener] = served;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await listener?.handler(
        new Request(`http://127.0.0.1:4040${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
        THIS_MACHINE,
      );
      return { status: response?.status, json: (await response?.json()) as unknown };
    };

    const queue = await call("GET", "/v1/review/queue");
    expect(queue).toMatchObject({
      status: 200,
      json: { count: 1, cards: [{ source: "listings", key: "r1", open: [{ name: "is_scam" }] }] },
    });
    const opened = await call("POST", "/v1/review/open", {});
    expect(opened).toMatchObject({
      status: 200,
      json: {
        card: {
          source: "listings",
          key: "r1",
          state: { title: "A red car" },
          open: [{ name: "is_scam", said: "50% likely yes" }],
        },
      },
    });
    const { card } = opened.json as { card: { stateHash: string } };
    const decided = await call("POST", "/v1/review/r1/decide", {
      source: "listings",
      stateHash: card.stateHash,
      question: "is_scam",
      value: true,
      note: "obvious",
    });

    expect(decided).toMatchObject({
      status: 200,
      json: { status: "done", open: [], failedActions: [] },
    });
    expect(await listing("r1")).toMatchObject({ is_scam: true, facetdb_status: "done" });
    const history = await store
      .log(storeSourceId(projectRef(PROJECT_DIR).id, "listings"))
      .history("r1");
    expect(history.at(-1)).toMatchObject({
      kind: "human",
      reviewer: "os:alex",
      value: true,
      note: "obvious",
    });
    expect(await call("GET", "/v1/review/queue")).toMatchObject({ json: { count: 0 } });
  });

  it("serves Home and Sources from the store and each source's engine", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const result = await run(["worker", "--once"]);
    expect(result.code, result.stderr).toBe(0);
    const { secret } = await store.apiKeys.create(projectRef(PROJECT_DIR).id, "studio");
    const [listener] = served;
    const get = async (path: string) => {
      const response = await listener?.handler(
        new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } }),
        THIS_MACHINE,
      );
      return { status: response?.status, json: (await response?.json()) as unknown };
    };

    const home = await get("/v1/home");
    expect(home.status).toBe(200);
    // The answer the run wrote is today's in the store's log; the queue and the alerts are empty.
    expect(home.json).toMatchObject({
      answered: { today: 1, words: { figure: "1" } },
      queue: { waiting: 0, words: { figure: "None" } },
      spending: { status: "uncapped" },
      alerts: [],
    });
    // The engine's doctor ran under the source's URL: PGlite's one login is its superuser, not the
    // worker login, so doctor's database check fails and Home says so in the alert's words.
    expect(home.json).toMatchObject({
      health: {
        checks: [
          { name: "worker" },
          { name: "model", status: "ok", words: "Model healthy" },
          {
            name: "sources",
            status: "fail",
            words: expect.stringContaining("not as the worker login facetdb_worker"),
          },
        ],
        sources: [{ name: "listings", verdict: "failing" }],
      },
    });

    const sources = await get("/v1/sources");
    expect(sources).toMatchObject({
      status: 200,
      json: {
        sources: [
          {
            name: "listings",
            kind: "table",
            connector: "Postgres, trigger",
            how: {
              label: "Wakes",
              words: expect.stringMatching(/^Instantly, on the trigger's notification\./),
            },
            answers: "Inline columns on public.listings. One question, version 1.",
            backfill: { state: "none", fraction: null },
            login: {
              words: "facetdb_worker reads id and title, and writes only FacetDB's own columns.",
            },
          },
        ],
      },
    });
    // The worker's connection string never reaches a response.
    expect(JSON.stringify([home.json, sources.json])).not.toContain("worker-password");
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

  it("@timing stops as on Ctrl+C when its reader goes (facetdb worker | head -1), never exiting mid-claim", async () => {
    let exits = 0;
    // The composition root's wiring: the closed pipe's end, and the stop signal the worker takes.
    const ending = runEnding({
      exit: () => {
        exits += 1;
      },
      listen: () => {},
    });
    const running = run(["worker", "--no-http"], { stop: ending.stopSignal() });
    await vi.waitFor(async () => expect(await heartbeat()).toBe(START), { timeout: 10_000 });
    await world.client.query("insert into public.listings (id, title) values ('r3', 'A bike')");
    clock.advance(2_000);
    await vi.waitFor(
      async () => expect(await listing("r3")).toMatchObject({ facetdb_status: "done" }),
      { timeout: 10_000 },
    );

    ending.end();
    const result = await running;

    expect(exits).toBe(0);
    expect(ending.pipeClosed()).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stopped: every claim was settled.");
    const held = await world.client.query(
      "select count(*)::int as n from facetdb.jobs where claimed_by is not null",
    );
    expect(held[0]?.["n"]).toBe(0);
  });
});

describe("the worker's outbox loop", () => {
  it("prints every give-up alert that could not be raised, and drops none", async () => {
    const event = (deliveryId: string) => ({
      projectId: "p",
      deliveryId,
      host: "hooks.example.com",
      attempts: 31,
      queuedAt: START,
    });
    const reports = [
      {
        alertFailures: [
          { event: event("7"), error: new Error("the alert channel is down"), final: false },
          { event: event("8"), error: "timed out", final: false },
        ],
      },
      { alertFailures: [] },
      { alertFailures: [{ event: event("7"), error: new Error("still down"), final: true }] },
    ];
    const stop = new AbortController();
    const printed: string[] = [];
    let passes = 0;

    await deliverUntil(
      stop.signal,
      () => {
        const report = reports[passes] ?? { alertFailures: [] };
        passes += 1;
        if (passes === reports.length) {
          stop.abort();
        }
        return Promise.resolve(report);
      },
      new FakeClock(START),
      (text) => printed.push(text),
    );

    expect(passes).toBe(3);
    expect(printed).toEqual([
      `webhook to hooks.example.com (delivery 7) was given up after 31 attempts in 24 hours, and its alert could not be raised: the alert channel is down. ${RETRIED}`,
      `webhook to hooks.example.com (delivery 8) was given up after 31 attempts in 24 hours, and its alert could not be raised: timed out. ${RETRIED}`,
      `webhook to hooks.example.com (delivery 7) was given up after 31 attempts in 24 hours, and its alert could not be raised: still down. ${CLOSED}`,
    ]);
  });

  it("--once prints every give-up alert that could not be raised too, the last one included", async () => {
    // A webhook queued 24 hours ago and due now: its send fails and so does its alert.
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ('p', 'https://hooks.example.com/facetdb', '{}', $1::bigint, $1::bigint)`,
      [START - GIVE_UP_AFTER_MS],
    );
    // Every timeout has already run out: the send, and then the alert, outlive it.
    const spent = () => AbortSignal.abort();

    const first = await run(["worker", "--once", "--no-http"], { abortAfter: spent });
    expect(first.code, first.stderr).toBe(0);
    expect(alertLines(first.stdout)).toEqual([
      `webhook to hooks.example.com (delivery 1) was given up after 1 attempt in 24 hours, and its alert could not be raised: it did not finish within ${DEFAULT_FETCH_TIMEOUT_MS} ms. ${RETRIED}`,
    ]);

    // The alert's one more try, due a retry delay later: it fails again, and the row closes.
    clock.advance(RETRY_FIRST_MS);
    const second = await run(["worker", "--once", "--no-http"], { abortAfter: spent });
    expect(second.code, second.stderr).toBe(0);
    expect(alertLines(second.stdout)).toEqual([
      `webhook to hooks.example.com (delivery 1) was given up after 1 attempt in 24 hours, and its alert could not be raised: it did not finish within ${DEFAULT_FETCH_TIMEOUT_MS} ms. ${CLOSED}`,
    ]);
    const [row] = await world.client.query(
      "select gave_up_at::text as gave_up_at from facetdb.webhook_outbox",
    );
    expect(Number(row?.["gave_up_at"])).toBe(START + RETRY_FIRST_MS);
  });
});

const RETRIED =
  "FacetDB tries the alert once more on the webhook's next attempt; the webhook itself is not sent again.";
const CLOSED =
  "That was the alert's last try: the webhook is closed, and this line is its only alert.";

function alertLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("webhook to "));
}
