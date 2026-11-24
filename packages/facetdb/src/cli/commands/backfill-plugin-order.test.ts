import {
  type AlertSignals,
  type BackfillProgress,
  backfillRun,
  type CursorStore,
  type ModelProvider,
  type RecordKey,
  reviewsOf,
  type ScanCursor,
  type ScanPage,
  type SpendingGate,
  type StateValue,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeOpenConnector,
  FakeReviewQueue,
  FakeRunLog,
  freshHeldModel,
} from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import type { BackfillJobStatus } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  env,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
  sourceCall,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { createPluginHost, definePlugin, type Plugin, source, z } from "../../plugin/index.ts";
import { pluginBackfillConnector, wireBackfillDryRun } from "../backfill-wiring.ts";
import { sharePools } from "../pools.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlConnect,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { createBackfillJobs, type JobLoop } from "./backfill-jobs.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * A plugin source's backfill pages through the plugin's `scan` in whatever order the plugin yields,
 * so no word about it promises newest first; a table source's words stay as they were. Each of the
 * three places, for a plugin source and a table source of one project: `facetdb backfill`'s header,
 * the worker's backfill job (its counting and running lines, and a restart under a new version),
 * and the Sources row of a run part way, as a worker serves it. The tracker plugin here pages its
 * issues oldest first, as a plugin may.
 */

const PROJECT_DIR = "/work/tracker-app";
const PROJECT_ID = projectRef(PROJECT_DIR).id;
const START = 1_700_000_000_000;
const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
/** The socket a request on this machine's loopback address arrives on: the OS user's. */
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  TRACKER_TOKEN: "trk_s3cret-token",
};

/** The table source's header as `facetdb backfill` has always printed it. */
const TABLE_HEADER = "Backfill of public.listings (source listings), newest records first:";
const PLUGIN_HEADER =
  "Backfill of @facetdb/tracker issues (source issues), records in the plugin's order:";

type Issue = Readonly<Record<string, StateValue>>;

const ISSUES: ReadonlyMap<number, Issue> = new Map(
  Array.from({ length: 25 }, (_, index) => [
    index + 1,
    { title: `Issue ${index + 1}`, body: `What issue ${index + 1} says` },
  ]),
);

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({ repo: z.string() }),
      watch: async function* () {},
      read: async (_ctx, keys) =>
        keys.flatMap((key) => {
          const issue = ISSUES.get(Number(key.slice("acme/web#".length)));
          return issue === undefined ? [] : [{ key, state: issue }];
        }),
      // Ten a page, oldest first: the plugin's own order; a cursor is the last number of a page.
      scan: async function* (_ctx, cursor) {
        let above = cursor === null ? 0 : Number(cursor);
        for (;;) {
          const numbers = [...ISSUES.keys()].filter((n) => n > above).sort((a, b) => a - b);
          const page = numbers.slice(0, 10);
          const last = page.at(-1);
          const next = numbers.length > page.length && last !== undefined ? String(last) : null;
          yield {
            rows: page.map((n) => ({ key: `acme/web#${n}`, state: ISSUES.get(n) ?? {} })),
            next,
          };
          if (next === null) {
            return;
          }
          above = Number(next);
        }
      },
    }),
  },
});

const PROJECT: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  plugins: { tracker: { token: env("TRACKER_TOKEN") } },
  sources: [
    {
      name: "listings",
      database: WORKER_URL,
      table: "listings",
      read: ["title", "body"],
      questions: { scam: noul("Is this listing a scam?") },
    },
    {
      name: "issues",
      source: sourceCall("@facetdb/tracker", "issues", { repo: "acme/web" }),
      read: ["title", "body"],
      questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
    },
  ],
});

function sourceOf(name: string): SourceConfig {
  const found = PROJECT.sources.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`the test's project has no source called ${name}`);
  }
  return found;
}

/** The plugin host of a loaded config, the tracker installed. */
function hostOf(loaded: ProjectConfig) {
  return createPluginHost({
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
  });
}

/** 30 rows `k1` to `k30` in pages of ten: what a table's connector, or a job's, reads. */
function thirtyRows(clock: FakeClock): FakeDatabase {
  const database = new FakeDatabase({ fields: ["title", "body"], pageSize: 10, clock });
  for (let n = 1; n <= 30; n += 1) {
    database.edit(`k${n}`, { title: `Item ${n}`, body: `What item ${n} says` });
  }
  database.install();
  return database;
}

