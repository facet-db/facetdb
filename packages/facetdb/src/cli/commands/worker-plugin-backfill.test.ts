import type { RecordKey, StateValue } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionCall,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  sourceCall,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  action,
  createPluginHost,
  definePlugin,
  type Plugin,
  source,
  z,
} from "../../plugin/index.ts";
import { sharePools } from "../pools.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import { storeSourceId } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * The studio's backfill of a plugin source, as a job inside a running worker: the estimate pages
 * through the plugin's scan and stores and queues nothing; the start takes every record into the
 * store and queues it at the pace, through a connector of the job's own; the source's loop answers
 * each from the store's queue, and the plugin's action runs for each, which labels every open
 * issue. The plugin's watch never runs for the job.
 */

const PROJECT_DIR = "/work/tracker-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  TRACKER_TOKEN: "trk_s3cret-token",
};

type Issue = Readonly<Record<string, StateValue>>;

let issues: Map<number, Issue>;
let watchCalls: number;
/** The cursor each call of the plugin's scan started from. */
let scans: (string | null)[];
let labelled: RecordKey[];

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({ repo: z.string() }),
      // Nothing changes while the backfill runs: its watch only waits for the stop.
      watch: async function* (ctx) {
        watchCalls += 1;
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      read: async (_ctx, keys) =>
        keys.flatMap((key) => {
          const issue = issues.get(Number(key.slice("acme/web#".length)));
          return issue === undefined ? [] : [{ key, state: issue }];
        }),
      scan: async function* (_ctx, cursor) {
        scans.push(cursor);
        let below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
        for (;;) {
          const numbers = [...issues.keys()].filter((n) => n < below).sort((a, b) => b - a);
          const page = numbers.slice(0, 10);
          const last = page.at(-1);
          const next = numbers.length > page.length && last !== undefined ? String(last) : null;
          yield {
            rows: page.map((n) => ({ key: `acme/web#${n}`, state: issues.get(n) ?? {} })),
            next,
          };
          if (next === null) {
            return;
          }
          below = Number(next);
        }
      },
    }),
  },
  actions: {
    label: action({
      config: z.object({ add: z.array(z.string()) }),
      run: async (_ctx, record) => {
        labelled.push(record.key);
      },
    }),
  },
});

function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { tracker: { token: env("TRACKER_TOKEN") } },
    sources: [
      {
        name: "issues",
        source: sourceCall("@facetdb/tracker", "issues", { repo: "acme/web" }),
        read: ["title", "body"],
        questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
        actions: [actionCall("@facetdb/tracker", "label", { add: ["triaged"] })],
      },
    ],
  });
}

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;
let served: HttpHandler[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  issues = new Map();
  for (let n = 1; n <= 25; n += 1) {
    issues.set(n, { title: `Issue ${n}`, body: `What issue ${n} says` });
  }
  watchCalls = 0;
  scans = [];
  labelled = [];
  served = [];
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(argv: readonly string[], stop: AbortSignal) {
  const connect = sharePools((url, connectOptions) => world.connect(url, connectOptions));
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(project()),
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      abortAfter: () => new AbortController().signal,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: ENV,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: (specifier) =>
            specifier === "@facetdb/tracker"
              ? Promise.resolve({ default: tracker })
              : Promise.reject(
                  Object.assign(new Error(`Cannot find package '${specifier}'`), {
                    code: "ERR_MODULE_NOT_FOUND",
                  }),
                ),
          builtins: {},
        }),
      serve: (handler, port) => {
        served.push(handler);
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      stopSignal: () => stop,
    },
    COMMANDS,
  );
}

const ISSUES_ID = storeSourceId(projectRef(PROJECT_DIR).id, "issues");

async function count(table: "records" | "jobs"): Promise<number> {
  const rows = await world.client.query(`select count(*)::int as n from facetdb.${table}`);
  return Number(rows[0]?.["n"]);
}

async function statuses(): Promise<string[]> {
  const rows = await world.client.query(
    "select status from facetdb.records where source_id = $1 order by record_key",
    [ISSUES_ID],
  );
  return rows.map((row) => String(row["status"]));
}

/** Moves the worker's clock until `check` holds: its loops, its jobs and its outbox wait on it. */
async function until(check: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(
    async () => {
      clock.advance(1_000);
      await check();
    },
    { timeout: 10_000, interval: 5 },
  );
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await served[0]?.(
    new Request(`http://127.0.0.1:4040${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    THIS_MACHINE,
  );
  return { status: response?.status, json: (await response?.json()) as Record<string, unknown> };
}

describe("the worker backfills a plugin source (worker-plugin-backfill)", () => {
  it("@timing estimates through the plugin's scan, then takes every record in and its loop answers each and runs its action", async () => {
    const stop = new AbortController();
    const running = run(["worker"], stop.signal);
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    const asked = await call("POST", "/v1/sources/issues/backfill/estimate", {});
    expect(asked.status).toBe(202);
    let token = "";
    await until(async () => {
      const status = await call("GET", "/v1/sources/issues/backfill");
      expect(status.json).toMatchObject({ state: "waiting", estimate: { records: 25 } });
      token = String(status.json["token"]);
    });
    // The estimate stored, queued and asked nothing.
    expect(await count("records")).toBe(0);
    expect(await count("jobs")).toBe(0);
    expect(provider.callCount).toBe(0);
    expect(scans).toEqual([null]);

    const started = await call("POST", "/v1/sources/issues/backfill/start", { token });
    expect(started).toMatchObject({ status: 200, json: { state: "running" } });
    await until(async () => {
      const status = await call("GET", "/v1/sources/issues/backfill");
      expect(status.json).toMatchObject({ state: "finished", counts: { queued: 25 } });
    });
    // One call of the plugin's scan for the estimate, one for the run.
    expect(scans).toEqual([null, null]);
    await until(async () => {
      expect(await statuses()).toEqual(Array.from({ length: 25 }, () => "done"));
    });
    await until(() => {
      expect([...labelled].sort()).toEqual(
        Array.from({ length: 25 }, (_, index) => `acme/web#${index + 1}`).sort(),
      );
    });
    expect(provider.callCount).toBe(25);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("issues: backfill started under version 1.");
    expect(result.stdout).toContain(
      "issues: backfill finished. Finished: 25 records queued for the worker, 0 already answered.",
    );
    // The job's connector never ran the plugin's watch: the loop's alone did.
    expect(watchCalls).toBe(1);
  });
});
