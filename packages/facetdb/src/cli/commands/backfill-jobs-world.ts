import type {
  AlertSignals,
  BackfillProgress,
  Connector,
  CursorStore,
  ModelProvider,
  OpenConnector,
  QuestionSet,
  RecordKey,
  SpendingGate,
} from "@facetdb/core";
import { reviewsOf } from "@facetdb/core";
import {
  FakeClock,
  FakeDecisionLog,
  FakeReviewQueue,
  FakeRunLog,
  freshHeldModel,
} from "@facetdb/core/testing";
import type { BackfillJobState, BackfillJobStatus } from "@facetdb/server";
import { expect } from "vitest";
import { facetdb, noul } from "../../config/index.ts";
import { createBackfillJobs, type JobLoop } from "./backfill-jobs.ts";
import { questionSetOf } from "./database.ts";

/**
 * A backfill job beside a worker's loop on a real engine: what the fakes of backfill-jobs.test.ts
 * cannot show, because every fake connector there shares one queue. Here the loop holds one
 * connector and the job opens another on the same installed table, as in the worker, and the
 * application writes to a record while the job asks the model about it. The engine's own test files
 * build the world (backfill-jobs-sqlite.test.ts on a file, backfill-jobs.db.test.ts on a Postgres
 * server) and run the two cases below on it.
 */

const SOURCE = "listings";
const START_MS = Date.parse("2026-11-10T09:00:00.000Z");

const PROJECT = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: SOURCE,
      database: "postgres://facetdb_worker:worker-password@localhost:5432/app",
      table: "listings",
      read: ["body"],
      questions: { scam: noul("Is this listing a scam?"), spam: noul("Is this listing spam?") },
    },
  ],
});

/** The loop a world's connectors run under: the listings source, its two questions, version 1. */
export function listingsLoop(): JobLoop {
  const [source] = PROJECT.sources;
  if (source === undefined) {
    throw new Error("the world's project has no source");
  }
  return {
    source,
    questionSet: questionSetOf(PROJECT, source),
    version: 1,
    heldModel: freshHeldModel(),
  };
}

/** The question set the world's table is installed with: the loop's. */
export function listingsQuestionSet(): QuestionSet {
  return listingsLoop().questionSet;
}

/** The records every world holds, and the body the application first gave each. */
export const WORLD_KEYS: readonly RecordKey[] = ["k1", "k2", "k3", "k4", "k5", "k6"];
export const bodyOf = (key: RecordKey): string => `the listing ${key}`;

export type EngineWorld = {
  /**
   * The connector the worker's loop holds on the table, under the worker's own id. Its queue is
   * empty when a case begins: what the application's inserts queued has been claimed and acked.
   */
  readonly loopConnector: Connector;
  /** Opens another connector on the table, as a job does, under the worker id given. */
  open(workerId: string): Promise<OpenConnector>;
  /** The application's own write: a new body for a record, from a connection of its own. */
  edit(key: RecordKey, body: string): Promise<void>;
};

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

const QUIET: AlertSignals = {
  modelCall: () => Promise.resolve(),
  modelChecked: () => Promise.resolve(),
  beat: () => Promise.resolve(),
  backfillFinished: () => Promise.resolve(),
  backfillFailed: () => Promise.resolve(),
};

