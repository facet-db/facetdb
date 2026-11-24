import {
  type AlertSignals,
  type AnswerEntry,
  type BackfillDeps,
  type BackfillProgress,
  type CursorStore,
  type QuestionSet,
  type RecordKey,
  reviewsOf,
  type SpendingGate,
  stateHash,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeOpenConnector,
  FakeReviewQueue,
  FakeRunLog,
  freshHeldModel,
} from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import type { BackfillJobStatus } from "@facetdb/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  choice,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
} from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import { postgresEngines, type SqlConnect } from "../testing.ts";
import { createBackfillJobs } from "./backfill-jobs.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * What an added-question backfill says of the records it left alone: only a record core found in
 * the queue is "queued for the worker"; every other one (never answered, another question
 * unanswered, or changed since its answer) is skipped, and the closing line names the whole-set
 * backfill that queues it. A changed record is not proof of a queue entry: a field added to `read`
 * changes every hash and queues nothing. Each case checks the words against the queue itself, so a
 * count the line gives is a count of what will happen.
 */

const noDatabase: SqlConnect = () => {
  throw new Error("backfill reaches the database only through its connector");
};

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
        is_vehicle: noul("Is this listing a vehicle?"),
      },
    },
  ],
});
const [firstSource] = config.sources;
if (firstSource === undefined) {
  throw new Error("the fixture config has a source");
}
const source: SourceConfig = firstSource;
const questionSet: QuestionSet = questionSetOf(config, source);
const PROJECT_ID = "listings-app";

