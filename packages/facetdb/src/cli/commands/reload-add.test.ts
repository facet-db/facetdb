import {
  type AlertSignals,
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
import { createOutagePolicy } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { CliError } from "../program.ts";
import { SteppedClock } from "../testing.ts";
import { createFleet, type InstallCheck, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * A reload starts a table source new in the file once the worker's own check of its database holds,
 * on the fakes: core's worker over the fake connector, a provider that answers at once, a clock
 * that moves only when told, and `installed` as the test sets it. A source the check does not find
 * is not started and says why; one whose connection variable was not set when the worker started,
 * or an API source, waits for a restart and says so; the other sources' loops are neither stopped
 * nor opened again, and the heartbeat never stops; a reload while the worker is stopping starts
 * nothing.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const START_MS = 1_700_000_000_000;

/** The project as the loader makes it from `database: process.env.DATABASE_URL`. */
function project(...more: readonly SourceConfig[]): ProjectConfig {
  const config = facetdb({
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
  });
  return {
    ...config,
    sources: [
      ...config.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
      ...more,
    ],
  };
}

const PROJECT = project();

/** The source the setup flow installed and wrote: refunds, on the same database as the others. */
const REFUNDS: SourceConfig = {
  ...facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "refunds",
        database: URL,
        table: "refunds",
        read: ["reason"],
        questions: { is_abuse: noul("Is this refund request abusive?") },
      },
    ],
  }).sources[0],
  databaseEnv: "DATABASE_URL",
} as SourceConfig;

const WITH_REFUNDS = project(REFUNDS);

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** Says a certain "no" to every noul, at once. */
class NoProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return Promise.resolve({
      model: request.model,
      answers: Object.fromEntries(
        request.questions.map((question) => [question.name, { type: "noul", probability: 0.01 }]),
      ),
      usage: { inputTokens: 100, outputTokens: 2 },
    });
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

/** As an engine whose doctor reads the worker login's rights (MySQL, say) answers. */
const HOLDS: InstallCheck = { kind: "holds", rightsRead: true };
const MISSING: InstallCheck = {
  kind: "missing",
  missing: "refunds: public.refunds lacks the answer columns is_abuse",
  rightsRead: true,
};

/** A promise the test settles by hand: a check or an open held until the test lets it through. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rig(initial: ProjectConfig = PROJECT) {
  const clock = new SteppedClock(START_MS);
  const provider = new NoProvider();
  const databases = new Map<string, FakeDatabase>();
  const logs = new Map<string, FakeDecisionLog>();
  const versions = new Map<string, QuestionSetVersion[]>();
  const beats: { readonly source: string; readonly at: number; readonly by: "loop" | "reload" }[] =
    [];
  const lines: string[] = [];
  const queue = new FakeReviewQueue();
  /** Every source opened, in order; every check asked; every loop closed; every source dropped. */
  const opened: string[] = [];
  const asked: { readonly source: string; readonly questions: readonly string[] }[] = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const state: {
    file: ProjectConfig;
    check: (source: string) => Promise<InstallCheck>;
    /** Opening this source fails with this error. */
    openFails: { readonly source: string; readonly error: Error } | undefined;
    /** Every open waits for this before it returns the loop (a slow connection). */
    openWaits: Promise<void> | undefined;
  } = {
    file: initial,
    check: () => Promise.resolve(MISSING),
    openFails: undefined,
    openWaits: undefined,
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
    open: async (source, config) => {
      opened.push(source.name);
      if (state.openFails?.source === source.name) {
        throw state.openFails.error;
      }
      await state.openWaits;
      const questionSet = questionSetOf(config, source);
      const rows = versions.get(source.name) ?? [];
      const previous = rows.at(-1);
      const version = nextVersion(previous, questionSet, { now: () => new Date(clock.now()) });
      if (version !== previous) {
        rows.push(version);
      }
      versions.set(source.name, rows);
      const connector = new FakeConnector(databaseOf(source));
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
      return loop;
    },
    installed: (source) => {
      asked.push({
        source: source.name,
        questions: source.questions.map((question) => question.name),
      });
      return state.check(source.name);
    },
    removed: (source) => {
      removed.push(source.name);
    },
    load: () => Promise.resolve(state.file),
    beat: (source) => {
      beats.push({ source, at: clock.now(), by: "reload" });
      return Promise.resolve();
    },
    clock,
    print: (line) => lines.push(line),
    onPass: () => () => undefined,
  });

  const database = (name: string): FakeDatabase => {
    const found = databases.get(name);
    if (found === undefined) {
      throw new Error(`no database for ${name}`);
    }
    return found;
  };

  return {
    clock,
    provider,
    logs,
    versions,
    beats,
    lines,
    opened,
    asked,
    closed,
    removed,
    state,
    fleet,
    database,
  };
}

