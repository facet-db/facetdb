import {
  type AlertSignals,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type DoctorCheck,
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
  freshHeldModel,
} from "@facetdb/core/testing";
import { createOutagePolicy, DEFAULT_RETRY_EVERY_MS } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import {
  choice,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
  score,
} from "../../config/index.ts";
import { CliError } from "../program.ts";
import { SteppedClock } from "../testing.ts";
import {
  createFleet,
  type InstallCheck,
  RELOAD_BEAT_EVERY_MS,
  type SourceLoop,
} from "./config-reload.ts";
import { questionSetOf } from "./database.ts";
import { installVerdict } from "./install-check.ts";

/**
 * A reload switches a source whose only change to the install is questions added once the worker's
 * own check of the database holds, on the fakes: core's worker over the fake connector, a provider
 * that can hold or fail its answers, a clock that moves only when told, and `installed` as the test
 * sets it. Until the check holds the source keeps answering with the version it ran and says what
 * is missing; any other change to the install is never checked.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const START_MS = 1_700_000_000_000;

type ListingsShape = {
  readonly read?: readonly string[];
  readonly where?: string;
  readonly storage?: "inline" | "side-table";
  readonly questions?: Parameters<typeof facetdb>[0]["sources"][number]["questions"];
};

const SCAM = noul("Is this listing a scam?");

/** The project as the loader makes it from `database: process.env.DATABASE_URL`. */
function project(listings: ListingsShape = {}): ProjectConfig {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: SCAM },
        ...listings,
      },
      {
        name: "orders",
        database: URL,
        table: "orders",
        read: ["note"],
        questions: { is_fraud: noul("Is this order fraud?") },
      },
    ],
  });
  return {
    ...config,
    sources: config.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
  };
}

const PROJECT = project();
const VEHICLE = noul("Is it a vehicle?");
const ADDED = project({ questions: { is_scam: SCAM, is_vehicle: VEHICLE } });

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** Says a certain "no" to every noul; `hold` keeps each answer until `release`; `down` fails all. */
class HeldProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
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
        request.questions.map((question) => [question.name, { type: "noul", probability: 0.01 }]),
      ),
      usage: { inputTokens: 100, outputTokens: 2 },
    };
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

const MISSING: InstallCheck = {
  kind: "missing",
  missing: "listings: public.listings lacks the answer columns is_vehicle",
  rightsRead: true,
};

