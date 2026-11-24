import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CurrentDecision,
  RecordDecision,
  RecordKey,
  WriteResult,
} from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import { followReview, reviewsOf } from "../review/index.ts";
import type { Answer } from "../thresholds/index.ts";
import {
  type AnswerEntry,
  type HumanEntry,
  type RestoreDeps,
  type RestoreOptions,
  restoreFromLog,
} from "./index.ts";

/**
 * `facetdb backfill --from-log`'s core. After a table rebuild that emptied FacetDB's columns, every
 * answered record gets its latest logged decision back with no model call and no action, only while
 * its state is the one the model answered, a person's decision kept.
 */

// The low-stakes defaults: yes at or above 0.70, no at or below 0.30.
const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing a scam?",
  stakes: "low",
};
const team: Question = {
  type: "choice",
  name: "team",
  instructions: "Which team owns this?",
  options: [
    { name: "billing", description: "Money questions" },
    { name: "tech", description: "Technical questions" },
  ],
  stakes: "low",
  storeProbabilities: false,
};
const FIELDS = ["title"];
const questionSet: QuestionSet = {
  questions: [scam],
  read: FIELDS,
  model: "jev-1.14.0",
  thresholds: {},
};
const SOURCE = "listings";

function hashOf(title: string): string {
  return stateHash(FIELDS, { title });
}

function answer(key: string, title: string, answers: Record<string, Answer>): AnswerEntry {
  return {
    kind: "answer",
    key,
    version: 1,
    model: "jev-1.14.0",
    stateHash: hashOf(title),
    answers,
    usage: { inputTokens: 100, outputTokens: 10 },
    at: new Date("2026-11-01T10:00:00Z"),
  };
}

function noul(probability: number): Record<string, Answer> {
  return { scam: { type: "noul", probability } };
}

function human(key: string, title: string, value: boolean): HumanEntry {
  return {
    kind: "human",
    key,
    question: "scam",
    value,
    reviewer: "amara",
    stateHash: hashOf(title),
    version: 1,
    at: new Date("2026-11-01T11:00:00Z"),
  };
}

/** Counts the writes that reach the table, landed or refused. */
class CountingConnector extends FakeConnector {
  writes = 0;
  override write(key: RecordKey, decision: RecordDecision, hash: string): Promise<WriteResult> {
    this.writes += 1;
    return super.write(key, decision, hash);
  }
}

type World = {
  readonly db: FakeDatabase;
  readonly connector: CountingConnector;
  readonly journal: string[];
  readonly log: FakeDecisionLog;
  readonly queue: FakeReviewQueue;
  readonly clock: FakeClock;
};

let world: World;

beforeEach(async () => {
  const clock = new FakeClock(1_000);
  const db = new FakeDatabase({ fields: FIELDS, clock });
  const connector = new CountingConnector(db);
  await connector.install();
  const journal: string[] = [];
  world = {
    db,
    connector,
    journal,
    log: new FakeDecisionLog(journal),
    queue: new FakeReviewQueue(),
    clock,
  };
});

/** A row as a rebuild leaves it: its state, FacetDB's columns empty, and no job queued. */
function rebuiltRow(key: string, title: string): void {
  world.db.edit(key, { title });
  world.db.jobs.clear();
}

/** Seeds the log with no line in the journal, so the journal shows only what the restore appends. */
async function seed(...entries: readonly (AnswerEntry | HumanEntry)[]): Promise<void> {
  for (const entry of entries) {
    await (entry.kind === "answer" ? world.log.appendAnswer(entry) : world.log.appendHuman(entry));
  }
  world.journal.length = 0;
}

function deps(overrides: Partial<RestoreDeps> = {}): RestoreDeps {
  const reviews = reviewsOf(world.queue, SOURCE);
  return {
    questionSet,
    log: world.log,
    connector: world.connector,
    follow: (record, decision, logged) => followReview(reviews, record, decision, logged),
    clock: world.clock,
    ...overrides,
  };
}

function options(overrides: Partial<RestoreOptions> = {}): RestoreOptions {
  return { pace: 50, confirm: () => true, ...overrides };
}

