import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecordKey, StateValue } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, facetdb, noul, type ProjectConfig, sourceCall } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  createPluginHost,
  definePlugin,
  type Plugin,
  SourceAccessLost,
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
 * `facetdb worker` takes a plugin source's webhook at `POST /v1/hooks/:plugin/:source` with no
 * FacetDB login, from another machine: a fixture plugin checks an HMAC of the raw body with its
 * secret. A good delivery queues the record and the worker answers it; a bad signature queues
 * nothing and reads nothing; the same delivery twice is one job and one model call; an event with
 * no key is a 202 with zero queued; a source that stopped is a 503 with when to try again, and a
 * 404 like a running one when its plugin takes no webhook for it; a plugin that fails is said in
 * FacetDB's words; one stuck in its receive, or in the read of a key it named, is given up after 10
 * seconds on the worker's clock with a 504, told through its signal; no header, body or secret
 * reaches a line; and under `--no-http` there is no route, and the worker says the source relies on
 * its poll.
 */

const PROJECT_DIR = "/work/tracker-app";
const START = 1_700_000_000_000;
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const HOOK_SECRET = "whsec_tr4cker-hook-s3cret";
/** What the plugin's own error says: it must reach no line or answer. */
const LEAKED = "receive blew up holding whsec_tr4cker-hook-s3cret";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  TRACKER_TOKEN: "trk_token",
  TRACKER_HOOK_SECRET: HOOK_SECRET,
};
const POLL_MS = 5_000;

type Issue = Readonly<Record<string, StateValue>>;

/** The tool outside FacetDB, and what the plugin was asked to read. */
let issues: Map<RecordKey, Issue>;
let reads: RecordKey[][];
let revoked: boolean;
let watchCalls: number;
/** Each slow plugin call, by step, once its signal told it the delivery was given up. */
let toldToStop: string[];

/** The tool's signature over a delivery's exact bytes: HMAC-SHA256 with the webhook's secret, hex. */
function signatureOf(body: Uint8Array | string, secret = HOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** A plugin call stuck on the service it asks: it ends only when its signal says to. */
function stuckUntilAborted(signal: AbortSignal, step: string): Promise<void> {
  return new Promise((resolve) => {
    const stopped = () => {
      toldToStop.push(step);
      resolve();
    };
    if (signal.aborted) {
      stopped();
    } else {
      signal.addEventListener("abort", stopped, { once: true });
    }
  });
}

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret(), webhookSecret: z.secret() }),
  sources: {
    issues: source({
      // Its poll: here it notices nothing by itself, and stops when its credential is revoked.
      watch: async function* (ctx) {
        watchCalls += 1;
        for (;;) {
          if (revoked) {
            throw new SourceAccessLost("token revoked");
          }
          await ctx.clock.sleep(POLL_MS);
          if (ctx.signal.aborted) {
            return;
          }
          yield [];
        }
      },
      read: async (ctx, keys) => {
        reads.push([...keys]);
        if (keys.includes("slow")) {
          await stuckUntilAborted(ctx.signal, "read");
        }
        return keys.flatMap((key) => {
          const issue = issues.get(key);
          return issue === undefined ? [] : [{ key, state: issue }];
        });
      },
      scan: async function* () {},
      // The signature over the exact bytes first; only then is the body read as data.
      receive: async (ctx, request) => {
        const given = request.headers.get("x-tracker-signature") ?? "";
        const body = new Uint8Array(await request.arrayBuffer());
        const expected = signatureOf(body, ctx.secrets["webhookSecret"]);
        if (
          given.length !== expected.length ||
          !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
        ) {
          return { status: 401, keys: [] };
        }
        const event = JSON.parse(new TextDecoder().decode(body)) as {
          changed: string[];
          explode?: boolean;
          stuck?: boolean;
        };
        if (event.explode === true) {
          throw new Error(LEAKED);
        }
        if (event.stuck === true) {
          await stuckUntilAborted(ctx.signal, "receive");
        }
        return { status: 202, keys: event.changed };
      },
    }),
    // A source of the same plugin that takes no webhook: it is read by its poll alone.
    tasks: source({
      watch: async function* (ctx) {
        for (;;) {
          if (revoked) {
            throw new SourceAccessLost("token revoked");
          }
          await ctx.clock.sleep(POLL_MS);
          if (ctx.signal.aborted) {
            return;
          }
          yield [];
        }
      },
      read: async () => [],
      scan: async function* () {},
    }),
  },
});

function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      tracker: { token: env("TRACKER_TOKEN"), webhookSecret: env("TRACKER_HOOK_SECRET") },
    },
    sources: [
      {
        name: "issues",
        source: sourceCall("@facetdb/tracker", "issues"),
        read: ["id", "title"],
        questions: { minor: noul("Is this issue minor?") },
      },
      {
        name: "tasks",
        source: sourceCall("@facetdb/tracker", "tasks"),
        read: ["id", "title"],
        questions: { minor: noul("Is this task minor?") },
      },
      { name: "support", api: true, read: ["id", "title"], questions: { minor: noul("Minor?") } },
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
  reads = [];
  revoked = false;
  watchCalls = 0;
  toldToStop = [];
  served = [];
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ keyField: "id", defaults: { noul: 0.01 } });
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

