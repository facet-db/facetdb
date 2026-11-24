import {
  type AlertStore,
  type BoundChannel,
  createAlerts,
  EngineRefusal,
  eventKey,
  type PassReport,
  quotedWords,
  sourceStoppedWords,
} from "@facetdb/core";
import {
  FakeAlertStore,
  FakeChannel,
  FakeConnector,
  FakeDatabase,
  freshHeldModel,
} from "@facetdb/core/testing";
import { hideSecrets, secretParts } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { PluginSourceFailed, SourceAccessLost } from "../../plugin/index.ts";
import { SteppedClock } from "../testing.ts";
import {
  ACCESS_CHECK_EVERY_MS,
  createAlertRaisers,
  type LoopStop,
  type WatchedSource,
} from "./alert-raisers.ts";
import { createFleet, type Fleet, RETRY_FIRST_MS, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * A source whose loop stops by itself, table or plugin, raises Source stopped, critical, the
 * failure's words hidden and quoted; a refused login or credential raises Connector lost access
 * alone, at a stop or at a failed try; a stop a reload or the worker's own stop caused raises
 * nothing; a stopped source's failed try raises it again; the first pass of the source's loop begun
 * after the alert resolves it at the next look, whether or not it had a record to write. The
 * raisers over core's alerts, an alert store and a channel in memory, on the stepped clock; then
 * the fleet's own hook into them.
 */

const START = Date.parse("2026-11-18T14:00:00Z");
const MINUTE = 60_000;
const PROJECT = "proj-shop";
const PASSWORD = "s3cret-worker-pass";
const SOURCE_URL = `postgres://facetdb_worker:${PASSWORD}@db.internal:5432/app`;
const LINK = "https://studio.example.com/sources";
/** An address the driver resolved itself, which no connection string names. */
const RESOLVED_IP = "10.0.0.7";

const config: ProjectConfig = (() => {
  const made = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: SOURCE_URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
      {
        name: "orders",
        database: SOURCE_URL,
        table: "orders",
        read: ["note"],
        questions: { is_fraud: noul("Is this order fraud?") },
      },
    ],
  });
  // As the loader reads `database: process.env.DATABASE_URL`: the value and the variable.
  return {
    ...made,
    sources: made.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
  };
})();

function sourceOf(project: ProjectConfig, name: string): SourceConfig {
  const found = project.sources.find((source) => source.name === name);
  if (found === undefined) {
    throw new Error(`the test config has a source ${name}`);
  }
  return found;
}

const ORDERS = sourceOf(config, "orders");
const { table: _table, ...untabled } = ORDERS;
/** A plugin source: its records the store's, read by its plugin. */
const ISSUES: SourceConfig = {
  ...untabled,
  name: "issues",
  source: { plugin: "@facetdb/tracker", source: "issues", settings: {} },
};
/** An API source: its database is the store, which no look reads. */
const SUPPORT: SourceConfig = { ...untabled, name: "support", api: true };

/** What the plugin source's connector throws for a plugin that failed. */
const PLUGIN_FAILED =
  "the plugin @facetdb/tracker (source issues of issues) failed in watch (its own words are not shown, as they could quote a secret it was handed)";

const NOT_TRIED =
  "Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.";

const keyOf = (kind: "source_stopped" | "connector_lost_access", source: string) =>
  eventKey({ kind, project: PROJECT, source, question: null });

/** A driver's failure that quotes the connection string and an address it resolved itself. */
const DRIVER = `connect ECONNREFUSED ${RESOLVED_IP}:5432 (${SOURCE_URL})`;

/** A refused login, as a driver throws it: the database's code, and words that quote the URL. */
const refusedLogin = () =>
  Object.assign(new Error(`password authentication failed (${SOURCE_URL})`), { code: "28P01" });

/** Every secret the tests plant, and the address the driver resolved, searched in what is sent. */
function expectNoSecret(text: string): void {
  for (const secret of [PASSWORD, SOURCE_URL, "facetdb_worker:", "db.internal", RESOLVED_IP]) {
    expect(text).not.toContain(secret);
  }
}

/**
 * One worker's raisers over its own alerts module and one channel; `shared` gives two workers the
 * one store and clock of their project, as two processes on one store share them.
 */