function rig(initial: ProjectConfig = PROJECT) {
  const clock = new SteppedClock(START_MS);
  const provider = new HeldProvider();
  const databases = new Map<string, FakeDatabase>();
  const logs = new Map<string, FakeDecisionLog>();
  const versions = new Map<string, QuestionSetVersion[]>();
  const beats: { readonly at: number; readonly by: "loop" | "reload" }[] = [];
  const lines: string[] = [];
  const queue = new FakeReviewQueue();
  /** Every check the fleet asked for: the source and the questions it was asked about. */
  const asked: { readonly source: string; readonly questions: readonly string[] }[] = [];
  const state: { file: ProjectConfig; check: () => Promise<InstallCheck> } = {
    file: initial,
    check: () => Promise.resolve(MISSING),
  };

  const databaseOf = (source: SourceConfig): FakeDatabase => {
    const known = databases.get(source.name);
    if (known !== undefined) {
      return known;
    }
    const made = new FakeDatabase({ fields: source.read, clock });
    made.install();
    databases.set(source.name, made);
    return made;
  };
  const logOf = (name: string): FakeDecisionLog => {
    const known = logs.get(name) ?? new FakeDecisionLog();
    logs.set(name, known);
    return known;
  };
  const signals = (): AlertSignals => ({
    modelCall: () => Promise.resolve(),
    modelChecked: () => Promise.resolve(),
    beat: () => {
      beats.push({ at: clock.now(), by: "loop" });
      return Promise.resolve();
    },
    backfillFinished: () => Promise.resolve(),
    backfillFailed: () => Promise.resolve(),
  });

  const fleet = createFleet({
    open: (source, config) => {
      const questionSet = questionSetOf(config, source);
      const rows = versions.get(source.name) ?? [];
      const previous = rows.at(-1);
      const version = nextVersion(previous, questionSet, { now: () => new Date(clock.now()) });
      if (version !== previous) {
        rows.push(version);
      }
      versions.set(source.name, rows);
      const connector = new FakeConnector(databaseOf(source));
      // A failed call holds the record at once (no retry window), as after ten minutes of outage.
      const outage = createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: 0 });
      const heldModel = freshHeldModel(version.version);
      const loop: SourceLoop = {
        source,
        questionSet,
        version: version.version,
        heldModel,
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
          heldModel,
          alerts: signals(),
          outage,
          spending: UNLIMITED,
        }),
        connector,
        keyText: undefined,
        outage,
        close: () => Promise.resolve(),
      };
      return Promise.resolve(loop);
    },
    installed: (source) => {
      asked.push({
        source: source.name,
        questions: source.questions.map((question) => question.name),
      });
      return state.check();
    },
    load: () => Promise.resolve(state.file),
    beat: () => {
      beats.push({ at: clock.now(), by: "reload" });
      return Promise.resolve();
    },
    clock,
    print: (line) => lines.push(line),
    hide: (text) => text,
    onPass: () => () => undefined,
  });

  const database = (name: string): FakeDatabase => {
    const found = databases.get(name);
    if (found === undefined) {
      throw new Error(`no database for ${name}`);
    }
    return found;
  };

  return { clock, provider, logs, versions, beats, lines, asked, state, fleet, database };
}

type Rig = ReturnType<typeof rig>;

async function running(t: Rig): Promise<{ stop: AbortController; done: Promise<void> }> {
  await t.fleet.open(t.state.file);
  const stop = new AbortController();
  const done = t.fleet.run(stop.signal);
  t.database("listings").edit("r1", { title: "A red car" });
  t.database("orders").edit("o1", { note: "Leave at the door" });
  await until(
    () =>
      t.provider.requests.length === 2 &&
      t.database("listings").jobs.size === 0 &&
      t.database("orders").jobs.size === 0,
  );
  return { stop, done };
}

const MISSING_WORDS =
  "the question is_vehicle is not installed in its database yet (listings: public.listings lacks the answer columns is_vehicle), so it keeps answering with version 1. Install it from the Questions page, or run facetdb migrate --source listings, then Check again.";