async function recordOf(key: string) {
  const rows = await world.client.query(
    "select status, state from facetdb.records where source_id = $1 and record_key = $2",
    [ISSUES_ID, key],
  );
  return rows[0];
}

async function jobCount(): Promise<number> {
  const rows = await world.client.query("select count(*)::int as n from facetdb.jobs");
  return Number(rows[0]?.["n"]);
}

/** Moves the worker's clock until `check` holds: its loops and the plugin's poll wait on it. */
async function until(check: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(
    async () => {
      clock.advance(1_000);
      await check();
    },
    { timeout: 10_000, interval: 5 },
  );
}

/** A stranger's delivery from another machine: no cookie, no API key, signed or not. */
async function deliver(
  body: string,
  options: { readonly path?: string; readonly signature?: string } = {},
) {
  const handler = served[0];
  if (handler === undefined) {
    throw new Error("the worker serves no HTTP surface");
  }
  const response = await handler(
    new Request(`http://worker.example.com${options.path ?? "/v1/hooks/tracker/issues"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracker-signature": options.signature ?? signatureOf(body),
      },
      body,
    }),
    ELSEWHERE,
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    json: (await response.json()) as Record<string, unknown>,
  };
}

/** A studio read, as the operator on this machine. */
async function get(path: string): Promise<unknown> {
  const handler = served[0];
  if (handler === undefined) {
    throw new Error("the worker serves no HTTP surface");
  }
  const response = await handler(new Request(`http://127.0.0.1:4040${path}`), {
    remoteAddress: "127.0.0.1",
  });
  return response.json();
}

/** The worker running until `stop`, its surface served. */
async function started() {
  const stop = new AbortController();
  const running = run(["worker"], stop.signal);
  await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });
  return { stop, running };
}

