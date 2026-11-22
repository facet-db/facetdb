import type { ActionDecisions, ActionRecord } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { ACTION_ERROR_NOT_KEPT } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionCall,
  actionCall,
  facetdb,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  type ActionContext,
  action,
  createPluginHost,
  definePlugin,
  type Plugin,
  z,
} from "../../plugin/index.ts";
import { sharePools } from "../pools.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import { storeSourceId } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb worker` runs a source's actions through their plugins, the Postgres engine on PGlite and
 * a fixture plugin: a decision queues one outbox row per action that applies, holding the decision
 * and the settings and nothing of the record, and the worker's outbox loop runs the plugin's `run`
 * with the record read at delivery. A person's decision queues them again; a failing action changes
 * neither the record, its log nor the other actions; and an `actions` change in the file restarts
 * the source's loop with the new steps.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
/** What the failing action's own error says: it must reach no row, line or alert. */
const LEAKED = "tracker token trk_s3cret-token refused";

type Ran = {
  readonly action: string;
  readonly ctx: ActionContext<unknown>;
  readonly record: ActionRecord;
  readonly decisions: ActionDecisions;
  readonly settings: unknown;
};

let ran: Ran[];

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({}),
  actions: {
    tag: action({
      config: z.object({ tag: z.string() }),
      run: async (ctx, record, decisions, settings) => {
        ran.push({ action: "tag", ctx, record, decisions, settings });
      },
    }),
    broken: action({
      config: z.object({}),
      run: () => Promise.reject(new Error(LEAKED)),
    }),
  },
});

/** The config as the loader reads the file: the source's string from LISTINGS_URL. */
function configWith(actions: readonly ActionCall[]): ProjectConfig {
  const declared = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["id", "title"],
        questions: { is_scam: noul("Is this listing a scam?") },
        actions,
      },
    ],
  });
  return {
    ...declared,
    sources: declared.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
  };
}

/** Tags a scam "scam" and anything else "fine". */
const TAG = actionCall("@facetdb/tracker", "tag", {
  tag: "scam",
  when: { is_scam: true },
  else: { tag: "fine" },
});

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
  ran = [];
  served = [];
  refusals.left = 0;
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const config = configWith([]);
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

/** The outbox insert the store refuses, as a dropped connection would: `left` times, or for good. */
const refusals = { left: 0 };

