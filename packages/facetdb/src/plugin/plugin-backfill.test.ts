import {
  type AlertSignals,
  type BackfillDeps,
  type BackfillEstimate,
  backfillRun,
  createBackfill,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type QuestionSet,
  type RecordKey,
  reviewsOf,
  type SpendingGate,
  type StateValue,
} from "@facetdb/core";
import { FakeClock, freshHeldModel, runConnectorContract } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import {
  createStore,
  NOT_A_RESUME_ROW,
  readResumeRows,
  type Store,
  sourceIdOf,
} from "@facetdb/postgres";
import {
  createPgliteWorld,
  type PgliteWorld,
  resetPgliteWorld,
  TEST_SECRET,
} from "@facetdb/postgres/testing";
import type { ActionDelivery } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actionCall,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
  sourceCall,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  actionSteps,
  type BackfillStore,
  createActionRunner,
  createPluginBackfillConnector,
  createPluginHost,
  createPluginSourceConnector,
  definePlugin,
  type HostedSource,
  hostedSource,
  MAX_CURSOR_LENGTH,
  MAX_EMPTY_PAGES,
  type PluginHost,
  type PluginSourceConnector,
  PluginSourceFailed,
  type QueuedAction,
  SourceAccessLost,
  type SourceDefinition,
  type SourcePage,
  source,
  z,
} from "./index.ts";

/**
 * `facetdb backfill` pages a plugin source through the plugin's own `scan`: a fixture plugin's
 * issue tracker on a PGlite store, under core's backfill, worker and the worker's action steps. The
 * estimate comes first and stores, queues and asks nothing; each page is read once a pass, through
 * one call of the plugin's scan, in the plugin's order; a record is taken into the store when it is
 * queued, at the pace; a stopped run resumes at the next page; a failed page saves no cursor; every
 * record is answered once and its actions run; a page's refused row is left out alone; a cursor the
 * plugin repeats fails in words.
 */

const START = 1_700_000_000_000;
const PROJECT = "tracker-app";
const ID = sourceIdOf(PROJECT, "issues");
/** What the plugin's own failure says: it must reach no error FacetDB raises. */
const LEAKED = "token trk_s3cret-token was refused";
const ENV = { TRACKER_TOKEN: "trk_s3cret-token" };
const ABOUT = "the plugin @facetdb/tracker (source issues of issues)";

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

// --- the issue tracker the plugin reads -------------------------------------------------------------

type Issue = Readonly<Record<string, StateValue>>;

/** The tool outside FacetDB: issues numbered from 1, the newest the highest. */
class Tracker {
  readonly issues = new Map<number, Issue>();
  /** The cursor of each page the plugin read, in order (null for the first). */
  readonly pages: (string | null)[] = [];
  /** The cursor each call of the plugin's scan started from. */
  readonly scans: (string | null)[] = [];
  /** The keys of each call of the plugin's read. */
  readonly reads: (readonly RecordKey[])[] = [];
  /** A page the plugin fails to read, by its cursor. */
  failAt: string | null | undefined;
  /** Set when the tool refuses the plugin's credential: the failure is a `SourceAccessLost`. */
  revoked = false;
  /** Issues a page holds. */
  readonly pageSize: number;

  constructor(count: number, pageSize: number) {
    this.pageSize = pageSize;
    for (let number = 1; number <= count; number += 1) {
      this.issues.set(number, { title: `Issue ${number}`, body: `What issue ${number} says` });
    }
  }
}

const keyOf = (number: number): RecordKey => `acme/web#${number}`;

/** Keys newest first, from `top` down to `bottom`. */
function keysFrom(top: number, bottom: number): RecordKey[] {
  const keys: RecordKey[] = [];
  for (let number = top; number >= bottom; number -= 1) {
    keys.push(keyOf(number));
  }
  return keys;
}

type Labelled = { readonly key: RecordKey; readonly settings: unknown };

function trackerPlugin(tracker: Tracker, labelled: Labelled[]) {
  return definePlugin({
    name: "tracker",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret() }),
    sources: {
      issues: source({
        config: z.object({ repo: z.string() }),
        watch: async function* () {},
        read: async (_ctx, keys) => {
          tracker.reads.push(keys);
          return keys.flatMap((key) => {
            const issue = tracker.issues.get(Number(key.slice("acme/web#".length)));
            return issue === undefined ? [] : [{ key, state: issue }];
          });
        },
        // Newest first; a cursor is the number of the last issue of the page before.
        scan: async function* (_ctx, cursor) {
          tracker.scans.push(cursor);
          let below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
          let at: string | null = cursor;
          for (;;) {
            tracker.pages.push(at);
            if (tracker.failAt !== undefined && tracker.failAt === at) {
              throw tracker.revoked ? new SourceAccessLost(LEAKED) : new Error(LEAKED);
            }
            const numbers = [...tracker.issues.keys()]
              .filter((number) => number < below)
              .sort((a, b) => b - a);
            const page = numbers.slice(0, tracker.pageSize);
            const last = page.at(-1);
            const next = numbers.length > page.length && last !== undefined ? String(last) : null;
            yield {
              rows: page.map((number) => ({
                key: keyOf(number),
                state: tracker.issues.get(number) ?? {},
              })),
              next,
            };
            if (next === null) {
              return;
            }
            below = Number(next);
            at = next;
          }
        },
      }),
    },
    actions: {
      label: action({
        config: z.object({
          add: z.array(z.string()).default([]),
          remove: z.array(z.string()).default([]),
        }),
        run: async (_ctx, record, _decisions, settings) => {
          labelled.push({ key: record.key, settings });
        },
      }),
    },
  });
}