describe("a reload when the only install change is questions added", () => {
  it("keeps the source when the check finds the columns missing, and says what and how on", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const listings = t.fleet.loop("listings");

    t.state.file = ADDED;
    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources).toEqual([
      { source: "listings", outcome: "kept", version: 1, message: MISSING_WORDS },
      { source: "orders", outcome: "unchanged", version: 1, message: null },
    ]);
    // The check was the worker's own, for the file's set.
    expect(t.asked).toEqual([{ source: "listings", questions: ["is_scam", "is_vehicle"] }]);
    expect(t.fleet.loop("listings")).toBe(listings);
    expect(t.versions.get("listings")).toHaveLength(1);
    expect(t.lines).toContain(`listings: ${MISSING_WORDS}`);
    // The pending list says the same, and that Check again can switch it.
    expect(t.fleet.pending()).toEqual([
      {
        source: "listings",
        outcome: "kept",
        message: MISSING_WORDS,
        migrate: true,
        added: ["is_vehicle"],
        removed: [],
        checkAgain: true,
      },
    ]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing switches once the check holds: a new version, nothing asked again, the heartbeat beating throughout, held records handed on", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const orders = t.fleet.loop("orders");
    // r2 is held by the outage policy: the model failed for it.
    t.provider.down = true;
    t.database("listings").edit("r2", { title: "Free money" });
    await until(() => t.fleet.loop("listings")?.outage?.held.includes("r2") === true);
    t.provider.down = false;
    // r3 is in flight when the reload comes.
    t.provider.hold();
    t.database("listings").edit("r3", { title: "A blue bike" });
    await until(() =>
      t.provider.requests.some((request) => request.state["title"] === "A blue bike"),
    );
    const old = t.fleet.loop("listings");

    t.state.file = ADDED;
    t.state.check = () => Promise.resolve({ kind: "holds", rightsRead: true });
    const summary = await t.fleet.reload();

    expect(summary.loaded && summary.sources[0]).toEqual({
      source: "listings",
      outcome: "restarted",
      version: 2,
      message:
        "the columns of the question is_vehicle are in its database and the worker login may write them: it finishes the batch in hand, then answers with version 2; nothing already answered is asked again.",
    });
    // The batch in hand is held for a minute and a half: the reload beats all the while.
    for (let step = 0; step < 6; step += 1) {
      t.clock.advance(RELOAD_BEAT_EVERY_MS);
      await flush();
    }
    expect(t.fleet.loop("listings")).toBe(old);
    expect(t.beats.filter((beat) => beat.by === "reload").length).toBeGreaterThanOrEqual(6);
    t.provider.release();
    await t.fleet.settled();

    expect(t.fleet.loop("listings")?.version).toBe(2);
    // The new loop beats on its first pass; no gap reached the two minutes of "worker not running".
    const switchedAt = t.clock.now();
    await until(() => t.beats.some((beat) => beat.by === "loop" && beat.at >= switchedAt));
    const beatsToSwitch = [...t.beats];
    expect(t.versions.get("listings")?.map((row) => row.version)).toEqual([1, 2]);
    expect(t.fleet.loop("orders")).toBe(orders);
    expect(t.fleet.pending()).toEqual([]);
    // Nothing is queued: no record already answered is asked again, however long it runs.
    // The only job is the record the outage held, which the new loop took over; r1 and r3 are not
    // queued again.
    expect([...t.database("listings").jobs.entries()].map(([key]) => key)).toEqual(["r2"]);
    // It is asked at its retry by the new loop, with the new set, and logged under version 2.
    t.clock.advance(DEFAULT_RETRY_EVERY_MS);
    await until(() => t.database("listings").decisionOf("r2")?.status === "done");
    expect(t.provider.requests.at(-1)?.state["title"]).toBe("Free money");
    expect(t.provider.requests.at(-1)?.questions.map((question) => question.name)).toEqual([
      "is_scam",
      "is_vehicle",
    ]);
    expect(await t.logs.get("listings")?.count(2)).toBe(1);
    expect(t.database("listings").jobs.size).toBe(0);
    // The retry was one jump of the clock: the heartbeat is judged up to the switch.
    const times = beatsToSwitch.map((beat) => beat.at);
    const gaps = times.slice(1).map((at, index) => at - (times[index] as number));
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_LOSS_MS);
    // Then nothing else: r1 and r3, answered under version 1, are never asked again.
    const asked = t.provider.requests.length;
    for (let poll = 0; poll < 5; poll += 1) {
      t.clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
      await flush();
    }
    expect(t.provider.requests).toHaveLength(asked);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("makes a question added together with another reworded one switch", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.check = () => Promise.resolve({ kind: "holds", rightsRead: true });
    t.state.file = project({
      questions: { is_scam: noul("Is this listing a scam or a fake?"), is_vehicle: VEHICLE },
    });

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources[0]?.outcome).toBe("restarted");
    expect(t.versions.get("listings")?.map((row) => row.version)).toEqual([1, 2]);
    expect(t.fleet.loop("listings")?.questionSet.questions.map((q) => q.instructions)).toEqual([
      "Is this listing a scam or a fake?",
      "Is it a vehicle?",
    ]);
    await t.fleet.close();
  });

  it("keeps a source whose check throws, and says its database could not be read", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.check = () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    t.state.file = ADDED;

    const summary = await t.fleet.reload();

    const words =
      "its database could not be read to check the question is_vehicle (connect ECONNREFUSED 10.0.0.5:5432), so it keeps answering with version 1. Check again once the database answers; facetdb doctor says what is wrong.";
    expect(summary.loaded && summary.sources[0]).toEqual({
      source: "listings",
      outcome: "kept",
      version: 1,
      message: words,
    });
    expect(t.fleet.pending()[0]).toMatchObject({ message: words, checkAgain: true });
    expect(t.versions.get("listings")).toHaveLength(1);
    await t.fleet.close();
  });

  it("keeps a source whose string its database refuses, with the fix and the restart, and no Check again", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    // Seen in a real run: a string logging in as another user than the worker login, which no
    // reading asked for again can mend while the worker's environment stands.
    t.state.check = () =>
      Promise.reject(
        new CliError(
          "doctor-database",
          '"listings" logs in as postgres on localhost/app, not as the worker login facetdb_worker',
          "set DATABASE_URL to the worker login's connection string",
        ),
      );
    t.state.file = ADDED;

    const summary = await t.fleet.reload();

    const words =
      'the question is_vehicle needs its columns, and the worker cannot check them ("listings" logs in as postgres on localhost/app, not as the worker login facetdb_worker; set DATABASE_URL to the worker login\'s connection string), so it keeps answering with version 1 until you restart facetdb worker.';
    expect(summary.loaded && summary.sources[0]).toEqual({
      source: "listings",
      outcome: "kept",
      version: 1,
      message: words,
    });
    expect(t.fleet.pending()[0]).toMatchObject({
      message: words,
      migrate: true,
      checkAgain: false,
    });
    expect(t.versions.get("listings")).toHaveLength(1);
    await t.fleet.close();
  });

  it("says a restart is needed where the engine's checks cannot tell", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.check = () =>
      Promise.resolve({
        kind: "cannot-tell",
        why: "the worker's checks of PostgreSQL cannot tell whether the worker login may write them",
      });
    t.state.file = ADDED;

    const summary = await t.fleet.reload();

    expect(summary.loaded && summary.sources[0]?.message).toBe(
      "the question is_vehicle needs its columns, and the worker's checks of PostgreSQL cannot tell whether the worker login may write them, so it keeps answering with version 1 until you run facetdb migrate --source listings and restart facetdb worker.",
    );
    expect(t.fleet.pending()[0]?.checkAgain).toBe(false);
    await t.fleet.close();
  });

  it("switches on a second reload once the columns arrive", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = ADDED;
    const first = await t.fleet.reload();
    expect(first.loaded && first.sources[0]?.outcome).toBe("kept");

    // facetdb migrate ran by hand; Check again asks for the reload.
    t.state.check = () => Promise.resolve({ kind: "holds", rightsRead: true });
    const second = await t.fleet.reload();
    await t.fleet.settled();

    expect(second.loaded && second.sources[0]).toMatchObject({
      source: "listings",
      outcome: "restarted",
      version: 2,
    });
    expect(t.asked).toHaveLength(2);
    expect(t.fleet.pending()).toEqual([]);
    expect(t.fleet.loop("listings")?.questionSet.questions.map((q) => q.name)).toEqual([
      "is_scam",
      "is_vehicle",
    ]);
    await t.fleet.close();
  });
});

