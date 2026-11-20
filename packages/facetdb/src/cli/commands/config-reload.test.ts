import {
  type AlertSignals,
  type Clock,
  createReviewService,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  HEARTBEAT_LOSS_MS,
  type ModelProvider,
  nextVersion,
  type ProviderRequest,
  type ProviderResponse,
  type QuestionSetVersion,
  reviewsOf,
  type SpendingGate,
} from "@facetdb/core";
import {
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { createOutagePolicy, DEFAULT_RETRY_EVERY_MS } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  type ConfigFileRead,
  type ConfigFiles,
  configFileSource,
  facetdb,
  type GitState,
  judgeDraftSource,
  noul,
  type ProjectConfig,
  type SourceDraft,
  toProjectJson,
} from "../../config/index.ts";
import {
  configFileDoor,
  createFleet,
  planReload,
  RELOAD_BEAT_EVERY_MS,
  reviewLookups,
  type SourceLoop,
} from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * The worker's reload after Apply on the fakes: core's worker over the fake connector and decision
 * log, a provider that can hold its answers, a clock that moves only when told to, and the store's
 * version path as `nextVersion` keeps it. A changed source finishes its batch in hand and starts
 * again under a new version; the others keep running; the heartbeat never stops.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const START_MS = 1_700_000_000_000;

/** What the loader makes of `database: process.env.DATABASE_URL`: the value and the variable. */
function loaded(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    sources: config.sources.map((source) =>
      source.api ? source : { ...source, databaseEnv: "DATABASE_URL" },
    ),
  };
}

const PROJECT = loaded(
  facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
      {
        name: "orders",
        database: URL,
        table: "orders",
        read: ["note"],
        questions: { is_fraud: noul("Is this order fraud?") },
      },
    ],
  }),
);

/** The project with one question's wording changed, nothing else. */
function reworded(config: ProjectConfig, source: string, instructions: string): ProjectConfig {
  return {
    ...config,
    sources: config.sources.map((candidate) =>
      candidate.name === source
        ? {
            ...candidate,
            questions: candidate.questions.map((question, index) =>
              index === 0 ? { ...question, instructions } : question,
            ),
          }
        : candidate,
    ),
  };
}

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** A clock whose sleeps end only when the test moves time past them. */
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

/** Says a certain "no" to every question; `hold` keeps each answer until `release`. */
class HeldProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  /** The "yes" probability of every answer: 0.5 leaves a low-stakes noul to a person. */
  probability = 0.01;
  /** Every call fails, as during a model outage. */
  down = false;
  #held = false;
  #waiting: (() => void)[] = [];

  hold(): void {
    this.#held = true;
  }

  release(): void {
    this.#held = false;
    for (const go of this.#waiting.splice(0)) {
      go();
    }
  }

  async ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.#held) {
      await new Promise<void>((go) => {
        this.#waiting.push(go);
      });
    }
    if (this.down) {
      throw new Error("the model answered 529");
    }
    return {
      model: request.model,
      answers: Object.fromEntries(
        request.questions.map((question) => [
          question.name,
          { type: "noul", probability: this.probability },
        ]),
      ),
      usage: { inputTokens: 100, outputTokens: 2 },
    };
  }
}

/**
 * One loop's connector over the shared fake table, told apart from the next loop's: what it wrote,
 * and a gate that holds its `current` (a review call in flight) until the test opens it.
 */
class TracedConnector extends FakeConnector {
  readonly version: number;
  writes = 0;
  gate: Promise<void> | undefined;
  /** Set once a call has reached the gate. */
  waiting = false;

  constructor(database: FakeDatabase, version: number) {
    super(database);
    this.version = version;
  }

  override async current(keys: readonly string[]) {
    if (this.gate !== undefined) {
      this.waiting = true;
      await this.gate;
    }
    return super.current(keys);
  }