describe("facetdb backfill's header", () => {
  /** The driver the command never reaches: a dry run reads its source through the connector. */
  const noDatabase: SqlConnect = () => {
    throw new Error("a dry run reaches the database only through its connector");
  };

  /** A dry run of one source, wired as the composition root wires a dry run: no store at all. */
  function dryRun(name: string) {
    const clock = new FakeClock(START);
    return runInProcess(
      ["backfill", "--dry-run", "--source", name],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        loadConfig: () => Promise.resolve(PROJECT),
        engines: postgresEngines(noDatabase),
        connect: noDatabase,
        pluginHost: hostOf,
        backfill: (loaded, chosen, mode) => {
          if (!mode.dryRun) {
            throw new Error("these tests run dry runs only");
          }
          const project = projectRef(PROJECT_DIR);
          if (chosen.source === undefined) {
            const connector = new FakeConnector(thirtyRows(clock));
            return Promise.resolve({
              deps: wireBackfillDryRun({
                config: loaded,
                source: chosen,
                project,
                connector,
                clock,
              }),
              close: () => Promise.resolve(),
            });
          }
          if (mode.plugins === undefined) {
            throw new Error("a plugin source's backfill needs its plugin host");
          }
          // The plugin's own scan, as a dry run of a plugin source pages it.
          const connector = pluginBackfillConnector({
            config: loaded,
            source: chosen,
            project,
            host: mode.plugins,
            env: ENV,
            clock,
            workerId: "backfill-1",
            store: undefined,
            note: mode.note ?? (() => undefined),
          });
          return Promise.resolve({
            deps: wireBackfillDryRun({ config: loaded, source: chosen, project, connector, clock }),
            close: () => connector.close(),
          });
        },
      },
      COMMANDS,
    );
  }

  it("says a plugin source pages in the plugin's order, and never newest first", async () => {
    const result = await dryRun("issues");

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(PLUGIN_HEADER);
    expect(result.stdout).toContain("25 records to answer");
    expect(result.stdout).not.toMatch(/newest/i);
  });

  it("says a table source pages newest first, as it always has", async () => {
    const result = await dryRun("listings");

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(TABLE_HEADER);
    expect(result.stdout).toContain("30 records to answer");
  });
});