function run(
  argv: readonly string[],
  options: {
    readonly config: () => ProjectConfig;
    readonly stop?: AbortSignal;
  },
) {
  const connect = sharePools((url, connectOptions) => {
    const client = world.connect(url, connectOptions);
    return {
      ...client,
      query: (text, params) => {
        if (text.includes("insert into facetdb.webhook_outbox") && refusals.left > 0) {
          refusals.left -= 1;
          return Promise.reject(new Error("Connection terminated unexpectedly"));
        }
        return client.query(text, params);
      },
    };
  });
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: {
        FACETDB_SECRET: TEST_SECRET,
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        TYPESAFE_API_KEY: "ts-test-key",
      },
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(options.config()),
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      // An action's attempt never runs out of time here: nothing in these tests is slow.
      abortAfter: () => new AbortController().signal,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: {},
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

/** The outbox's action rows, oldest first. */
async function actionRows() {
  return world.client.query(
    `select id::text as id, source_id, record_key, plugin, action, position, payload,
            delivered_at::text as delivered_at, gave_up_at::text as gave_up_at, last_error
       from facetdb.webhook_outbox where plugin is not null order by id`,
  );
}

async function listing(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await world.client.query(
    "select is_scam, facetdb_status from public.listings where id = $1",
    [id],
  );
  return rows[0];
}

const SOURCE_ID = storeSourceId(projectRef(PROJECT_DIR).id, "listings");

describe("the worker runs a source's actions through their plugins (worker-actions)", () => {
  it("one decision queues one row, and the plugin's run gets the record, the decisions and the settings", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once", "--no-http"], {
      config: () => configWith([TAG]),
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("plugin actions run once plugins are resolved");
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      source_id: SOURCE_ID,
      record_key: "r1",
      plugin: "@facetdb/tracker",
      action: "tag",
      position: 0,
      gave_up_at: null,
      last_error: null,
    });
    expect(row?.["delivered_at"]).not.toBeNull();
    // The row holds the decision and the settings, never the record's state.
    expect(JSON.stringify(row?.["payload"])).not.toContain("A red car");

    expect(ran).toHaveLength(1);
    const [call] = ran;
    expect(call?.record).toMatchObject({
      key: "r1",
      state: { id: "r1", title: "A red car" },
      status: "done",
    });
    expect(call?.decisions).toMatchObject({ is_scam: { kind: "decided", value: false } });
    expect(call?.settings).toEqual({ tag: "fine" });
    expect(call?.ctx.source).toEqual({ name: "listings", settings: null });
    // The answer columns were written first, as without actions.
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
  });

  it("a person's decision queues the actions again, and the worker delivers them", async () => {
    provider = createFakeProvider({ defaults: { noul: 0.5 } });
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const config = () => configWith([TAG]);

    const first = await run(["worker", "--once"], { config });
    expect(first.code, first.stderr).toBe(0);
    expect(await listing("r1")).toMatchObject({ facetdb_status: "needs_review" });
    // The model's answer: still open, so `when` cannot hold and the else applies.
    expect(ran.map((call) => [call.record.status, call.settings])).toEqual([
      ["needs_review", { tag: "fine" }],
    ]);

    const [handler] = served;
    const call = async (path: string, body: unknown) => {
      const response = await handler?.(
        new Request(`http://127.0.0.1:4040${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        THIS_MACHINE,
      );
      return { status: response?.status, json: (await response?.json()) as unknown };
    };
    const opened = await call("/v1/review/open", {});
    const { card } = opened.json as { card: { stateHash: string } };
    clock.advance(1_000);
    const decided = await call("/v1/review/r1/decide", {
      source: "listings",
      stateHash: card.stateHash,
      question: "is_scam",
      value: true,
    });
    expect(decided).toMatchObject({ status: 200, json: { status: "done", failedActions: [] } });
    expect(await actionRows()).toHaveLength(2);

    // The next worker run delivers what the decision queued.
    const second = await run(["worker", "--once", "--no-http"], { config });
    expect(second.code, second.stderr).toBe(0);
    expect(ran.map((ranCall) => [ranCall.record.status, ranCall.settings])).toEqual([
      ["needs_review", { tag: "fine" }],
      ["done", { tag: "scam" }],
    ]);
    expect(ran[1]?.decisions).toMatchObject({ is_scam: { kind: "decided", value: true } });
    expect(ran[1]?.record.decidedAt.getTime()).toBe(START + 1_000);
  });

  it("a failing action changes neither the record, its log nor the other actions, and its words are not kept", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once", "--no-http"], {
      config: () => configWith([actionCall("@facetdb/tracker", "broken", {}), TAG]),
    });

    expect(result.code, result.stderr).toBe(0);
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
    const history = await store.log(SOURCE_ID).history("r1");
    expect(history.map((entry) => entry.kind)).toEqual(["answer"]);
    // The other action ran, and the failing one waits for its retry with fixed words.
    expect(ran.map((call) => call.settings)).toEqual([{ tag: "fine" }]);
    const rows = await actionRows();
    expect(
      rows.map((row) => [row["action"], row["delivered_at"] !== null, row["last_error"]]),
    ).toEqual([
      ["broken", false, ACTION_ERROR_NOT_KEPT],
      ["tag", true, null],
    ]);
    expect(result.stdout).not.toContain("trk_s3cret");
    expect(result.stderr).not.toContain("trk_s3cret");
  });

  it("a row the store refuses once is queued by the next pass, from the log, with one model call in all", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    refusals.left = 1;

    const result = await run(["worker", "--once", "--no-http"], {
      config: () => configWith([TAG]),
    });

    expect(result.code, result.stderr).toBe(0);
    // The decision stands from the first pass; the job went back to the queue, not acked.
    expect(await listing("r1")).toMatchObject({ is_scam: false, facetdb_status: "done" });
    expect(result.stdout).toContain(
      "listings: r1 failed at action: it was not queued, as the store did not take it (Connection terminated unexpectedly); it is queued again when the worker next writes the record's decision, or a person decides it again",
    );
    expect(result.stdout).toContain("listings: already answered r1 at this state");
    expect(provider.callCount).toBe(1);
    const rows = await actionRows();
    expect(rows.map((row) => [row["action"], row["delivered_at"] !== null])).toEqual([
      ["tag", true],
    ]);
    expect(ran.map((call) => call.settings)).toEqual([{ tag: "fine" }]);
    const jobs = await world.client.query("select count(*)::int as n from facetdb.jobs");
    expect(jobs[0]?.["n"]).toBe(0);
  });

  it("a store that refuses the row for good keeps the job queued, says so once a pass, and never spins", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    refusals.left = Number.POSITIVE_INFINITY;

    const result = await run(["worker", "--once", "--no-http"], {
      config: () => configWith([TAG]),
    });

    expect(result.code, result.stderr).toBe(0);
    // The answering pass, then one pass that settles nothing, where --once stops: two lines.
    const refused = result.stdout
      .split("\n")
      .filter((line) => line.includes("failed at action: it was not queued"));
    expect(refused).toHaveLength(2);
    expect(provider.callCount).toBe(1);
    expect(await actionRows()).toEqual([]);
    expect(await listing("r1")).toMatchObject({ facetdb_status: "done" });
    // Still queued for the next worker, unclaimed.
    const jobs = await world.client.query(
      "select count(*)::int as n from facetdb.jobs where claimed_by is null",
    );
    expect(jobs[0]?.["n"]).toBe(1);
  });

  it("refuses to start on an action its plugin does not provide, before anything opens", async () => {
    const result = await run(["worker", "--once", "--no-http"], {
      config: () => configWith([actionCall("@facetdb/tracker", "tagg", { tag: "x" })]),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'sources[0].actions[0].action is "tagg", but the plugin "@facetdb/tracker" has no action of that name: its actions are tag, broken',
    );
    expect(await actionRows()).toEqual([]);
  });

  it("@timing restarts the source's loop with the new steps when the file's actions change", async () => {
    let inFile = configWith([TAG]);
    const stop = new AbortController();
    const running = run(["worker"], { config: () => inFile, stop: stop.signal });
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    const reload = async () => {
      const response = await served[0]?.(
        new Request("http://127.0.0.1:4040/v1/reload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        THIS_MACHINE,
      );
      return response?.json();
    };

    inFile = configWith([
      actionCall("@facetdb/tracker", "tag", { tag: "renamed", when: { is_scam: false } }),
    ]);
    expect(await reload()).toMatchObject({
      loaded: true,
      sources: [{ source: "listings", outcome: "restarted" }],
      notes: [],
    });

    await world.client.query("insert into public.listings (id, title) values ('r2', 'A flat')");
    await vi.waitFor(
      () => {
        clock.advance(2_000);
        expect(ran.map((call) => call.settings)).toEqual([{ tag: "renamed" }]);
      },
      { timeout: 10_000 },
    );

    // An action its plugin lacks keeps the loop on the steps it runs, and the reload says why.
    const renamed = inFile;
    inFile = configWith([actionCall("@facetdb/tracker", "tagg", { tag: "x" })]);
    expect(await reload()).toMatchObject({
      sources: [
        {
          source: "listings",
          outcome: "failed",
          message: expect.stringContaining(
            'sources[0].actions[0].action is "tagg", but the plugin "@facetdb/tracker" has no action of that name',
          ) as string,
        },
      ],
    });
    // A `plugins` entry giving the plugin the settings it already runs with changes nothing, so
    // nothing restarts and the reload says nothing of it (no restart is asked for).
    inFile = { ...renamed, plugins: { tracker: {} } };
    expect(await reload()).toMatchObject({
      sources: [{ source: "listings", outcome: "unchanged" }],
      notes: [],
    });
    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
  });
});