  override write(...args: Parameters<FakeConnector["write"]>) {
    this.writes += 1;
    return super.write(...args);
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) {
    await Promise.resolve();
  }
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
    await flush();
  }
  expect(done()).toBe(true);
}

type Beat = { readonly source: string; readonly at: number; readonly by: "loop" | "reload" };

function rig(initial: ProjectConfig = PROJECT) {
  const clock = new SteppedClock(START_MS);
  const provider = new HeldProvider();
  const databases = new Map<string, FakeDatabase>();
  const logs = new Map<string, FakeDecisionLog>();
  /** The store's version rows per source, as `store.questionSets.record` keeps them. */
  const versions = new Map<string, QuestionSetVersion[]>();
  const beats: Beat[] = [];
  const closed: string[] = [];
  const lines: string[] = [];
  /** The review queue every loop's writes follow, by source name (the store id in these tests). */
  const queue = new FakeReviewQueue();
  /** Every connector a loop was opened with, in order. */
  const connectors: { readonly source: string; readonly connector: TracedConnector }[] = [];
  const state: { file: ProjectConfig; fails: ConfigError | undefined; openFails: boolean } = {
    file: initial,
    fails: undefined,
    openFails: false,
  };

  const databaseOf = (name: string, fields: readonly string[]): FakeDatabase => {
    const known = databases.get(name);
    if (known !== undefined) {
      return known;
    }
    const made = new FakeDatabase({ fields, clock });
    made.install();
    databases.set(name, made);
    return made;
  };
  const logOf = (name: string): FakeDecisionLog => {
    const known = logs.get(name) ?? new FakeDecisionLog();
    logs.set(name, known);
    return known;
  };
  const signals = (source: string): AlertSignals => ({
    modelCall: () => Promise.resolve(),
    beat: () => {
      beats.push({ source, at: clock.now(), by: "loop" });
      return Promise.resolve();
    },
    backfillFinished: () => Promise.resolve(),
    backfillFailed: () => Promise.resolve(),
  });

  const fleet = createFleet({
    open: (source, config) => {
      if (state.openFails) {
        return Promise.reject(new Error("the table could not be reached"));
      }
      const questionSet = questionSetOf(config, source);
      const rows = versions.get(source.name) ?? [];
      const previous = rows.at(-1);
      const version = nextVersion(previous, questionSet, { now: () => new Date(clock.now()) });
      if (version !== previous) {
        rows.push(version);
      }
      versions.set(source.name, rows);
      const connector = new TracedConnector(databaseOf(source.name, source.read), version.version);
      connectors.push({ source: source.name, connector });
      // A failed call holds the record at once (no retry window), as after ten minutes of outage.
      const outage = createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: 0 });
      const loop: SourceLoop = {
        source,
        questionSet,
        version: version.version,
        worker: createWorker({
          connector,
          provider,
          log: logOf(source.name),
          reviews: reviewsOf(queue, source.name),
          actions: [],
          clock,
          limits: DEFAULT_WORKER_LIMITS,
          questionSet,
          version: version.version,
          alerts: signals(source.name),
          outage,
          spending: UNLIMITED,
        }),
        connector,
        keyText: undefined,
        outage,
        close: () => {
          closed.push(source.name);
          return Promise.resolve();
        },
      };
      return Promise.resolve(loop);
    },
    load: () =>
      state.fails === undefined ? Promise.resolve(state.file) : Promise.reject(state.fails),
    beat: (source) => {
      beats.push({ source, at: clock.now(), by: "reload" });
      return Promise.resolve();
    },
    clock,
    print: (line) => lines.push(line),
    onPass: () => () => undefined,
  });

  return {
    clock,
    provider,
    databases,
    logs,
    logOf,
    versions,
    beats,
    closed,
    lines,
    state,
    queue,
    connectors,
    fleet,
  };
}

type Rig = ReturnType<typeof rig>;