describe("every other change to the install stays kept, and the check is never asked", () => {
  const CATEGORY = choice("Which category is this listing?", { car: "A car", flat: "A flat" });
  const QUALITY = score("How good is the photo?", ["poor", "fine", "great"]);
  const BASE = { is_scam: SCAM, category: CATEGORY, quality: QUALITY };

  it.each([
    ["read", { read: ["title", "body"] }],
    ["where", { where: "price > 0" }],
    ["storage", { storage: "side-table" as const }],
    ["a question removed", { questions: { is_scam: SCAM, category: CATEGORY } }],
    ["a type", { questions: { ...BASE, is_scam: score("How scammy?", ["low", "high"]) } }],
    [
      "options",
      {
        questions: {
          ...BASE,
          category: choice("Which category is this listing?", { car: "A car", boat: "A boat" }),
        },
      },
    ],
    [
      "levels",
      { questions: { ...BASE, quality: score("How good is the photo?", ["poor", "great"]) } },
    ],
    [
      "a question added with read changed",
      { read: ["title", "body"], questions: { ...BASE, is_vehicle: VEHICLE } },
    ],
  ] as const)("%s", async (_name, change: ListingsShape) => {
    const t = rig(project({ questions: BASE }));
    await t.fleet.open(t.state.file);
    const listings = t.fleet.loop("listings");
    t.state.check = () => Promise.resolve({ kind: "holds", rightsRead: true });
    t.state.file = project({ questions: BASE, ...change });

    const summary = await t.fleet.reload();

    expect(summary.loaded && summary.sources[0]).toMatchObject({
      source: "listings",
      outcome: "kept",
    });
    expect(t.asked).toEqual([]);
    expect(t.fleet.loop("listings")).toBe(listings);
    expect(t.fleet.pending()[0]?.checkAgain).toBe(false);
    await t.fleet.close();
  });
});