const stateOf = (key: RecordKey, title = `Listing ${key}`) => ({ id: key, title });

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("reservation"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

class Memory implements CursorStore {
  readonly #saved = new Map<string, BackfillProgress>();
  load(run: string) {
    return Promise.resolve(this.#saved.get(run));
  }
  save(run: string, progress: BackfillProgress) {
    this.#saved.set(run, progress);
    return Promise.resolve();
  }
}

type World = {
  readonly db: FakeDatabase;
  readonly connector: FakeConnector;
  readonly log: FakeDecisionLog;
  readonly cursors: Memory;
  readonly clock: FakeClock;
};

let world: World;

/** The rows exist before FacetDB is installed, as on a table that had them: none is queued. */
function tableOf(keys: readonly RecordKey[]): World {
  const clock = new FakeClock(1_000);
  const db = new FakeDatabase({ fields: ["id", "title"], pageSize: 3, clock });
  for (const key of keys) {
    db.edit(key, stateOf(key));
  }
  db.install();
  return {
    db,
    connector: new FakeConnector(db),
    log: new FakeDecisionLog(),
    cursors: new Memory(),
    clock,
  };
}

/** What a worker's earlier answer left in the log: `questions` answered for the hash given. */
async function answered(
  key: RecordKey,
  questions: readonly string[],
  hash = stateHash(questionSet.read, stateOf(key)),
): Promise<void> {
  const answers: AnswerEntry["answers"] = Object.fromEntries(
    questions.map((name): [string, AnswerEntry["answers"][string]] => [
      name,
      name === "category"
        ? { type: "choice", top: "car", probabilities: [1, 0] }
        : { type: "noul", probability: 0.02 },
    ]),
  );
  await world.log.appendAnswer({
    kind: "answer",
    key,
    version: 1,
    model: questionSet.model,
    stateHash: hash,
    answers,
    usage: { inputTokens: 10, outputTokens: 0 },
    at: new Date(0),
  });
}

/** Answered for the two first questions, then changed by the application: the trigger queued it. */
async function changed(key: RecordKey): Promise<void> {
  await answered(key, ["is_scam", "category"]);
  world.db.edit(key, stateOf(key, `Listing ${key}, price lowered`));
}

/**
 * Answered for the two first questions when the source read `id` alone; `title` was added to `read`
 * since, which changes the record's hash with no write to the row: nothing queued it.
 */
async function readChanged(key: RecordKey): Promise<void> {
  await answered(key, ["is_scam", "category"], stateHash(["id"], { id: key }));
}

/** Answered for the two first questions at its state, then saved unchanged: in the queue. */
async function waiting(key: RecordKey): Promise<void> {
  await answered(key, ["is_scam", "category"]);
  world.db.edit(key, stateOf(key));
}

function depsFor(provider: FakeProvider): BackfillDeps {
  return {
    project: PROJECT_ID,
    source: source.name,
    connector: world.connector,
    worker: provider,
    clock: world.clock,
    cursorStore: world.cursors,
    log: world.log,
    reviews: reviewsOf(new FakeReviewQueue(), source.name),
    questionSet,
    version: 1,
    heldModel: freshHeldModel(),
    spending: UNLIMITED,
  };
}

function backfill(
  argv: readonly string[],
  provider = createFakeProvider({ defaults: { noul: 0.1 } }),
) {
  return runInProcess(
    ["backfill", "--yes", ...argv],
    {
      projectDir: "/work/listings-app",
      env: {},
      loadConfig: () => Promise.resolve(config),
      engines: postgresEngines(noDatabase),
      connect: noDatabase,
      backfill: () => Promise.resolve({ deps: depsFor(provider), close: () => Promise.resolve() }),
      answers: [],
    },
    COMMANDS,
  );
}

const queued = (keys: readonly RecordKey[]) => keys.filter((key) => world.db.jobs.has(key));

describe("facetdb backfill --question: what it leaves, and to whom", () => {
  beforeEach(() => {
    world = tableOf(["r1", "r2", "r3", "r4"]);
  });

  it("rows never answered: skipped, with the whole-set command that queues them", async () => {
    const provider = createFakeProvider({ defaults: { noul: 0.1 } });

    const result = await backfill(["--question", "is_vehicle"], provider);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Done: nothing answered. 4 skipped (changed or never fully answered): run facetdb backfill --source listings to queue them with every question.\n",
    );
    expect(result.stdout).not.toContain("for the worker");
    // True as said: nothing was asked, and no worker would take them, since none is queued.
    expect(provider.callCount).toBe(0);
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual([]);

    // The command it names queues every one of them for the worker.
    const whole = await backfill(["--source", "listings"]);
    expect(whole.code, whole.stderr).toBe(0);
    expect(whole.stdout).toContain(
      "Done: 4 records queued for the worker. Run facetdb worker to answer the queue.\n",
    );
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("records whose hash a field added to read changed, with no row written: skipped, never the worker's", async () => {
    await readChanged("r1");
    await readChanged("r2");
    await readChanged("r3");
    await readChanged("r4");

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Done: nothing answered. 4 skipped (changed or never fully answered): run facetdb backfill --source listings to queue them with every question.\n",
    );
    expect(result.stdout).not.toContain("for the worker");
    // No worker would ever take them: nothing queued them.
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual([]);

    // The command it names queues them.
    const whole = await backfill(["--source", "listings"]);
    expect(whole.stdout).toContain(
      "Done: 4 records queued for the worker. Run facetdb worker to answer the queue.\n",
    );
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("one record with another question unanswered: said in the singular", async () => {
    world = tableOf(["r1"]);
    await answered("r1", ["is_scam"]);

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.stdout).toContain(
      "Done: nothing answered. 1 skipped (changed or never fully answered): run facetdb backfill --source listings to queue it with every question.\n",
    );
    expect(queued(["r1"])).toEqual([]);
  });

  it("records answered at their state and waiting in the queue are queued for the worker, and no command is named", async () => {
    await waiting("r1");
    await waiting("r2");
    await answered("r3", ["is_scam", "category"]);
    await answered("r4", ["is_scam", "category", "is_vehicle"]);

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Done: 1 answered, 1 already answered, 2 queued for the worker.\n",
    );
    expect(result.stdout).not.toContain("skipped");
    // Each one counted as the worker's is in its queue.
    expect(queued(["r1", "r2"])).toEqual(["r1", "r2"]);
  });

  it("a record changed by the application is skipped, though its trigger queued it: core says stale, not queued", async () => {
    await changed("r1");
    await answered("r2", ["is_scam", "category"]);
    await answered("r3", ["is_scam", "category"]);
    await answered("r4", ["is_scam", "category"]);

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.stdout).toContain(
      "Done: 3 answered. 1 skipped (changed or never fully answered): run facetdb backfill --source listings to queue it with every question.\n",
    );
    expect(queued(["r1"])).toEqual(["r1"]);
  });

  it("a mix says each part, each record counted once", async () => {
    world = tableOf(["n1", "p1", "c1", "s1", "q1", "q2", "a1", "d1"]);
    // n1 never answered, p1 lacks category, c1 changed, s1's read changed: skipped.
    await answered("p1", ["is_scam"]);
    await changed("c1");
    await readChanged("s1");
    // q1 and q2 are answered at their state and in the queue: the worker's.
    await waiting("q1");
    await waiting("q2");
    // a1 is asked; d1 has every answer already.
    await answered("a1", ["is_scam", "category"]);
    await answered("d1", ["is_scam", "category", "is_vehicle"]);

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Done: 1 answered, 1 already answered, 2 queued for the worker. 4 skipped (changed or never fully answered): run facetdb backfill --source listings to queue them with every question.\n",
    );
    expect(queued(["q1", "q2"])).toEqual(["q1", "q2"]);
    expect(queued(["n1", "p1", "s1"])).toEqual([]);
  });

  it("nothing left over: neither part is said", async () => {
    await answered("r1", ["is_scam", "category"]);
    await answered("r2", ["is_scam", "category"]);
    await answered("r3", ["is_scam", "category"]);
    await answered("r4", ["is_scam", "category", "is_vehicle"]);

    const result = await backfill(["--question", "is_vehicle"]);

    expect(result.stdout).toContain("Done: 3 answered, 1 already answered.\n");
    expect(result.stdout).not.toContain("for the worker");
    expect(result.stdout).not.toContain("skipped");
  });
});