describe("the worker takes a plugin source's webhook (worker-hooks)", () => {
  it("@timing queues and answers a signed delivery's record once, sent once or twice, and queues nothing for a bad signature", async () => {
    const { stop, running } = await started();
    issues.set("k1", { id: "k1", title: "Typo in README" });
    const event = JSON.stringify({ changed: ["k1"], note: "MARK-BODY" });

    // A bad signature, and none at all: 401, nothing read, stored or queued.
    for (const signature of [signatureOf(event, "not-the-secret"), ""]) {
      expect(await deliver(event, { signature })).toMatchObject({
        status: 401,
        json: { error: { code: "bad_signature" } },
      });
    }
    expect(reads).toEqual([]);
    expect(await recordOf("k1")).toBeUndefined();
    expect(await jobCount()).toBe(0);

    // The same signed delivery twice: the record is queued once, whether or not the worker has
    // answered it in between (the same state queues nothing), so it is one job and one model call.
    expect(await deliver(event)).toEqual({ status: 202, retryAfter: null, json: { queued: 1 } });
    expect(await deliver(event)).toEqual({ status: 202, retryAfter: null, json: { queued: 0 } });
    expect(await jobCount()).toBeLessThanOrEqual(1);

    await until(async () => {
      expect(await recordOf("k1")).toMatchObject({ status: "done" });
    });
    expect(provider.callCount).toBe(1);

    // An event that names no key: taken, nothing queued.
    expect(await deliver(JSON.stringify({ changed: [] }))).toEqual({
      status: 202,
      retryAfter: null,
      json: { queued: 0 },
    });

    // A changed record named again is asked again.
    issues.set("k1", { id: "k1", title: "Typo in README, and in the docs" });
    expect((await deliver(event)).json).toEqual({ queued: 1 });
    await until(() => {
      expect(provider.callCount).toBe(2);
    });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("issues: answered k1");
    // No header, body or secret of any delivery reached a line.
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("MARK-BODY");
      expect(output).not.toContain(signatureOf(event));
      expect(output).not.toContain(HOOK_SECRET);
    }
  });

  it("answers 404 for a name of no plugin source, or of another plugin, the plugin never asked", async () => {
    const { stop, running } = await started();
    const event = JSON.stringify({ changed: ["k1"] });

    for (const path of [
      "/v1/hooks/tracker/pulls",
      "/v1/hooks/github/issues",
      // The API source by its name: no plugin's source at all.
      "/v1/hooks/tracker/support",
      // A running plugin source whose plugin takes no webhook for it.
      "/v1/hooks/tracker/tasks",
    ]) {
      expect(await deliver(event, { path })).toMatchObject({
        status: 404,
        json: { error: { code: "unknown_hook" } },
      });
    }
    expect(reads).toEqual([]);

    stop.abort();
    expect((await running).code).toBe(0);
  });

  it("@timing says a plugin's failure in FacetDB's words, its own never, and answers 500", async () => {
    const { stop, running } = await started();

    const answer = await deliver(JSON.stringify({ changed: ["k1"], explode: true }));
    expect(answer).toMatchObject({ status: 500, json: { error: { code: "hook_failed" } } });
    expect(JSON.stringify(answer.json)).not.toContain("blew up");
    expect(await jobCount()).toBe(0);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "issues: a webhook delivery was not taken in: the plugin @facetdb/tracker (source issues of issues) failed in receive (its own words are not shown, as they could quote a secret it was handed)",
    );
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("blew up");
      expect(output).not.toContain(HOOK_SECRET);
    }
  });

  it("@timing gives a delivery its plugin has not taken in 10 seconds up with a 504, the plugin told through its signal", async () => {
    const { stop, running } = await started();
    issues.set("k1", { id: "k1", title: "Typo in README" });
    issues.set("slow", { id: "slow", title: "Read from a service that does not answer" });

    // Stuck in receive, then stuck in the read of a key it named: each answered at 10 seconds on
    // the worker's clock, and never before.
    for (const [event, step] of [
      [{ changed: ["k1"], stuck: true }, "receive"],
      [{ changed: ["slow"] }, "read"],
    ] as const) {
      let answer: Awaited<ReturnType<typeof deliver>> | undefined;
      const from = clock.now();
      void deliver(JSON.stringify(event)).then((settled) => {
        answer = settled;
      });
      await until(() => {
        expect(answer).toBeDefined();
      });
      expect(clock.now() - from, step).toBeGreaterThanOrEqual(10_000);
      expect(answer).toMatchObject({ status: 504, json: { error: { code: "hook_timeout" } } });
      await vi.waitFor(() => expect(toldToStop.at(-1)).toBe(step));
    }
    // What the stuck receive named after it was given up was never taken in.
    expect(await recordOf("k1")).toBeUndefined();
    expect(await recordOf("slow")).toBeUndefined();

    // The source runs on: the next delivery is taken at once.
    expect(await deliver(JSON.stringify({ changed: ["k1"] }))).toMatchObject({
      status: 202,
      json: { queued: 1 },
    });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "issues: a webhook delivery was given up after 10 seconds: the plugin @facetdb/tracker had not taken it by then, so its work on it is abandoned",
    );
  });

  it("@timing answers 503 with when to try again while the source is stopped, and takes deliveries again once it runs", async () => {
    const { stop, running } = await started();
    await vi.waitFor(() => expect(watchCalls).toBe(1), { timeout: 10_000 });
    issues.set("k1", { id: "k1", title: "Login loops after SSO" });
    const event = JSON.stringify({ changed: ["k1"] });

    // Its poll loses its credential: the source stops, and is tried again 30 seconds on.
    revoked = true;
    const empty = JSON.stringify({ changed: [] });
    await until(async () => {
      expect((await deliver(empty)).status).toBe(503);
    });
    // A stopped source whose plugin takes no webhook for it is unknown, as it is while it runs.
    await until(async () => {
      const config = (await get("/v1/config")) as { pending: readonly { source: string }[] };
      expect(config.pending.map((entry) => entry.source)).toContain("tasks");
    });
    expect(await deliver(empty, { path: "/v1/hooks/tracker/tasks" })).toMatchObject({
      status: 404,
      json: { error: { code: "unknown_hook" } },
    });
    const refused = await deliver(event);
    expect(refused).toMatchObject({ status: 503, json: { error: { code: "source_not_running" } } });
    // Whole seconds until the fleet's next try of the source, at most its first wait.
    expect(refused.retryAfter).toMatch(/^\d+$/);
    const seconds = Number(refused.retryAfter);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(30);
    expect(await recordOf("k1")).toBeUndefined();
    expect(reads).toEqual([]);

    // The credential restored: the fleet's next try starts it, and deliveries are taken again.
    revoked = false;
    await until(async () => {
      clock.advance(30_000);
      expect((await deliver(event)).status).toBe(202);
    });
    await until(async () => {
      expect(await recordOf("k1")).toMatchObject({ status: "done" });
    });

    stop.abort();
    expect((await running).code).toBe(0);
  });

  it("@timing serves no route under --no-http, and says the source relies on its poll", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], stop.signal);
    await vi.waitFor(() => expect(watchCalls).toBe(1), { timeout: 10_000 });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(served).toEqual([]);
    expect(result.stdout).toContain(
      "issues: this worker serves no HTTP (--no-http), so it takes no webhook for this source; its changes reach it by the plugin's own poll, or through a worker that serves POST /v1/hooks/tracker/issues",
    );
    // The API source, and a plugin source whose plugin takes no webhook for it, are not named.
    expect(result.stdout).not.toContain("support: this worker serves no HTTP");
    expect(result.stdout).not.toContain("tasks: this worker serves no HTTP");
  });
});