describe("which doctor checks stand for the install of the new set", () => {
  const ok = (name: string): DoctorCheck => ({ name, status: "ok", detail: `${name} is fine` });
  const fail = (name: string, detail: string): DoctorCheck => ({
    name,
    status: "fail",
    detail,
    fix: "run facetdb migrate",
  });

  it("holds on MySQL, SQL Server, MongoDB and SQLite when the install and the rights pass", () => {
    expect(
      installVerdict("MySQL", [ok("database"), ok("version"), ok("install"), ok("grants")]),
    ).toEqual({ kind: "holds", rightsRead: true });
    expect(installVerdict("MongoDB", [ok("database"), ok("login"), ok("install")])).toEqual({
      kind: "holds",
      rightsRead: true,
    });
    expect(installVerdict("SQLite", [ok("file"), ok("wal"), ok("install"), ok("marks")])).toEqual({
      kind: "holds",
      rightsRead: true,
    });
    // A warning is worth knowing, never a failure.
    expect(
      installVerdict("MySQL", [ok("install"), { name: "grants", status: "warn", detail: "slow" }]),
    ).toEqual({ kind: "holds", rightsRead: true });
  });

  it("names what is missing when the columns or the rights fail", () => {
    expect(
      installVerdict("MySQL", [
        ok("install"),
        fail("grants", "facetdb_worker may not update is_vehicle"),
      ]),
    ).toEqual({
      kind: "missing",
      rightsRead: true,
      missing: "facetdb_worker may not update is_vehicle",
    });
    expect(
      installVerdict("SQLite", [
        ok("file"),
        ok("install"),
        fail("marks", "listings has no column is_vehicle"),
      ]),
    ).toEqual({ kind: "missing", rightsRead: true, missing: "listings has no column is_vehicle" });
    expect(
      installVerdict("MongoDB", [
        ok("login"),
        { name: "install", status: "skip", detail: "not checked: the login failed" },
      ]),
    ).toEqual({ kind: "missing", rightsRead: true, missing: "not checked: the login failed" });
  });

  it("cannot tell where the doctor has no check of the worker login's rights", () => {
    // PostgreSQL and the polling engines: the install, no rights; libSQL: a token is not a right to write.
    for (const [database, checks] of [
      ["PostgreSQL", [ok("database"), ok("pooler"), ok("install"), ok("worker")]],
      ["CockroachDB", [ok("database"), ok("install"), ok("worker")]],
      ["libSQL", [ok("server"), ok("token"), ok("install"), ok("marks")]],
    ] as const) {
      expect(installVerdict(database, checks)).toEqual({
        kind: "cannot-tell",
        why: `the worker's checks of ${database} cannot tell whether the worker login may write them`,
      });
    }
  });
});
