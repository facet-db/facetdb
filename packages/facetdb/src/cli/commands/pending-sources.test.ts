import type { Clock, Worker } from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { createFleet, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";

/**
 * Which sources do not run facetdb.config.ts as last loaded, asked of the fleet at any time: the
 * reload's `kept` and `not-started` outcomes, with the questions the loop lacks. Loops here never
 * run; the fleet only needs to hold them, as a worker does between passes.
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";

const NEVER_SLEEPS: Pick<Clock, "sleep"> = { sleep: () => new Promise<void>(() => undefined) };

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

const [LISTINGS, ORDERS] = PROJECT.sources as [SourceConfig, SourceConfig];

const NOT_RUNNING: Worker = {
  runOnce: () => Promise.reject(new Error("these tests run no loop")),
  run: () => Promise.reject(new Error("these tests run no loop")),
  onHumanDecision: () => Promise.reject(new Error("these tests decide nothing")),
};

function rig() {
  const state: { file: ProjectConfig } = { file: PROJECT };
  const fleet = createFleet({
    open: (source, config) => {
      const questionSet = questionSetOf(config, source);
      const database = new FakeDatabase({ fields: source.read, clock: new FakeClock(0) });
      const loop: SourceLoop = {
        source,
        questionSet,
        version: 1,
        worker: NOT_RUNNING,
        connector: new FakeConnector(database),
        keyText: undefined,
        close: () => Promise.resolve(),
      };
      return Promise.resolve(loop);
    },
    load: () => Promise.resolve(state.file),
    beat: () => Promise.resolve(),
    clock: NEVER_SLEEPS,
    print: () => undefined,
    onPass: () => () => undefined,
  });
  return { fleet, state };
}

/** The project with one more question on a source, as an applied Add question writes it. */
function withQuestion(config: ProjectConfig, source: string, name: string): ProjectConfig {
  return {
    ...config,
    sources: config.sources.map((candidate) =>
      candidate.name === source
        ? {
            ...candidate,
            questions: [...candidate.questions, { ...noul("Is it a vehicle?"), name }],
          }
        : candidate,
    ),
  };
}

describe("the sources that do not run the file as last loaded", () => {
  it("is empty while every loop runs the file", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);

    expect(t.fleet.pending()).toEqual([]);
    await t.fleet.reload();
    expect(t.fleet.pending()).toEqual([]);
  });

  it("names a question added and applied, and the version the source still answers with", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = withQuestion(PROJECT, "listings", "is_vehicle");

    const summary = await t.fleet.reload();
    await t.fleet.settled();

    expect(t.fleet.pending()).toEqual([
      {
        source: "listings",
        outcome: "kept",
        message:
          "the change reaches what facetdb migrate installed (a question added or removed, a type, options or levels, read, where, the table, storage or capture), so it keeps answering with version 1 until you run facetdb migrate and restart facetdb worker.",
        migrate: true,
        added: ["is_vehicle"],
        removed: [],
      },
    ]);
    // The list says what the reload said, word for word.
    const reloaded = summary.loaded ? summary.sources.find((s) => s.source === "listings") : null;
    expect(t.fleet.pending()[0]?.message).toBe(reloaded?.message);
  });

  it("names a question removed from the file that the loop still runs", async () => {
    const t = rig();
    await t.fleet.open(withQuestion(PROJECT, "listings", "is_vehicle"));
    t.state.file = PROJECT;

    await t.fleet.reload();

    expect(
      t.fleet.pending().map(({ source, added, removed }) => ({ source, added, removed })),
    ).toEqual([{ source: "listings", added: [], removed: ["is_vehicle"] }]);
  });

  it("is asked afresh: it is there without a reload in hand, and goes with the question's change back", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = withQuestion(PROJECT, "listings", "is_vehicle");
    await t.fleet.reload();

    t.state.file = PROJECT;
    await t.fleet.reload();

    expect(t.fleet.pending()).toEqual([]);
  });

  it("does not name a reworded question: the loop restarts on it", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = {
      ...PROJECT,
      sources: [
        {
          ...LISTINGS,
          questions: LISTINGS.questions.map((question) => ({
            ...question,
            instructions: "Does this listing look like a scam to a buyer?",
          })),
        },
        ORDERS,
      ],
    };

    await t.fleet.reload();
    await t.fleet.settled();

    expect(t.fleet.pending()).toEqual([]);
  });

  it("names a new source as not started, with no question the loop lacks", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = {
      ...PROJECT,
      sources: [LISTINGS, ORDERS, { ...ORDERS, name: "refunds", table: "refunds" }],
    };

    await t.fleet.reload();

    expect(t.fleet.pending()).toEqual([
      {
        source: "refunds",
        outcome: "not-started",
        message:
          "new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.",
        migrate: true,
        added: [],
        removed: [],
      },
    ]);
  });

  it("is empty once the worker runs the file: a restart opens every loop on it", async () => {
    const t = rig();
    await t.fleet.open(PROJECT);
    t.state.file = withQuestion(PROJECT, "listings", "is_vehicle");
    await t.fleet.reload();
    expect(t.fleet.pending()).toHaveLength(1);

    const restarted = rig();
    await restarted.fleet.open(t.state.file);

    expect(restarted.fleet.pending()).toEqual([]);
  });
});