function setup(
  sources: () => readonly WatchedSource[] = () => [],
  shared?: { readonly clock: SteppedClock; readonly store: FakeAlertStore },
  stoppedSources: () => readonly ({ readonly source: string } & LoopStop)[] = () => [],
) {
  const clock = shared?.clock ?? new SteppedClock(START);
  const store = shared?.store ?? new FakeAlertStore(clock);
  const channel = new FakeChannel<null>();
  const channels: BoundChannel[] = [
    { name: "slack:#ops", deliver: (message) => channel.deliver(message, null) },
  ];
  const alerts = createAlerts({ store: store satisfies AlertStore, clock, channels });
  const lines: string[] = [];
  const raisers = createAlertRaisers({
    alerts,
    active: (key) => store.getActive(key),
    clock,
    project: PROJECT,
    links: {
      access: () => "https://studio.example.com/sources#access",
      stopped: () => LINK,
      questionSet: (source) => `https://studio.example.com/questions?source=${source}`,
    },
    sources,
    stoppedSources,
    hide: (text) => hideSecrets(text, secretParts(SOURCE_URL)),
    print: (line) => lines.push(line),
    configPath: "/work/shop/facetdb.config.ts",
  });
  /** What the channel was sent: each message's severity and text. */
  const sent = () =>
    channel.delivered.map((delivery) => `${delivery.message.severity}: ${delivery.message.text}`);
  /** Whether the store holds the source's Source stopped open (a resolve keeps its row, resolved). */
  const open = (source: string) => {
    const row = store.active.get(keyOf("source_stopped", source));
    return row !== undefined && (row.resolvedAt ?? null) === null;
  };
  return { clock, store, channel, raisers, lines, sent, open };
}

/** A running table source whose doctor passes. */
const tableSource = (name: string): WatchedSource => ({
  kind: "table",
  name,
  doctor: () =>
    Promise.resolve([{ name: "database", status: "ok", detail: "logged in as the worker" }]),
});

/** A pass as core reports it: when it began and how many records it wrote. */
function pass(began: number, wrote = 0): PassReport {
  return {
    startedAt: began,
    claimed: wrote,
    paused: false,
    written: Array.from({ length: wrote }, (_, index) => `r${index}`),
    skipped: [],
    alreadyAnswered: [],
    discarded: [],
    gone: [],
    withdrawn: [],
    refused: [],
    warned: [],
    held: [],
    waiting: [],
    heldUntil: null,
    requeued: [],
    failures: [],
    toReview: [],
    tokens: 0,
  };
}

