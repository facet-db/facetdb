import type { Clock, RecordKey, StateValue } from "@facetdb/core";
import { FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { createStore, type Store } from "@facetdb/postgres";
import {
  createPgliteWorld,
  type PgliteWorld,
  resetPgliteWorld,
  TEST_SECRET,
} from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actionCall, env, facetdb, noul, type ProjectConfig, sourceCall } from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  createPluginHost,
  createPluginSourceConnector,
  definePlugin,
  type HostedSource,
  hostedSource,
  keyProblem,
  MAX_KEY_BYTES,
  MAX_STATE_BYTES,
  type Plugin,
  PluginHostError,
  type PluginSourceConnector,
  PluginSourceFailed,
  printableKey,
  ReceiveAbandoned,
  type RecordStore,
  SourceAccessLost,
  type SourceContext,
  type SourceDefinition,
  type SourcePage,
  source,
  z,
} from "./index.ts";

/**
 * A plugin source over the FacetDB store: the adapter passes the connector contract on a PGlite
 * store, unchanged; `intake` queues a changed state and nothing for an unchanged one, skips a key
 * the plugin leaves out and refuses what the store would not take; the cursor survives a new
 * adapter and is saved only after the keys it covers were taken in; the pump stops with the source
 * and leaves no timer; a plugin's own words never come out.
 */

const START = 1_700_000_000_000;
const FIELDS = ["title", "body"] as const;
const SOURCE_ID = "3:p:x:issues";
const RUN = `plugin-source:${SOURCE_ID}`;
/** What a failing plugin's own error says: it must reach no error FacetDB raises. */
const LEAKED = "token trk_s3cret-token was refused";

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

/**
 * A clock whose sleeps end only when the test moves time past them, or when their signal aborts,
 * and that lists the sleeps still waiting: what a stop must not leave behind.
 */