type Rig = ReturnType<typeof rig>;

/** The fleet open and running on the file, listings and orders each having answered one record. */
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

const STARTED_WORDS =
  "its install is in its database and the worker login may write its columns, so it started: it answers every change from now on with version 1. The records already in the table are answered by a backfill, which shows its cost first.";

const MISSING_WORDS =
  "new in facetdb.config.ts and not answered yet: its database does not hold its install (refunds: public.refunds lacks the answer columns is_abuse). Run facetdb migrate --source refunds on this machine, then Check again.";

describe("a reload with a table source new in the file", () => {
  it("@timing starts it once the check holds: it answers its first record and beats, and the other loops are neither stopped nor opened again", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const listings = t.fleet.loop("listings");
    const orders = t.fleet.loop("orders");

    t.state.file = WITH_REFUNDS;
    t.state.check = () => Promise.resolve(HOLDS);
    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources).toEqual([
      { source: "listings", outcome: "unchanged", version: 1, message: null },
      { source: "orders", outcome: "unchanged", version: 1, message: null },
      { source: "refunds", outcome: "started", version: 1, message: STARTED_WORDS },
    ]);
    // The check was the worker's own, for the file's source; the start followed it.
    expect(t.asked).toEqual([{ source: "refunds", questions: ["is_abuse"] }]);
    expect(t.opened).toEqual(["listings", "orders", "refunds"]);
    expect(t.closed).toEqual([]);
    expect(t.fleet.loop("listings")).toBe(listings);
    expect(t.fleet.loop("orders")).toBe(orders);
    expect(t.fleet.loops().map((loop) => loop.source.name)).toEqual([
      "listings",
      "orders",
      "refunds",
    ]);
    expect(t.versions.get("refunds")?.map((row) => row.version)).toEqual([1]);
    expect(t.lines).toContain(`refunds: ${STARTED_WORDS}`);
    expect(t.fleet.pending()).toEqual([]);
    // Nothing stopped, so the fleet had nothing to beat for: no reload beat at all.
    expect(t.beats.filter((beat) => beat.by === "reload")).toEqual([]);

    // Its first record is answered under its own question set and logged under version 1.
    const startedAt = t.clock.now();
    t.database("refunds").edit("f1", { reason: "Never arrived" });
    await until(() => t.database("refunds").decisionOf("f1")?.status === "done");
    const request = t.provider.requests.at(-1);
    expect(request?.state["reason"]).toBe("Never arrived");
    expect(request?.questions.map((question) => question.name)).toEqual(["is_abuse"]);
    expect(await t.logs.get("refunds")?.count(1)).toBe(1);
    expect(t.beats.some((beat) => beat.source === "refunds" && beat.by === "loop")).toBe(true);
    // The heartbeat never stopped: every loop beats on through the polls that follow.
    for (let poll = 0; poll < 3; poll += 1) {
      t.clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
      await flush();
    }
    for (const source of ["listings", "orders", "refunds"]) {
      const times = t.beats
        .filter((beat) => beat.source === source && beat.at >= startedAt)
        .map((beat) => beat.at);
      expect(times.length).toBeGreaterThanOrEqual(2);
      const gaps = times.slice(1).map((at, index) => at - (times[index] as number));
      expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_LOSS_MS);
    }
    // The records the others answered before are never asked again.
    expect(t.provider.requests.filter((asked) => asked.state["title"] !== undefined)).toHaveLength(
      1,
    );

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("does not start one whose install is missing, says why, and starts it on a reload once the check holds", async () => {
    const t = rig();
    const { stop, done } = await running(t);

    t.state.file = WITH_REFUNDS;
    const first = await t.fleet.reload();
    await t.fleet.settled();

    expect(first.loaded && first.sources[2]).toEqual({
      source: "refunds",
      outcome: "not-started",
      version: null,
      message: MISSING_WORDS,
    });
    expect(t.fleet.loop("refunds")).toBeUndefined();
    expect(t.opened).toEqual(["listings", "orders"]);
    expect(t.versions.get("refunds")).toBeUndefined();
    expect(t.lines).toContain(`refunds: ${MISSING_WORDS}`);
    // The pending list says the same, and that Check again can start it.
    expect(t.fleet.pending()).toEqual([
      {
        source: "refunds",
        outcome: "not-started",
        message: MISSING_WORDS,
        migrate: true,
        added: [],
        removed: [],
        checkAgain: true,
      },
    ]);

    // facetdb migrate ran by hand; Check again asks for the reload.
    t.state.check = () => Promise.resolve(HOLDS);
    const second = await t.fleet.reload();
    await t.fleet.settled();

    expect(second.loaded && second.sources[2]).toMatchObject({
      source: "refunds",
      outcome: "started",
      version: 1,
    });
    expect(t.asked).toHaveLength(2);
    expect(t.fleet.pending()).toEqual([]);
    t.database("refunds").edit("f1", { reason: "Wrong size" });
    await until(() => t.database("refunds").decisionOf("f1")?.status === "done");

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("says to set the variable where the worker runs and restart, when the connection string was not set at start, and reads nothing", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.check = () => Promise.resolve(HOLDS);
    // As the loader leaves a source whose variable is unset: no connection string at all.
    const { database: _unset, ...refunds } = REFUNDS;
    t.state.file = project({ ...refunds, databaseEnv: "REFUNDS_URL" });

    const summary = await t.fleet.reload();

    const words =
      "new in facetdb.config.ts and not answered yet: its connection string is read from REFUNDS_URL, which was not set when facetdb worker started. Set REFUNDS_URL where the worker runs, then restart facetdb worker.";
    expect(summary.loaded && summary.sources[2]).toEqual({
      source: "refunds",
      outcome: "not-started",
      version: null,
      message: words,
    });
    expect(t.asked).toEqual([]);
    expect(t.opened).toEqual(["listings", "orders"]);
    expect(t.fleet.pending()).toEqual([
      expect.objectContaining({ source: "refunds", message: words, checkAgain: false }),
    ]);
    await t.fleet.close();
  });

  it("leaves an API source new in the file to a restart", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.check = () => Promise.resolve(HOLDS);
    const { database: _url, databaseEnv: _variable, table: _table, ...tickets } = REFUNDS;
    t.state.file = project({ ...tickets, name: "tickets", api: true });

    const summary = await t.fleet.reload();

    const words =
      "new in facetdb.config.ts and not answered yet: it answers through POST /v1/check, whose sources are set when the worker starts, so restart facetdb worker.";
    expect(summary.loaded && summary.sources[2]).toEqual({
      source: "tickets",
      outcome: "not-started",
      version: null,
      message: words,
    });
    expect(t.asked).toEqual([]);
    expect(t.fleet.pending()).toEqual([
      expect.objectContaining({
        source: "tickets",
        message: words,
        migrate: false,
        checkAgain: false,
      }),
    ]);
    await t.fleet.close();
  });

  it("keeps it unstarted when its database could not be read (Check again), and when the engine's checks cannot tell (a restart)", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = WITH_REFUNDS;

    t.state.check = () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const unread = await t.fleet.reload();
    const unreadWords =
      "new in facetdb.config.ts and not answered yet: its database could not be read to check its install (connect ECONNREFUSED 10.0.0.5:5432). Check again once the database answers; facetdb doctor says what is wrong.";
    expect(unread.loaded && unread.sources[2]?.message).toBe(unreadWords);
    expect(t.fleet.pending()[0]).toMatchObject({ message: unreadWords, checkAgain: true });

    t.state.check = () =>
      Promise.resolve({
        kind: "cannot-tell",
        why: "the worker's checks of PostgreSQL cannot tell whether the worker login may write them",
      });
    const cannotTell = await t.fleet.reload();
    const cannotTellWords =
      "new in facetdb.config.ts and not answered yet: its install cannot be checked from here (the worker's checks of PostgreSQL cannot tell whether the worker login may write them), so it waits for a restart. Run facetdb migrate --source refunds if the install did not finish, then restart facetdb worker.";
    expect(cannotTell.loaded && cannotTell.sources[2]?.message).toBe(cannotTellWords);
    expect(t.fleet.pending()[0]).toMatchObject({ message: cannotTellWords, checkAgain: false });
    expect(t.opened).toEqual(["listings", "orders"]);
    await t.fleet.close();
  });

  it("says the start's own refusal with its fix and a restart, never Check again, when the string, its engine or the store's variable is refused", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = WITH_REFUNDS;
    // What `tableOf` throws on demand (worker.ts): the start's checks, before anything connects.
    t.state.check = () =>
      Promise.reject(
        new CliError(
          "unknown-scheme",
          "the connection string names no database FacetDB connects to (its scheme is foo:)",
          "use a connection string one of the registered engines reads",
        ),
      );

    const summary = await t.fleet.reload();

    const words =
      "new in facetdb.config.ts and not answered yet: the connection string names no database FacetDB connects to (its scheme is foo:); use a connection string one of the registered engines reads. Then restart facetdb worker.";
    expect(summary.loaded && summary.sources[2]).toEqual({
      source: "refunds",
      outcome: "not-started",
      version: null,
      message: words,
    });
    expect(t.fleet.pending()[0]).toMatchObject({ message: words, checkAgain: false });
    expect(t.opened).toEqual(["listings", "orders"]);
    await t.fleet.close();
  });

  it("offers a restart, not Check again, where only this worker's finished install stood in for the rights (PostgreSQL)", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = WITH_REFUNDS;

    // The columns were not found, and the reading used the finished run up.
    t.state.check = () => Promise.resolve({ ...MISSING, rightsRead: false });
    const missing = await t.fleet.reload();
    const missingWords =
      "new in facetdb.config.ts and not answered yet: its database does not hold its install (refunds: public.refunds lacks the answer columns is_abuse). Run facetdb migrate --source refunds on this machine, then restart facetdb worker.";
    expect(missing.loaded && missing.sources[2]?.message).toBe(missingWords);
    expect(t.fleet.pending()[0]).toMatchObject({ message: missingWords, checkAgain: false });

    // The install held by the run, and the open failed: the next reading cannot hold again.
    t.state.check = () => Promise.resolve({ kind: "holds", rightsRead: false });
    t.state.openFails = { source: "refunds", error: new Error("too many connections") };
    const failed = await t.fleet.reload();
    const failedWords =
      "new in facetdb.config.ts and not answered yet: its install is in its database, and it could not be started (too many connections). Check it with facetdb doctor, then restart facetdb worker.";
    expect(failed.loaded && failed.sources[2]?.message).toBe(failedWords);
    expect(t.fleet.pending()[0]).toMatchObject({ message: failedWords, checkAgain: false });
    await t.fleet.close();
  });

  it("does not start one it could not open, and says so", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = WITH_REFUNDS;
    t.state.check = () => Promise.resolve(HOLDS);
    t.state.openFails = {
      source: "refunds",
      error: new Error("connect ECONNREFUSED 10.0.0.5:5432"),
    };

    const summary = await t.fleet.reload();

    const words =
      "new in facetdb.config.ts and not answered yet: its install is in its database, and it could not be started (connect ECONNREFUSED 10.0.0.5:5432). Check it with facetdb doctor, then Check again or restart facetdb worker.";
    expect(summary.loaded && summary.sources[2]).toEqual({
      source: "refunds",
      outcome: "not-started",
      version: null,
      message: words,
    });
    expect(t.fleet.loop("refunds")).toBeUndefined();
    expect(t.fleet.pending()[0]).toMatchObject({ message: words, checkAgain: true });
    await t.fleet.close();
  });

  it("starts nothing while the worker is stopping", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    stop.abort();

    t.state.file = WITH_REFUNDS;
    t.state.check = () => Promise.resolve(HOLDS);
    const summary = await t.fleet.reload();

    expect(summary.loaded && summary.sources[2]).toEqual({
      source: "refunds",
      outcome: "not-started",
      version: null,
      message:
        "new in facetdb.config.ts and not started: the worker is stopping, which starts nothing; it answers once facetdb worker runs again.",
    });
    expect(t.asked).toEqual([]);
    expect(t.opened).toEqual(["listings", "orders"]);
    await done;
    await t.fleet.close();
    expect(t.fleet.loop("refunds")).toBeUndefined();
  });

  it("opens nothing when the stop comes during the check: the check's answer is read, and the source is not opened", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    t.state.file = WITH_REFUNDS;
    const check = deferred();
    t.state.check = () => check.promise.then(() => HOLDS);

    const reload = t.fleet.reload();
    await until(() => t.asked.length === 1);
    stop.abort();
    check.resolve();
    const summary = await reload;

    expect(summary.loaded && summary.sources[2]).toMatchObject({
      source: "refunds",
      outcome: "not-started",
      message:
        "new in facetdb.config.ts and not started: the worker is stopping, which starts nothing; it answers once facetdb worker runs again.",
    });
    // Nothing opened on the database for a source that will never run; no version recorded.
    expect(t.opened).toEqual(["listings", "orders"]);
    expect(t.versions.get("refunds")).toBeUndefined();
    expect(t.fleet.loop("refunds")).toBeUndefined();
    await done;
    await t.fleet.close();
  });

  it("closes the connection again when the stop comes during the open: the loop is never launched", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    t.state.file = WITH_REFUNDS;
    t.state.check = () => Promise.resolve(HOLDS);
    const open = deferred();
    t.state.openWaits = open.promise;

    const reload = t.fleet.reload();
    await until(() => t.opened.includes("refunds"));
    stop.abort();
    open.resolve();
    const summary = await reload;

    expect(summary.loaded && summary.sources[2]).toMatchObject({
      source: "refunds",
      outcome: "not-started",
      message:
        "new in facetdb.config.ts and not started: the worker is stopping, which starts nothing; it answers once facetdb worker runs again.",
    });
    expect(t.closed).toEqual(["refunds"]);
    expect(t.fleet.loop("refunds")).toBeUndefined();
    expect(t.beats.filter((beat) => beat.source === "refunds")).toEqual([]);
    await done;
    await t.fleet.close();
    expect(t.closed).toEqual(["refunds", "listings", "orders"]);
  });

  it("puts a loop in place before the fleet runs, and run launches it with the rest", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = WITH_REFUNDS;
    t.state.check = () => Promise.resolve(HOLDS);

    const summary = await t.fleet.reload();
    expect(summary.loaded && summary.sources[2]?.outcome).toBe("started");
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);
    t.database("refunds").edit("f1", { reason: "Damaged" });
    await until(() => t.database("refunds").decisionOf("f1")?.status === "done");

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("drops a source removed from the file once its loop closed, and starts it anew when it is added again", async () => {
    const t = rig();
    const { stop, done } = await running(t);
    const [listings] = PROJECT.sources;

    t.state.file = { ...PROJECT, sources: listings === undefined ? [] : [listings] };
    await t.fleet.reload();
    await t.fleet.settled();
    expect(t.closed).toEqual(["orders"]);
    expect(t.removed).toEqual(["orders"]);

    t.state.file = PROJECT;
    t.state.check = () => Promise.resolve(HOLDS);
    const summary = await t.fleet.reload();
    await t.fleet.settled();
    expect(summary.loaded && summary.sources[1]).toMatchObject({
      source: "orders",
      outcome: "started",
      version: 1,
    });
    expect(t.opened).toEqual(["listings", "orders", "orders"]);
    t.database("orders").edit("o2", { note: "Ring twice" });
    await until(() => t.database("orders").decisionOf("o2")?.status === "done");

    stop.abort();
    await done;
    await t.fleet.close();
  });
});