describe("Source stopped at a loop that stopped by itself", () => {
  it("raises it for a table loop, critical, its words hidden and quoted, saying only that FacetDB keeps trying", async () => {
    const t = setup();
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + RETRY_FIRST_MS });
    await t.raisers.settled();

    const quoted = quotedWords(hideSecrets(DRIVER, secretParts(SOURCE_URL)));
    expect(t.store.history.map((line) => [line.event.kind, line.severity])).toEqual([
      ["source_stopped", "critical"],
    ]);
    expect(t.store.history[0]?.event).toEqual({
      kind: "source_stopped",
      what: `orders stopped: ${quoted}.`,
      project: PROJECT,
      source: "orders",
      question: null,
      did: "Retrying on its own.",
      link: LINK,
    });
    expect(t.sent()).toEqual([
      `critical: orders stopped: ${quoted}. Project ${PROJECT}, source orders, all questions. FacetDB: Retrying on its own.`,
    ]);
    expect(quoted).toContain("10[.]0[.]0[.]7");
    expectNoSecret(
      JSON.stringify([
        t.store.history,
        t.store.active.get(keyOf("source_stopped", "orders")),
        t.channel.delivered,
      ]),
    );
    // A stop that is not a refused login raises no lost access.
    expect(t.store.active.has(keyOf("connector_lost_access", "orders"))).toBe(false);
  });

  it("raises it for a plugin loop in the fleet's words, its plugin's scope kept", async () => {
    const t = setup();
    t.raisers.stopped(ISSUES, new PluginSourceFailed(PLUGIN_FAILED), {
      why: PLUGIN_FAILED,
      retryAt: START + RETRY_FIRST_MS,
    });
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.event.what)).toEqual([
      `issues stopped: ${PLUGIN_FAILED}.`,
    ]);
  });

  it("says a refused engine is not tried again until it is fixed, with the Sources page", async () => {
    const t = setup();
    const locked = new EngineRefusal({
      code: "one-worker",
      message: "SQLite allows one worker, and worker worker-2 holds the lock on orders in shop.db",
      fix: "stop the other facetdb worker first",
    });
    t.raisers.stopped(ORDERS, locked, { why: locked.message, retryAt: null });
    await t.raisers.settled();
    expect(t.store.history[0]?.event.did).toBe(NOT_TRIED);
    expect(t.store.history[0]?.event.what).toBe(
      "orders stopped: SQLite allows one worker, and worker worker-2 holds the lock on orders in shop[.]db.",
    );
  });

  it("raises Connector lost access alone for a refused login or credential, and nothing for an API source", async () => {
    const t = setup();
    const stop = { why: "refused", retryAt: START + RETRY_FIRST_MS };
    t.raisers.stopped(ORDERS, refusedLogin(), stop);
    t.raisers.stopped(
      ISSUES,
      new SourceAccessLost(
        "the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it",
      ),
      stop,
    );
    t.raisers.stopped(SUPPORT, new Error("the store went away"), stop);
    await t.raisers.settled();
    expect(t.store.history.map((line) => `${line.event.kind} ${line.event.source}`)).toEqual([
      "connector_lost_access orders",
      "connector_lost_access issues",
    ]);
  });

  it("@timing raises exactly one in 30 minutes for a source that keeps stopping, and says it again past them", async () => {
    const t = setup();
    for (let minute = 0; minute < 30; minute += 1) {
      t.raisers.stopped(ORDERS, new Error(DRIVER), {
        why: DRIVER,
        retryAt: t.clock.now() + RETRY_FIRST_MS,
      });
      await t.raisers.settled();
      t.clock.advance(MINUTE - 1);
    }
    expect(t.clock.now() - START).toBeLessThan(30 * MINUTE);
    expect(t.sent()).toHaveLength(1);
    t.clock.advance(MINUTE);
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: t.clock.now() });
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "raised"]);
  });
});

