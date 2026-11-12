import {
  type AnswerEntry,
  type BackfillDeps,
  type BackfillProgress,
  type Connector,
  type CursorStore,
  type QuestionSet,
  type RecordKey,
  stateHash,
} from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase, FakeDecisionLog } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider, type FakeScript } from "@facetdb/model";
import { beforeEach, describe, expect, it } from "vitest";
import {
  choice,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
} from "../../config/index.ts";
import { wireBackfillDryRun } from "../backfill-wiring.ts";
import { runInProcess } from "../program.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb backfill` through the in-process runner. The engine is core's; these tests prove the
 * command around it: the estimate comes before anything is asked, a decline or a dry run asks
 * nothing, a run goes newest first, and a stopped run resumes from the saved place. Fakes are
 * handwritten and passed through `CliDeps.backfill`, the same door the composition root fills.
 */

const KEYS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:pw@localhost:5432/app",
      table: "listings",
      read: ["id", "title"],
      questions: {
        is_scam: noul("Is this listing a scam?"),
        category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
      },
    },
  ],
});
const firstSource = config.sources[0];
if (firstSource === undefined) {
  throw new Error("the fixture config has a source");
}
const source: SourceConfig = firstSource;
const questionSet: QuestionSet = questionSetOf(config, source);

/** Counts enqueues in order, so a test can assert newest first and that a decline queued nothing. */
class RecordingConnector extends FakeConnector {
  readonly queued: RecordKey[] = [];
  override async enqueue(keys: readonly RecordKey[]): Promise<void> {
    this.queued.push(...keys);
    await super.enqueue(keys);
  }
}

class Memory implements CursorStore {
  readonly saved = new Map<string, BackfillProgress>();
  saves = 0;
  load(run: string) {
    return Promise.resolve(this.saved.get(run));
  }
  save(run: string, progress: BackfillProgress) {
    this.saves += 1;
    this.saved.set(run, progress);
    return Promise.resolve();
  }
}

type World = {
  readonly db: FakeDatabase;
  readonly connector: RecordingConnector;
  readonly log: FakeDecisionLog;
  readonly cursors: Memory;
  readonly clock: FakeClock;
  closes: number;
  /** The mode the command asked the composition root for, per call. */
  readonly modes: { readonly dryRun: boolean; readonly allowInsecure?: boolean }[];
};

let world: World;

beforeEach(async () => {
  const db = new FakeDatabase({ fields: ["id", "title"], pageSize: 2 });
  const connector = new RecordingConnector(db);
  await connector.install();
  for (const key of KEYS) {
    db.edit(key, { id: key, title: `Listing ${key}` });
  }
  // The rows existed before FacetDB was installed: the trigger queued none of them.
  db.jobs.clear();
  world = {
    db,
    connector,
    log: new FakeDecisionLog(),
    cursors: new Memory(),
    clock: new FakeClock(1_000),
    closes: 0,
    modes: [],
  };
});

/** What a prior whole-set run left: every record answered for `is_scam` only, at the current state. */
async function seedFirstQuestion(): Promise<void> {
  for (const key of KEYS) {
    const state = { id: key, title: `Listing ${key}` };
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 1,
      model: questionSet.model,
      stateHash: stateHash(questionSet.read, state),
      answers: { is_scam: { type: "noul", probability: 0.02 } },
      usage: { inputTokens: 10, outputTokens: 0 },
      at: new Date(0),
    };
    await world.log.appendAnswer(entry);
  }
}

function depsFor(provider: FakeProvider, connector: Connector = world.connector): BackfillDeps {
  return {
    connector,
    worker: provider,
    clock: world.clock,
    cursorStore: world.cursors,
    log: world.log,
    questionSet,
    version: 1,
    spending: {
      allowsWork: () => Promise.resolve(true),
      admit: () => Promise.resolve("reservation"),
      settle: () => Promise.resolve(),
      record: () => Promise.resolve(),
    },
  };
}

function run(
  argv: readonly string[],
  provider: FakeProvider,
  answers: readonly string[] = [],
  setup: { readonly config?: ProjectConfig; readonly env?: Record<string, string> } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: "/work/listings-app",
      env: setup.env ?? {},
      loadConfig: () => Promise.resolve(setup.config ?? config),
      connect: () => {
        throw new Error("backfill reaches the database only through its connector");
      },
      // The same split the composition root makes: a dry run is wired without any store
      // (`world.log` and `world.cursors` stand for the store and are not handed to it).
      backfill: (_config, _source, mode) => {
        world.modes.push(mode);
        return Promise.resolve({
          deps: mode.dryRun
            ? wireBackfillDryRun({
                config,
                source,
                connector: world.connector,
                clock: world.clock,
              })
            : depsFor(provider),
          close: () => {
            world.closes += 1;
            return Promise.resolve();
          },
        });
      },
      answers,
    },
    COMMANDS,
  );
}

