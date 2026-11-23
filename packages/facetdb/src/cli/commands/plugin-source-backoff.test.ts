import {
  createWorker,
  DEFAULT_WORKER_LIMITS,
  reviewsOf,
  type SpendingGate,
  type StateValue,
} from "@facetdb/core";
import {
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  freshHeldModel,
} from "@facetdb/core/testing";
import { createFakeProvider } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, sourceCall } from "../../config/index.ts";
import {
  createPluginSourceConnector,
  type HostedSource,
  type RecordStore,
  SourceAccessLost,
  source,
} from "../../plugin/index.ts";
import { SteppedClock } from "../testing.ts";
import { createFleet, RETRY_FIRST_MS, RETRY_MAX_MS, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * A plugin source's backoff after a failure: the store answers a plugin source's pass whatever its
 * plugin does, so a pass never starts the wait over. A plugin whose `watch` keeps throwing
 * `SourceAccessLost` is tried after 30 seconds, then 1, 2, 4 and 8 minutes, then every 10; once a
 * read through the plugin answers again, the next failure waits 30 seconds again. The fleet and the
 * adapter are the real ones; the store is core's fake connector.
 */

const START_MS = 1_700_000_000_000;
const POLL_MS = 5_000;

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

const PROJECT: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "issues",
      source: sourceCall("@facetdb/tracker", "issues"),
      read: ["title"],
      questions: { minor: noul("Is this issue minor?") },
    },
  ],
});

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
  const state = { revoked: true, changed: [] as string[], watches: 0 };
  const lines: string[] = [];
  const definition = source({
    watch: async function* (ctx) {
      state.watches += 1;
      let seen = 0;
      for (;;) {
        if (state.revoked) {
          throw new SourceAccessLost("token revoked");
        }
        if (state.changed.length > seen) {
          const batch = state.changed.slice(seen);
          seen = state.changed.length;
          yield batch;
        }
        await ctx.clock.sleep(POLL_MS);
        if (ctx.signal.aborted) {
          return;
        }
      }
    },
    read: async (_ctx, keys) => keys.map((key) => ({ key, state: { title: `issue ${key}` } })),
    scan: async function* () {},
  });
  const hosted: HostedSource = {
    packageName: "@facetdb/tracker",
    entry: "issues",
    definition: definition as never,
    settings: {},
    actions: [],
    variables: ["TRACKER_TOKEN"],
  };
  const database = new FakeDatabase({ fields: ["title"], clock });
  database.install();

  const fleet = createFleet({
    open: (opened, config) => {
      const questionSet = questionSetOf(config, opened);
      const records: RecordStore = Object.assign(new FakeConnector(database), {
        upsertRecord: (key: string, written: Readonly<Record<string, StateValue>>) => {
          database.edit(key, written);
          return Promise.resolve(true);
        },
      });
      const connector = createPluginSourceConnector({
        store: records,
        name: opened.name,
        hosted,
        context: (signal) => ({ config: {}, secrets: {}, signal }),
        fields: opened.read,
        clock,
        cursors: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
        cursorRun: "plugin-source:p:issues",
        note: (line) => lines.push(line),
      });
      const heldModel = freshHeldModel();
      const loop: SourceLoop = {
        source: opened,
        questionSet,
        version: 1,
        heldModel,
        worker: createWorker({
          connector,
          provider: createFakeProvider({ defaults: { noul: 0.01 } }),
          log: new FakeDecisionLog(),
          reviews: reviewsOf(new FakeReviewQueue(), opened.name),
          actions: [],
          clock,
          limits: DEFAULT_WORKER_LIMITS,
          questionSet,
          version: 1,
          heldModel,
          spending: UNLIMITED,
        }),
        connector,
        keyText: undefined,
        proven: (heard) => connector.onWorking(heard),
        close: () => connector.close(),
      };
      return Promise.resolve(loop);
    },
    installed: () => Promise.reject(new Error("a plugin source has no install to read")),
    load: () => Promise.resolve(PROJECT),
    beat: () => Promise.resolve(),
    clock,
    print: (line) => lines.push(line),
    onPass: () => () => undefined,
  });

  /** The wait before the stopped source's next try, as the fleet holds it. */
  const wait = () => Date.parse(fleet.stopped()[0]?.retryAt ?? "") - clock.now();
  return { clock, state, lines, fleet, database, wait };
}

describe("a plugin source's backoff (plugin-source)", () => {
  it("@timing doubles up to 10 minutes while its watch keeps failing, and starts over once a read answers", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    const stop = new AbortController();
    const done = t.fleet.run(stop.signal);

    // Each try opens the loop, its store's pass works, and its plugin's watch fails again.
    const waits = [1, 2, 4, 8, 16, 20, 20].map((times) => times * RETRY_FIRST_MS);
    for (const [index, expected] of waits.entries()) {
      await until(() => t.fleet.stopped().length === 1 && t.state.watches === index + 1);
      expect(t.wait()).toBe(expected);
      t.clock.advance(expected);
      await flush();
    }
    expect(waits.at(-1)).toBe(RETRY_MAX_MS);
    await until(() => t.state.watches === waits.length + 1 && t.fleet.stopped().length === 1);
    expect(t.wait()).toBe(RETRY_MAX_MS);
    expect(t.lines.join("\n")).not.toContain("token revoked");

    // The credential restored: the next try's watch takes a key in, and its read answers.
    t.state.revoked = false;
    t.state.changed.push("k1");
    t.clock.advance(RETRY_MAX_MS);
    await until(() => t.fleet.loop("issues") !== undefined && t.database.rows.has("k1"));
    await until(() => t.fleet.stopped().length === 0);

    // Revoked again: the wait starts over at 30 seconds.
    t.state.revoked = true;
    t.clock.advance(POLL_MS);
    await until(() => t.fleet.stopped().length === 1);
    expect(t.wait()).toBe(RETRY_FIRST_MS);

    stop.abort();
    await done;
    await t.fleet.close();
  });
});