/** The worked example, as a plugin source: one question, labelled by the same plugin. */
const CONFIG: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  plugins: { tracker: { token: env("TRACKER_TOKEN") } },
  sources: [
    {
      name: "issues",
      source: sourceCall("@facetdb/tracker", "issues", { repo: "acme/web" }),
      read: ["title", "body"],
      questions: {
        not_priority: noul("Would the maintainers treat this as low priority?"),
        impacts_only_oss: noul("Does this affect only the self-hosted open-source version?"),
      },
      thresholds: {
        not_priority: { yesAbove: 0.8, noBelow: 0.2 },
        impacts_only_oss: { yesAbove: 0.8, noBelow: 0.2 },
      },
      actions: [
        actionCall("@facetdb/tracker", "label", {
          when: { not_priority: true },
          add: ["Not Priority"],
          else: { add: [], remove: ["Not Priority"] },
        }),
      ],
    },
  ],
});

function sourceConfig(): SourceConfig {
  const [first] = CONFIG.sources;
  if (first === undefined) {
    throw new Error("the test config has a source");
  }
  return first;
}

/** The set as the worker runs it: the first question alone, or both once the second is added. */
function setOf(questions: readonly string[]): QuestionSet {
  const issues = sourceConfig();
  return {
    questions: issues.questions.filter((question) => questions.includes(question.name)),
    read: issues.read,
    model: "jev-1.14.0",
    thresholds: issues.thresholds,
  };
}

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

type Rig = {
  readonly store: Store;
  readonly tracker: Tracker;
  readonly clock: FakeClock;
  readonly provider: FakeProvider;
  readonly host: PluginHost;
  readonly hosted: HostedSource;
  readonly notes: string[];
  readonly labelled: Labelled[];
  /** The action rows the worker's steps queued, in order. */
  readonly rows: QueuedAction[];
  readonly alerts: string[];
  /**
   * A backfill's own adapter over the store, as a backfill opens one: `wrap` stands between it and
   * the store, and `scan`, when given, is the plugin's scan instead of the tracker's.
   */
  adapter(
    workerId: string,
    wrap?: (store: BackfillStore) => BackfillStore,
    scan?: SourceDefinition<unknown>["scan"],
  ): PluginSourceConnector;
  /** The worker's loop's adapter, as the worker opens it: its previews and its re-queues go through it. */
  readonly loop: PluginSourceConnector;
  /** A backfill under `set` at `version`, over `connector`. */
  backfill(
    connector: PluginSourceConnector,
    set?: QuestionSet,
    version?: number,
  ): ReturnType<typeof createBackfill>;
  /** The worker's loop over the store's queue: claims until the queue is empty. */
  drain(set?: QuestionSet, version?: number): Promise<void>;
  /** Runs every queued action row through the plugin's action, as the outbox does. */
  deliver(): Promise<void>;
};

const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const one of opened.splice(0).reverse()) {
    await one.close();
  }
  await resetPgliteWorld(world);
});