describe("Source stopped resolved once the source's loop runs again", () => {
  it("resolves a table source's at the look after its first pass begun after the alert, though it wrote nothing", async () => {
    const running: WatchedSource[] = [];
    const t = setup(() => running);
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + RETRY_FIRST_MS });
    await t.raisers.settled();
    // Still stopped: not among the running sources, nothing to look at.
    await t.raisers.look();
    expect(t.open("orders")).toBe(true);

    // Started again on a quiet source: a pass that claimed nothing is its loop running.
    t.clock.advance(RETRY_FIRST_MS);
    running.push(tableSource("orders"));
    t.raisers.passed(ORDERS, pass(t.clock.now()));
    await t.raisers.look();
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect(t.sent()).toEqual([
      expect.stringMatching(/^critical: orders stopped: /),
      `information: orders runs again. Project ${PROJECT}, source orders, all questions.`,
    ]);
    expect(t.open("orders")).toBe(false);
  });

  it("@timing resolves a plugin source's at the first look after a pass of its loop", async () => {
    const running: WatchedSource[] = [];
    const t = setup(() => running);
    const stop = new AbortController();
    const looking = t.raisers.run(stop.signal);
    await waitForSleep(t.clock);
    // A pass before the stop says nothing of the loop after it.
    t.raisers.passed(ISSUES, pass(t.clock.now()));
    t.raisers.stopped(ISSUES, new PluginSourceFailed(PLUGIN_FAILED), {
      why: PLUGIN_FAILED,
      retryAt: START + RETRY_FIRST_MS,
    });
    await t.raisers.settled();
    running.push({ kind: "plugin", name: "issues" });

    t.clock.advance(ACCESS_CHECK_EVERY_MS);
    await waitForSleep(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised"]);

    t.raisers.passed(ISSUES, pass(t.clock.now()));
    t.clock.advance(ACCESS_CHECK_EVERY_MS);
    await waitForSleep(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    await looking;
    expect(t.clock.pending()).toEqual([]);
  });

  it("with two workers on one store: one alert, a pass of either resolves it, and a pass begun before it never does", async () => {
    const first = setup(() => []);
    const shared = { clock: first.clock, store: first.store };
    const second = setup(() => [tableSource("orders")], shared);
    const stop = { why: DRIVER, retryAt: START + RETRY_FIRST_MS };
    const began = shared.clock.now();
    shared.clock.advance(MINUTE);
    first.raisers.stopped(ORDERS, new Error(DRIVER), stop);
    await first.raisers.settled();
    // The second worker's pass begun before the stop says nothing of the source after it.
    second.raisers.passed(ORDERS, pass(began));
    await second.raisers.look();
    expect(shared.store.history.map((line) => line.phase)).toEqual(["raised"]);
    shared.clock.advance(MINUTE);
    second.raisers.stopped(ORDERS, new Error(DRIVER), stop);
    await second.raisers.settled();
    expect(shared.store.history.map((line) => line.phase)).toEqual(["raised"]);

    // The second worker's loop runs again: the source's records are answered.
    shared.clock.advance(RETRY_FIRST_MS);
    second.raisers.passed(ORDERS, pass(shared.clock.now()));
    await second.raisers.look();
    // The first worker's loop is still stopped: its look reads nothing of it.
    await first.raisers.look();
    expect(shared.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect([...first.sent(), ...second.sent()]).toHaveLength(2);
  });

  it("resolves the alert of a source taken out of the file", async () => {
    const t = setup();
    t.raisers.loaded(config);
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + RETRY_FIRST_MS });
    await t.raisers.settled();
    t.raisers.loaded({ ...config, sources: [sourceOf(config, "listings")] });
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect(t.open("orders")).toBe(false);
    // Its row, kept after the resolve, holds nothing for a source no longer read.
    expect(t.store.active.has(keyOf("source_stopped", "orders"))).toBe(false);
  });

  it("@timing deletes the row a resolve kept at the first look once its 30 minutes are over", async () => {
    const running: WatchedSource[] = [tableSource("orders")];
    const t = setup(() => running);
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + RETRY_FIRST_MS });
    await t.raisers.settled();
    t.clock.advance(RETRY_FIRST_MS);
    t.raisers.passed(ORDERS, pass(t.clock.now()));
    await t.raisers.look();
    expect(t.store.active.has(keyOf("source_stopped", "orders"))).toBe(true);
    t.clock.advance(25 * MINUTE);
    await t.raisers.look();
    expect(t.store.active.has(keyOf("source_stopped", "orders"))).toBe(true);
    t.clock.advance(5 * MINUTE);
    await t.raisers.look();
    expect(t.store.active.has(keyOf("source_stopped", "orders"))).toBe(false);
  });
});

describe("a raise held after a resolve is never the last word while the source stays stopped", () => {
  /** 02:00 stops and is said; 02:05 runs again and is said; the stopped source's look list. */
  async function stoppedThenRan() {
    const running: WatchedSource[] = [];
    const stops: ({ readonly source: string } & LoopStop)[] = [];
    const t = setup(
      () => running,
      undefined,
      () => stops,
    );
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + RETRY_FIRST_MS });
    await t.raisers.settled();
    t.clock.advance(5 * MINUTE);
    running.push(tableSource("orders"));
    t.raisers.passed(ORDERS, pass(t.clock.now()));
    await t.raisers.look();
    expect(t.sent().map((line) => line.split(":")[0])).toEqual(["critical", "information"]);
    running.length = 0;
    t.clock.advance(5 * MINUTE);
    return { ...t, stops };
  }

  it("@timing sends at once, at 02:10, a stop no wait mends", async () => {
    const t = await stoppedThenRan();
    const locked = new EngineRefusal({
      code: "one-worker",
      message: "SQLite allows one worker, and worker worker-2 holds the lock on orders in shop.db",
      fix: "stop the other facetdb worker first",
    });
    t.raisers.stopped(ORDERS, locked, { why: locked.message, retryAt: null });
    await t.raisers.settled();
    expect(t.sent()[2]).toBe(
      `critical: orders stopped: SQLite allows one worker, and worker worker-2 holds the lock on orders in shop[.]db. Project ${PROJECT}, source orders, all questions. FacetDB: ${NOT_TRIED}`,
    );
  });

  it("@timing sends a stop held at 02:10 at the first look past 02:30, though nothing raises it again", async () => {
    const t = await stoppedThenRan();
    t.raisers.stopped(ORDERS, new Error(DRIVER), { why: DRIVER, retryAt: START + 60 * MINUTE });
    await t.raisers.settled();
    expect(t.open("orders")).toBe(true);
    expect(t.sent()).toHaveLength(2);
    // Held in the fleet with no try before 03:00: the looks raise it again in its present words.
    t.stops.push({
      source: "orders",
      why: "the database is still down",
      retryAt: START + 60 * MINUTE,
    });
    t.clock.advance(5 * MINUTE);
    await t.raisers.look();
    expect(t.sent()).toHaveLength(2);
    t.clock.advance(15 * MINUTE + 1);
    await t.raisers.look();
    expect(t.sent()[2]).toBe(
      `critical: orders stopped: the database is still down. Project ${PROJECT}, source orders, all questions. FacetDB: Retrying on its own.`,
    );
    // Said once: the next look within 30 minutes keeps it silent.
    t.clock.advance(5 * MINUTE);
    await t.raisers.look();
    expect(t.sent()).toHaveLength(3);
  });
});

