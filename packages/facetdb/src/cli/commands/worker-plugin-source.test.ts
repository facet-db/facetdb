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
  type ActionContext,
  action,
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
 * `facetdb worker` runs a plugin source: a fixture plugin's source in a running worker, the
 * Postgres store on PGlite. A key the plugin reports is read into the store, answered, and
 * explained and exported from the store's log; an unsure answer makes a review card; an action of
 * the same plugin is handed the source's settings; the record's state lives in `facetdb.records`
 * only; a `SourceAccessLost` stops that source alone with FacetDB's words; `--once` answers what is
 * queued without starting the plugin's watch; and the plugin's wait leaves no timer at the stop.
 */

const PROJECT_DIR = "/work/tracker-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
/** What the plugin's own refused-credential error says: it must reach no line or page. */
const LEAKED = "token trk_s3cret-token revoked";
const TRACKER_TOKEN = "trk_s3cret-token";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  TRACKER_TOKEN,
};
/** How often the fixture plugin looks for changes, on the worker's clock. */
const POLL_MS = 5_000;

type Issue = Readonly<Record<string, StateValue>>;

/** The tool outside FacetDB: its issues and a log of the keys that changed, in order. */
let issues: Map<RecordKey, Issue>;
let changed: RecordKey[];
/** Set when the tool starts refusing the plugin's credential. */
let revoked: boolean;
let watchCalls: number;
/** The plugin's waits on the worker's clock still running: none once the source has stopped. */
let waiting: number;
let ran: { readonly ctx: ActionContext<unknown>; readonly settings: unknown }[];

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({ project: z.string() }),
      // A `since` poll on the worker's clock, resuming from its saved cursor.
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
  actions: {
    tag: action({
      config: z.object({ tag: z.string() }),
      run: async (ctx, _record, _decisions, settings) => {
        ran.push({ ctx, settings });
      },
    }),
  },
});

function edit(key: RecordKey, title: string): void {
  issues.set(key, { id: key, title });
  changed.push(key);
}