class SteppedClock implements Clock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];

  constructor(start: number) {
    this.#time = start;
  }

  now(): number {
    return this.#time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((wake) => {
      if (signal?.aborted === true) {
        wake();
        return;
      }
      const sleeper = { due: this.#time + ms, wake };
      this.#sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
          wake();
        },
        { once: true },
      );
    });
  }

  pending(): readonly number[] {
    return this.#sleepers.map((sleeper) => sleeper.due);
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

// --- the external service a source plugin watches -------------------------------------------------

type TrackerState = Readonly<Record<string, StateValue>>;

/** An issue tracker: the thing outside FacetDB. Its log of changes is what a webhook would carry. */
class IssueTracker {
  readonly issues = new Map<RecordKey, { seq: number; state: TrackerState }>();
  readonly changes: RecordKey[] = [];
  readonly #waiters: (() => void)[] = [];
  #seq = 1;

  edit(key: RecordKey, state: TrackerState): void {
    this.issues.set(key, { seq: this.issues.get(key)?.seq ?? this.#seq++, state });
    this.changes.push(key);
    for (const wake of this.#waiters.splice(0)) {
      wake();
    }
  }

  /** Resolves when the log passes `after` entries, or when `signal` aborts. */
  nextChange(after: number, signal: AbortSignal): Promise<void> {
    if (this.changes.length > after || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

/**
 * The plugin under test: `watch` follows the tracker's log from its saved cursor and saves the
 * cursor after each batch it yielded; `read` and `scan` read the tracker, newest first.
 */
function trackerSource(service: IssueTracker): SourceDefinition<{ pageSize: number }> {
  return source<{ pageSize: number }>({
    watch: async function* (ctx) {
      // From the saved cursor, or from the log's beginning on a first start.
      let seen = Number((await ctx.cursor.load()) ?? "0");
      for (;;) {
        await service.nextChange(seen, ctx.signal);
        if (ctx.signal.aborted) {
          return;
        }
        const batch = service.changes.slice(seen);
        seen += batch.length;
        yield batch;
        await ctx.cursor.save(String(seen));
      }
    },
    read: async (_ctx, keys) =>
      keys.flatMap((key) => {
        const issue = service.issues.get(key);
        return issue === undefined ? [] : [{ key, state: issue.state }];
      }),
    scan: async function* (ctx, cursor) {
      let bound = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
      for (;;) {
        const candidates = [...service.issues.entries()]
          .filter(([, issue]) => issue.seq < bound)
          .sort(([, a], [, b]) => b.seq - a.seq);
        const page = candidates.slice(0, ctx.config.pageSize);
        const last = page.at(-1);
        const next =
          candidates.length > page.length && last !== undefined ? String(last[1].seq) : null;
        const result: SourcePage = {
          rows: page.map(([key, issue]) => ({ key, state: issue.state })),
          next,
        };
        yield result;
        if (next === null) {
          return;
        }
        bound = Number(next);
      }
    },
  });
}

function hostedOf(definition: SourceDefinition<{ pageSize: number }>): HostedSource {
  return {
    packageName: "@facetdb/tracker",
    entry: "issues",
    definition: definition as SourceDefinition<unknown>,
    settings: {},
    actions: [],
    variables: ["TRACKER_TOKEN"],
  };
}

type World = {
  readonly store: Store;
  /** The source's records as the store holds them, read apart from any adapter. */
  readonly records: ReturnType<Store["connector"]>;
  readonly notes: string[];
  adapter(
    definition: SourceDefinition<{ pageSize: number }>,
    options?: { readonly workerId?: string; readonly clock?: Clock; readonly store?: RecordStore },
  ): PluginSourceConnector;
  close(): Promise<void>;
};

const opened: World[] = [];

// Every adapter stopped and the store closed first, then the one engine back to an empty cluster.
afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.close();
  }
  await resetPgliteWorld(world);
});

async function worldOf(clock: Clock = new FakeClock(START)): Promise<World> {
  const store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  const adapters: PluginSourceConnector[] = [];
  const notes: string[] = [];
  const records = store.connector({ sourceId: SOURCE_ID, fields: FIELDS, workerId: "reader" });
  const made: World = {
    store,
    records,
    notes,
    adapter(definition, options = {}) {
      const adapter = createPluginSourceConnector({
        store:
          options.store ??
          store.connector({
            sourceId: SOURCE_ID,
            fields: FIELDS,
            workerId: options.workerId ?? "worker-1",
            pageSize: 10,
          }),
        name: "issues",
        hosted: hostedOf(definition),
        context: (signal) => ({ config: { pageSize: 10 }, secrets: {}, signal }),
        fields: FIELDS,
        clock: options.clock ?? clock,
        cursors: store.cursors,
        cursorRun: RUN,
        note: (line) => notes.push(line),
      });
      adapters.push(adapter);
      return adapter;
    },
    async close() {
      for (const adapter of adapters.splice(0)) {
        await adapter.close();
      }
      await store.close();
    },
  };
  opened.push(made);
  return made;
}

const state = (title: string): TrackerState => ({ title, body: `${title} body` });

async function jobCount(): Promise<number> {
  const rows = await world.client.query("select count(*)::int as n from facetdb.jobs");
  return Number(rows[0]?.["n"]);
}

describe("a plugin source passes the connector contract over a PGlite store (plugin-source)", () => {
  runConnectorContract(async () => {
    const service = new IssueTracker();
    const clock = new FakeClock(START);
    const made = await worldOf(clock);
    const definition = trackerSource(service);
    const connector = made.adapter(definition, { workerId: "worker-1" });
    const peer = made.adapter(definition, { workerId: "worker-2" });
    return {
      connector,
      peer,
      fields: FIELDS,
      // The application's write is the tool's change and its delivery: the event names the key.
      edit: async (key, written) => {
        service.edit(key, written);
        await connector.intake([key]);
      },
      // A plugin source keeps its decisions in the store, with no answer columns.
      probabilities: "no-column",
      decisionOf: async (key) => (await made.records.getRecord(key))?.decision ?? null,
      clock,
    };
  });
});

describe("the plugin source's intake (plugin-source)", () => {
  it("queues a changed state, and nothing for an unchanged one; a key left out is skipped", async () => {
    const service = new IssueTracker();
    const made = await worldOf();
    const adapter = made.adapter(trackerSource(service));
    service.edit("k1", state("first"));

    expect(await adapter.intake(["k1", "k1", "gone"])).toEqual({
      queued: ["k1"],
      unchanged: [],
      skipped: ["gone"],
      refused: [],
      strangers: 0,
    });
    expect(await adapter.claim(10)).toEqual(["k1"]);
    await adapter.ack(["k1"]);

    // The same state again: nothing queued, nothing to claim.
    expect(await adapter.intake(["k1"])).toMatchObject({ queued: [], unchanged: ["k1"] });
    expect(await adapter.claim(10)).toEqual([]);
    expect(await jobCount()).toBe(0);

    service.edit("k1", state("second"));
    expect(await adapter.intake(["k1"])).toMatchObject({ queued: ["k1"] });
    expect(await adapter.claim(10)).toEqual(["k1"]);
    // The record's state lives in the store's records, as the worker reads it.
    const read = await adapter.read(["k1"]);
    expect(read.rows[0]?.state).toEqual({ title: "second", body: "second body" });
    // A key the store does not hold is missing, never made up.
    expect((await adapter.read(["gone"])).missing).toEqual(["gone"]);
  });

  it("refuses what the plugin returns in a shape the store does not take, and says what happens to each", async () => {
    const rows: unknown = [
      { key: "ok", state: { title: "fine", body: null, extra: 7 } },
      { key: "twice", state: { title: "a", body: "a" } },
      { key: "twice", state: { title: "b", body: "b" } },
      { key: "flat", state: "just text" },
      { key: "short", state: { title: "no body" } },
      { key: "typed", state: { title: ["a", "b"], body: "x" } },
      { key: "nul", state: { title: "a\u0000b", body: "x" } },
      { key: "huge", state: { title: "x".repeat(MAX_STATE_BYTES), body: "x" } },
      { key: "stranger", state: { title: "not asked", body: "x" } },
      { nokey: true },
    ];
    const definition = source<{ pageSize: number }>({
      watch: async function* () {},
      read: async () => rows as never,
      scan: async function* () {},
    });
    const made = await worldOf();
    const adapter = made.adapter(definition);

    const report = await adapter.intake([
      "ok",
      "twice",
      "flat",
      "short",
      "typed",
      "nul",
      "huge",
      "left",
    ]);

    expect(report.queued).toEqual(["ok"]);
    expect(report.skipped).toEqual(["left"]);
    expect(report.strangers).toBe(2);
    expect(report.refused).toEqual([
      { key: "twice", why: "read returned it more than once" },
      { key: "flat", why: "its state is not an object of fields" },
      {
        key: "short",
        why: "its state lacks the field body, which the source reads (a field with no value is null)",
      },
      { key: "typed", why: "its field title is a list, not text or null" },
      {
        key: "nul",
        why: "its field title holds a character the store cannot keep (a NUL or a lone surrogate)",
      },
      {
        key: "huge",
        why: expect.stringContaining(
          `more than the ${MAX_STATE_BYTES} a record may hold`,
        ) as string,
      },
    ]);
    // Only the fields the source reads are kept, and nothing refused reached the store.
    expect((await adapter.read(["ok"])).rows[0]?.state).toEqual({ title: "fine", body: null });
    expect(
      (await adapter.read(["twice", "flat", "short", "typed", "nul", "huge", "stranger"])).rows,
    ).toEqual([]);
    expect(made.notes).toContain(
      "the plugin @facetdb/tracker (source issues of issues) returned the record twice in a shape the store does not take (read returned it more than once), so it is not queued; it is read again at its next change",
    );
    expect(made.notes).toContain(
      "the plugin @facetdb/tracker (source issues of issues) returned 2 rows for keys it was not asked for; they are not kept (a plugin names its changed keys in watch)",
    );
  });

  it("never lets a plugin's own words out, and words a refused credential with the variables it reads", async () => {
    let failure: Error = new Error(LEAKED);
    const definition = source<{ pageSize: number }>({
      watch: async function* () {},
      read: () => Promise.reject(failure),
      scan: async function* () {},
    });
    const made = await worldOf();
    const adapter = made.adapter(definition);

    const failed = await adapter.intake(["k1"]).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(PluginSourceFailed);
    expect((failed as Error).message).toBe(
      "the plugin @facetdb/tracker (source issues of issues) failed in read (its own words are not shown, as they could quote a secret it was handed)",
    );

    failure = new SourceAccessLost(LEAKED);
    const lost = await adapter.intake(["k1"]).catch((error: unknown) => error);
    expect((lost as Error).name).toBe("SourceAccessLost");
    expect((lost as Error).message).toBe(
      "the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in read; check the variable TRACKER_TOKEN and the rights granted to it",
    );
    // Matched by name: one thrown by a plugin built against another copy of facetdb/plugin counts.
    failure = Object.assign(new Error(LEAKED), { name: "SourceAccessLost" });
    expect(((await adapter.intake(["k1"]).catch((error: unknown) => error)) as Error).name).toBe(
      "SourceAccessLost",
    );
    // A read that is not a list fails the intake in words too.
    const odd = source<{ pageSize: number }>({
      watch: async function* () {},
      read: async () => ({ rows: [] }) as never,
      scan: async function* () {},
    });
    await expect(made.adapter(odd).intake(["k1"])).rejects.toThrow(
      "the plugin @facetdb/tracker (source issues of issues) returned something other than a list of rows from read",
    );
  });
});

/** How often the stuck plugin below polls, on the worker's clock. */
const POLL_MS = 5_000;

/** A NUL, a lone surrogate, a line break with a terminal escape: keys the store or a line cannot take. */
const NUL_KEY = "bad\u0000key";
const FORGED_KEY = "k9\nissues: answered everything\u001b[31m";

describe("the keys a plugin names (plugin-source)", () => {
  it("refuses a key the store cannot keep, says why, and reads and queues the batch's other keys", async () => {
    const service = new IssueTracker();
    service.edit("good", state("fine"));
    const asked: (readonly string[])[] = [];
    const tracker = trackerSource(service);
    const made = await worldOf();
    const adapter = made.adapter({
      ...tracker,
      read: (ctx, keys) => {
        asked.push(keys);
        return tracker.read(ctx, keys);
      },
    });
    const long = "k".repeat(MAX_KEY_BYTES + 1);

    const report = await adapter.intake([
      "good",
      NUL_KEY,
      "lone\ud800",
      FORGED_KEY,
      long,
      "",
      7 as never,
      NUL_KEY,
    ]);

    expect(report.queued).toEqual(["good"]);
    expect(asked).toEqual([["good"]]);
    expect(report.refused).toEqual([
      {
        key: NUL_KEY,
        why: "it holds a control character (a NUL, a line break or an escape)",
      },
      { key: "lone\ud800", why: "it holds a lone surrogate" },
      {
        key: FORGED_KEY,
        why: "it holds a control character (a NUL, a line break or an escape)",
      },
      {
        key: long,
        why: `it is ${MAX_KEY_BYTES + 1} bytes, more than the ${MAX_KEY_BYTES} a key may hold`,
      },
      { key: "", why: "it is empty" },
      { key: "7", why: "it is not text" },
    ]);
    // Nothing of a refused key reached the store.
    expect(await jobCount()).toBe(1);
    // A batch of refused keys alone reads nothing and stops nothing.
    expect(await adapter.intake([NUL_KEY])).toMatchObject({
      queued: [],
      refused: [{ key: NUL_KEY }],
    });
    expect(asked).toHaveLength(1);
    // The bound is in bytes, as the store's index counts them: 1,024 at most, a key of 2-byte
    // characters halves the characters.
    expect(keyProblem("é".repeat(MAX_KEY_BYTES / 2))).toBeUndefined();
    expect(keyProblem("é".repeat(MAX_KEY_BYTES / 2 + 1))).toContain("more than the 1024");
  });

  it("prints a key with no control or format character and cut short, so no line is forged", async () => {
    const made = await worldOf();
    const adapter = made.adapter(trackerSource(new IssueTracker()));
    await adapter.intake([FORGED_KEY]);

    const [line] = made.notes;
    expect(line).toBe(
      "the plugin @facetdb/tracker (source issues of issues) named a key the store cannot keep (it holds a control character (a NUL, a line break or an escape)), so it is not read or queued: k9issues: answered everything[31m… (a key of 35 characters, shown in part)",
    );
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    // A key the store keeps may still hold a format character (a right-to-left override): printed
    // without it, and a long key shows its start and its length.
    expect(printableKey("k1‮evil")).toBe("k1evil… (a key of 7 characters, shown in part)");
    expect(printableKey("acme/web#1234")).toBe("acme/web#1234");
    expect(printableKey("x".repeat(100))).toBe(
      `${"x".repeat(64)}… (a key of 100 characters, shown in part)`,
    );
  });

  it("@timing keeps answering its good keys while the plugin names a bad one again on every turn", async () => {
    const clock = new SteppedClock(START);
    const service = new IssueTracker();
    let turn = 0;
    // A plugin whose saved cursor never moves past a bad key: it names it again every poll.
    const stuck = source<{ pageSize: number }>({
      ...trackerSource(service),
      watch: async function* (ctx) {
        for (;;) {
          turn += 1;
          const good = `good-${turn}`;
          service.edit(good, state(good));
          yield [NUL_KEY, good];
          await ctx.clock.sleep(POLL_MS);
        }
      },
    });
    const made = await worldOf(clock);
    const adapter = made.adapter(stuck, { clock });
    const wakes = adapter.watch()[Symbol.asyncIterator]();
    const woken: string[] = [];
    for (let at = 1; at <= 3; at += 1) {
      woken.push(...((await wakes.next()).value ?? []));
      await vi.waitFor(() => expect(clock.pending()).toHaveLength(1));
      clock.advance(POLL_MS);
    }

    expect(woken).toEqual(["good-1", "good-2", "good-3"]);
    expect((await adapter.read(["good-1", "good-2", "good-3"])).rows).toHaveLength(3);
    // Refused and said on every turn the plugin named it, the turn begun by the last move included.
    expect(
      made.notes.filter((note) => note.includes("named a key the store cannot keep")),
    ).toHaveLength(turn);
    expect(turn).toBeGreaterThanOrEqual(3);
    await adapter.close();
  });
});

describe("the plugin source's pump and cursor (plugin-source)", () => {
  it("takes in what watch yields, wakes the worker's watch, and the cursor survives a new adapter", async () => {
    const service = new IssueTracker();
    const made = await worldOf();
    const first = made.adapter(trackerSource(service));
    const wakes = first.watch()[Symbol.asyncIterator]();
    const woken = wakes.next();

    service.edit("k1", state("one"));
    service.edit("k2", state("two"));
    const batch = await woken;
    expect(batch.value).toEqual(["k1", "k2"]);
    await vi.waitFor(async () => {
      expect(await made.store.cursors.load(RUN)).toEqual({ cursor: "2", done: true });
    });
    await first.close();
    // A closed source's watch ends rather than waiting for a change that never comes.
    expect(await wakes.next()).toEqual({ done: true, value: undefined });

    // A new adapter (the worker restarted) resumes from the saved cursor: nothing is read twice.
    let reads = 0;
    const counting = trackerSource(service);
    const second = made.adapter({
      ...counting,
      read: (ctx, keys) => {
        reads += keys.length;
        return counting.read(ctx, keys);
      },
    });
    const again = second.watch()[Symbol.asyncIterator]();
    const next = again.next();
    service.edit("k3", state("three"));
    expect((await next).value).toEqual(["k3"]);
    expect(reads).toBe(1);
    await vi.waitFor(async () => {
      expect((await made.store.cursors.load(RUN))?.cursor).toBe("3");
    });
  });

  it("saves no cursor for keys that were not taken in: a crash between the two repeats the work", async () => {
    const service = new IssueTracker();
    const made = await worldOf();
    // A first run takes k0 in and saves the cursor past it.
    const good = made.adapter(trackerSource(service));
    const first = good.watch()[Symbol.asyncIterator]().next();
    service.edit("k0", state("zero"));
    expect((await first).value).toEqual(["k0"]);
    await vi.waitFor(async () => {
      expect((await made.store.cursors.load(RUN))?.cursor).toBe("1");
    });
    await good.close();

    // The next run's store refuses the write, as a dropped connection would.
    const records = made.store.connector({ sourceId: SOURCE_ID, fields: FIELDS, workerId: "w" });
    const refusing: RecordStore = {
      ...records,
      upsertRecord: () => Promise.reject(new Error("Connection terminated unexpectedly")),
    };
    const broken = made.adapter(trackerSource(service), { store: refusing });
    const woken = broken.watch()[Symbol.asyncIterator]().next();
    service.edit("k1", state("one"));
    // The pump failed: the worker's watch fails with the store's own words, which stops the loop,
    // and the cursor stays where the keys taken in end.
    await expect(woken).rejects.toThrow("Connection terminated unexpectedly");
    expect(await made.store.cursors.load(RUN)).toEqual({ cursor: "1", done: true });
    await broken.close();

    // The next start resumes from that cursor, so k1 is taken in after all: repeated, not skipped.
    const fixed = made.adapter(trackerSource(service));
    const next = fixed.watch()[Symbol.asyncIterator]().next();
    expect((await next).value).toEqual(["k1"]);
    expect((await fixed.read(["k1"])).rows).toHaveLength(1);
    await vi.waitFor(async () => {
      expect((await made.store.cursors.load(RUN))?.cursor).toBe("2");
    });
  });

  it("@timing stops with the source: the plugin's wait on the worker's clock ends, and no timer is left", async () => {
    const clock = new SteppedClock(START);
    const made = await worldOf(clock);
    let polls = 0;
    const polling = source<{ pageSize: number }>({
      watch: async function* (ctx) {
        for (;;) {
          polls += 1;
          yield [];
          // The worker's clock, as the plugin is told to use: no Date.now(), no setTimeout.
          await ctx.clock.sleep(60_000);
        }
      },
      read: async () => [],
      scan: async function* () {},
    });
    const adapter = made.adapter(polling, { clock });
    const wakes = adapter.watch()[Symbol.asyncIterator]();
    const woken = wakes.next();
    await vi.waitFor(() => expect(clock.pending()).toEqual([START + 60_000]));
    clock.advance(60_000);
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(clock.now()).toBe(START + 60_000);

    await adapter.close();
    expect(clock.pending()).toEqual([]);
    expect(await woken).toEqual({ done: true, value: undefined });
  });

  it("a watch that fails stops the source with FacetDB's words: a refused credential, or a failure", async () => {
    const made = await worldOf();
    const lost = source<{ pageSize: number }>({
      watch: async function* () {
        yield [];
        throw new SourceAccessLost(LEAKED);
      },
      read: async () => [],
      scan: async function* () {},
    });
    const wakes = made.adapter(lost).watch()[Symbol.asyncIterator]();
    const failed = await wakes.next().catch((error: unknown) => error);
    expect((failed as Error).name).toBe("SourceAccessLost");
    expect((failed as Error).message).not.toContain("trk_s3cret");
    expect((failed as Error).message).toContain("refused its credential in watch");

    const ended = source<{ pageSize: number }>({
      watch: async function* () {},
      read: async () => [],
      scan: async function* () {},
    });
    await expect(made.adapter(ended).watch()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "the plugin @facetdb/tracker (source issues of issues) ended its watch, so no change would be noticed; the source starts it again",
    );
    const odd = source<{ pageSize: number }>({
      watch: async function* () {
        // Not a list at all: the batch's shape is the plugin's failure (a key in a list is judged
        // alone, and refused without stopping the source).
        yield "k1" as never;
      },
      read: async () => [],
      scan: async function* () {},
    });
    await expect(made.adapter(odd).watch()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "yielded something other than a list of keys from watch",
    );
  });
});

describe("the plugin source's receive (plugin-source)", () => {
  it("takes in the keys an event names, answers the plugin's status, and refuses a malformed answer", async () => {
    const service = new IssueTracker();
    service.edit("k1", state("one"));
    const tracker = trackerSource(service);
    let answer: unknown = { status: 202, keys: ["k1"] };
    let seen: string | undefined;
    const receiving = source<{ pageSize: number }>({
      ...tracker,
      receive: async (_ctx, request) => {
        seen = await request.text();
        return answer as never;
      },
    });
    const made = await worldOf();
    const adapter = made.adapter(receiving);
    const request = () =>
      new Request("http://127.0.0.1:4040/v1/sources/issues/events", {
        method: "POST",
        body: '{"issue":1}',
      });

    expect(await adapter.receive(request())).toEqual({
      status: 202,
      intake: { queued: ["k1"], unchanged: [], skipped: [], refused: [], strangers: 0 },
    });
    expect(seen).toBe('{"issue":1}');
    expect(await adapter.claim(10)).toEqual(["k1"]);

    // A key in the event the store cannot keep is refused alone; the event's other keys go on.
    service.edit("k1", state("two"));
    answer = { status: 202, keys: [FORGED_KEY, "k1"] };
    expect(await adapter.receive(request())).toMatchObject({
      status: 202,
      intake: { queued: ["k1"], refused: [{ key: FORGED_KEY }] },
    });

    answer = { status: 202, keys: "k1" };
    await expect(adapter.receive(request())).rejects.toThrow(
      "answered an event with something other than { status, keys }",
    );
    // A source with no receive answers 404, and a stopped one 503: nothing is taken in.
    expect((await made.adapter(tracker).receive(request())).status).toBe(404);
    await adapter.close();
    expect((await adapter.receive(request())).status).toBe(503);
  });

  it("takes in no key of an event the plugin refused, whatever keys it named beside its refusal", async () => {
    const service = new IssueTracker();
    service.edit("k1", state("one"));
    const tracker = trackerSource(service);
    let answer: { status: number; keys: string[] } = { status: 401, keys: ["k1"] };
    const reads: (readonly string[])[] = [];
    const made = await worldOf();
    const adapter = made.adapter(
      source<{ pageSize: number }>({
        ...tracker,
        read: (ctx, keys) => {
          reads.push(keys);
          return tracker.read(ctx, keys);
        },
        receive: async () => answer,
      }),
    );
    const request = () =>
      new Request("http://127.0.0.1:4040/v1/hooks/tracker/issues", { method: "POST", body: "{}" });

    for (const status of [401, 400, 413, 422, 500, 302]) {
      answer = { status, keys: ["k1"] };
      expect(await adapter.receive(request())).toEqual({
        status,
        intake: { queued: [], unchanged: [], skipped: [], refused: [], strangers: 0 },
      });
    }
    expect(await adapter.claim(10)).toEqual([]);
    expect(reads).toEqual([]);
    // Said in FacetDB's words with the status alone: no key of the event is printed.
    expect(made.notes).toContain(
      "the plugin @facetdb/tracker (source issues of issues) refused an event (HTTP 401) and still named keys with it; none is read or queued",
    );
    expect(made.notes.join("\n")).not.toContain("k1");

    // A refusal with no key says nothing.
    const before = made.notes.length;
    answer = { status: 401, keys: [] };
    expect((await adapter.receive(request())).status).toBe(401);
    expect(made.notes).toHaveLength(before);
  });

  it("abandons a receive, or a read of the keys it named, when its caller gives up, telling the plugin through its signal", async () => {
    const service = new IssueTracker();
    service.edit("k1", state("one"));
    service.edit("slow", state("slow"));
    const tracker = trackerSource(service);
    /** Each plugin call that waits for its signal, by step: when it began, and once told to stop. */
    const waiting: string[] = [];
    const toldToStop: string[] = [];
    const untilAborted = (signal: AbortSignal, step: string) =>
      new Promise<void>((resolve) => {
        waiting.push(step);
        if (signal.aborted) {
          toldToStop.push(step);
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            toldToStop.push(step);
            resolve();
          },
          { once: true },
        );
      });
    let event: { hang: boolean; keys: string[] } = { hang: true, keys: ["k1"] };
    const made = await worldOf();
    const adapter = made.adapter(
      source<{ pageSize: number }>({
        ...tracker,
        read: async (ctx, keys) => {
          if (keys.includes("slow")) {
            await untilAborted(ctx.signal, "read");
          }
          return tracker.read(ctx, keys);
        },
        receive: async (ctx) => {
          if (event.hang) {
            await untilAborted(ctx.signal, "receive");
          }
          return { status: 202, keys: event.keys };
        },
      }),
    );
    const request = () =>
      new Request("http://127.0.0.1:4040/v1/hooks/tracker/issues", { method: "POST", body: "{}" });

    // A receive that never answers: given up when its caller is, nothing taken in.
    const first = new AbortController();
    const hanging = adapter.receive(request(), first.signal);
    await vi.waitFor(() => expect(waiting).toEqual(["receive"]));
    first.abort();
    await expect(hanging).rejects.toThrow(ReceiveAbandoned);
    await expect(hanging).rejects.toThrow(
      "the plugin @facetdb/tracker (source issues of issues) had not answered in receive when the event's time ran out; its work there is abandoned",
    );
    // A receive that answers, but whose read of a key it named never does: given up the same way.
    event = { hang: false, keys: ["slow"] };
    const second = new AbortController();
    const reading = adapter.receive(request(), second.signal);
    await vi.waitFor(() => expect(waiting).toEqual(["receive", "read"]));
    second.abort();
    await expect(reading).rejects.toThrow("had not answered in read");
    await vi.waitFor(() => expect(toldToStop).toEqual(["receive", "read"]));
    expect(await adapter.claim(10)).toEqual([]);

    // An event whose caller already gave up never reaches the plugin; one whose caller waits is
    // taken in as before, and the source's own work is untouched by the callers that gave up.
    const gone = new AbortController();
    gone.abort();
    await expect(adapter.receive(request(), gone.signal)).rejects.toThrow(ReceiveAbandoned);
    expect(toldToStop).toEqual(["receive", "read"]);
    event = { hang: false, keys: ["k1"] };
    expect(await adapter.receive(request(), new AbortController().signal)).toMatchObject({
      status: 202,
      intake: { queued: ["k1"] },
    });
    expect(await adapter.claim(10)).toEqual(["k1"]);
  });

  it("refuses a key an event names that holds a direction override, a zero-width character or a line separator", async () => {
    const service = new IssueTracker();
    const formatted = ["k‮evil", "k‍zw", "k line", "﻿k"];
    for (const key of [...formatted, "k1"]) {
      service.edit(key, state(key));
    }
    const tracker = trackerSource(service);
    const reads: (readonly string[])[] = [];
    const made = await worldOf();
    const adapter = made.adapter(
      source<{ pageSize: number }>({
        ...tracker,
        read: (ctx, keys) => {
          reads.push(keys);
          return tracker.read(ctx, keys);
        },
        receive: async () => ({ status: 202, keys: [...formatted, "k1", formatted[0] as string] }),
      }),
    );

    const outcome = await adapter.receive(
      new Request("http://127.0.0.1:4040/v1/hooks/tracker/issues", { method: "POST", body: "{}" }),
    );

    expect(outcome.status).toBe(202);
    expect(outcome.intake.queued).toEqual(["k1"]);
    expect(outcome.intake.refused.map((entry) => entry.key)).toEqual(formatted);
    expect(await adapter.claim(10)).toEqual(["k1"]);
    // Each is said once, printed with no formatting character, and never read through the plugin.
    const said = made.notes.filter((line) => line.includes("a webhook may not name"));
    expect(said).toHaveLength(formatted.length);
    for (const line of said) {
      expect(line).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    expect(reads.flat()).toEqual(["k1"]);
    // From watch the store keeps such a key as before: the rule is the webhook's alone.
    expect((await adapter.intake(["k‮evil"])).queued).toEqual(["k‮evil"]);
  });
});

// --- the source host: a plugin source as the config names it, against the loaded plugins ----------

const trackerPlugin: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({
        project: z.string().min(3),
        signing: z.secret().optional(),
      }),
      watch: async function* () {},
      read: async () => [],
      scan: async function* () {},
    }),
    plain: source({
      watch: async function* () {},
      read: async () => [],
      scan: async function* () {},
    }),
  },
  actions: {
    tag: action({ config: z.object({ tag: z.string() }), run: async () => undefined }),
  },
});