describe("the worker's backfill job", () => {
  /** A point a job is held at: `entered` once it is there, `release` lets it go on. */
  type Pause = {
    readonly at: (
      step: { readonly scan: number } | { readonly keys: readonly RecordKey[] },
    ) => boolean;
    readonly gate: Promise<void>;
    readonly release: () => void;
    entered: boolean;
  };

  function pauseWhere(at: Pause["at"]): Pause {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { at, gate, release, entered: false };
  }

  async function flush(): Promise<void> {
    for (let turn = 0; turn < 60; turn += 1) {
      await Promise.resolve();
    }
  }

  /** Every fake answers at once, so a job gets where it is going within a few turns or never does. */
  async function until(done: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
      await flush();
    }
    if (!done()) {
      throw new Error(`the backfill never got to where ${what}`);
    }
  }

  /** The words of one source's job at each step: counting, running, and stopped by a new version. */
  async function walk(name: string) {
    const clock = new FakeClock(START);
    const database = thirtyRows(clock);
    const loopOf = (version: number): JobLoop => {
      const chosen = sourceOf(name);
      return {
        source: chosen,
        questionSet: questionSetOf(PROJECT, chosen),
        version,
        heldModel: freshHeldModel(version),
      };
    };
    const loops = new Map<string, JobLoop>([[name, loopOf(1)]]);
    let pause: Pause | undefined;
    const checkpoint = async (step: Parameters<Pause["at"]>[0]) => {
      if (pause !== undefined && !pause.entered && pause.at(step)) {
        pause.entered = true;
        await pause.gate;
      }
    };

    /** The job's own connector: its scans counted, its scans and enqueues held where a test says. */
    class JobConnector extends FakeOpenConnector {
      scans = 0;
      override async scan(cursor: ScanCursor | null): Promise<ScanPage> {
        this.scans += 1;
        await checkpoint({ scan: this.scans });
        return super.scan(cursor);
      }
      override async enqueue(keys: readonly RecordKey[]): Promise<readonly RecordKey[]> {
        await checkpoint({ keys });
        return super.enqueue(keys);
      }
    }
    // A table's records go to the queue of the loop in force; a plugin source's are taken in by the
    // job's own connector, as the worker wires them.
    const loopQueue = new FakeConnector(database);
    const queue = {
      enqueue: async (keys: readonly RecordKey[]) => {
        await checkpoint({ keys });
        return loopQueue.enqueue(keys);
      },
    };
    const saved = new Map<string, BackfillProgress>();
    const cursors: CursorStore = {
      load: (run) => Promise.resolve(saved.get(run)),
      save: (run, progress) => {
        saved.set(run, progress);
        return Promise.resolve();
      },
    };
    // A whole set's records are queued for the loop, which asks them: the job asks nothing.
    const provider: ModelProvider = {
      ask: () => Promise.reject(new Error("a whole-set backfill job asks the model nothing")),
    };
    const spending: SpendingGate = {
      allowsWork: () => Promise.resolve(true),
      admit: () => Promise.resolve("reservation"),
      settle: () => Promise.resolve(),
      record: () => Promise.resolve(),
      finish: () => Promise.resolve(),
    };
    const signals: AlertSignals = {
      modelCall: () => Promise.resolve(),
      modelChecked: () => Promise.resolve(),
      beat: () => Promise.resolve(),
      backfillFinished: () => Promise.resolve(),
      backfillFailed: () => Promise.resolve(),
    };
    const lines: string[] = [];
    const runs = new FakeRunLog();
    const log = new FakeDecisionLog();
    const jobs = createBackfillJobs({
      projectId: PROJECT_ID,
      loop: (asked) => loops.get(asked),
      open: () => Promise.resolve(new JobConnector(database)),
      newWorkerId: () => "backfill-1",
      queue: (asked) => (sourceOf(asked).source === undefined ? queue : undefined),
      provider,
      spending,
      clock,
      cursors,
      log: () => log,
      runs: (asked) => ({ log: runs, source: `${PROJECT_ID}:${asked}` }),
      reviews: (asked) => reviewsOf(new FakeReviewQueue(), `${PROJECT_ID}:${asked}`),
      alerts: () => signals,
      expireAfter: () => new AbortController().signal,
      newToken: () => "token-1",
      print: (line) => {
        lines.push(line);
      },
    });

    async function status(): Promise<BackfillJobStatus> {
      const outcome = await jobs.status(name);
      if (outcome.kind !== "status") {
        throw new Error(`the worker runs no source called ${name}`);
      }
      return outcome.status;
    }

    async function reaches(state: BackfillJobStatus["state"]): Promise<BackfillJobStatus> {
      let last = await status();
      for (let attempt = 0; attempt < 200 && last.state !== state; attempt += 1) {
        await flush();
        last = await status();
      }
      if (last.state !== state) {
        throw new Error(`the backfill of ${name} is ${last.state}, not ${state}: ${last.words}`);
      }
      return last;
    }

    // Counting: held before the second page of three is read.
    pause = pauseWhere((step) => "scan" in step && step.scan === 2);
    expect(await jobs.estimate(name, undefined)).toMatchObject({ kind: "estimating" });
    const counting = pause;
    await until(() => counting.entered, "the second page is being counted");
    const countingWords = (await status()).words;
    counting.release();
    const waiting = await reaches("waiting");

    // Running: held as the second page's records are queued (k30 to k21 is page one), page one done.
    pause = pauseWhere((step) => "keys" in step && step.keys.includes("k20"));
    const inPageTwo = pause;
    expect(await jobs.start(name, waiting.token ?? "")).toMatchObject({ kind: "started" });
    await until(() => inPageTwo.entered, "page two is being queued");
    const runningWords = (await status()).words;

    // A reload restarts the source under version 2: the job stops after the page in hand.
    loops.set(name, loopOf(2));
    inPageTwo.release();
    const stopped = await reaches("stopped");
    await jobs.close();

    return { counting: countingWords, running: runningWords, restarted: stopped.why, lines };
  }

  it("counts, runs and restarts a plugin source in the plugin's order, never newest first", async () => {
    const words = await walk("issues");

    expect(words.counting).toBe(
      "Counting the records of issues to price the backfill: 10 read so far, in the plugin's order. Nothing is asked until it is started.",
    );
    expect(words.running).toBe(
      "Running under version 1, in the plugin's order, at most 50 records a second: 10 of 30 records done.",
    );
    expect(words.restarted).toBe(
      "issues restarted under version 2 after a reload, so the backfill under version 1 stopped after the page in hand. A backfill under version 2 is a new one: estimate again, and it starts from the first record in the plugin's order.",
    );
    // Nor does any line the worker prints of the job.
    expect(words.lines.length).toBeGreaterThan(0);
    expect(words.lines.join("\n")).not.toMatch(/newest/i);
  });

  it("counts, runs and restarts a table source newest first, as it always has", async () => {
    const words = await walk("listings");

    expect(words.counting).toBe(
      "Counting the records of listings to price the backfill: 10 read so far, newest first. Nothing is asked until it is started.",
    );
    expect(words.running).toBe(
      "Running under version 1, newest first, at most 50 records a second: 10 of 30 records done.",
    );
    expect(words.restarted).toBe(
      "listings restarted under version 2 after a reload, so the backfill under version 1 stopped after the page in hand. A backfill under version 2 is a new one: estimate again, and it starts from the newest record.",
    );
  });
});