/** Waits until the look's run sleeps toward its next look. */
async function waitForSleep(clock: SteppedClock): Promise<void> {
  const next = clock.now() + ACCESS_CHECK_EVERY_MS;
  for (let turn = 0; turn < 500 && !clock.pending().includes(next); turn += 1) {
    await Promise.resolve();
  }
  expect(clock.pending()).toContain(next);
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

/**
 * The fleet over scripted loops, its hook and passes wired to the raisers as `facetdb worker` wires
 * them: each loop runs until the test fails it, and fails as it stops while `failOnStop` holds; the
 * worker's reading of a stopped source's database at its next try fails with `installFails`.
 */
function fleetRig(shared?: { readonly clock: SteppedClock; readonly store: FakeAlertStore }) {
  // The look reads the fleet's running loops, as the worker's does.
  const holder: { fleet?: Fleet } = {};
  const t = setup(
    () => (holder.fleet?.loops() ?? []).map((loop) => tableSource(loop.source.name)),
    shared,
    // Home's door's stopped sources, as `facetdb worker` hands them to the look.
    () =>
      (holder.fleet?.stopped() ?? []).map((entry) => ({
        source: entry.source,
        why: entry.why,
        retryAt: entry.retryAt === null ? null : Date.parse(entry.retryAt),
      })),
  );
  const running = new Map<
    string,
    { readonly fail: (error: unknown) => void; readonly seen: (report: PassReport) => void }
  >();
  /** Each loop run, by source, in order. */
  const runs: string[] = [];
  /** Each time the hook was told, by source, among the printed lines: the order they came in. */
  const told: string[] = t.lines;
  const state: {
    file: ProjectConfig;
    failOnStop: boolean;
    installFails: (() => Error) | undefined;
  } = { file: config, failOnStop: false, installFails: undefined };
  const fleet = createFleet({
    open: (source, from) => {
      const questionSet = questionSetOf(from, source);
      const loop: SourceLoop = {
        source,
        questionSet,
        version: 1,
        heldModel: freshHeldModel(),
        worker: {
          runOnce: () => Promise.reject(new Error("not run here")),
          onHumanDecision: () => Promise.reject(new Error("not run here")),
          run: (signal, onPass) =>
            new Promise<void>((resolve, reject) => {
              runs.push(source.name);
              running.set(source.name, { fail: reject, seen: (report) => onPass?.(report) });
              signal.addEventListener(
                "abort",
                () => {
                  if (state.failOnStop) {
                    reject(new Error(`the pool of ${SOURCE_URL} closed under the pass`));
                  } else {
                    resolve();
                  }
                },
                { once: true },
              );
            }),
        },
        connector: new FakeConnector(new FakeDatabase({ fields: source.read, clock: t.clock })),
        keyText: undefined,
        close: () => Promise.resolve(),
      };
      return Promise.resolve(loop);
    },
    installed: () =>
      state.installFails === undefined
        ? Promise.resolve({ kind: "holds", rightsRead: true })
        : Promise.reject(state.installFails()),
    load: () => Promise.resolve(state.file),
    beat: () => Promise.resolve(),
    clock: t.clock,
    print: (line) => t.lines.push(line),
    hide: (text) => hideSecrets(text, secretParts(SOURCE_URL)),
    onPass: (loop) => (report) => t.raisers.passed(loop.source, report),
    stoppedAlone: (source, error, stop) => {
      told.push(`told: ${source.name}`);
      t.raisers.stopped(source, error, stop);
    },
  });
  holder.fleet = fleet;
  const loopOf = (name: string) => {
    const found = running.get(name);
    if (found === undefined) {
      throw new Error(`no loop of ${name} runs`);
    }
    return found;
  };
  async function start(): Promise<{
    readonly stop: AbortController;
    readonly done: Promise<void>;
  }> {
    await fleet.open(state.file);
    const stop = new AbortController();
    const done = fleet.run(stop.signal);
    await until(() => running.size === state.file.sources.length);
    return { stop, done };
  }
  /** Moves the clock in steps of a second, letting every timer due fire and settle. */
  async function walk(ms: number): Promise<void> {
    for (let moved = 0; moved < ms; moved += 1_000) {
      t.clock.advance(1_000);
      await flush();
    }
    await t.raisers.settled();
  }
  return { ...t, fleet, state, runs, loopOf, start, walk };
}

describe("the fleet tells the raisers of a loop that stopped by itself, of its failed tries, and of no other stop", () => {
  it("raises it with the stop's words, before the stop is printed, and its next pass resolves it", async () => {
    const t = fleetRig();
    const { stop, done } = await t.start();

    t.loopOf("orders").fail(new Error(DRIVER));
    await until(() => t.fleet.stopped().length === 1);
    await t.raisers.settled();

    const [entry] = t.fleet.stopped();
    if (entry === undefined || entry.retryAt === null) {
      throw new Error("orders waits for its next try");
    }
    // Home reads the door's entry live, with the next try's time; the alert, from the same words
    // and the same function, says only that FacetDB keeps trying.
    const home = sourceStoppedWords(
      { source: entry.source, why: entry.why, retryAt: Date.parse(entry.retryAt) },
      true,
    );
    expect(home.next).toBe("Trying again at 2026-11-18 14:00 UTC.");
    expect(t.store.history.map((line) => [line.event.what, line.event.did])).toEqual([
      [`orders stopped: ${quotedWords(entry.why)}.`, "Retrying on its own."],
    ]);
    expectNoSecret(JSON.stringify([t.store.history, t.channel.delivered]));
    // Told before anything is printed of the stop: a print that throws keeps no alert back.
    const toldAt = t.lines.indexOf("told: orders");
    const printedAt = t.lines.findIndex((line) => line.startsWith("orders stopped:"));
    expect(toldAt).toBeGreaterThanOrEqual(0);
    expect(toldAt).toBeLessThan(printedAt);

    // Its next try opens it again, and its first pass, with nothing to write, resolves it.
    t.clock.advance(RETRY_FIRST_MS);
    await until(() => t.runs.filter((name) => name === "orders").length === 2);
    t.loopOf("orders").seen(pass(t.clock.now()));
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("raises Connector lost access for a login refused at a try, as at a first stop", async () => {
    const t = fleetRig();
    const { stop, done } = await t.start();
    t.loopOf("orders").fail(new Error(DRIVER));
    await until(() => t.fleet.stopped().length === 1);

    // The password rotated while it was stopped: its next try is refused.
    t.state.installFails = refusedLogin;
    await t.walk(RETRY_FIRST_MS);
    expect(t.lines.filter((line) => line === "told: orders")).toHaveLength(2);
    expect(t.store.history.map((line) => line.event.kind)).toEqual([
      "source_stopped",
      "connector_lost_access",
    ]);
    expectNoSecret(JSON.stringify([t.store.history, t.channel.delivered]));

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing raises it again while its loop stays stopped after another worker's pass resolved it, its message held to 30 minutes after the last", async () => {
    const t = fleetRig();
    const other = setup(() => [tableSource("orders")], { clock: t.clock, store: t.store });
    const { stop, done } = await t.start();
    t.state.installFails = () => new Error(DRIVER);
    t.loopOf("orders").fail(new Error(DRIVER));
    await until(() => t.fleet.stopped().length === 1);
    await t.raisers.settled();

    // Another worker's loop of orders runs: its look resolves the alert.
    t.clock.advance(1_000);
    other.raisers.passed(ORDERS, pass(t.clock.now()));
    await other.raisers.look();
    expect(t.open("orders")).toBe(false);

    // This worker's next try fails: the alert is open again, and no channel hears of it yet.
    await t.walk(RETRY_FIRST_MS);
    expect(t.open("orders")).toBe(true);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved", "raised"]);
    expect([...t.sent(), ...other.sent()].map((line) => line.split(":")[0])).toEqual([
      "critical",
      "information",
    ]);

    // Still stopped 30 minutes after the raise sent: a failed try sends it again.
    await t.walk(36 * MINUTE);
    expect(t.sent().filter((line) => line.startsWith("critical:"))).toHaveLength(2);
    expect(t.open("orders")).toBe(true);

    stop.abort();
    await done;
    await t.fleet.close();
  });

  it("@timing stopped at 02:00, running at 02:05, stopped at 02:10 with every try failing for an hour: said again past 02:30, and its end said too", async () => {
    const t = fleetRig();
    const { stop, done } = await t.start();
    const looking = t.raisers.run(stop.signal);
    await waitForSleep(t.clock);
    const kinds = () => t.sent().map((line) => line.split(":")[0]);

    // 02:00: stops, and is said.
    t.loopOf("orders").fail(new Error(DRIVER));
    await until(() => t.fleet.stopped().length === 1);
    await t.raisers.settled();
    // 02:00:30: its try opens it again; its pass runs; the 02:05 look says it runs again.
    await t.walk(RETRY_FIRST_MS);
    await until(() => t.runs.filter((name) => name === "orders").length === 2);
    t.loopOf("orders").seen(pass(t.clock.now()));
    await t.walk(5 * MINUTE - RETRY_FIRST_MS);
    expect(kinds()).toEqual(["critical", "information"]);

    // 02:10: stops again, and every try fails: held inside 30 minutes of 02:00.
    await t.walk(5 * MINUTE);
    t.state.installFails = () => new Error(DRIVER);
    t.loopOf("orders").fail(new Error(DRIVER));
    await until(() => t.fleet.stopped().length === 1);
    await t.walk(START + 30 * MINUTE - 1_000 - t.clock.now());
    expect(kinds()).toEqual(["critical", "information"]);
    expect(t.open("orders")).toBe(true);
    // Past 02:30 the first look or failed try says it again.
    await t.walk(6 * MINUTE);
    expect(kinds()).toEqual(["critical", "information", "critical"]);
    // Still stopped at 03:10: said at most once more per 30 minutes, never in between.
    await t.walk(START + 70 * MINUTE - t.clock.now());
    expect(kinds().filter((kind) => kind === "critical").length).toBeLessThanOrEqual(4);

    // Its database answers: the next try opens it, its pass runs, and its end is said.
    t.state.installFails = undefined;
    const opened = t.runs.length;
    await t.walk(11 * MINUTE);
    await until(() => t.runs.length > opened);
    t.loopOf("orders").seen(pass(t.clock.now()));
    await t.walk(6 * MINUTE);
    expect(kinds().at(-1)).toBe("information");
    expect(t.open("orders")).toBe(false);
    expectNoSecret(JSON.stringify(t.channel.delivered));

    stop.abort();
    await looking;
    await done;
    await t.fleet.close();
  });

  it("raises nothing for a loop a reload restarts, nor for the worker's own stop, even when it fails as it stops", async () => {
    const t = fleetRig();
    const { stop, done } = await t.start();
    t.state.failOnStop = true;

    // A reload that changes the orders model restarts its loop: the old one fails as it stops.
    t.state.file = {
      ...config,
      sources: config.sources.map((source) =>
        source.name === "orders" ? { ...source, model: "jev-1.15.0" } : source,
      ),
    };
    await t.fleet.reload();
    await t.fleet.settled();
    expect(t.lines.some((line) => line.startsWith("orders: its loop failed as it stopped"))).toBe(
      true,
    );

    // The worker stops: every loop fails as it stops.
    stop.abort();
    await done;
    await t.fleet.close();
    await t.raisers.settled();
    expect(t.lines.some((line) => line.startsWith("listings: its loop failed as it stopped"))).toBe(
      true,
    );
    expect(t.lines.some((line) => line.startsWith("told:"))).toBe(false);
    expect(t.store.history).toEqual([]);
    expect(t.channel.delivered).toEqual([]);
  });
});