async function rigOf(count: number, pageSize: number): Promise<Rig> {
  const clock = new FakeClock(START);
  const store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  opened.push(store);
  await store.ensureProject({ id: PROJECT, name: PROJECT });
  await store.ensureSource({ projectId: PROJECT, name: "issues", kind: "plugin-source" });
  const tracker = new Tracker(count, pageSize);
  const labelled: Labelled[] = [];
  const host = await createPluginHost({
    config: CONFIG,
    env: ENV,
    projectDir: "/work/tracker-app",
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "@facetdb/tracker"
        ? Promise.resolve({ default: trackerPlugin(tracker, labelled) })
        : Promise.reject(Object.assign(new Error("no"), { code: "ERR_MODULE_NOT_FOUND" })),
    builtins: {},
  });
  const issues = sourceConfig();
  const hosted = hostedSource(host, CONFIG, issues, ENV);
  // Every record a clear "yes, not a priority": the label action adds its label to each.
  const provider = createFakeProvider({ defaults: { noul: 0.93 } });
  const notes: string[] = [];
  const rows: QueuedAction[] = [];
  const alerts: string[] = [];
  // A backfill that finished or failed says so.
  const recordingAlerts: AlertSignals = {
    modelCall: () => Promise.resolve(),
    modelChecked: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    backfillFinished: (summary) => {
      alerts.push(`finished: ${summary.queued} queued`);
      return Promise.resolve();
    },
    backfillFailed: (summary) => {
      alerts.push(`failed: ${summary.failed}`);
      return Promise.resolve();
    },
  };
  const first = await store.questionSets.record(ID, setOf(["not_priority"]));

  const own = {
    name: "issues",
    context: (signal: AbortSignal) => host.contextFor("@facetdb/tracker", signal),
    fields: issues.read,
    clock,
    cursors: store.cursors,
    cursorRun: `plugin-source:${ID}`,
    note: (line: string) => notes.push(line),
  };

  function adapter(
    workerId: string,
    wrap = (inner: BackfillStore) => inner,
    scan?: SourceDefinition<unknown>["scan"],
  ) {
    const made = createPluginBackfillConnector({
      ...own,
      store: wrap(store.connector({ sourceId: ID, fields: issues.read, workerId })),
      hosted:
        scan === undefined ? hosted : { ...hosted, definition: { ...hosted.definition, scan } },
    });
    opened.push(made);
    return made;
  }

  const loop = createPluginSourceConnector({
    ...own,
    store: store.connector({ sourceId: ID, fields: issues.read, workerId: "worker-1" }),
    hosted,
  });
  opened.push(loop);

  return {
    store,
    tracker,
    loop,
    clock,
    provider,
    host,
    hosted,
    notes,
    labelled,
    rows,
    alerts,
    adapter,
    backfill(connector, set = setOf(["not_priority"]), version = first.version) {
      const deps: BackfillDeps = {
        project: PROJECT,
        source: "issues",
        connector,
        worker: provider,
        clock,
        cursorStore: store.cursors,
        log: store.log(ID),
        questionSet: set,
        version,
        heldModel: freshHeldModel(version),
        alerts: recordingAlerts,
        spending: UNLIMITED,
        runs: { log: store.runs, source: ID },
        reviews: reviewsOf(store.reviews, ID),
      };
      return createBackfill(deps);
    },
    async drain(set = setOf(["not_priority"]), version = first.version) {
      const worker = createWorker({
        connector: loop,
        provider,
        log: store.log(ID),
        reviews: reviewsOf(store.reviews, ID),
        // The action steps: each decision queues one row per action, run later from the outbox.
        actions: actionSteps(issues, (row) => {
          rows.push(row);
          return Promise.resolve();
        }),
        clock,
        limits: DEFAULT_WORKER_LIMITS,
        questionSet: set,
        version,
        heldModel: freshHeldModel(version),
        spending: UNLIMITED,
      });
      for (;;) {
        const pass = await worker.runOnce();
        expect(pass.failures).toEqual([]);
        if (pass.claimed === 0) {
          return;
        }
      }
    },
    async deliver() {
      const run = createActionRunner({
        host,
        source: () => ({
          kind: "running",
          name: "issues",
          connector: loop,
          log: store.log(ID),
          questionSet: setOf(["not_priority"]),
          plugin: {
            packageName: hosted.packageName,
            settings: hosted.settings,
            variables: hosted.variables,
          },
        }),
        env: ENV,
        // No notification here (notify-action.test.ts sends those).
        notify: {
          clock: new FakeClock(START),
          stop: () => new AbortController().signal,
          recordLink: () => undefined,
          listLink: () => undefined,
        },
      });
      for (const [index, row] of rows.splice(0).entries()) {
        const delivery: ActionDelivery = {
          deliveryId: String(index),
          projectId: PROJECT,
          sourceId: ID,
          recordKey: row.recordKey,
          plugin: row.plugin,
          action: row.action,
          position: row.position,
          // Read back from its JSON, as the outbox hands it on.
          payload: JSON.parse(JSON.stringify(row.payload)) as unknown,
          batchKey: undefined,
          attempt: 1,
          queuedAt: clock.now(),
        };
        expect(await run(delivery, new AbortController().signal)).toBeUndefined();
      }
    },
  };
}

async function count(table: "records" | "jobs"): Promise<number> {
  const rows = await world.client.query(`select count(*)::int as n from facetdb.${table}`);
  return Number(rows[0]?.["n"]);
}

/** What the run saved for the whole set at version 1. */
const ALL_V1 = backfillRun(PROJECT, "issues", 1, undefined);

const yes = (): boolean => true;