describe("restoreFromLog", () => {
  it("fills empty columns from each record's latest logged answer, and puts the unsure one on the review screen", async () => {
    rebuiltRow("r1", "bike");
    rebuiltRow("r2", "car");
    await seed(
      answer("r1", "bike", noul(0.4)),
      // The latest answer is the one restored: the earlier one at the same record is history.
      answer("r1", "bike", noul(0.92)),
      answer("r2", "car", noul(0.55)),
    );

    const report = await restoreFromLog(deps(), options());

    expect(report).toMatchObject({
      status: "completed",
      examined: 2,
      written: ["r1", "r2"],
      current: [],
      changed: [],
    });
    expect(world.db.decisionOf("r1")).toEqual({
      decisions: { scam: { kind: "decided", value: true, probabilityOrConfidence: 0.92 } },
      status: "done",
    });
    expect(world.db.decisionOf("r2")).toEqual({
      decisions: { scam: { kind: "needs_review" } },
      status: "needs_review",
    });
    // The needs_review record has its card, with the model's figure, as the worker's write leaves it.
    expect(world.queue.rows.map((card) => [card.key, card.stateHash])).toEqual([
      ["r2", hashOf("car")],
    ]);
  });

  it("asks no model and runs no action: nothing is appended to the log, nothing queued", async () => {
    rebuiltRow("r1", "bike");
    await seed(answer("r1", "bike", noul(0.92)));

    await restoreFromLog(deps(), options());

    // A model call is logged before its write; the restore logs nothing.
    expect(world.journal).toEqual([]);
    expect(world.db.jobs.size).toBe(0);
    // The dependencies hold no provider and no action: a restore has nothing to call either with.
    expect(Object.keys(deps()).sort()).toEqual([
      "clock",
      "connector",
      "follow",
      "log",
      "questionSet",
    ]);
  });

  it("writes a person's decision at the record's state back as the person made it, with reviewed set", async () => {
    rebuiltRow("r1", "bike");
    rebuiltRow("r2", "car");
    await seed(
      answer("r1", "bike", noul(0.55)),
      human("r1", "bike", false),
      // r2: a person decided, then the model answered again at the same state (a question-set
      // change asked it again): the later answer is the latest, and the person's word still stands.
      answer("r2", "car", noul(0.5)),
      human("r2", "car", true),
      answer("r2", "car", noul(0.1)),
    );

    const report = await restoreFromLog(deps(), options());

    expect(report.written).toEqual(["r1", "r2"]);
    expect(world.db.decisionOf("r1")).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: 0.55 } },
      status: "done",
      reviewed: true,
    });
    expect(world.db.decisionOf("r2")).toEqual({
      decisions: { scam: { kind: "decided", value: true, probabilityOrConfidence: 0.1 } },
      status: "done",
      reviewed: true,
    });
    expect(world.queue.rows).toEqual([]);
  });

  it("does not bring back a person's decision made at an older state", async () => {
    rebuiltRow("r1", "bike, blue");
    await seed(
      answer("r1", "bike", noul(0.55)),
      human("r1", "bike", true),
      answer("r1", "bike, blue", noul(0.1)),
    );

    await restoreFromLog(deps(), options());

    expect(world.db.decisionOf("r1")).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: 0.1 } },
      status: "done",
    });
  });

  it("counts a record whose state moved since its answer and does not write it", async () => {
    rebuiltRow("r1", "bike, now red");
    await seed(answer("r1", "bike", noul(0.92)));

    const report = await restoreFromLog(deps(), options());

    expect(report).toMatchObject({ written: [], changed: ["r1"] });
    expect(world.connector.writes).toBe(0);
    expect(world.db.decisionOf("r1")).toBeNull();
  });

  it("counts a record whose state moves while it is written: the hash-guarded write refuses it", async () => {
    rebuiltRow("r1", "bike");
    await seed(answer("r1", "bike", noul(0.92)));
    // The application edits the row between the restore's read and its write.
    class Racing extends CountingConnector {
      override write(key: RecordKey, decision: RecordDecision, hash: string) {
        world.db.edit(key, { title: "bike, edited" });
        return super.write(key, decision, hash);
      }
    }

    const report = await restoreFromLog(deps({ connector: new Racing(world.db) }), options());

    expect(report).toMatchObject({ written: [], changed: ["r1"] });
    expect(world.db.decisionOf("r1")).toBeNull();
  });

  it("does not write a record whose columns already hold the log's decision, so a second run writes nothing", async () => {
    rebuiltRow("r1", "bike");
    rebuiltRow("r2", "car");
    await seed(
      answer("r1", "bike", noul(0.92)),
      answer("r2", "car", noul(0.55)),
      human("r2", "car", true),
    );
    const first = await restoreFromLog(deps(), options());
    expect(first.written).toEqual(["r1", "r2"]);
    const writes = world.connector.writes;

    const second = await restoreFromLog(deps(), options());

    expect(second).toMatchObject({ written: [], current: ["r1", "r2"] });
    expect(world.connector.writes).toBe(writes);
  });

  it("reads a single-precision column's number as the logged one, so a Postgres real column is current", async () => {
    rebuiltRow("r1", "bike");
    await seed(answer("r1", "bike", noul(0.123456789)));
    /** A `real` column: the number comes back rounded to single precision. */
    class SinglePrecision extends CountingConnector {
      override async current(keys: readonly RecordKey[]) {
        const found = new Map<RecordKey, CurrentDecision>();
        for (const [key, held] of await super.current(keys)) {
          const decisions: Record<string, CurrentDecision["decisions"][string]> = {};
          for (const [name, decision] of Object.entries(held.decisions)) {
            decisions[name] = {
              ...decision,
              probabilityOrConfidence: Math.fround(decision.probabilityOrConfidence),
            };
          }
          found.set(key, { ...held, decisions });
        }
        return found;
      }
    }
    const connector = new SinglePrecision(world.db);
    await restoreFromLog(deps({ connector }), options());
    expect(connector.writes).toBe(1);

    const again = await restoreFromLog(deps({ connector }), options());

    expect(again.current).toEqual(["r1"]);
    expect(connector.writes).toBe(1);
  });

  it("writes a row whose columns disagree with the log, a person's decision included", async () => {
    rebuiltRow("r1", "bike");
    await seed(answer("r1", "bike", noul(0.55)), human("r1", "bike", true));
    // A row holding the thresholds' needs_review without the person's yes (the person's write was lost).
    await world.connector.write(
      "r1",
      { decisions: { scam: { kind: "needs_review" } }, status: "needs_review" },
      hashOf("bike"),
    );

    const report = await restoreFromLog(deps(), options());

    expect(report.written).toEqual(["r1"]);
    expect(world.db.decisionOf("r1")).toMatchObject({ status: "done", reviewed: true });
  });

  it("leaves a record lacking a question of the set, one the worker set error, unchecked or skipped since, and one gone", async () => {
    const both: QuestionSet = { ...questionSet, questions: [scam, team] };
    const whole: Record<string, Answer> = {
      ...noul(0.92),
      team: { type: "choice", top: "billing", probabilities: [0.9, 0.1] },
    };
    rebuiltRow("r1", "bike");
    rebuiltRow("r2", "car");
    rebuiltRow("r3", "van");
    rebuiltRow("r4", "boat");
    await seed(
      // r1: answered before `team` was added.
      answer("r1", "bike", noul(0.92)),
      answer("r2", "car", whole),
      answer("r3", "van", whole),
      answer("r4", "boat", whole),
      answer("gone", "plane", noul(0.92)),
    );
    // r2: a later ask failed; r3: the filter excludes it now. The log holds neither outcome.
    await world.connector.write("r2", { decisions: {}, status: "error" }, hashOf("car"));
    await world.connector.write("r3", { decisions: {}, status: "skipped" }, hashOf("van"));
    const before = world.connector.writes;

    const report = await restoreFromLog(deps({ questionSet: both }), options());

    expect(report).toMatchObject({
      examined: 5,
      written: ["r4"],
      incomplete: ["r1"],
      kept: ["r2", "r3"],
      gone: ["gone"],
    });
    expect(world.connector.writes).toBe(before + 1);
    expect(world.db.decisionOf("r1")).toBeNull();
    expect(world.db.decisionOf("r2")?.status).toBe("error");
    expect(world.db.decisionOf("r3")?.status).toBe("skipped");
  });

  it("re-applies the thresholds in force to the logged probabilities", async () => {
    rebuiltRow("r1", "bike");
    // 0.55 waited for review at the defaults; the thresholds in force now say yes from 0.5.
    await seed(answer("r1", "bike", noul(0.55)));

    await restoreFromLog(
      deps({ questionSet: { ...questionSet, thresholds: { scam: { yesAbove: 0.5 } } } }),
      options(),
    );

    expect(world.db.decisionOf("r1")).toEqual({
      decisions: { scam: { kind: "decided", value: true, probabilityOrConfidence: 0.55 } },
      status: "done",
    });
  });

  it("a dry run counts the same and writes nothing, follows no review queue", async () => {
    rebuiltRow("r1", "bike");
    rebuiltRow("r2", "car, edited");
    await seed(answer("r1", "bike", noul(0.55)), answer("r2", "car", noul(0.92)));

    const report = await restoreFromLog(deps(), options({ dryRun: true }));

    expect(report).toMatchObject({ written: ["r1"], changed: ["r2"] });
    expect(world.connector.writes).toBe(0);
    expect(world.queue.rows).toEqual([]);
    expect(world.clock.sleeps).toEqual([]);
  });

  it("shows the count first, and a refusal writes nothing", async () => {
    rebuiltRow("r1", "bike");
    await seed(answer("r1", "bike", noul(0.92)));
    const shown: number[] = [];

    const report = await restoreFromLog(
      deps(),
      options({
        confirm: (records) => {
          shown.push(records);
          return false;
        },
      }),
    );

    expect(shown).toEqual([1]);
    expect(report.status).toBe("declined");
    expect(world.connector.writes).toBe(0);
  });

  it("@timing writes at the pace, records already current costing no wait", async () => {
    for (const key of ["r1", "r2", "r3"]) {
      rebuiltRow(key, key);
      await world.log.appendAnswer(answer(key, key, noul(0.92)));
    }

    await restoreFromLog(deps(), options({ pace: 2 }));
    expect(world.clock.sleeps).toEqual([500, 500]);

    await restoreFromLog(deps(), options({ pace: 2 }));
    expect(world.clock.sleeps).toEqual([500, 500]);
  });
});