describe("the studio's backfill job of an added question", () => {
  const QUIET: AlertSignals = {
    modelCall: () => Promise.resolve(),
    modelChecked: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    backfillFinished: () => Promise.resolve(),
    backfillFailed: () => Promise.resolve(),
  };

  async function finishedJob(): Promise<{ status: BackfillJobStatus; lines: string[] }> {
    const loop = {
      source,
      questionSet,
      version: 1,
      heldModel: freshHeldModel(),
    };
    const lines: string[] = [];
    const jobs = createBackfillJobs({
      projectId: PROJECT_ID,
      loop: (name) => (name === source.name ? loop : undefined),
      open: () => Promise.resolve(new FakeOpenConnector(world.db)),
      newWorkerId: () => "backfill-1",
      queue: (name) => (name === source.name ? new FakeConnector(world.db) : undefined),
      provider: createFakeProvider({ defaults: { noul: 0.1 } }),
      spending: UNLIMITED,
      clock: world.clock,
      cursors: world.cursors,
      log: () => world.log,
      runs: (name) => ({ log: new FakeRunLog(), source: `${PROJECT_ID}:${name}` }),
      reviews: (name) => reviewsOf(new FakeReviewQueue(), `${PROJECT_ID}:${name}`),
      alerts: () => QUIET,
      expireAfter: () => new AbortController().signal,
      newToken: () => "token-1",
      print: (line) => {
        lines.push(line);
      },
    });
    const reaches = async (state: BackfillJobStatus["state"]) => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const outcome = await jobs.status(source.name);
        if (outcome.kind === "status" && outcome.status.state === state) {
          return outcome.status;
        }
        await Promise.resolve();
      }
      throw new Error(`the job never reached ${state}`);
    };
    await jobs.estimate(source.name, ["is_vehicle"]);
    await reaches("waiting");
    await jobs.start(source.name, "token-1");
    const status = await reaches("finished");
    await jobs.close();
    return { status, lines };
  }

  it("rows never answered: skipped, sent to the Sources page's control, never to a terminal", async () => {
    world = tableOf(["n1", "n2"]);

    const { status, lines } = await finishedJob();

    const words =
      "Finished: nothing answered. 2 skipped (changed or never fully answered): use Answer existing records on the Sources page to queue them with every question.";
    expect(status.words).toBe(words);
    expect(status.words).not.toContain("facetdb backfill");
    expect(lines).toContain(`listings: backfill of "is_vehicle" finished. ${words}`);
    expect(queued(["n1", "n2"])).toEqual([]);
  });

  it("a record whose read changed with no row written is skipped, never the worker's", async () => {
    world = tableOf(["s1"]);
    await readChanged("s1");

    const { status } = await finishedJob();

    expect(status.words).toBe(
      "Finished: nothing answered. 1 skipped (changed or never fully answered): use Answer existing records on the Sources page to queue it with every question.",
    );
    expect(queued(["s1"])).toEqual([]);
  });

  it("a mix says each part, as the command does", async () => {
    world = tableOf(["n1", "p1", "c1", "q1", "a1", "d1"]);
    await answered("p1", ["is_scam"]);
    await changed("c1");
    await waiting("q1");
    await answered("a1", ["is_scam", "category"]);
    await answered("d1", ["is_scam", "category", "is_vehicle"]);

    const { status } = await finishedJob();

    expect(status.words).toBe(
      "Finished: 1 answered, 1 already answered, 1 queued for the worker. 3 skipped (changed or never fully answered): use Answer existing records on the Sources page to queue them with every question.",
    );
    // The counts the studio reads keep the whole deferred number.
    expect(status.counts).toMatchObject({ answered: 1, alreadyAnswered: 1, deferred: 4 });
    expect(queued(["q1"])).toEqual(["q1"]);
    expect(queued(["n1", "p1"])).toEqual([]);
  });

  it("records waiting in the queue alone: the words end after the worker's part", async () => {
    world = tableOf(["q1", "q2"]);
    await waiting("q1");
    await waiting("q2");

    const { status } = await finishedJob();

    expect(status.words).toBe("Finished: 2 queued for the worker.");
  });
});

/**
 * A whole-set backfill counts as queued only the records its connector queued. A plugin source
 * leaves out a record its plugin no longer returns on the read again: the closing line names those
 * apart, on the terminal, in `--json` and in the studio's job, and a part that counts zero is left
 * out.
 */
