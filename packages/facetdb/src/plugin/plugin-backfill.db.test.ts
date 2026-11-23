import {
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
import { FakeClock, freshHeldModel } from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import {
  connectPostgres,
  createStore,
  type SqlClient,
  type Store,
  sourceIdOf,
} from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPluginBackfillConnector,
  createPluginSourceConnector,
  type HostedSource,
  type PluginSourceConnector,
  source,
} from "./index.ts";

/**
 * A plugin source's backfill on a real Postgres, for what PGlite's one connection cannot show: the
 * backfill takes each record into the store and queues it on connections of its own, as `facetdb
 * backfill` in another process or the worker's job does, while the source's loop claims, answers
 * and acks on its own; every record is answered once, at the state the plugin's scan read.
 */

const START = 1_700_000_000_000;
const PROJECT = "tracker-app";
const ID = sourceIdOf(PROJECT, "issues");
const FIELDS = ["title", "body"];
const SECRET = "a-long-random-secret-for-tests-only";

type Issue = Readonly<Record<string, StateValue>>;

const issues = new Map<number, Issue>();
for (let n = 1; n <= 45; n += 1) {
  issues.set(n, { title: `Issue ${n}`, body: `What issue ${n} says` });
}

/** The tracker's issues, ten a page, newest first. */
const hosted: HostedSource = {
  packageName: "@facetdb/tracker",
  entry: "issues",
  definition: source<unknown>({
    watch: async function* () {},
    read: async () => [],
    scan: async function* (_ctx, cursor) {
      let below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
      for (;;) {
        const numbers = [...issues.keys()].filter((n) => n < below).sort((a, b) => b - a);
        const page = numbers.slice(0, 10);
        const last = page.at(-1);
        const next = numbers.length > page.length && last !== undefined ? String(last) : null;
        yield {
          rows: page.map((n) => ({ key: `acme/web#${n}`, state: issues.get(n) ?? {} })),
          next,
        };
        if (next === null) {
          return;
        }
        below = Number(next);
      }
    },
  }) as HostedSource["definition"],
  settings: {},
  actions: [],
  variables: ["TRACKER_TOKEN"],
};

const SET: QuestionSet = {
  questions: [
    {
      type: "noul",
      name: "not_priority",
      instructions: "Would the maintainers treat this as low priority?",
      stakes: "low",
    },
  ],
  read: FIELDS,
  model: "jev-1.14.0",
  thresholds: {},
};

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

let scratch: ScratchDatabase;
let admin: SqlClient;
const stores: Store[] = [];
const adapters: PluginSourceConnector[] = [];

/** A store on connections of its own: two of them are two processes as far as Postgres can tell. */
async function newStore(clock: FakeClock): Promise<Store> {
  // The scratch database is on the test machine's server, reached without TLS.
  const store = await createStore({
    url: scratch.url,
    pgHost: undefined,
    secret: SECRET,
    clock,
    allowInsecure: true,
  });
  stores.push(store);
  return store;
}

/** The backfill's own adapter, or the loop's (the worker's, which pages and queues through the store). */
function adapterOf(
  store: Store,
  clock: FakeClock,
  workerId: string,
  kind: "backfill" | "loop",
): PluginSourceConnector {
  const make = kind === "backfill" ? createPluginBackfillConnector : createPluginSourceConnector;
  const made = make({
    store: store.connector({ sourceId: ID, fields: FIELDS, workerId }),
    name: "issues",
    hosted,
    context: (signal) => ({ config: {}, secrets: {}, signal }),
    fields: FIELDS,
    clock,
    cursors: store.cursors,
    cursorRun: `plugin-source:${ID}`,
    note: () => undefined,
  });
  adapters.push(made);
  return made;
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
});

afterAll(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.close();
  }
  for (const store of stores.splice(0)) {
    await store.close();
  }
  await admin.close();
  await scratch.drop();
});

describe("a plugin source's backfill beside its loop on a real Postgres (plugin-backfill)", () => {
  it("takes every record in on its own connections while the loop answers each once on its own", async () => {
    const clock = new FakeClock(START);
    const job = await newStore(clock);
    const loopStore = await newStore(clock);
    await job.ensureProject({ id: PROJECT, name: PROJECT });
    await job.ensureSource({ projectId: PROJECT, name: "issues", kind: "plugin-source" });
    const { version } = await job.questionSets.record(ID, SET);
    const provider = createFakeProvider({ defaults: { noul: 0.93 } });

    const backfill = createBackfill({
      project: PROJECT,
      source: "issues",
      connector: adapterOf(job, clock, "backfill-1", "backfill"),
      worker: provider,
      clock,
      cursorStore: job.cursors,
      log: job.log(ID),
      questionSet: SET,
      version,
      heldModel: freshHeldModel(version),
      spending: UNLIMITED,
      reviews: reviewsOf(job.reviews, ID),
    });
    const loop = createWorker({
      connector: adapterOf(loopStore, clock, "worker-1", "loop"),
      provider,
      log: loopStore.log(ID),
      reviews: reviewsOf(loopStore.reviews, ID),
      actions: [],
      clock,
      limits: { ...DEFAULT_WORKER_LIMITS, claimBatch: 5 },
      questionSet: SET,
      version,
      heldModel: freshHeldModel(version),
      spending: UNLIMITED,
    });

    // `as boolean`: set in the run's `finally`, a flow TypeScript does not follow.
    let finished = false as boolean;
    const answered: RecordKey[] = [];
    const running = backfill.run({ onEstimate: () => true, pace: 10 }).finally(() => {
      finished = true;
    });
    // The loop claims while the backfill still takes records in, until both are done.
    for (;;) {
      const pass = await loop.runOnce();
      expect(pass.failures).toEqual([]);
      answered.push(...pass.written);
      if (finished && pass.claimed === 0) {
        break;
      }
    }
    const report = await running;

    expect(report.status).toBe("completed");
    expect(report.enqueued).toHaveLength(45);
    expect([...answered].sort()).toEqual([...report.enqueued].sort());
    expect(provider.callCount).toBe(45);
    const rows = await admin.query(
      "select count(*)::int as n from facetdb.records where source_id = $1 and status = 'done'",
      [ID],
    );
    expect(rows[0]?.["n"]).toBe(45);
    expect(await admin.query("select record_key from facetdb.jobs")).toEqual([]);
    expect(await job.cursors.load(backfillRun(PROJECT, "issues", version, undefined))).toEqual({
      cursor: null,
      done: true,
    });
  });
});