describe("a backfill of a plugin source (plugin-backfill)", () => {
  it("reads 250 records at 100 a page in three pages, in order, estimate first, and leaves done set", async () => {
    const rig = await rigOf(250, 100);
    const seen: BackfillEstimate[] = [];
    const before: number[] = [];
    const taken: RecordKey[] = [];
    const counting = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      insertRecord: (key, state) => {
        taken.push(key);
        return inner.insertRecord(key, state);
      },
    }));

    const report = await rig.backfill(counting).run({
      onEstimate: async (estimate) => {
        seen.push(estimate);
        // Shown before anything is stored, queued or asked.
        before.push(await count("records"), await count("jobs"), rig.provider.callCount);
        return true;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ records: 250, sampled: 100 });
    expect(seen[0]?.tokens).toBeGreaterThan(0);
    expect(before).toEqual([0, 0, 0]);
    expect(report.status).toBe("completed");
    // One call of the plugin's scan a pass, three pages each: the estimate's, then the run's.
    expect(rig.tracker.scans).toEqual([null, null]);
    expect(rig.tracker.pages).toEqual([null, "151", "51", null, "151", "51"]);
    // The plugin's order, newest first, taken in and queued as the run reached each record.
    expect(taken).toEqual(keysFrom(250, 1));
    expect(report.enqueued).toEqual(keysFrom(250, 1));
    expect(await count("records")).toBe(250);
    expect(await count("jobs")).toBe(250);
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: null, done: true });
    expect(rig.alerts).toEqual(["finished: 250 queued"]);
    // Nothing was asked: the worker answers the queue.
    expect(rig.provider.callCount).toBe(0);
    // The store holds the state the scan read, and only the fields the source reads.
    const stored = await counting.read([keyOf(7)]);
    expect(stored.rows[0]?.state).toEqual({ title: "Issue 7", body: "What issue 7 says" });
  });

  it("asks nothing, stores nothing and queues nothing on a declined estimate, as a dry run's is", async () => {
    const rig = await rigOf(25, 10);
    const report = await rig.backfill(rig.adapter("backfill-1")).run({ onEstimate: () => false });

    expect(report.status).toBe("declined");
    expect(report.estimate.records).toBe(25);
    expect(rig.tracker.pages).toEqual([null, "16", "6"]);
    expect(await count("records")).toBe(0);
    expect(await count("jobs")).toBe(0);
    expect(rig.provider.callCount).toBe(0);
    expect(await rig.store.cursors.load(ALL_V1)).toBeUndefined();
  });

  it("answers every record once and runs its actions, which labels every open issue; a second pass queues nothing", async () => {
    const rig = await rigOf(250, 100);
    await rig.backfill(rig.adapter("backfill-1")).run({ onEstimate: yes });
    await rig.drain();

    expect(rig.provider.callCount).toBe(250);
    expect(await count("jobs")).toBe(0);
    // The action steps: one row a record, each run through the plugin's own action.
    expect(rig.rows).toHaveLength(250);
    await rig.deliver();
    expect(rig.labelled.map((call) => call.key).sort()).toEqual(keysFrom(250, 1).sort());
    expect(new Set(rig.labelled.map((call) => JSON.stringify(call.settings)))).toEqual(
      new Set([JSON.stringify({ add: ["Not Priority"], remove: [] })]),
    );

    // The same states again: everything is answered at them, so nothing is queued or asked.
    const again = await rig.backfill(rig.adapter("backfill-2")).run({ onEstimate: yes });
    expect(again.status).toBe("completed");
    expect(again.enqueued).toEqual([]);
    expect(again.alreadyAnswered).toHaveLength(250);
    expect(await count("jobs")).toBe(0);
    await rig.drain();
    expect(rig.provider.callCount).toBe(250);
    expect(rig.rows).toEqual([]);
  });

  it("resumes a run stopped after page one at page two, and queues no record twice", async () => {
    const rig = await rigOf(25, 10);
    const stop = new AbortController();
    const first = await rig.backfill(rig.adapter("backfill-1")).run({
      onEstimate: yes,
      signal: stop.signal,
      onPage: () => stop.abort(),
    });

    expect(first.status).toBe("aborted");
    expect(first.enqueued).toEqual(keysFrom(25, 16));
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: "16", done: false });
    expect(await count("records")).toBe(10);
    // The run's place is core's backfill key, a resume row of the source: never the plugin's own
    // watch cursor (`plugin-source:`, untouched), and never an unfinished backfill that would keep
    // the store's shared tables in uninstall's sweep.
    expect(ALL_V1).toBe(`backfill:${ID}:all@v1`);
    expect(await rig.store.cursors.load(`plugin-source:${ID}`)).toBeUndefined();
    const query = (sql: string, params?: readonly unknown[]) => world.client.query(sql, params);
    expect(
      await query(`select run from facetdb.cursors where not done and ${NOT_A_RESUME_ROW}`),
    ).toEqual([]);
    expect(await readResumeRows(query, ID)).toEqual([ALL_V1]);

    // A new process: its estimate and its run both start at page two, never at page one.
    rig.tracker.scans.length = 0;
    rig.tracker.pages.length = 0;
    const second = await rig.backfill(rig.adapter("backfill-2")).run({ onEstimate: yes });
    expect(second.status).toBe("completed");
    expect(second.estimate.records).toBe(15);
    expect(rig.tracker.scans).toEqual(["16", "16"]);
    expect(rig.tracker.pages).toEqual(["16", "6", "16", "6"]);
    expect(second.enqueued).toEqual(keysFrom(15, 1));
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: null, done: true });

    await rig.drain();
    expect(rig.provider.callCount).toBe(25);
  });

  it("saves no cursor for a page the plugin failed to read, in FacetDB's words, and the next run reads it", async () => {
    const rig = await rigOf(25, 10);
    const failed = await rig
      .backfill(rig.adapter("backfill-1"))
      .run({
        // The estimate read every page; the run's second page fails.
        onEstimate: () => {
          rig.tracker.failAt = "16";
          return true;
        },
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(PluginSourceFailed);
    expect((failed as Error).message).toBe(
      `${ABOUT} failed in scan (its own words are not shown, as they could quote a secret it was handed)`,
    );
    expect(JSON.stringify(failed)).not.toContain("trk_s3cret");
    // Page one was taken in and saved; nothing of page two was.
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: "16", done: false });
    expect(await count("records")).toBe(10);

    // A refused credential on that page, in the estimate this time: said as one, by name, with
    // the variable the source reads, and still nothing saved past page one.
    rig.tracker.revoked = true;
    const lost = await rig
      .backfill(rig.adapter("backfill-2"))
      .run({ onEstimate: yes })
      .catch((error: unknown) => error);
    expect((lost as Error).name).toBe("SourceAccessLost");
    expect((lost as Error).message).toBe(
      `${ABOUT} lost access: the service it reads refused its credential in scan; check the variable TRACKER_TOKEN and the rights granted to it`,
    );
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: "16", done: false });

    rig.tracker.failAt = undefined;
    const next = await rig.backfill(rig.adapter("backfill-3")).run({ onEstimate: yes });
    expect(next.status).toBe("completed");
    expect(next.enqueued).toEqual(keysFrom(15, 1));
    await rig.drain();
    expect(rig.provider.callCount).toBe(25);
  });

  it("saves no cursor for a page the store would not take in, and repeats it: every record answered once", async () => {
    const rig = await rigOf(25, 10);
    let refusing = true;
    const broken = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      insertRecord: (key, state) =>
        refusing && key === keyOf(12)
          ? Promise.reject(new Error("Connection terminated unexpectedly"))
          : inner.insertRecord(key, state),
    }));
    const stopped = await rig.backfill(broken).run({ onEstimate: yes, pace: 5 });

    expect(stopped.status).toBe("stopped");
    expect(stopped.failures.map((failure) => failure.key)).toEqual(keysFrom(15, 11));
    expect(rig.alerts).toEqual(["failed: 5"]);
    expect(await rig.store.cursors.load(ALL_V1)).toEqual({ cursor: "16", done: false });

    refusing = false;
    const repeated = await rig.backfill(rig.adapter("backfill-2")).run({ onEstimate: yes });
    expect(repeated.status).toBe("completed");
    // Page two again from its start: its first chunk was queued before, and is queued once.
    expect(repeated.enqueued).toEqual(keysFrom(15, 1));
    await rig.drain();
    expect(rig.provider.callCount).toBe(25);
  });

  it("@timing takes records in at the pace, as a table source queues them, and none while it counts", async () => {
    const rig = await rigOf(250, 100);
    const at: number[] = [];
    let estimated = false;
    const paced = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      insertRecord: (key, state) => {
        expect(estimated).toBe(true);
        at.push(rig.clock.now());
        return inner.insertRecord(key, state);
      },
    }));
    const started = rig.clock.now();
    await rig.backfill(paced).run({
      onEstimate: () => {
        estimated = true;
        return true;
      },
    });

    expect(at).toHaveLength(250);
    // At most 50 a second (the default), in any one-second window.
    for (const [index, time] of at.entries()) {
      expect(
        at.filter((other) => other >= time && other < time + 1_000).length,
      ).toBeLessThanOrEqual(50);
      expect(index < 50 || time >= started + 1_000).toBe(true);
    }
    expect((at.at(-1) ?? 0) - started).toBeGreaterThanOrEqual(4_000);
  });

  it("@timing takes records in at a lower pace when one is given", async () => {
    const rig = await rigOf(25, 10);
    const at: number[] = [];
    const paced = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      insertRecord: (key, state) => {
        at.push(rig.clock.now());
        return inner.insertRecord(key, state);
      },
    }));
    const started = rig.clock.now();
    await rig.backfill(paced).run({ onEstimate: yes, pace: 5 });

    expect(at).toHaveLength(25);
    for (const time of at) {
      expect(
        at.filter((other) => other >= time && other < time + 1_000).length,
      ).toBeLessThanOrEqual(5);
    }
    expect((at.at(-1) ?? 0) - started).toBeGreaterThanOrEqual(4_000);
  });

  it("leaves out a row the store does not take, says each and counts them, and goes on with the page", async () => {
    const rig = await rigOf(5, 10);
    // An issue whose state lacks a field the source reads, and below a key the store cannot keep.
    rig.tracker.issues.set(6, { title: "No body" });
    const scanning = rig.hosted.definition.scan;
    const connector = rig.adapter("backfill-1", undefined, async function* (ctx, cursor) {
      for await (const page of scanning(ctx, cursor)) {
        yield {
          ...page,
          rows: [...page.rows, { key: "bad\u0000key", state: { title: "x", body: "x" } }],
        };
      }
    });

    const report = await rig.backfill(connector).run({ onEstimate: yes });

    expect(report.status).toBe("completed");
    expect(report.estimate.records).toBe(5);
    expect(report.enqueued).toEqual(keysFrom(5, 1));
    expect(await count("records")).toBe(5);
    const said = [
      `${ABOUT} returned the record acme/web#6 from scan in a shape the store does not take (its state lacks the field body, which the source reads (a field with no value is null)), so it is left out of the backfill`,
      `${ABOUT} returned a record from scan whose key the store cannot keep (it holds a control character (a NUL, a line break or an escape)), so it is left out of the backfill: badkey… (a key of 7 characters, shown in part)`,
      `${ABOUT} returned 2 rows in this pass of its scan that the store does not take, each named above: left out of the backfill, its count and its estimate`,
    ];
    // Said in the estimate's pass and again in the run's.
    expect(rig.notes).toEqual([...said, ...said]);
    // The hash the scan handed core is the one the store keeps for the state it took in.
    const page = await connector.scan(null);
    const read = await connector.read(page.rows.map((row) => row.key));
    expect(read.rows.map((row) => [row.key, row.hash])).toEqual(
      page.rows.map((row) => [row.key, row.hash]),
    );
  });

  it("fails in words, and never pages forever, when the plugin's next cursor repeats an earlier one", async () => {
    const rig = await rigOf(0, 10);
    const row = (key: string) => ({ key, state: { title: key, body: key } });
    const pagingWith = (pages: (cursor: string | null) => AsyncIterable<SourcePage>) =>
      rig.adapter("backfill-1", undefined, (_ctx, cursor) => pages(cursor));
    const words = `${ABOUT} returned a page from scan whose next cursor repeats one it gave earlier in the same scan, so its pages would never end; nothing of the page is taken in, and the backfill's saved place stays at the page before it`;

    // c1, c2, then c1 again: a cycle the estimate would follow forever.
    const cycling = pagingWith(async function* () {
      for (;;) {
        yield { rows: [row("a")], next: "c1" };
        yield { rows: [row("b")], next: "c2" };
      }
    });
    await expect(rig.backfill(cycling).run({ onEstimate: yes })).rejects.toThrow(words);
    expect(await count("records")).toBe(0);
    expect(await count("jobs")).toBe(0);
    expect(await rig.store.cursors.load(ALL_V1)).toBeUndefined();

    // A page whose next is the very cursor it was read from, continued or resumed from it.
    const stuck = pagingWith(async function* () {
      for (;;) {
        yield { rows: [row("a")], next: "c1" };
      }
    });
    expect((await stuck.scan(null)).next).toBe("c1");
    await expect(stuck.scan("c1")).rejects.toThrow(words);
    await expect(stuck.scan("c1")).rejects.toThrow(words);
    expect(await count("records")).toBe(0);
  });

  it("fails in words on a page that is not { rows, next }, and on a next cursor the store cannot keep", async () => {
    const rig = await rigOf(0, 10);
    const yielding = (value: unknown) =>
      rig.adapter("backfill-1", undefined, async function* () {
        yield value as SourcePage;
      });

    for (const odd of [[], { rows: "a" }, { rows: [] }, { rows: [], next: 7 }]) {
      await expect(yielding(odd).scan(null)).rejects.toThrow(
        `${ABOUT} yielded something other than a page of { rows, next } from scan`,
      );
    }
    for (const cursor of ["c\u0000", "x".repeat(MAX_CURSOR_LENGTH + 1), "lone\ud800"]) {
      await expect(yielding({ rows: [], next: cursor }).scan(null)).rejects.toThrow(
        "whose next cursor the store cannot keep",
      );
    }
    // A scan that yields nothing at all is an empty source: one empty last page.
    const empty = rig.adapter("backfill-1", undefined, async function* () {});
    expect(await empty.scan(null)).toEqual({ rows: [], next: null });

    // Empty pages without end, each naming a fresh cursor: stopped in words, never paged forever.
    let pages = 0;
    const endless = rig.adapter("backfill-1", undefined, async function* () {
      for (;;) {
        pages += 1;
        yield { rows: [], next: `page-${pages}` };
      }
    });
    await expect(rig.backfill(endless).run({ onEstimate: yes })).rejects.toThrow(
      `${ABOUT} returned more than ${MAX_EMPTY_PAGES} empty pages in a row from scan, each naming a next cursor, so its pages may never end; nothing more is taken in, and the next backfill resumes from the last page saved`,
    );
    expect(pages).toBe(MAX_EMPTY_PAGES + 1);

    // A scan reads the source's one saved cursor, but saving it, watch's resume point, fails the scan.
    await rig.store.cursors.save(`plugin-source:${ID}`, { cursor: "watch-7", done: true });
    let loaded: string | null = null;
    const saving = rig.adapter("backfill-1", undefined, async function* (ctx) {
      loaded = await ctx.cursor.load();
      await ctx.cursor.save("scan-1");
      yield { rows: [], next: null };
    });
    await expect(saving.scan(null)).rejects.toThrow(`${ABOUT} failed in scan`);
    expect(loaded).toBe("watch-7");
    expect(await rig.store.cursors.load(`plugin-source:${ID}`)).toEqual({
      cursor: "watch-7",
      done: true,
    });
  });

  it("asks a named question alone of the records answered before, as on any source", async () => {
    const rig = await rigOf(5, 2);
    await rig.backfill(rig.adapter("backfill-1")).run({ onEstimate: yes });
    await rig.drain();
    expect(rig.provider.callCount).toBe(5);

    const both = setOf(["not_priority", "impacts_only_oss"]);
    const second = await rig.store.questionSets.record(ID, both);
    const added = await rig
      .backfill(rig.adapter("backfill-2"), both, second.version)
      .run({ onEstimate: yes, onlyQuestions: ["impacts_only_oss"] });

    expect(added.status).toBe("completed");
    expect([...added.answered].sort()).toEqual(keysFrom(5, 1).sort());
    expect(added.enqueued).toEqual([]);
    expect(
      rig.provider.requests.slice(5).map((request) => request.questions.map((q) => q.name)),
    ).toEqual(Array.from({ length: 5 }, () => ["impacts_only_oss"]));
    expect(await count("jobs")).toBe(0);
  });
});