const otherPlugin: Plugin = definePlugin({
  name: "other",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({}),
  actions: { ping: action({ config: z.object({}), run: async () => undefined }) },
});

function projectWith(settings: Record<string, unknown>, entry = "issues"): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { tracker: { token: env("TRACKER_TOKEN") } },
    sources: [
      {
        name: "issues",
        source: sourceCall("@facetdb/tracker", entry, settings as never),
        read: ["title"],
        questions: { minor: noul("Is it minor?") },
        actions: [
          actionCall("@facetdb/tracker", "tag", { tag: "x" }),
          actionCall("@facetdb/other", "ping", {}),
        ],
      },
    ],
  });
}

async function hostFor(config: ProjectConfig, environment: Record<string, string>) {
  return createPluginHost({
    config,
    env: environment,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "@facetdb/tracker"
        ? Promise.resolve({ default: trackerPlugin })
        : specifier === "@facetdb/other"
          ? Promise.resolve({ default: otherPlugin })
          : Promise.reject(Object.assign(new Error("no"), { code: "ERR_MODULE_NOT_FOUND" })),
    builtins: {},
  });
}

const ENV = { TRACKER_TOKEN: "trk_s3cret-token", PROJECT: "ab" };

async function refusalOf(settings: Record<string, unknown>, entry?: string) {
  const config = projectWith(settings, entry);
  const host = await hostFor(config, ENV);
  try {
    hostedSource(host, config, config.sources[0] as never, ENV);
  } catch (error) {
    if (error instanceof PluginHostError) {
      return error;
    }
    throw error;
  }
  throw new Error("the source was not refused");
}