function database(t: Rig, name: string): FakeDatabase {
  const found = t.databases.get(name);
  if (found === undefined) {
    throw new Error(`no database for ${name}`);
  }
  return found;
}

/** Opens and runs the fleet, and answers one record per source so there is history to keep. */
async function running(t: Rig): Promise<{ stop: AbortController; done: Promise<void> }> {
  await t.fleet.open(t.state.file);
  const stop = new AbortController();
  const done = t.fleet.run(stop.signal);
  database(t, "listings").edit("r1", { title: "A red car" });
  database(t, "listings").edit("r2", { title: "Free money" });
  database(t, "orders").edit("o1", { note: "Leave at the door" });
  await until(
    () =>
      t.provider.requests.length === 3 &&
      database(t, "listings").jobs.size === 0 &&
      database(t, "orders").jobs.size === 0,
  );
  return { stop, done };
}

describe("the worker reloads facetdb.config.ts after Apply", () => {
  it("a changed wording makes one new version for that source only, asks nothing again, and keeps the heartbeat", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const asked = t.provider.requests.length;
    const orders = t.fleet.loop("orders");
    const listings = t.fleet.loop("listings");

    t.state.file = reworded(PROJECT, "listings", "Is this listing a scam or a fake?");
    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary).toEqual({
      loaded: true,
      sources: [
        {
          source: "listings",
          outcome: "restarted",
          version: 2,
          message:
            "the question set changed: it finishes the batch in hand, then answers with version 2; nothing already answered is asked again.",
        },
        { source: "orders", outcome: "unchanged", version: 1, message: null },
      ],
      notes: [],
    });
    // One new version row, for the changed source only.
    expect(t.versions.get("listings")?.map((row) => row.version)).toEqual([1, 2]);
    expect(t.versions.get("orders")?.map((row) => row.version)).toEqual([1]);
    // The unchanged source's loop was never touched; the changed one is a new loop, the old closed.
    expect(t.fleet.loop("orders")).toBe(orders);
    expect(t.fleet.loop("listings")).not.toBe(listings);
    expect(t.closed).toEqual(["listings"]);
    // Nothing already answered is asked again, however long the worker runs on.
    for (let poll = 0; poll < 5; poll += 1) {
      t.clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
      await flush();
    }
    expect(t.provider.requests).toHaveLength(asked);
    // A record changed from now on is asked with the new wording, and logged under version 2.
    database(t, "listings").edit("r3", { title: "A blue bike" });
    await until(() => t.provider.requests.length === asked + 1);
    expect(t.provider.requests.at(-1)?.questions[0]?.instructions).toBe(
      "Is this listing a scam or a fake?",
    );
    await until(() => database(t, "listings").jobs.size === 0);
    expect(await t.logs.get("listings")?.count(2)).toBe(1);
    expect(await t.logs.get("listings")?.count(1)).toBe(2);
    // The config the studio reads is the file as written.
    expect(toProjectJson(t.fleet.config())).toEqual(toProjectJson(t.state.file));

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing a source mid-batch finishes its batch under the old version, its claims settled, while the heartbeat goes on", async () => {
    const t = rig(loaded({ ...PROJECT, sources: PROJECT.sources.slice(0, 1) }));
    await t.fleet.open(t.state.file);
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);
    // A record in flight: its model call held.
    t.provider.hold();
    database(t, "listings").edit("r1", { title: "A red car" });
    await until(() => t.provider.requests.length === 1);
    const old = t.fleet.loop("listings");

    t.state.file = reworded(t.state.file, "listings", "Is this listing a scam or a fake?");
    const summary = await t.fleet.reload();
    expect(summary.loaded && summary.sources[0]?.outcome).toBe("restarted");

    // The batch in hand is held for a minute and a half: the reload beats all the while.
    const beatsBefore = t.beats.length;
    for (let step = 0; step < 6; step += 1) {
      t.clock.advance(RELOAD_BEAT_EVERY_MS);
      await flush();
    }
    const during = t.beats.slice(beatsBefore);
    expect(during.filter((beat) => beat.by === "reload").length).toBeGreaterThanOrEqual(6);
    // The old loop is still the one running: the new one waits for the batch in hand.
    expect(t.fleet.loop("listings")).toBe(old);
    expect(database(t, "listings").jobs.get("r1")?.claimedBy).not.toBeNull();

    t.provider.release();
    await t.fleet.settled();
    // The batch in hand finished under the version it was asked with, and its claim was acked.
    expect(await t.logs.get("listings")?.count(1)).toBe(1);
    expect(await t.logs.get("listings")?.count(2)).toBe(0);
    expect(database(t, "listings").jobs.size).toBe(0);
    expect(t.fleet.loop("listings")?.version).toBe(2);
    // The new loop beats on its first pass.
    await until(() => t.beats.some((beat) => beat.by === "loop" && beat.at > START_MS));

    // No gap in the heartbeat reached the two minutes that raise "worker not running".
    const times = t.beats.map((beat) => beat.at);
    const gaps = times.slice(1).map((at, index) => at - (times[index] as number));
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_LOSS_MS);
    // The model was asked once: for the record in flight, never again for it.
    expect(t.provider.requests).toHaveLength(1);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("a removed source stops after its batch and closes; a new one waits for facetdb migrate", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    t.state.file = {
      ...PROJECT,
      sources: [
        PROJECT.sources[0] as ProjectConfig["sources"][number],
        {
          ...(PROJECT.sources[1] as ProjectConfig["sources"][number]),
          name: "refunds",
          table: "refunds",
        },
      ],
    };

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources).toEqual([
      { source: "listings", outcome: "unchanged", version: 1, message: null },
      {
        source: "refunds",
        outcome: "not-started",
        version: null,
        message:
          "new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.",
      },
      {
        source: "orders",
        outcome: "stopped",
        version: null,
        message:
          "no longer in facetdb.config.ts, so it stops after the batch in hand; its answers and log stay.",
      },
    ]);
    expect(t.fleet.loops().map((loop) => loop.source.name)).toEqual(["listings"]);
    expect(t.closed).toEqual(["orders"]);
    expect(t.lines).toContain(
      "refunds: new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.",
    );
    // A change to the removed source's table is no longer answered.
    const asked = t.provider.requests.length;
    database(t, "orders").edit("o2", { note: "Ring twice" });
    t.clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
    await flush();
    expect(t.provider.requests).toHaveLength(asked);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("a change that reaches the install keeps the source on what it runs until migrate and a restart", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const listings = t.fleet.loop("listings");
    const [first, second] = PROJECT.sources as [
      ProjectConfig["sources"][number],
      ProjectConfig["sources"][number],
    ];
    t.state.file = {
      ...PROJECT,
      sources: [
        {
          ...first,
          questions: [...first.questions, { ...noul("Is it sold out?"), name: "sold_out" }],
        },
        second,
      ],
    };

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources[0]).toEqual({
      source: "listings",
      outcome: "kept",
      version: 1,
      message:
        "the change reaches what facetdb migrate installed (a question added or removed, a type, options or levels, read, where, the table, storage or capture), so it keeps answering with version 1 until you run facetdb migrate and restart facetdb worker.",
    });
    expect(t.fleet.loop("listings")).toBe(listings);
    expect(t.versions.get("listings")).toHaveLength(1);
    expect(t.closed).toEqual([]);
    // The studio reads the file as written all the same.
    expect(t.fleet.config()).toBe(t.state.file);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("a file that does not load leaves every source running on the config it had, and says what to fix", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const before = t.fleet.loops();
    t.state.fails = new ConfigError(
      [{ path: "sources[0].model", message: 'write the pinned model, "jev-1.14.0"' }],
      "facetdb.config.ts",
    );

    const summary = await t.fleet.reload();

    expect(summary).toEqual({
      loaded: false,
      message: expect.stringContaining('sources[0].model: write the pinned model, "jev-1.14.0"'),
      fix: "Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.",
    });
    expect(t.fleet.loops()).toEqual(before);
    expect(t.fleet.config()).toBe(PROJECT);
    expect(t.lines.join("\n")).toContain("The worker keeps running on the config it had");

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("a source that cannot be opened anew keeps running what it ran", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const listings = t.fleet.loop("listings");
    t.state.file = reworded(PROJECT, "listings", "Is this listing a scam or a fake?");
    t.state.openFails = true;

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources[0]).toMatchObject({
      source: "listings",
      outcome: "failed",
      version: 1,
    });
    expect(t.fleet.loop("listings")).toBe(listings);
    expect(t.closed).toEqual([]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("the project's own settings take a restart, and the worker says so", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = { ...PROJECT, spendingCap: 5_000 };

    const summary = await t.fleet.reload();

    expect(summary.loaded && summary.notes).toEqual([
      "The project's spendingCap changed in facetdb.config.ts; the worker keeps what it started with until you restart facetdb worker.",
    ]);
    await t.fleet.close();
  });
});