const SCRIPT: FakeScript = { defaults: { choice: 0 } };

describe("facetdb backfill", () => {
  it("--dry-run prints the estimate and makes no provider call, no queue entry and no prompt", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["backfill", "--dry-run"], provider);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("6 records to answer");
    expect(result.stdout).toMatch(/input tokens, (about \$|less than \$)/);
    expect(result.stdout).toContain("Dry run: nothing was asked and nothing was changed.");
    expect(result.prompts).toEqual([]);
    expect(provider.callCount).toBe(0);
    expect(world.connector.queued).toEqual([]);
    expect(world.cursors.saves).toBe(0);
    expect(world.closes).toBe(1);
  });

  it("says the pace is a ceiling, with the seconds it takes on a database close to the worker", async () => {
    const atDefault = await run(["backfill", "--dry-run"], createFakeProvider(SCRIPT));
    // 6 records at 50 a second: under a second, rounded up. Each queue call is a round trip, so a
    // far database goes slower than the pace (seen on Supabase).
    expect(atDefault.stdout).toContain(
      "Pace: at most 50 records per second, so about 1 second on a database close to the worker.",
    );

    const slower = await run(["backfill", "--dry-run", "--pace", "2"], createFakeProvider(SCRIPT));
    expect(slower.stdout).toContain(
      "Pace: at most 2 records per second, so about 3 seconds on a database close to the worker.",
    );
    expect(slower.stdout).not.toContain("roughly");
  });

  it("--dry-run asks for a setup without the store; a real run asks for the full one", async () => {
    const dry = await run(["backfill", "--dry-run"], createFakeProvider(SCRIPT));
    expect(dry.code).toBe(0);
    // The estimate came from the source alone, and says what it could not see.
    expect(dry.stdout).toContain("6 records to answer");
    expect(dry.stdout).toContain("does not open FacetDB's store");
    expect(world.modes).toEqual([{ dryRun: true }]);

    await run(["backfill", "--yes"], createFakeProvider(SCRIPT));
    expect(world.modes).toEqual([{ dryRun: true }, { dryRun: false }]);
  });

  it("--allow-insecure reaches the composition root, and is absent without it", async () => {
    await run(["backfill", "--yes", "--allow-insecure"], createFakeProvider(SCRIPT));
    expect(world.modes).toEqual([{ dryRun: false, allowInsecure: true }]);
  });

  describe("refuses the worker's password in the clear to another machine", () => {
    const REMOTE_PLAIN = "postgres://facetdb_worker:s3cret-worker-password@db.example.com/x";

    /** What the loader makes of `database: process.env.LISTINGS_URL`: the value read, and the variable. */
    function ownUrl(url: string): ProjectConfig {
      return {
        ...config,
        sources: config.sources.map(({ database: _database, ...own }) => ({
          ...own,
          database: url,
          databaseEnv: "LISTINGS_URL",
        })),
      };
    }

    it.each([
      ["a dry run", ["backfill", "--dry-run"]],
      ["a real run", ["backfill", "--yes"]],
    ])(
      "%s with a plaintext remote source URL is refused before anything is set up",
      async (_name, argv) => {
        const result = await run(argv, createFakeProvider(SCRIPT), [], {
          config: ownUrl(REMOTE_PLAIN),
          env: { DATABASE_URL: `${REMOTE_PLAIN}?sslmode=require` },
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          "error: LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
        );
        expect(result.stderr).toContain(
          "fix: add ?sslmode=require to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
        );
        expect(result.stderr).not.toContain("s3cret-worker-password");
        expect(world.modes).toEqual([]);
      },
    );

    it("a real run is refused for a plaintext remote DATABASE_URL, a dry run (no store) is not", async () => {
      const env = { DATABASE_URL: REMOTE_PLAIN };
      const real = await run(["backfill", "--yes"], createFakeProvider(SCRIPT), [], { env });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("error: DATABASE_URL reaches db.example.com without TLS");
      expect(world.modes).toEqual([]);
      const dry = await run(["backfill", "--dry-run"], createFakeProvider(SCRIPT), [], { env });
      expect(dry.code, dry.stderr).toBe(0);
    });

    it("--allow-insecure lets a trusted network through", async () => {
      const result = await run(
        ["backfill", "--dry-run", "--allow-insecure"],
        createFakeProvider(SCRIPT),
        [],
        {
          config: ownUrl(REMOTE_PLAIN),
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(world.modes).toEqual([{ dryRun: true, allowInsecure: true }]);
    });
  });

  it("the dry-run wiring reads the source and refuses every write and every model call", async () => {
    const deps = wireBackfillDryRun({
      config,
      source,
      connector: world.connector,
      clock: world.clock,
    });

    expect(await deps.cursorStore.load("all@v1")).toBeUndefined();
    expect(await deps.log.latestAnswer("r1")).toBeUndefined();
    expect(() => deps.cursorStore.save("all@v1", { cursor: null, done: true })).toThrow(
      "a dry run never",
    );
    expect(() => deps.worker.ask({} as never)).toThrow("a dry run never");
    expect(() => deps.spending.admit(1)).toThrow("a dry run never");
    expect(() => deps.log.appendAnswer({} as never)).toThrow("a dry run never");
  });

  it("a declined prompt asks nothing, queues nothing and leaves the cursor alone", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["backfill"], provider, ["no"]);

    expect(result.code).toBe(0);
    expect(result.prompts).toHaveLength(1);
    // The estimate was on the screen before the question.
    expect(result.stdout).toContain("6 records to answer");
    expect(result.stdout).toContain("Nothing was asked and nothing was changed.");
    expect(provider.callCount).toBe(0);
    expect(world.connector.queued).toEqual([]);
    expect(world.cursors.saves).toBe(0);
  });

  it("a whole-set run queues every record for the worker, newest first, and shows the resume point", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["backfill"], provider, ["yes"]);

    expect(result.code).toBe(0);
    expect(world.connector.queued).toEqual(["r6", "r5", "r4", "r3", "r2", "r1"]);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain("Resume point saved:");
    expect(result.stdout).toContain("6 records done. That was the last page.");
    expect(result.stdout).toContain("6 records queued for the worker");
    expect(world.cursors.saved.get("all@v1")?.done).toBe(true);
  });

  it("--yes starts without a prompt", async () => {
    const result = await run(["backfill", "--yes"], createFakeProvider(SCRIPT));

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(world.connector.queued).toHaveLength(6);
  });

  it("--question asks only that question, newest first, and --pace spaces the records", async () => {
    await seedFirstQuestion();
    const provider = createFakeProvider(SCRIPT);

    const result = await run(
      ["backfill", "--yes", "--question", "category", "--pace", "10"],
      provider,
    );

    expect(result.code).toBe(0);
    expect(provider.requests.map((request) => request.state["id"])).toEqual([
      "r6",
      "r5",
      "r4",
      "r3",
      "r2",
      "r1",
    ]);
    for (const request of provider.requests) {
      expect(request.questions.map((question) => question.name)).toEqual(["category"]);
    }
    // 10 records a second: each record starts 100 ms after the last.
    expect(world.clock.sleeps.filter((ms) => ms > 0)).toContain(100);
    expect(result.stdout).toContain("6 records answered");
    for (const key of KEYS) {
      expect(world.db.decisionOf(key)?.status).toBe("done");
    }
  });

  it("a run that stops resumes from the saved place, and does not ask the answered records again", async () => {
    await seedFirstQuestion();
    // Page 1 (r6, r5) is calls 0 and 1; call 2 is the first of page 2 (r4, r3).
    const first = createFakeProvider({ ...SCRIPT, failures: { 2: { kind: "503" } } });

    const stopped = await run(["backfill", "--yes", "--question", "category"], first);

    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("the backfill stopped at the page it was on");
    expect(stopped.stderr).toContain("run facetdb backfill again");
    expect(stopped.stdout).toContain("Resume point saved:");
    const saved = world.cursors.saved.get("only@v1:category");
    expect(saved?.done).toBe(false);
    expect(saved?.cursor).not.toBeNull();

    const second = createFakeProvider(SCRIPT);
    const resumed = await run(["backfill", "--yes", "--question", "category"], second);

    expect(resumed.code).toBe(0);
    const asked = second.requests.map((request) => request.state["id"]);
    // Page 1 is not visited again; page 2 asks only the record that failed, then pages 3.
    expect(asked).not.toContain("r6");
    expect(asked).not.toContain("r5");
    expect(asked).toEqual(expect.arrayContaining(["r2", "r1"]));
    expect(asked.filter((key) => key === "r4" || key === "r3")).toHaveLength(1);
    expect(world.cursors.saved.get("only@v1:category")?.done).toBe(true);
    for (const key of KEYS) {
      expect(world.db.decisionOf(key)?.status).toBe("done");
    }
  });

  it("names the questions it has when --question is wrong, as a bad invocation", async () => {
    const provider = createFakeProvider(SCRIPT);

    const result = await run(["backfill", "--yes", "--question", "colour"], provider);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no question named "colour"');
    expect(result.stderr).toContain("is_scam, category");
    expect(provider.callCount).toBe(0);
  });

  it("refuses a pace that is not above zero, as a bad invocation", async () => {
    const result = await run(["backfill", "--pace", "0"], createFakeProvider(SCRIPT));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--pace");
  });
});