/** One plugin source, `issues`, beside an API source that keeps running whatever it does. */
function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { tracker: { token: env("TRACKER_TOKEN") } },
    sources: [
      {
        name: "issues",
        source: sourceCall("@facetdb/tracker", "issues", { project: "web" }),
        read: ["id", "title"],
        questions: { minor: noul("Is this issue minor?") },
        actions: [actionCall("@facetdb/tracker", "tag", { tag: "seen" })],
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
  changed = [];
  revoked = false;
  watchCalls = 0;
  waiting = 0;
  ran = [];
  served = [];
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  // Every record is a clear "no", but the one keyed `unsure`, which falls between the thresholds.
  provider = createFakeProvider({
    keyField: "id",
    answers: { unsure: { minor: { type: "noul", probability: 0.5 } } },
    defaults: { noul: 0.01 },
  });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  options: { readonly config?: () => ProjectConfig; readonly stop?: AbortSignal } = {},
) {
  const config = options.config ?? project;
  const connect = sharePools((url, connectOptions) => world.connect(url, connectOptions));
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(config()),
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
      ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
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

/** Moves the worker's clock until `check` holds: its loops, its outbox and the plugin wait on it. */
async function until(check: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(
    async () => {
      clock.advance(1_000);
      await check();
    },
    { timeout: 10_000, interval: 5 },
  );
}

async function get(path: string): Promise<unknown> {
  const response = await served[0]?.(new Request(`http://127.0.0.1:4040${path}`), THIS_MACHINE);
  return response?.json();
}

describe("the worker runs a plugin source (worker-plugin-source)", () => {
  it("@timing answers a key the plugin reports, explain and export read it, an unsure one makes a card", async () => {
    const stop = new AbortController();
    const running = run(["worker"], { stop: stop.signal });
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    edit("k1", "Typo in README MARK-STATE");
    await until(async () => {
      expect(await recordOf("k1")).toMatchObject({ status: "done" });
    });
    // The action of the same plugin is handed the source's own settings.
    await until(() => {
      expect(ran.map((call) => call.ctx.source)).toEqual([
        { name: "issues", settings: { project: "web" } },
      ]);
    });
    expect(ran[0]?.settings).toEqual({ tag: "seen" });

    edit("unsure", "Login loops after SSO");
    await until(async () => {
      expect(await recordOf("unsure")).toMatchObject({ status: "needs_review" });
    });
    const cards = await world.client.query(
      "select record_key from facetdb.reviews where source_id = $1",
      [ISSUES_ID],
    );
    expect(cards.map((card) => card["record_key"])).toEqual(["unsure"]);

    // The sources endpoint says the connector in words.
    expect(await get("/v1/sources")).toMatchObject({
      sources: [
        {
          name: "issues",
          kind: "plugin",
          connector: "Plugin @facetdb/tracker, issues",
          install: null,
          login: null,
        },
        { name: "support", kind: "api" },
      ],
    });

    // The plugin saved its cursor after the keys it covers; it is the store's, one per source.
    expect(await store.cursors.load(`plugin-source:${ISSUES_ID}`)).toEqual({
      cursor: "2",
      done: true,
    });
    // Registered in the store as a plugin source, never as a table's.
    const registered = await world.client.query("select kind from facetdb.sources where id = $1", [
      ISSUES_ID,
    ]);
    expect(registered).toEqual([{ kind: "plugin-source" }]);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("issues: answered k1");
    // The plugin's wait on the worker's clock ended with the source: no timer is left behind.
    expect(watchCalls).toBe(1);
    expect(waiting).toBe(0);

    // The record's state lives in facetdb.records, and nowhere else in the store.
    const tables = await world.client.query(
      "select table_name from information_schema.tables where table_schema = 'facetdb' and table_type = 'BASE TABLE' order by 1",
    );
    const holding: string[] = [];
    for (const row of tables) {
      const name = String(row["table_name"]);
      const found = await world.client.query(
        `select count(*)::int as n from facetdb."${name}" t where t::text like '%MARK-STATE%'`,
      );
      if (Number(found[0]?.["n"]) > 0) {
        holding.push(name);
      }
    }
    expect(holding).toEqual(["records"]);

    const explained = await run(["explain", "issues", "k1"]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain('History of record k1 of "issues", oldest first:');
    expect(explained.stdout).toContain("Now: minor: no · status: done");

    const exported = await run(["export", "--source", "issues"]);
    expect(exported.code, exported.stderr).toBe(0);
    const lines = exported.stdout.trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { record_key: string }).record_key)).toEqual([
      "k1",
      "unsure",
    ]);
  });

  it("@timing a SourceAccessLost stops that source alone, in FacetDB's words, and is tried again", async () => {
    const stop = new AbortController();
    const running = run(["worker"], { stop: stop.signal });
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });
    edit("k1", "first");
    await until(async () => {
      expect(await recordOf("k1")).toMatchObject({ status: "done" });
    });

    revoked = true;
    await until(async () => {
      const home = (await get("/v1/home")) as { stopped?: readonly { source: string }[] };
      expect(JSON.stringify(home)).toContain("lost access");
    });
    // The API source still runs; only the plugin source stopped, with a time it is tried again.
    const config = (await get("/v1/config")) as { pending: readonly Record<string, unknown>[] };
    expect(config.pending).toEqual([
      expect.objectContaining({
        source: "issues",
        outcome: "not-started",
        message: expect.stringContaining(
          "the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it.",
        ) as string,
        checkAgain: true,
      }),
    ]);

    // The credential restored where it is granted: the next try starts the source again.
    revoked = false;
    edit("k2", "second");
    await until(async () => {
      clock.advance(30_000);
      expect(await recordOf("k2")).toMatchObject({ status: "done" });
    });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "issues stopped: the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it. The other sources keep running; the worker tries issues again at",
    );
    expect(result.stdout).toContain("issues: started again after it stopped");
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("trk_s3cret");
    }
    // The failed loop's watch and the one that started again both ended with their source.
    expect(watchCalls).toBe(2);
    expect(waiting).toBe(0);
  });

  it("@timing prints a plugin's keys with no line break, escape or format character, and refuses a key the store cannot keep", async () => {
    const stop = new AbortController();
    const running = run(["worker"], { stop: stop.signal });
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    // A key with a right-to-left override, which the store keeps; and one with a line break and a
    // terminal escape, which it cannot (the plugin naming one on every turn: plugin-source.test.ts).
    const forged = "k9\nissues: answered everything\u001b[31m";
    edit("k‮evil", "Reversed");
    changed.push(forged);
    await until(async () => {
      expect(await recordOf("k‮evil")).toMatchObject({ status: "done" });
    });
    edit("k2", "after the bad key");
    await until(async () => {
      expect(await recordOf("k2")).toMatchObject({ status: "done" });
    });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "issues: answered kevil… (a key of 6 characters, shown in part)",
    );
    expect(result.stdout).toContain(
      "named a key the store cannot keep (it holds a control character (a NUL, a line break or an escape)), so it is not read or queued: k9issues: answered everything[31m…",
    );
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("‮");
      expect(output).not.toContain("\nissues: answered everything");
    }
    expect(await recordOf(forged)).toBeUndefined();
  });

  it("--once answers what is queued and exits, never starting the plugin's watch", async () => {
    issues.set("k1", { id: "k1", title: "queued earlier" });
    const queued = store.connector({ sourceId: ISSUES_ID, fields: ["id", "title"], workerId: "w" });
    await queued.upsertRecord("k1", { id: "k1", title: "queued earlier" });

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("issues: answered k1");
    expect(await recordOf("k1")).toMatchObject({ status: "done" });
    expect(watchCalls).toBe(0);
  });

  it("facetdb uninstall never plans a plugin source: it is store-held, never a table", async () => {
    const one = await run(["uninstall", "--source", "issues", "--purge", "--dry-run"]);
    expect(one.code).toBe(1);
    expect(one.stderr).toContain(
      'the source "issues" does not read a table (it is read by the plugin @facetdb/tracker, and a plugin source keeps its records and answers in the FacetDB store)',
    );
    const all = await run(["uninstall", "--purge", "--dry-run"]);
    expect(all.code).toBe(1);
    expect(all.stderr).toContain(
      "no source in the config reads a table, so there is nothing to install",
    );
    for (const result of [one, all]) {
      expect(result.stdout).not.toContain("do $$");
    }
  });

  it("refuses to start a plugin source its plugin lacks or whose settings its schema refuses", async () => {
    const lacking = await run(["worker", "--once", "--no-http"], {
      config: () =>
        facetdb({
          model: "jev-1.14.0",
          plugins: { tracker: { token: env("TRACKER_TOKEN") } },
          sources: [
            {
              name: "issues",
              source: sourceCall("@facetdb/tracker", "pulls"),
              read: ["id", "title"],
              questions: { minor: noul("Is this issue minor?") },
            },
          ],
        }),
    });
    expect(lacking.code).toBe(1);
    expect(lacking.stderr).toContain(
      'sources[0].source.source is "pulls", but the plugin "@facetdb/tracker" has no source of that name: its sources are issues',
    );
    expect(watchCalls).toBe(0);

    const refused = await run(["worker", "--once", "--no-http"], {
      config: () =>
        facetdb({
          model: "jev-1.14.0",
          plugins: { tracker: { token: env("TRACKER_TOKEN") } },
          sources: [
            {
              name: "issues",
              source: sourceCall("@facetdb/tracker", "issues", { project: 7 }),
              read: ["id", "title"],
              questions: { minor: noul("Is this issue minor?") },
            },
          ],
        }),
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "the settings of sources[0].source (@facetdb/tracker issues) are refused by the source's schema",
    );
  });

  it("@timing pending() names a plugin source a reload added whose plugin this worker did not load", async () => {
    const apiOnly = facetdb({
      model: "jev-1.14.0",
      sources: [{ name: "support", api: true, read: ["id"], questions: { minor: noul("Minor?") } }],
    });
    let inFile: ProjectConfig = apiOnly;
    const stop = new AbortController();
    const running = run(["worker"], { config: () => inFile, stop: stop.signal });
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    inFile = {
      ...apiOnly,
      sources: [...apiOnly.sources, ...project().sources.filter((one) => one.name === "issues")],
    };
    const response = await served[0]?.(
      new Request("http://127.0.0.1:4040/v1/reload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      THIS_MACHINE,
    );
    const words =
      'new in facetdb.config.ts and not answered yet: sources[1].source.plugin names the plugin "@facetdb/tracker", which this worker did not load when it started; restart facetdb worker so it loads the plugin, after installing it with facetdb add if it is not installed.';
    expect(await response?.json()).toMatchObject({
      sources: [
        { source: "support", outcome: "unchanged" },
        { source: "issues", outcome: "not-started", message: words },
      ],
    });
    expect(((await get("/v1/config")) as { pending: unknown }).pending).toEqual([
      expect.objectContaining({
        source: "issues",
        outcome: "not-started",
        message: words,
        migrate: false,
        checkAgain: false,
      }),
    ]);
    expect(watchCalls).toBe(0);

    stop.abort();
    expect((await running).code).toBe(0);
  });
});