/** An issue's state as the tool gives it. */
const issueState = (title: string, body: string): Issue => ({ title, body });

describe("a backfill never writes an older state over a newer one (plugin-backfill)", () => {
  it("takes each record in by what the store holds as its chunk is queued, reading a changed one again through the plugin", async () => {
    const rig = await rigOf(5, 10);
    // What watch took in before: #4 at a text since edited in the tool, #3 at the text it has now.
    rig.tracker.issues.set(4, issueState("Issue 4, before", "the old text"));
    await rig.loop.intake([keyOf(4)]);
    rig.tracker.issues.set(4, issueState("Issue 4", "What issue 4 says"));
    await rig.loop.intake([keyOf(3)]);
    await rig.loop.ack(await rig.loop.claim(10));
    rig.tracker.reads.length = 0;

    // A newer change of #1 lands between the store's look and #1's insert.
    let racing = true;
    const backfill = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      read: async (keys) => {
        const found = await inner.read(keys);
        if (racing) {
          racing = false;
          rig.tracker.issues.set(1, issueState("Issue 1, edited", "the newest text"));
          await rig.loop.intake([keyOf(1)]);
        }
        return found;
      },
    }));
    const page = await backfill.scan(null);
    expect(page.rows.map((row) => row.key)).toEqual(keysFrom(5, 1));
    // The page is read; then #5 is edited and its change stored (watch or a webhook) before its chunk.
    rig.tracker.issues.set(5, issueState("Issue 5, edited", "the newer text"));
    await rig.loop.intake([keyOf(5)]);
    rig.tracker.reads.length = 0;

    const queued = await backfill.enqueue(keysFrom(5, 1));
    // Every key was taken in and queued, so every key is returned.
    expect([...queued].sort()).toEqual(keysFrom(5, 1).sort());

    const stored = await rig.loop.read(keysFrom(5, 1));
    expect(Object.fromEntries(stored.rows.map((row) => [row.key, row.state]))).toEqual({
      // Stored newer since the page: kept, never the page's older text.
      [keyOf(5)]: issueState("Issue 5, edited", "the newer text"),
      // Stored older than the page: read again through the plugin, which has the page's text.
      [keyOf(4)]: issueState("Issue 4", "What issue 4 says"),
      // Stored at the page's state: queued as it is.
      [keyOf(3)]: issueState("Issue 3", "What issue 3 says"),
      // Not stored: taken in from the page.
      [keyOf(2)]: issueState("Issue 2", "What issue 2 says"),
      // Stored while the backfill looked: the newer one stands.
      [keyOf(1)]: issueState("Issue 1, edited", "the newest text"),
    });
    // The plugin is read again, in one call after the race's own intake, for the records the store
    // holds at another state, and only those.
    expect(rig.tracker.reads).toEqual([[keyOf(1)], [keyOf(5), keyOf(4), keyOf(1)]]);
    // Every record queued once, and answered at the state the store holds.
    expect(await count("jobs")).toBe(5);
    await rig.drain();
    expect(rig.provider.callCount).toBe(5);
    expect(rig.provider.requests.map((request) => request.state["title"]).sort()).toEqual([
      "Issue 1, edited",
      "Issue 2",
      "Issue 3",
      "Issue 4",
      "Issue 5, edited",
    ]);
  });

  it("counts as queued only what it took in: a record the plugin no longer returns on the read again is named apart", async () => {
    const rig = await rigOf(5, 10);
    // Stored before at a text since edited in the tool: #4 and #2 are read again; #3 is stored as it is.
    rig.tracker.issues.set(4, issueState("Issue 4, before", "the old text"));
    rig.tracker.issues.set(2, issueState("Issue 2, before", "the old text"));
    await rig.loop.intake([keyOf(4), keyOf(2), keyOf(3)]);
    rig.tracker.issues.set(4, issueState("Issue 4", "What issue 4 says"));
    rig.tracker.issues.set(2, issueState("Issue 2", "What issue 2 says"));
    await rig.loop.ack(await rig.loop.claim(10));
    // #4 is deleted in the tool after the run's page is read, before its chunk is taken in.
    let started = false;
    const connector = rig.adapter("backfill-1", (inner) => ({
      ...inner,
      read: (keys) => {
        if (started) {
          rig.tracker.issues.delete(4);
        }
        return inner.read(keys);
      },
    }));

    const report = await rig.backfill(connector).run({
      onEstimate: () => {
        started = true;
        return true;
      },
    });

    expect(report.status).toBe("completed");
    expect(report.enqueued).toEqual([keyOf(5), keyOf(3), keyOf(2), keyOf(1)]);
    expect(report.notQueued).toEqual([keyOf(4)]);
    expect(await count("jobs")).toBe(4);
    expect(rig.alerts).toEqual(["finished: 4 queued"]);
    await rig.drain();
    expect(rig.provider.callCount).toBe(4);
  });

  it("leaves the worker's own adapter as it was: a preview reads the store, and an outage's re-queue keeps the stored state", async () => {
    const rig = await rigOf(5, 10);
    await rig.loop.intake(keysFrom(5, 1));
    await rig.drain();
    expect(rig.provider.callCount).toBe(5);

    // A preview (core's newest rows) pages through the worker's adapter: the store's, never the plugin.
    const preview = await rig.loop.scan(null);
    expect(preview.rows.map((row) => row.key)).toEqual(keysFrom(5, 1));
    expect(rig.tracker.scans).toEqual([]);

    // Later #3 is edited and the change stored; the model is down, so the worker holds #3 and
    // queues it again through the same adapter.
    rig.tracker.issues.set(3, issueState("Issue 3, edited", "the newer text"));
    await rig.loop.intake([keyOf(3)]);
    await rig.loop.ack(await rig.loop.claim(10));
    await rig.loop.enqueue([keyOf(3)]);

    expect((await rig.loop.read([keyOf(3)])).rows[0]?.state).toEqual(
      issueState("Issue 3, edited", "the newer text"),
    );
    await rig.drain();
    expect(rig.provider.requests.at(-1)?.state).toEqual(
      issueState("Issue 3, edited", "the newer text"),
    );
    expect(rig.tracker.scans).toEqual([]);
  });
});