describe("a whole-set backfill's closing line: only what the connector queued", () => {
  /** Queues every key but those in `dropped`, as a plugin source does with records gone from its tool. */
  class LeavesOut extends FakeConnector {
    readonly #dropped: ReadonlySet<RecordKey>;
    constructor(db: FakeDatabase, dropped: readonly RecordKey[]) {
      super(db);
      this.#dropped = new Set(dropped);
    }
    override enqueue(keys: readonly RecordKey[]): Promise<readonly RecordKey[]> {
      return super.enqueue(keys.filter((key) => !this.#dropped.has(key)));
    }
  }

  beforeEach(() => {
    world = tableOf(["r1", "r2", "r3", "r4"]);
  });

  it("the terminal names the records not queued, and counts as queued only what the queue holds", async () => {
    world = { ...world, connector: new LeavesOut(world.db, ["r2", "r3"]) };
    await answered("r4", ["is_scam", "category", "is_vehicle"]);

    const result = await backfill(["--source", "listings"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Done: 1 record queued for the worker, 1 already answered. 2 not queued: the plugin no longer returns them. Run facetdb worker to answer the queue.\n",
    );
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual(["r1"]);
  });

  it("--json carries the count not queued beside the count queued", async () => {
    world = { ...world, connector: new LeavesOut(world.db, ["r4"]) };

    const result = await backfill(["--source", "listings", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ queued: 3, notQueued: 1 });
  });

  it("nothing queued: the worker is not named, and one record left out is said in the singular", async () => {
    world = tableOf(["r1"]);
    world = { ...world, connector: new LeavesOut(world.db, ["r1"]) };

    const result = await backfill(["--source", "listings"]);

    expect(result.stdout).toContain("Done. 1 not queued: the plugin no longer returns it.\n");
    expect(result.stdout).not.toContain("facetdb worker");
    expect(queued(["r1"])).toEqual([]);
  });

  it("nothing to queue and nothing left out: said so, with no command", async () => {
    for (const key of ["r1", "r2", "r3", "r4"]) {
      await answered(key, ["is_scam", "category", "is_vehicle"]);
    }

    const result = await backfill(["--source", "listings"]);

    expect(result.stdout).toContain("Done: 4 already answered.\n");
    expect(result.stdout).not.toContain("facetdb worker");
  });

  it("the studio's job says the same, without a terminal command", async () => {
    world = { ...world, connector: new LeavesOut(world.db, ["r2", "r3"]) };
    const loop = { source, questionSet, version: 1, heldModel: freshHeldModel() };
    const quiet: AlertSignals = {
      modelCall: () => Promise.resolve(),
      modelChecked: () => Promise.resolve(),
      beat: () => Promise.resolve(),
      backfillFinished: () => Promise.resolve(),
      backfillFailed: () => Promise.resolve(),
    };
    const lines: string[] = [];
    const jobs = createBackfillJobs({
      projectId: PROJECT_ID,
      loop: (name) => (name === source.name ? loop : undefined),
      open: () => Promise.resolve(new FakeOpenConnector(world.db)),
      newWorkerId: () => "backfill-1",
      // The loop in force's queue, which leaves out what the plugin no longer returns.
      queue: (name) => (name === source.name ? world.connector : undefined),
      provider: createFakeProvider({ defaults: { noul: 0.1 } }),
      spending: UNLIMITED,
      clock: world.clock,
      cursors: world.cursors,
      log: () => world.log,
      runs: (name) => ({ log: new FakeRunLog(), source: `${PROJECT_ID}:${name}` }),
      reviews: (name) => reviewsOf(new FakeReviewQueue(), `${PROJECT_ID}:${name}`),
      alerts: () => quiet,
      expireAfter: () => new AbortController().signal,
      newToken: () => "token-1",
      print: (line) => {
        lines.push(line);
      },
    });
    const reaches = async (state: BackfillJobStatus["state"]) => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const outcome = await jobs.status(source.name);
        if (outcome.kind === "status" && outcome.status.state === state) {
          return outcome.status;
        }
        await Promise.resolve();
      }
      throw new Error(`the job never reached ${state}`);
    };
    await jobs.estimate(source.name, undefined);
    await reaches("waiting");
    await jobs.start(source.name, "token-1");
    const status = await reaches("finished");
    await jobs.close();

    const words =
      "Finished: 2 records queued for the worker. 2 not queued: the plugin no longer returns them.";
    expect(status.words).toBe(words);
    expect(status.counts).toMatchObject({ queued: 2 });
    expect(lines).toContain(`listings: backfill finished. ${words}`);
    expect(queued(["r1", "r2", "r3", "r4"])).toEqual(["r1", "r4"]);
  });
});