/** The jobs of a worker whose one loop is the world's, with the model, the log and the cap faked. */
function jobsOver(world: EngineWorld) {
  const loop = listingsLoop();
  const log = new FakeDecisionLog();
  const stored = new Map<string, BackfillProgress>();
  const cursors: CursorStore = {
    load: (run) => Promise.resolve(stored.get(run)),
    save: (run, progress) => {
      stored.set(run, progress);
      return Promise.resolve();
    },
  };
  const hooks: { beforeAnswer: (body: string) => Promise<void> } = {
    beforeAnswer: () => Promise.resolve(),
  };
  const asked: string[] = [];
  /** Says "no" to every question asked. */
  const provider: ModelProvider = {
    async ask(request) {
      const body = String(request.state["body"]);
      asked.push(body);
      await hooks.beforeAnswer(body);
      const answers: Record<string, { type: "noul"; probability: number }> = {};
      for (const question of request.questions) {
        answers[question.name] = { type: "noul", probability: 0.05 };
      }
      return { model: request.model, answers, usage: { inputTokens: 100, outputTokens: 5 } };
    },
  };
  const openedAs: string[] = [];
  let workers = 0;
  const jobs = createBackfillJobs({
    projectId: "proj_market",
    loop: (name) => (name === SOURCE ? loop : undefined),
    open: (_loop, workerId) => {
      openedAs.push(workerId);
      return world.open(workerId);
    },
    newWorkerId: () => {
      workers += 1;
      return `backfill-${workers}`;
    },
    queue: (name) => (name === SOURCE ? world.loopConnector : undefined),
    provider,
    spending: UNLIMITED,
    // The job's pace alone: its sleeps pass at once. The engine's connectors keep their own time.
    clock: new FakeClock(START_MS),
    cursors,
    log: () => log,
    runs: () => ({ log: new FakeRunLog(), source: `proj_market:${SOURCE}` }),
    reviews: () => reviewsOf(new FakeReviewQueue(), `proj_market:${SOURCE}`),
    alerts: () => QUIET,
    expireAfter: () => new AbortController().signal,
    newToken: () => "token-1",
    print: () => undefined,
  });

  /** Waits for the engine: each look is 5 ms after the last, for up to 15 seconds. */
  async function reaches(state: BackfillJobState): Promise<BackfillJobStatus> {
    let last: BackfillJobStatus | undefined;
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      const outcome = await jobs.status(SOURCE);
      if (outcome.kind !== "status") {
        throw new Error(`the worker runs no source called ${SOURCE}`);
      }
      last = outcome.status;
      if (last.state === state) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the backfill is ${last?.state}, not ${state}: ${last?.words}`);
  }

  /** Estimates, then starts with the token the estimate gave, and waits for the job to finish. */
  async function run(questions?: readonly string[]): Promise<BackfillJobStatus> {
    const estimate = await jobs.estimate(SOURCE, questions);
    expect(estimate.kind).toBe("estimating");
    const waiting = await reaches("waiting");
    const started = await jobs.start(SOURCE, waiting.token ?? "");
    expect(started.kind).toBe("started");
    return reaches("finished");
  }

  return { jobs, log, hooks, asked, openedAs, run };
}

/**
 * A job of an added question while the application changes a record the model is being asked about,
 * and the loop takes the change at its next pass. The record is the loop's from then on: the job's
 * stale answer is not written, and the job settles its own claim alone, so the loop's stands and
 * the record is asked once at its new state. Under the worker's own id, a queue that tells claims
 * apart by that id alone (SQLite) let the job's release hand the loop's claim back.
 */
export async function anAddedQuestionJobBesideTheLoop(world: EngineWorld): Promise<void> {
  const t = jobsOver(world);
  const [, , changed] = WORLD_KEYS;
  if (changed === undefined) {
    throw new Error("the world holds fewer than three records");
  }
  const others = WORLD_KEYS.filter((key) => key !== changed);
  // Every record has its answer to `scam` at its present state, as a loop that ran before `spam`
  // was added left it: the added question merges with it.
  const read = await world.loopConnector.read(WORLD_KEYS);
  expect(read.rows).toHaveLength(WORLD_KEYS.length);
  for (const row of read.rows) {
    await t.log.appendAnswer({
      kind: "answer",
      key: row.key,
      version: 1,
      model: "jev-1.14.0",
      stateHash: row.hash,
      answers: { scam: { type: "noul", probability: 0.05 } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date(START_MS),
    });
  }

  let loopsClaim: readonly RecordKey[] | undefined;
  t.hooks.beforeAnswer = async (body) => {
    if (body !== bodyOf(changed) || loopsClaim !== undefined) {
      return;
    }
    // The model is being asked about the record as it was: the application changes it now, which
    // queues it again, and the loop's next pass claims what the change queued.
    await world.edit(changed, "the listing as the seller rewrote it");
    loopsClaim = await world.loopConnector.claim(20);
  };

  const done = await t.run(["spam"]);

  // The change took the record from the job and gave it to the loop; no other record was the loop's.
  expect(loopsClaim).toEqual([changed]);
  expect(done.counts).toMatchObject({ answered: others.length, alreadyAnswered: 0, deferred: 0 });
  expect([...t.asked].sort()).toEqual(WORLD_KEYS.map(bodyOf).sort());
  // The job read under an id of its own, never the loop's.
  expect(t.openedAs).toEqual(["backfill-1"]);
  // The job let go of its own claim of that record, not the loop's: nothing is there for a second
  // pass to take, so the record is not asked twice at one state.
  expect(await world.loopConnector.claim(20)).toEqual([]);
  // The answer for the state that is gone was not written; every other record has both answers.
  const current = await world.loopConnector.current(WORLD_KEYS);
  expect(current.get(changed)?.decisions).toEqual({});
  for (const key of others) {
    expect(current.get(key)?.decisions).toMatchObject({
      scam: { kind: "decided", value: false },
      spam: { kind: "decided", value: false },
    });
  }
  // The loop finishes the record: its ack takes the job out of the queue, and the queue is empty.
  await world.loopConnector.ack([changed]);
  expect(await world.loopConnector.claim(20)).toEqual([]);
}

/**
 * A job of the whole set: its records are handed to the loop's own connector, so they are in the
 * queue the loop claims from, each once.
 */
export async function aWholeSetJobBesideTheLoop(world: EngineWorld): Promise<void> {
  const t = jobsOver(world);

  const done = await t.run();

  expect(done.counts).toMatchObject({
    records: WORLD_KEYS.length,
    queued: WORLD_KEYS.length,
    answered: 0,
  });
  // The job asked nothing itself: the loop does, and its next pass finds every record waiting.
  expect(t.asked).toEqual([]);
  const claimed = await world.loopConnector.claim(100);
  expect([...claimed].sort()).toEqual([...WORLD_KEYS].sort());
  await world.loopConnector.ack(claimed);
  expect(await world.loopConnector.claim(100)).toEqual([]);
}