describe("planReload", () => {
  const loops = (config: ProjectConfig) =>
    new Map(
      config.sources.map((source) => [
        source.name,
        { source, questionSet: questionSetOf(config, source) } as SourceLoop,
      ]),
    );

  it("restarts the sources whose model comes from a changed project default, and only those", () => {
    const own = {
      ...PROJECT,
      sources: PROJECT.sources.map((source, index) =>
        index === 1 ? { ...source, model: "jev-1.14.0" } : source,
      ),
    };
    const steps = planReload(loops(own), { ...own, model: "jev-1.15.0" });
    expect(steps.map((step) => [step.name, step.kind])).toEqual([
      ["listings", "restart"],
      ["orders", "unchanged"],
    ]);
  });

  it("restarts on thresholds, stakes and onOutage, and keeps on read, where, table and a new option", () => {
    const [first] = PROJECT.sources as [ProjectConfig["sources"][number]];
    const plan = (changed: Partial<ProjectConfig["sources"][number]>) =>
      planReload(loops(PROJECT), { ...PROJECT, sources: [{ ...first, ...changed }] })[0]?.kind;
    expect(plan({ thresholds: { is_scam: { yesAbove: 0.9 } } })).toBe("restart");
    expect(plan({ onOutage: "release" })).toBe("restart");
    expect(
      plan({ questions: first.questions.map((question) => ({ ...question, stakes: "high" })) }),
    ).toBe("restart");
    expect(plan({ read: ["title", "body"] })).toBe("keep");
    expect(plan({ where: "price > 0" })).toBe("keep");
    expect(plan({ table: "adverts" })).toBe("keep");
  });
});