describe("the Sources row of a backfill part way", () => {
  let world: PgliteWorld;
  let store: Store;
  let served: HttpHandler[];

  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  beforeEach(async () => {
    served = [];
    store = await createStore({
      pglite: world.db,
      secret: TEST_SECRET,
      clock: new FakeClock(START),
    });
    // The table source installed as `facetdb migrate` would; the plugin source is the store's.
    await world.client.query(
      "create table public.listings (id text primary key, title text, body text)",
    );
    const installed = await migrate({
      adminUrl: "pglite://admin",
      connect: world.connect,
      print: () => undefined,
      plan: {
        source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
        questionSet: questionSetOf(PROJECT, sourceOf("listings")),
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

  /** One pass of the worker, which serves the studio's surface over the store. */
  function worker() {
    const connect = sharePools((url, options) => world.connect(url, options));
    return runInProcess(
      ["worker", "--once"],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        osUser: () => "alex",
        loadConfig: () => Promise.resolve(PROJECT),
        engines: postgresEngines(connect),
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
        clock: new SteppedClock(START),
        random: () => 0.5,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        pluginHost: hostOf,
        serve: (handler, port) => {
          served.push(handler);
          return Promise.resolve({ port, close: () => Promise.resolve() });
        },
      },
      COMMANDS,
    );
  }

  it("says a plugin source's run is part way in the plugin's order, a table source's newest first", async () => {
    // Each source's whole-set run under version 1 stopped part way, its place saved.
    await store.cursors.save(backfillRun(PROJECT_ID, "listings", 1, undefined), {
      cursor: "k20",
      done: false,
    });
    await store.cursors.save(backfillRun(PROJECT_ID, "issues", 1, undefined), {
      cursor: "10",
      done: false,
    });

    const result = await worker();
    expect(result.code, result.stderr).toBe(0);
    const response = await served[0]?.(
      new Request("http://127.0.0.1:4040/v1/sources"),
      THIS_MACHINE,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      readonly sources: readonly {
        readonly name: string;
        readonly kind: string;
        readonly backfill: { readonly state: string; readonly words: string };
      }[];
    };
    const rows = new Map(body.sources.map((row) => [row.name, row]));

    expect(rows.get("issues")).toMatchObject({
      kind: "plugin",
      backfill: {
        state: "part-way",
        words:
          "Part way through the whole question set, in the plugin's order: 0 records answered under version 1 so far. The next run resumes where this one stopped.",
      },
    });
    expect(rows.get("listings")).toMatchObject({
      kind: "table",
      backfill: {
        state: "part-way",
        words:
          "Part way through the whole question set, newest first: 0 records answered under version 1 so far. The next run resumes where this one stopped.",
      },
    });
  });
});