describe("the source host (plugin-source)", () => {
  it("hands the source its parsed settings, its plugin's actions and the variables it reads", async () => {
    const config = projectWith({ project: "web" });
    const host = await hostFor(config, ENV);
    const hosted = hostedSource(host, config, config.sources[0] as never, ENV);
    expect(hosted).toMatchObject({
      packageName: "@facetdb/tracker",
      entry: "issues",
      settings: { project: "web" },
      actions: [{ action: "tag", config: { tag: "x" } }],
      variables: ["TRACKER_TOKEN"],
    });
    expect(Object.isFrozen(hosted.settings)).toBe(true);
    // The source's context as the plugin gets it: its settings, the worker's clock and cursor.
    const seen: SourceContext<unknown, unknown>[] = [];
    const made = await worldOf();
    const adapter = createPluginSourceConnector({
      store: made.store.connector({ sourceId: SOURCE_ID, fields: ["title"], workerId: "w" }),
      name: "issues",
      hosted: {
        ...hosted,
        definition: {
          ...hosted.definition,
          read: async (ctx, keys) => {
            seen.push(ctx);
            return keys.map((key) => ({ key, state: { title: "t" } }));
          },
        },
      },
      context: (signal) => host.contextFor("@facetdb/tracker", signal),
      fields: ["title"],
      clock: new FakeClock(START),
      cursors: made.store.cursors,
      cursorRun: RUN,
      note: () => undefined,
    });
    await adapter.intake(["k"]);
    await adapter.close();
    expect(seen[0]?.source).toEqual({
      name: "issues",
      settings: { project: "web" },
      actions: [{ action: "tag", config: { tag: "x" } }],
    });
    expect(seen[0]?.secrets).toEqual({ token: "trk_s3cret-token" });
    expect(seen[0]?.clock.now()).toBe(START);
  });

  it("refuses a source its plugin lacks, a secret written into the file, an unset variable and refused settings", async () => {
    expect((await refusalOf({ project: "web" }, "pulls")).message).toBe(
      'sources[0].source.source is "pulls", but the plugin "@facetdb/tracker" has no source of that name: its sources are issues, plain',
    );
    const literal = await refusalOf({ project: "web", signing: "abc" });
    expect(literal.code).toBe("plugin-secret-literal");
    expect(literal.fix).toContain('signing: env("TRACKER_SIGNING")');
    const unset = await refusalOf({ project: env("MISSING_PROJECT") });
    expect(unset.code).toBe("plugin-variable-unset");
    expect(unset.message).toContain(
      "MISSING_PROJECT is not set (sources[0].source.settings.project reads it)",
    );
    // The schema's reason is never printed for a value a variable fed: it could quote the value.
    const short = await refusalOf({ project: env("PROJECT") });
    expect(short.code).toBe("source-settings");
    expect(short.message).toContain(
      "sources[0].source.settings.project: the value of PROJECT is refused by the source's schema (its reason is not shown, as it could quote the value)",
    );
    expect(short.message).not.toContain('"ab"');
    const typed = await refusalOf({ project: 7 });
    expect(typed.message).toContain("sources[0].source.settings.project:");
    const none = await refusalOf({ x: 1 }, "plain");
    expect(none.message).toBe(
      "sources[0].source.settings gives settings to the source @facetdb/tracker plain, which takes none",
    );
  });

  it("refuses a plugin source whose plugin the worker did not load", async () => {
    const config = projectWith({ project: "web" });
    const started = facetdb({
      model: "jev-1.14.0",
      sources: [
        { name: "support", api: true, read: ["title"], questions: { minor: noul("Minor?") } },
      ],
    });
    const host = await hostFor(started, ENV);
    expect(() => hostedSource(host, config, config.sources[0] as never, ENV)).toThrow(
      'sources[0].source.plugin names the plugin "@facetdb/tracker", which this worker did not load when it started',
    );
  });
});