/** The config file's door on fakes: the file's text in memory, and git's answer as the test sets it. */
function fakeFiles(text: string, git: GitState = { kind: "clean" }) {
  const state = { text, git, writes: [] as string[] };
  const files: ConfigFiles = {
    read: (): Promise<ConfigFileRead> => Promise.resolve({ kind: "file", text: state.text }),
    replace: (_path, written) => {
      state.text = written;
      state.writes.push(written);
      return Promise.resolve();
    },
    gitState: () => Promise.resolve(state.git),
  };
  return { state, files };
}

describe("the config file door", () => {
  const ENV = { DATABASE_URL: URL };
  const draft: SourceDraft = {
    name: "listings",
    questions: {
      is_scam: { type: "noul", instructions: "Is this listing a scam or a fake?", stakes: "low" },
    },
  };

  /** A loader that reads back the configs the exporter rendered: the text names the config. */
  function loader(files: { state: { text: string } }, configs: readonly ProjectConfig[]) {
    return () => {
      const found = configs.find((config) => configFileSource(config) === files.state.text);
      return found === undefined
        ? Promise.reject(new ConfigError([{ path: "", message: "not a known file" }]))
        : Promise.resolve(found);
    };
  }

  it("shows the diff, writes it on confirm, reloads, and GET /v1/config then reads the write", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const fake = fakeFiles(configFileSource(PROJECT));
    const judged = judgeDraftSource(PROJECT, draft, ENV);
    if (!judged.ok) {
      throw new Error("the draft is valid");
    }
    const load = loader(fake, [PROJECT, judged.config]);
    t.state.file = judged.config;
    const door = configFileDoor({
      path: "facetdb.config.ts",
      files: fake.files,
      load,
      env: ENV,
      reload: () => t.fleet.reload(),
    });

    const shown = await door.diff(draft);
    expect(shown).toMatchObject({ kind: "planned", changed: true, uncommitted: null });
    if (shown.kind !== "planned") {
      throw new Error("planned");
    }
    expect(shown.diff).toBe(
      [
        "--- a/facetdb.config.ts",
        "+++ b/facetdb.config.ts",
        "@@ -9,7 +9,7 @@",
        // A context line is its text after one space.
        `       table: "listings",`,
        `       read: ["title"],`,
        "       questions: {",
        '-        "is_scam": noul("Is this listing a scam?"),',
        '+        "is_scam": noul("Is this listing a scam or a fake?"),',
        "       },",
        "     },",
        "     {",
        "",
      ].join("\n"),
    );
    expect(fake.state.writes).toEqual([]);

    const applied = await door.apply(draft, { plan: shown.plan, force: false });
    await t.fleet.settled();

    expect(applied).toMatchObject({
      kind: "applied",
      diff: shown.diff,
      reload: {
        loaded: true,
        sources: [{ source: "listings", outcome: "restarted", version: 2 }, {}],
      },
    });
    expect(fake.state.writes).toEqual([configFileSource(judged.config)]);
    // What GET /v1/config answers (toProjectJson of the fleet's config) is the file as written.
    expect(toProjectJson(t.fleet.config()).sources[0]?.questions["is_scam"]?.instructions).toBe(
      "Is this listing a scam or a fake?",
    );

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("refuses a plan that is not the one the file and draft make now, and writes nothing", async () => {
    const fake = fakeFiles(configFileSource(PROJECT));
    const door = configFileDoor({
      path: "facetdb.config.ts",
      files: fake.files,
      load: () => Promise.resolve(PROJECT),
      env: ENV,
      reload: () => Promise.reject(new Error("nothing is written, so nothing reloads")),
    });
    expect(await door.apply(draft, { plan: "an-old-plan", force: true })).toEqual({
      kind: "stale",
    });
    expect(fake.state.writes).toEqual([]);
  });

  it("warns on the diff and refuses on confirm when git keeps no copy, unless forced", async () => {
    const fake = fakeFiles(configFileSource(PROJECT), { kind: "modified" });
    const judged = judgeDraftSource(PROJECT, draft, ENV);
    if (!judged.ok) {
      throw new Error("the draft is valid");
    }
    const reloads: string[] = [];
    const door = configFileDoor({
      path: "facetdb.config.ts",
      files: fake.files,
      load: loader(fake, [PROJECT, judged.config]),
      env: ENV,
      reload: () => {
        reloads.push("reload");
        return Promise.resolve({ loaded: true, sources: [], notes: [] });
      },
    });

    const shown = await door.diff(draft);
    if (shown.kind !== "planned") {
      throw new Error("planned");
    }
    expect(shown.uncommitted).toEqual({
      message: "facetdb.config.ts has changes git has not committed, and Apply would replace them",
      fix: 'commit them (git add facetdb.config.ts && git commit), or apply again with force ("force": true) to replace them',
    });
    expect(await door.apply(draft, { plan: shown.plan, force: false })).toEqual({
      kind: "uncommitted",
      ...shown.uncommitted,
    });
    expect(fake.state.writes).toEqual([]);
    expect(reloads).toEqual([]);

    expect(await door.apply(draft, { plan: shown.plan, force: true })).toMatchObject({
      kind: "applied",
    });
    expect(fake.state.writes).toHaveLength(1);
    expect(reloads).toEqual(["reload"]);
  });

  it("says the file does not load as it is now, and an invalid draft by its paths", async () => {
    const fake = fakeFiles("export default nothing;\n");
    const broken = configFileDoor({
      path: "facetdb.config.ts",
      files: fake.files,
      load: () =>
        Promise.reject(
          new ConfigError(
            [{ path: "", message: "facetdb.config.ts exports nothing" }],
            "facetdb.config.ts",
          ),
        ),
      env: ENV,
      reload: () => Promise.reject(new Error("never")),
    });
    expect(await broken.diff(draft)).toMatchObject({
      kind: "unreadable",
      fix: "fix each line named in facetdb.config.ts, then apply again",
    });

    const door = configFileDoor({
      path: "facetdb.config.ts",
      files: fakeFiles(configFileSource(PROJECT)).files,
      load: () => Promise.resolve(PROJECT),
      env: ENV,
      reload: () => Promise.reject(new Error("never")),
    });
    expect(
      await door.diff({ name: "listings", thresholds: { is_scam: { yesAbove: 2 } } }),
    ).toMatchObject({
      kind: "invalid",
      issues: [expect.objectContaining({ path: expect.stringContaining("thresholds") })],
    });
  });
});

describe("a reload does not lose what the worker holds for others", () => {
  it("hands the records held during a model outage to the restarted loop, which asks them again", async () => {
    const t = rig(loaded({ ...PROJECT, sources: PROJECT.sources.slice(0, 1) }));
    await t.fleet.open(t.state.file);
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);
    t.provider.down = true;
    database(t, "listings").edit("r1", { title: "A red car" });
    await until(() => t.fleet.loop("listings")?.outage?.held.includes("r1") === true);
    // Held: out of the queue, marked error, waiting for the 5-minute retry in the loop's memory.
    expect(database(t, "listings").jobs.size).toBe(0);
    expect(database(t, "listings").decisionOf("r1")?.status).toBe("error");

    t.state.file = reworded(t.state.file, "listings", "Is this listing a scam or a fake?");
    await t.fleet.reload();
    await t.fleet.settled();
    expect(t.fleet.loop("listings")?.version).toBe(2);
    expect(t.fleet.loop("listings")?.outage?.held).toEqual(["r1"]);

    // The model is back; at the retry the new loop asks the record, under version 2.
    t.provider.down = false;
    t.clock.advance(DEFAULT_RETRY_EVERY_MS);
    await until(() => database(t, "listings").decisionOf("r1")?.status === "done");
    expect(t.provider.requests.at(-1)?.questions[0]?.instructions).toBe(
      "Is this listing a scam or a fake?",
    );
    expect(await t.logs.get("listings")?.count(2)).toBe(1);

    stop.abort();
    await done;
    await t.fleet.close();
  });
});