/** A tool keyed by any text, newest first by when each key first appeared: what the contract seeds. */
class KeyedTool {
  readonly items = new Map<RecordKey, { readonly seq: number; readonly state: Issue }>();
  #seq = 1;

  edit(key: RecordKey, state: Issue): void {
    this.items.set(key, { seq: this.items.get(key)?.seq ?? this.#seq++, state });
  }
}

function keyedSource(tool: KeyedTool): SourceDefinition<unknown> {
  return source<unknown>({
    // Changes reach the adapter through `intake` (the contract's edit): watch waits for the stop.
    watch: async function* (ctx) {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    read: async (_ctx, keys) =>
      keys.flatMap((key) => {
        const item = tool.items.get(key);
        return item === undefined ? [] : [{ key, state: item.state }];
      }),
    scan: async function* (_ctx, cursor) {
      let below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
      for (;;) {
        const newest = [...tool.items.entries()]
          .filter(([, item]) => item.seq < below)
          .sort(([, a], [, b]) => b.seq - a.seq);
        const page = newest.slice(0, 10);
        const last = page.at(-1);
        const next = newest.length > page.length && last !== undefined ? String(last[1].seq) : null;
        yield { rows: page.map(([key, item]) => ({ key, state: item.state })), next };
        if (next === null) {
          return;
        }
        below = Number(next);
      }
    },
  }) as SourceDefinition<unknown>;
}

describe("a backfill's own adapter passes the connector contract over a PGlite store (plugin-backfill)", () => {
  runConnectorContract(async () => {
    const clock = new FakeClock(START);
    const store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
    opened.push(store);
    const tool = new KeyedTool();
    const fields = ["title", "body"];
    const hosted: HostedSource = {
      packageName: "@facetdb/tracker",
      entry: "issues",
      definition: keyedSource(tool),
      settings: {},
      actions: [],
      variables: [],
    };
    const adapterFor = (workerId: string) => {
      const made = createPluginBackfillConnector({
        store: store.connector({ sourceId: ID, fields, workerId }),
        name: "issues",
        hosted,
        context: (signal) => ({ config: {}, secrets: {}, signal }),
        fields,
        clock,
        cursors: store.cursors,
        cursorRun: `plugin-source:${ID}`,
        note: () => undefined,
      });
      opened.push(made);
      return made;
    };
    const connector = adapterFor("worker-1");
    const records = store.connector({ sourceId: ID, fields, workerId: "reader" });
    return {
      connector,
      peer: adapterFor("worker-2"),
      fields,
      edit: async (key, written) => {
        tool.edit(key, written);
        await connector.intake([key]);
      },
      // A plugin source keeps its decisions in the store, with no answer columns.
      probabilities: "no-column",
      decisionOf: async (key) => (await records.getRecord(key))?.decision ?? null,
      clock,
    };
  });
});
