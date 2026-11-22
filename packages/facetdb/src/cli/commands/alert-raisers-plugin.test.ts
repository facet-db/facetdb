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
import { docsLink, runInProcess } from "../program.ts";
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
import { ACCESS_CHECK_EVERY_MS } from "./alert-raisers.ts";
import { projectRef } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * A plugin source's Connector lost access through `facetdb worker`'s own wiring: a
 * `SourceAccessLost` raises it at once in the source connector's words, never the plugin's own; a
 * plugin source has no doctor, so the alert is resolved at the first 5-minute look after a read
 * through the plugin answered, and a source that came back with nothing to read keeps it open,
 * raised once. A fixture plugin over the worker's clock, the store on PGlite.
 */

const PROJECT_DIR = "/work/tracker-app";
const START = 1_700_000_000_000;
/** What the plugin's own refused-credential error says: it must reach no alert, line or page. */
const LEAKED = "token trk_s3cret-token revoked";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  TRACKER_TOKEN: "trk_s3cret-token",
};
/** How often the fixture plugin looks for changes, on the worker's clock. */
const POLL_MS = 5_000;

let issues: Map<RecordKey, Readonly<Record<string, StateValue>>>;
let changed: RecordKey[];
let revoked: boolean;
let watchCalls: number;
let waiting: number;

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({ project: z.string() }),
      watch: async function* (ctx) {
        watchCalls += 1;
        let seen = Number((await ctx.cursor.load()) ?? "0");
        for (;;) {
          if (revoked) {
            throw new SourceAccessLost(LEAKED);
          }
          if (changed.length > seen) {
            const batch = changed.slice(seen);
            seen = changed.length;
            yield batch;
            await ctx.cursor.save(String(seen));
          }
          waiting += 1;
          try {
            await ctx.clock.sleep(POLL_MS);
          } finally {
            waiting -= 1;
          }
          if (ctx.signal.aborted) {
            return;
          }
        }
      },
      read: async (_ctx, keys) =>
        keys.flatMap((key) => {
          const issue = issues.get(key);
          return issue === undefined ? [] : [{ key, state: issue }];
        }),
      scan: async function* () {},
    }),
  },
});

function edit(key: RecordKey, title: string): void {
  issues.set(key, { id: key, title });
  changed.push(key);
}

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  plugins: { tracker: { token: env("TRACKER_TOKEN") } },
  sources: [
    {
      name: "issues",
      source: sourceCall("@facetdb/tracker", "issues", { project: "web" }),
      read: ["id", "title"],
      questions: { minor: noul("Is this issue minor?") },
    },
  ],
});

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  issues = new Map();
  changed = [];
  revoked = false;
  watchCalls = 0;
  waiting = 0;
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(stop: AbortSignal) {
  const connect = sharePools((url, connectOptions) => world.connect(url, connectOptions));
  return runInProcess(
    ["worker", "--no-http"],
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(config),
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
              : Promise.reject(new Error(`Cannot find package '${specifier}'`)),
          builtins: {},
        }),
      serve: (_handler, port) => Promise.resolve({ port, close: () => Promise.resolve() }),
      stopSignal: () => stop,
    },
    COMMANDS,
  );
}

const ISSUES_ID = storeSourceId(projectRef(PROJECT_DIR).id, "issues");

async function statusOf(key: string): Promise<unknown> {
  const rows = await world.client.query(
    "select status from facetdb.records where source_id = $1 and record_key = $2",
    [ISSUES_ID, key],
  );
  return rows[0]?.["status"];
}

/** The Connector lost access lines, oldest first, and the history's raw text. */
async function lost(): Promise<{
  readonly lines: readonly {
    readonly phase: string;
    readonly what: string;
    readonly link: string;
  }[];
  readonly raw: string;
}> {
  const rows = await world.client.query(
    "select record::text as record from facetdb.alert_history order by id",
  );
  return {
    raw: rows.map((row) => String(row["record"])).join("\n"),
    lines: rows.flatMap((row) => {
      const record = JSON.parse(String(row["record"])) as {
        phase: string;
        event: { kind: string; what: string; link: string };
      };
      return record.event.kind === "connector_lost_access"
        ? [{ phase: record.phase, what: record.event.what, link: record.event.link }]
        : [];
    }),
  };
}

/** Moves the worker's clock a second at a time until `check` holds. */
async function until(check: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(
    async () => {
      clock.advance(1_000);
      await check();
    },
    { timeout: 10_000, interval: 5 },
  );
}

/**
 * Moves the clock to the worker's next 5-minute look and waits for it to sleep toward the one after:
 * the look's sleep is the only one on the clock minutes away (the others are seconds).
 */
async function nextLook(): Promise<void> {
  const due = clock.pending().find((at) => at - clock.now() > 2 * 60_000);
  if (due === undefined) {
    throw new Error("the worker has its next look on the clock");
  }
  clock.advance(due - clock.now());
  await vi.waitFor(() => expect(clock.pending()).toContain(due + ACCESS_CHECK_EVERY_MS), {
    timeout: 10_000,
  });
}

describe("a plugin source's lost access in the running worker (alert-raisers)", () => {
  it("@timing raises a refused credential at once in FacetDB's words, keeps it open while the source that came back reads nothing, and resolves it at the look after its first read", async () => {
    const stop = new AbortController();
    const running = run(stop.signal);
    edit("k1", "first");
    await until(async () => {
      expect(await statusOf("k1")).toBe("done");
    });

    revoked = true;
    await until(async () => {
      expect((await lost()).lines).toHaveLength(1);
    });
    expect((await lost()).lines[0]).toEqual({
      phase: "raised",
      what: "The plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it.",
      link: docsLink("worker-login"),
    });

    // The credential restored where it is granted: the source starts again after its wait, and
    // nothing changed in the service since, so nothing is read through the plugin.
    revoked = false;
    await until(() => {
      expect(watchCalls).toBe(2);
    });
    await nextLook();
    await nextLook();
    expect((await lost()).lines.map((line) => line.phase)).toEqual(["raised"]);

    // The first change read through the plugin is the proof: the look after it resolves the alert.
    edit("k2", "second");
    await until(async () => {
      expect(await statusOf("k2")).toBe("done");
    });
    await nextLook();
    expect((await lost()).lines.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    const active = await world.client.query("select state::text as state from facetdb.alerts");
    for (const text of [result.stdout, result.stderr, (await lost()).raw, JSON.stringify(active)]) {
      expect(text).not.toContain("trk_s3cret");
    }
    expect(waiting).toBe(0);
  });
});