describe("the review door follows the loop in force", () => {
  /** A card waits for a person: the model said 50% to a low-stakes noul. */
  async function waitingCard(t: Rig, key: string, title: string) {
    t.provider.probability = 0.5;
    database(t, "listings").edit(key, { title });
    await until(() => t.queue.rows.some((row) => row.key === key));
  }

  function reviewOf(t: Rig) {
    return createReviewService({
      queue: t.queue,
      ...reviewLookups(t.fleet, {
        idOf: (name) => name,
        log: (name) => t.logOf(name),
        actionsOf: () => [],
      }),
      clock: t.clock,
    });
  }

  async function openCard(review: ReturnType<typeof reviewOf>, viewer: string, key: string) {
    const card = await review.openKey(viewer, "listings", key);
    if (card.kind !== "opened") {
      throw new Error(`no card for ${key}: ${card.kind}`);
    }
    return { source: card.card.source, key, stateHash: card.card.stateHash };
  }

  it("a decision in flight across the swap completes, and one after it is judged and logged under the new version through the new connector", async () => {
    const t = rig(loaded({ ...PROJECT, sources: PROJECT.sources.slice(0, 1) }));
    await t.fleet.open(t.state.file);
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);
    await waitingCard(t, "r1", "A red car");
    const review = reviewOf(t);
    const first = await openCard(review, "alice", "r1");

    // The decision reaches the record's current status on the old loop's connector, and waits there.
    const [old] = t.connectors;
    if (old === undefined) {
      throw new Error("the first loop's connector");
    }
    let open: () => void = () => undefined;
    old.connector.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inFlight = review.decide("alice", first, "is_scam", true);
    await until(() => old.connector.waiting);

    t.state.file = reworded(t.state.file, "listings", "Is this listing a scam or a fake?");
    const summary = await t.fleet.reload();
    expect(summary.loaded && summary.sources[0]?.version).toBe(2);
    await flush();
    // The new loop runs; the old one waits for the call in flight before its pool closes.
    expect(t.fleet.loop("listings")?.version).toBe(2);
    expect(t.closed).toEqual([]);

    open();
    expect(await inFlight).toMatchObject({ kind: "decided", status: "done" });
    await t.fleet.settled();
    expect(t.closed).toEqual(["listings"]);
    const [, fresh] = t.connectors;
    if (fresh === undefined) {
      throw new Error("the restarted loop's connector");
    }
    // Begun under version 1, it is logged under it; its write went through the loop in force.
    expect(await t.logOf("listings").history("r1")).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "human", version: 1 })]),
    );
    expect(fresh.connector.writes).toBe(1);
    const oldWrites = old.connector.writes;

    // A card answered after the reload is decided under version 2, through the new connector.
    await waitingCard(t, "r2", "Free money");
    const second = await openCard(review, "alice", "r2");
    expect(await review.decide("alice", second, "is_scam", false)).toMatchObject({
      kind: "decided",
      status: "done",
    });
    expect(await t.logOf("listings").history("r2")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "answer", version: 2 }),
        expect.objectContaining({ kind: "human", version: 2 }),
      ]),
    );
    expect(old.connector.writes).toBe(oldWrites);
    expect(fresh.connector.writes).toBeGreaterThan(1);

    stop.abort();
    await done;
    await t.fleet.close();
  });
});

