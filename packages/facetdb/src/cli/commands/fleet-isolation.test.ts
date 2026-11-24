import {
  type AlertSignals,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  EngineRefusal,
  HEARTBEAT_LOSS_MS,
  type ModelProvider,
  reviewsOf,
  type SpendingGate,
} from "@facetdb/core";
import {
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeEngine,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { createFakeProvider, createOutagePolicy, DEFAULT_RETRY_EVERY_MS } from "@facetdb/model";
import { secretParts } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import { createHide } from "../secret-words.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { createFleet, RETRY_FIRST_MS, RETRY_MAX_MS, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * A source whose loop fails stops alone: two sources on the fakes, one whose connector throws on
 * its second pass. The other keeps answering and beating, the failed one is closed, said in the log
 * and in `pending()`, and tried again on the stepped clock after 30 seconds, the wait doubling up
 * to 10 minutes, until its database answers and it answers again. A stop during the wait opens
 * nothing, a reload during it tries at once (and the retry it replaced opens no second loop), and
 * under --once the command exits non-zero once the other source has finished its pass. A source its
 * engine refuses (another worker holds a SQLite file's lock) stops alone too, but no wait mends
 * that: it is tried on Check again only, and a run left with nothing else ends with the refusal, as
 * the worker's start would have.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
/** A fixed start time. */
const START_MS = 1_700_000_000_000;
const REFUSED = "connect ECONNREFUSED 10.0.0.7:5432";

const PROJECT: ProjectConfig = (() => {
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
  // As the loader reads `database: process.env.DATABASE_URL`: the value and the variable.
  return {
    ...config,
    sources: config.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
  };
})();

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** A time as the worker's lines say it, in the house form: `YYYY-MM-DD HH:MM UTC`. */
function at(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What an engine says when another worker holds a SQLite file's one lock. */
const LOCKED = new EngineRefusal({
  code: "one-worker",
  message: "SQLite allows one worker, and worker worker-2 holds the lock on orders in shop.db",
  fix: "stop the other facetdb worker first",
});

/**
 * A connector whose claim throws while its database is down, as a pool that lost its server, or
 * is refused by its engine, as a second worker on a SQLite file is.
 */
class BreakableConnector extends FakeConnector {
  readonly #fails: () => Error | undefined;

  constructor(database: FakeDatabase, fails: () => Error | undefined) {
    super(database);
    this.#fails = fails;
  }

  override claim(limit: number) {
    const failure = this.#fails();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return super.claim(limit);
  }
}

/** A database whose every connector call fails in a driver's words, which `failure` gives. */
class LeakyDatabase extends FakeDatabase {
  readonly #failure: string;

  constructor(options: ConstructorParameters<typeof FakeDatabase>[0], failure: string) {
    super(options);
    this.#failure = failure;
  }

  override assertInstalled(): void {
    throw new Error(this.#failure);
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

function rig() {
  const clock = new SteppedClock(START_MS);
  const provider = createFakeProvider({ defaults: { noul: 0.01 } });
  const databases = new Map<string, FakeDatabase>();
  const queue = new FakeReviewQueue();
  /** Every beat of a loop, by source. */
  const beats: { readonly source: string; readonly at: number }[] = [];
  const lines: string[] = [];
  const closed: string[] = [];
  /** Each loop the fleet opened, by source, in order. */
  const opened: string[] = [];
  /** Each reading of a database's install the fleet asked for, by source. */
  const checked: string[] = [];
  /**
   * The file as the loader reads it (held while `loadGate` is), whether the orders database
   * answers, refuses or fails with words of its own, and whether the model answers.
   */
  const state: {
    file: ProjectConfig;
    ordersDown: boolean;
    ordersRefused: boolean;
    ordersError: Error | undefined;
    modelDown: boolean;
    loadGate: Promise<void> | undefined;
  } = {
    file: PROJECT,
    ordersDown: false,
    ordersRefused: false,
    ordersError: undefined,
    modelDown: false,
    loadGate: undefined,
  };
  /** The model the loops ask: the fake provider, failing while the model is down. */
  const model: ModelProvider = {
    ask: (request) =>
      state.modelDown ? Promise.reject(new Error("the model answered 529")) : provider.ask(request),
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
  const signals = (source: string): AlertSignals => ({
    modelCall: () => Promise.resolve(),
    modelChecked: () => Promise.resolve(),
    beat: () => {
      beats.push({ source, at: clock.now() });
      return Promise.resolve();
    },
    backfillFinished: () => Promise.resolve(),
    backfillFailed: () => Promise.resolve(),
  });
  const down = (name: string) => name === "orders" && state.ordersDown;

  const fleet = createFleet({
    open: (source, config) => {
      opened.push(source.name);
      const questionSet = questionSetOf(config, source);
      const connector = new BreakableConnector(databaseOf(source.name, source.read), () =>
        source.name !== "orders"
          ? undefined
          : state.ordersRefused
            ? LOCKED
            : (state.ordersError ?? (down(source.name) ? new Error(REFUSED) : undefined)),
      );
      const outage = createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: 0 });
      const heldModel = freshHeldModel();
      const loop: SourceLoop = {
        source,
        questionSet,
        version: 1,
        heldModel,
        worker: createWorker({
          connector,
          provider: model,
          log: new FakeDecisionLog(),
          reviews: reviewsOf(queue, source.name),
          actions: [],
          clock,
          limits: DEFAULT_WORKER_LIMITS,
          questionSet,
          version: 1,
          heldModel,
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
    // The worker's own reading of the database: it does not answer while the database is down.
    installed: (source) => {
      checked.push(source.name);
      return down(source.name)
        ? Promise.reject(new Error(REFUSED))
        : Promise.resolve({ kind: "holds", rightsRead: true });
    },
    load: async () => {
      await state.loadGate;
      return state.file;
    },
    beat: () => Promise.resolve(),
    clock,
    print: (line) => lines.push(line),
    hide: createHide(() => secretParts(URL)),
    onPass: () => () => undefined,
  });

  const database = (name: string): FakeDatabase => {
    const found = databases.get(name);
    if (found === undefined) {
      throw new Error(`no database for ${name}`);
    }
    return found;
  };

  /**
   * Opens and runs the fleet; once each loop's first pass has worked, the orders database goes down
   * (or its engine refuses it) and a change wakes its loop: its second pass throws.
   */
  async function failOrders(
    how: "down" | "refused" | Error = "down",
  ): Promise<{ stop: AbortController; done: Promise<void> }> {
    await fleet.open(state.file);
    const stop = new AbortController();
    const done = fleet.run(stop.signal);
    await until(() =>
      state.file.sources.every((source) => beats.some((beat) => beat.source === source.name)),
    );
    if (how === "down") {
      state.ordersDown = true;
    } else if (how === "refused") {
      state.ordersRefused = true;
    } else {
      state.ordersError = how;
    }
    database("orders").edit("o1", { note: "Leave at the door" });
    await until(() => fleet.loop("orders") === undefined && closed.includes("orders"));
    return { stop, done };
  }

  return {
    clock,
    provider,
    beats,
    lines,
    closed,
    opened,
    checked,
    state,
    fleet,
    database,
    failOrders,
  };
}

type Rig = ReturnType<typeof rig>;

/** Moves the clock in poll-sized steps, letting every loop take its pass at each. */
async function walk(t: Rig, ms: number): Promise<void> {
  const step = DEFAULT_WORKER_LIMITS.pollIntervalMs;
  for (let moved = 0; moved < ms; moved += step) {
    t.clock.advance(Math.min(step, ms - moved));
    await flush();
  }
}

const stoppedLine = (retryAt: number) =>
  `orders stopped: ${REFUSED}. The other sources keep running; the worker tries orders again at ${at(retryAt)}.`;

describe("a source whose loop fails stops alone", () => {
  it("@timing is closed and said, and the other source keeps answering with no gap in its heartbeat", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();

    // Taken out alone and closed: the other loop is the one opened at the start, never touched.
    expect(t.fleet.loops().map((loop) => loop.source.name)).toEqual(["listings"]);
    expect(t.opened).toEqual(["listings", "orders"]);
    expect(t.closed).toEqual(["orders"]);
    expect(t.lines).toContain(stoppedLine(START_MS + RETRY_FIRST_MS));
    expect(t.fleet.pending()).toEqual([
      {
        source: "orders",
        outcome: "not-started",
        message: `stopped at ${at(START_MS)}: ${REFUSED}. The other sources keep answering; the worker tries orders again at ${at(START_MS + RETRY_FIRST_MS)}, or at once on Check again.`,
        migrate: false,
        added: [],
        removed: [],
        checkAgain: true,
      },
    ]);
    // Home's door names it with the same why and times.
    expect(t.fleet.stopped()).toEqual([
      {
        source: "orders",
        why: REFUSED,
        since: new Date(START_MS).toISOString(),
        retryAt: new Date(START_MS + RETRY_FIRST_MS).toISOString(),
      },
    ]);

    // Three minutes on, the database still down: the other source answers every change.
    const asked = t.provider.callCount;
    for (let minute = 0; minute < 3; minute += 1) {
      t.database("listings").edit(`r${minute}`, { title: `Bike ${minute}` });
      await until(() => t.database("listings").jobs.size === 0);
      await walk(t, 60_000);
    }
    expect(t.provider.callCount).toBe(asked + 3);
    const times = t.beats.filter((beat) => beat.source === "listings").map((beat) => beat.at);
    const gaps = times.slice(1).map((time, index) => time - (times[index] as number));
    expect(t.clock.now() - START_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_LOSS_MS);
    expect(times.at(-1)).toBe(t.clock.now());
    expect(t.opened).toEqual(["listings", "orders"]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing is tried again after 30 seconds, the wait doubling, and answers again once its database does", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();

    // Not before 30 seconds.
    await walk(t, RETRY_FIRST_MS - 1);
    expect(t.checked).toEqual([]);
    // At 30 seconds its database is read, and does not answer: the next try waits a minute.
    await walk(t, 1);
    await until(() => t.checked.length === 1);
    const second = START_MS + RETRY_FIRST_MS + 2 * RETRY_FIRST_MS;
    expect(t.lines).toContain(
      `orders: could not start again (${REFUSED}); the worker tries it again at ${at(second)}.`,
    );
    expect(t.fleet.stopped()[0]?.retryAt).toBe(new Date(second).toISOString());
    expect(t.fleet.pending()[0]?.message).toContain(`tries orders again at ${at(second)}`);
    expect(t.opened).toEqual(["listings", "orders"]);

    // A change while it is stopped stays queued for it.
    t.database("orders").edit("o2", { note: "Ring twice" });
    await walk(t, 2 * RETRY_FIRST_MS);
    await until(() => t.checked.length === 2);
    const third = second + 4 * RETRY_FIRST_MS;
    expect(t.fleet.stopped()[0]?.retryAt).toBe(new Date(third).toISOString());

    // The database answers again: the next try reads it, opens the loop, and the queue is answered.
    t.state.ordersDown = false;
    await walk(t, 4 * RETRY_FIRST_MS);
    await until(() => t.fleet.loop("orders") !== undefined);
    expect(t.checked).toEqual(["orders", "orders", "orders"]);
    expect(t.opened).toEqual(["listings", "orders", "orders"]);
    expect(t.lines).toContain("orders: started again after it stopped; it answers with version 1.");
    await until(() => t.database("orders").jobs.size === 0);
    expect(t.database("orders").rows.get("o2")?.decision).not.toBeNull();
    expect(t.fleet.pending()).toEqual([]);
    expect(t.fleet.stopped()).toEqual([]);
    expect(t.fleet.loops().map((loop) => loop.source.name)).toEqual(["listings", "orders"]);

    // A pass that works started the wait over: failing again, it is tried after 30 seconds.
    const now = t.clock.now();
    t.state.ordersDown = true;
    t.database("orders").edit("o3", { note: "Gift wrap" });
    await until(() => t.fleet.loop("orders") === undefined);
    expect(t.lines).toContain(stoppedLine(now + RETRY_FIRST_MS));

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing waits at most 10 minutes between tries", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();
    // 30 seconds, 1, 2, 4 and 8 minutes, then 10 and 10.
    const waits = [1, 2, 4, 8, 16, 20, 20].map((times) => times * RETRY_FIRST_MS);
    for (const [index, wait] of waits.entries()) {
      await walk(t, wait);
      await until(() => t.checked.length === index + 1);
    }
    expect(waits.at(-1)).toBe(RETRY_MAX_MS);
    const retryAt = Date.parse(t.fleet.stopped()[0]?.retryAt ?? "");
    expect(retryAt - t.clock.now()).toBe(RETRY_MAX_MS);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing a stop during the wait opens nothing, and leaves no sleep of the wait on the clock", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();
    t.state.ordersDown = false;
    // The wait for the next try is a sleep on the clock, until the stop.
    expect(t.clock.pending()).toContain(START_MS + RETRY_FIRST_MS);

    stop.abort();
    await done;
    // Cancelled with its timer: nothing of the wait keeps a stopping worker alive.
    expect(t.clock.pending().filter((due) => due >= START_MS + RETRY_FIRST_MS)).toEqual([]);
    await walk(t, RETRY_MAX_MS);

    expect(t.checked).toEqual([]);
    expect(t.opened).toEqual(["listings", "orders"]);
    await t.fleet.close();
    // Each loop closed once: the failed one when it stopped, the other at the end.
    expect(t.closed).toEqual(["orders", "listings"]);
  });

  it("@timing a reload during the wait tries it at once, and the retry it replaced never opens a second loop", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();
    t.state.ordersDown = false;

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(summary.loaded && summary.sources).toEqual([
      { source: "listings", outcome: "unchanged", version: 1, message: null },
      {
        source: "orders",
        outcome: "started",
        version: 1,
        message:
          "it had stopped, and it started again: it answers every change from now on with version 1.",
      },
    ]);
    const restarted = t.fleet.loop("orders");
    expect(restarted).toBeDefined();
    // The wait the reload cancelled comes and goes: nothing more is read or opened.
    await walk(t, RETRY_MAX_MS);
    expect(t.checked).toEqual(["orders"]);
    expect(t.opened).toEqual(["listings", "orders", "orders"]);
    expect(t.fleet.loop("orders")).toBe(restarted);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing a source its engine refuses stops alone and is not tried on a timer, the other answering on", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders("refused");
    let ended = false;
    void done.then(() => {
      ended = true;
    });

    expect(t.lines).toContain(
      `orders stopped: ${LOCKED.message}. The other sources keep running; no wait mends this, so the worker does not try orders again until Check again or a restart.`,
    );
    expect(t.fleet.stopped()).toEqual([
      {
        source: "orders",
        why: LOCKED.message,
        since: new Date(START_MS).toISOString(),
        retryAt: null,
      },
    ]);
    expect(t.fleet.pending()[0]?.message).toBe(
      `stopped at ${at(START_MS)}: ${LOCKED.message}. The other sources keep answering; no wait mends this, so fix it, then Check again or restart facetdb worker.`,
    );
    t.database("listings").edit("r1", { title: "A red car" });
    await walk(t, RETRY_MAX_MS);
    await until(() => t.database("listings").jobs.size === 0);
    expect(t.checked).toEqual([]);
    expect(t.opened).toEqual(["listings", "orders"]);
    expect(ended).toBe(false);

    // Check again once the other worker let go: the reload tries it at once.
    t.state.ordersRefused = false;
    const summary = await t.fleet.reload();
    expect(summary.loaded && summary.sources[1]?.outcome).toBe("started");
    expect(t.fleet.stopped()).toEqual([]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing a run whose every source its engine refused ends with the refusal, as the start would have", async () => {
    const t = rig();
    t.state.file = { ...PROJECT, sources: PROJECT.sources.slice(1) };
    const { stop, done } = await t.failOrders("refused");

    await expect(done).rejects.toBe(LOCKED);
    expect(t.closed).toEqual(["orders"]);
    stop.abort();
    await t.fleet.close();
  });

  it("@timing a try that comes due while a reload holds the queue leaves one wait, doubled once", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();
    // A reload starts and holds the queue while it reads the file.
    let release: () => void = () => undefined;
    t.state.loadGate = new Promise<void>((go) => {
      release = go;
    });
    const reloaded = t.fleet.reload();
    // The try comes due meanwhile: it waits in the queue behind the reload.
    await walk(t, RETRY_FIRST_MS);
    expect(t.checked).toEqual([]);

    // The reload tries the source itself, the database still down: one read, one new wait.
    release();
    await reloaded;
    await t.fleet.settled();
    await flush();
    expect(t.checked).toEqual(["orders"]);
    const next = t.clock.now() + 2 * RETRY_FIRST_MS;
    expect(t.fleet.stopped()[0]?.retryAt).toBe(new Date(next).toISOString());
    // The queued try was the old wait's: it read nothing, and no second wait is on the clock.
    expect(t.clock.pending().filter((due) => due > t.clock.now() + 2_000)).toEqual([next]);

    // The one wait comes due, and the one after it waits twice as long: one doubling a round.
    await walk(t, 2 * RETRY_FIRST_MS);
    await until(() => t.checked.length === 2);
    await flush();
    expect(t.checked).toEqual(["orders", "orders"]);
    expect(t.fleet.stopped()[0]?.retryAt).toBe(
      new Date(t.clock.now() + 4 * RETRY_FIRST_MS).toISOString(),
    );

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing hands the records its outage policy held to the loop a try opens, which answers them once the model is back", async () => {
    const t = rig();
    await t.fleet.open(t.state.file);
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);
    await until(() => t.beats.some((beat) => beat.source === "orders"));
    // The model is down: o1 is held (error), to be asked again in 5 minutes.
    t.state.modelDown = true;
    t.database("orders").edit("o1", { note: "Leave at the door" });
    await until(() => (t.fleet.loop("orders")?.outage?.held ?? []).includes("o1"));
    // Held, it left the queue as error: only its policy brings it back.
    expect(t.database("orders").rows.get("o1")?.decision?.status).toBe("error");
    expect(t.database("orders").jobs.size).toBe(0);
    // Then the orders database goes too, and its loop fails at its next poll.
    t.state.ordersDown = true;
    for (let poll = 0; poll < 3 && t.fleet.loop("orders") !== undefined; poll += 1) {
      await walk(t, DEFAULT_WORKER_LIMITS.pollIntervalMs);
    }
    await until(() => t.fleet.loop("orders") === undefined);

    // Both come back; the try opens a new loop, which holds o1 as the old one did.
    t.state.modelDown = false;
    t.state.ordersDown = false;
    await walk(t, RETRY_FIRST_MS);
    await until(() => t.fleet.loop("orders") !== undefined);
    expect(t.fleet.loop("orders")?.outage?.held).toEqual(["o1"]);
    // Asked again at its retry, and answered.
    await walk(t, DEFAULT_RETRY_EVERY_MS);
    await until(() => t.database("orders").rows.get("o1")?.decision?.status === "done");
    expect(t.fleet.loop("orders")?.outage?.held).toEqual([]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing says why without the connection string, its password, user or host", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders(
      new Error(`password authentication failed for ${URL} (connecting to localhost:5432)`),
    );

    const [halted] = t.fleet.stopped();
    expect(halted?.why).toBe(
      "password authentication failed for [hidden] (connecting to [hidden])",
    );
    const said = JSON.stringify([t.lines, t.fleet.pending(), t.fleet.stopped()]);
    for (const secret of ["worker-password", "facetdb_worker", "localhost"]) {
      expect(said).not.toContain(secret);
    }

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing a run whose last source is refused while a queued reload starts another goes on, and a later stop ends it cleanly", async () => {
    const t = rig();
    t.state.file = { ...PROJECT, sources: PROJECT.sources.slice(1) };
    await t.fleet.open(t.state.file);
    const stop = new AbortController();
    let ended: "resolved" | "rejected" | undefined;
    const done = t.fleet.run(stop.signal).then(
      () => {
        ended = "resolved";
      },
      () => {
        ended = "rejected";
      },
    );
    await until(() => t.beats.some((beat) => beat.source === "orders"));
    // A reload that adds listings holds the queue while it reads the file.
    let release: () => void = () => undefined;
    t.state.loadGate = new Promise<void>((go) => {
      release = go;
    });
    t.state.file = PROJECT;
    const reloaded = t.fleet.reload();
    // Meanwhile the only running source is refused: nothing runs, nothing waits for a try.
    t.state.ordersRefused = true;
    t.database("orders").edit("o1", { note: "Leave at the door" });
    await until(() => t.fleet.loop("orders") === undefined);

    // The queued reload starts listings: the run goes on with it.
    release();
    await reloaded;
    await t.fleet.settled();
    await until(() => t.fleet.loop("listings") !== undefined);
    await flush();
    expect(ended).toBeUndefined();
    t.database("listings").edit("r1", { title: "A red car" });
    await until(() => t.database("listings").jobs.size === 0);

    stop.abort();
    await done;
    expect(ended).toBe("resolved");
    await t.fleet.close();
  });

  it("@timing a reload that takes a stopped source out of the file tries it no more", async () => {
    const t = rig();
    const { stop, done } = await t.failOrders();
    t.state.file = { ...PROJECT, sources: PROJECT.sources.slice(0, 1) };

    await t.fleet.reload();
    await t.fleet.settled();

    expect(t.lines).toContain(
      "orders: no longer in facetdb.config.ts; it had stopped, and the worker no longer tries it.",
    );
    expect(t.fleet.pending()).toEqual([]);
    await walk(t, RETRY_MAX_MS);
    expect(t.checked).toEqual([]);
    expect(t.opened).toEqual(["listings", "orders"]);

    stop.abort();
    await done;
    await t.fleet.close();
  });
});

describe("facetdb worker --once with a source that fails", () => {
  let world: PgliteWorld;
  let store: Store;

  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  beforeEach(async () => {
    store = await createStore({
      pglite: world.db,
      secret: TEST_SECRET,
      clock: new SteppedClock(START_MS),
    });
  });

  afterEach(async () => {
    await store.close();
    await resetPgliteWorld(world);
  });

  it("answers the other source's queue, then exits non-zero with the failure; nothing is tried again", async () => {
    // The orders database was never installed: its first claim throws. The listings one answers.
    const broken = new FakeDatabase({ fields: ["note"] });
    broken.edit("o1", { note: "Leave at the door" });
    const working = new FakeDatabase({ fields: ["title"] });
    working.install();
    working.edit("r1", { title: "A red car" });
    // The refunds database fails in its driver's words, which name its whole connection string.
    const refundsUrl = "mssql://facetdb_worker:s3cret-pw-77@localhost:1433/app";
    const leaky = new LeakyDatabase(
      { fields: ["amount"] },
      `login failed for ${refundsUrl} (password s3cret-pw-77)`,
    );
    leaky.install();
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "orders",
          database: "mysql://facetdb_worker:worker-password@localhost:3306/app",
          table: "orders",
          read: ["note"],
          questions: { is_fraud: noul("Is this order fraud?") },
        },
        {
          name: "listings",
          database: "mongodb://facetdb_worker:worker-password@localhost:27017/app",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
        {
          name: "refunds",
          database: refundsUrl,
          table: "refunds",
          read: ["amount"],
          questions: { is_abuse: noul("Is this refund abuse?") },
        },
      ],
    });
    const provider = createFakeProvider({ defaults: { noul: 0.01 } });

    const result = await runInProcess(
      ["worker", "--once", "--no-http"],
      {
        projectDir: "/work/shop",
        env: {
          FACETDB_SECRET: TEST_SECRET,
          DATABASE_URL: "postgres://localhost:5432/facetdb",
          TYPESAFE_API_KEY: "ts-test-key",
        },
        osUser: () => "alex",
        loadConfig: () => Promise.resolve(config),
        engines: [
          lazyEngine("mysql", () =>
            Promise.resolve(
              new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"], database: broken }),
            ),
          ),
          lazyEngine("mongodb", () =>
            Promise.resolve(
              new FakeEngine({
                name: "mongodb",
                schemes: ["mongodb", "mongodb+srv"],
                database: working,
              }),
            ),
          ),
          lazyEngine("mssql", () =>
            Promise.resolve(
              new FakeEngine({ name: "mssql", schemes: ["mssql", "sqlserver"], database: leaky }),
            ),
          ),
        ],
        connect: world.connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        clock: new SteppedClock(START_MS),
        random: () => 0.5,
        stopSignal: () => new AbortController().signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      },
      COMMANDS,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "orders stopped; the other sources finish their pass, then the worker exits with its error.",
    );
    expect(result.stdout).toContain("listings: answered r1");
    // Each failing source says its own error on its own line; the command exits with the first.
    expect(result.stdout).toContain(
      "orders stopped: the connector is not installed: run install first.\n",
    );
    expect(result.stdout).toContain(
      "refunds stopped: login failed for [hidden] (password [hidden]).\n",
    );
    expect(result.stderr).toContain("the connector is not installed: run install first");
    expect(result.stderr).not.toContain("login failed");
    expect(`${result.stdout}${result.stderr}`).not.toContain("s3cret-pw-77");
    expect(provider.callCount).toBe(1);
    expect(working.rows.get("r1")?.decision).not.toBeNull();
  });
});