describe("the config file door when the written file does not load", () => {
  it("puts the text it replaced back, aside and renamed, and says nothing changed", async () => {
    const fake = fakeFiles(configFileSource(PROJECT));
    const draft: SourceDraft = {
      name: "listings",
      questions: {
        is_scam: { type: "noul", instructions: "Is this listing a scam or a fake?", stakes: "low" },
      },
    };
    const door = configFileDoor({
      path: "facetdb.config.ts",
      files: fake.files,
      load: () => Promise.resolve(PROJECT),
      env: { DATABASE_URL: URL },
      reload: () =>
        Promise.resolve({
          loaded: false,
          message: "facetdb.config.ts has problems: sources[0].model: write the pinned model",
          fix: "Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.",
        }),
    });
    const shown = await door.diff(draft);
    if (shown.kind !== "planned") {
      throw new Error("planned");
    }

    const result = await door.apply(draft, { plan: shown.plan, force: false });

    expect(result).toEqual({
      kind: "reverted",
      message: expect.stringContaining(
        "facetdb.config.ts was written, but it does not load, so it was put back as it was and nothing changed.",
      ),
      fix: expect.stringContaining("then apply again"),
    });
    expect(fake.state.writes).toHaveLength(2);
    expect(fake.state.writes[1]).toBe(configFileSource(PROJECT));
    expect(fake.state.text).toBe(configFileSource(PROJECT));
  });
});
