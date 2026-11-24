import {
  type Answer,
  type AnswerEntry,
  type ChoiceQuestion,
  createReviewService,
  type NoulQuestion,
  type QuestionSet,
  type RecordDecision,
  reapplyThresholds,
  recordAnswer,
  reviewEntryOf,
} from "@facetdb/core";
import { FakeClock, FakeDecisionLog, FakeReviewQueue } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { newWorld, useCaptureWorld } from "./capture-world.ts";

/**
 * A record answered before its choice's options changed is still on the review screen, and the
 * review service judges that old answer against the set in force. Through the real review service
 * and the real Postgres write (PGlite): the column is written by option name where the answer names
 * its options and they are the present ones, NULL where the answer cannot be tied to them, and no
 * decision, undo or decision on another question ever fails over it.
 */

useCaptureWorld();

const SOURCE = "proj_listings:listings";
const V1_NAMES = ["billing", "bug", "sales"];

const scam: NoulQuestion = {
  type: "noul",
  name: "scam",
  instructions: "Is this a scam?",
  stakes: "low",
};
const teamWith = (names: readonly string[]): ChoiceQuestion => ({
  type: "choice",
  name: "team",
  instructions: "Which team should handle this?",
  options: names.map((name) => ({ name, description: `The ${name} team` })),
  stakes: "low",
  storeProbabilities: true,
});
const setWith = (team: ChoiceQuestion): QuestionSet => ({
  questions: [scam, team],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
});

/** The team's answer under version 1's options, with or without the option names (an earlier version). */
function teamAnswer(probabilities: readonly number[], named: boolean): Answer {
  const top = V1_NAMES[probabilities.indexOf(Math.max(...probabilities))] ?? "";
  return named
    ? { type: "choice", top, probabilities, options: V1_NAMES }
    : { type: "choice", top, probabilities };
}

/**
 * One record answered under version 1 (`answers`), written and queued for review as the worker
 * leaves it; the review service runs under version 2, whose team options are `present`.
 */
async function reviewed(present: readonly string[], answers: Record<string, Answer>, version = 1) {
  const now = setWith(teamWith(present));
  const world = await newWorld("inline", "keep", { questions: now.questions });
  const connector = world.connector();
  await connector.install();
  await world.edit("r1", { title: "a listing", body: "its text" });
  const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
  const clock = new FakeClock(1_700_000_000_000);
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const entry: AnswerEntry = {
    kind: "answer",
    key: "r1",
    version,
    model: "jev-1.14.0",
    stateHash: hash,
    answers,
    usage: { inputTokens: 100, outputTokens: 8 },
    at: new Date(clock.now()),
  };
  const writes: RecordDecision[] = [];
  await recordAnswer(entry, setWith(teamWith(V1_NAMES)), log, (key, decision, expected) => {
    writes.push(decision);
    return connector.write(key, decision, expected);
  });
  const [written] = writes;
  if (written === undefined || written.status !== "needs_review") {
    throw new Error("the seed's answer did not leave the record for review");
  }
  await queue.upsert({
    source: SOURCE,
    ...reviewEntryOf({
      key: "r1",
      stateHash: hash,
      decisions: written.decisions,
      answers,
      since: entry.at,
    }),
  });
  clock.advance(1_000);
  const service = createReviewService({
    queue,
    log: new Map([[SOURCE, log]]),
    connectors: new Map([[SOURCE, connector]]),
    actions: new Map([[SOURCE, []]]),
    questionSets: new Map([[SOURCE, { questionSet: now, version: 2 }]]),
    clock,
  });
  const card = await service.open("alice", {});
  if (card === null) {
    throw new Error("the record's card did not open");
  }
  const ref = { source: card.source, key: card.key, stateHash: card.stateHash };
  const row = async () =>
    (
      await world.pg.client.query(
        `select team, team_confidence as confidence, team_probabilities as stored,
                facetdb_status as status from public.listings where id = 'r1'`,
      )
    )[0];
  return { service, ref, row };
}

describe("an option added since the answer", () => {
  const added = [...V1_NAMES, "legal"];

  it("a person's decision on the choice writes, the column NULL beside the model's confidence", async () => {
    const t = await reviewed(added, {
      scam: { type: "noul", probability: 0.95 },
      team: teamAnswer([0.4, 0.35, 0.25], true),
    });

    expect(await t.service.decide("alice", t.ref, "team", "legal")).toMatchObject({
      kind: "decided",
      status: "done",
    });

    expect(await t.row()).toMatchObject({ team: "legal", stored: null, status: "done" });
    expect((await t.row())?.["confidence"]).not.toBeNull();
  });

  it("a decision on another question of the card writes too, and its undo", async () => {
    // The thresholds decide the choice (confidence 0.7); the noul is left to a person.
    const t = await reviewed(added, {
      scam: { type: "noul", probability: 0.5 },
      team: teamAnswer([0.8, 0.15, 0.05], true),
    });

    expect(await t.service.decide("alice", t.ref, "scam", false)).toMatchObject({
      kind: "decided",
      status: "done",
    });
    expect(await t.row()).toMatchObject({ team: "billing", stored: null, status: "done" });

    expect(await t.service.undo("alice", t.ref, "scam")).toMatchObject({
      kind: "undone",
      status: "needs_review",
    });
    expect(await t.row()).toMatchObject({ team: "billing", stored: null, status: "needs_review" });
  });
});

describe("options reordered since the answer", () => {
  const reordered = [...V1_NAMES].reverse();

  it("an answer that names its options: each option keeps its own number", async () => {
    const t = await reviewed(reordered, {
      scam: { type: "noul", probability: 0.95 },
      team: teamAnswer([0.4, 0.35, 0.25], true),
    });

    await t.service.decide("alice", t.ref, "team", "billing");

    expect((await t.row())?.["stored"]).toEqual({ billing: 0.4, bug: 0.35, sales: 0.25 });
  });

  it("an answer logged by an earlier version at an older version: NULL, never another option's number", async () => {
    const t = await reviewed(reordered, {
      scam: { type: "noul", probability: 0.95 },
      team: teamAnswer([0.4, 0.35, 0.25], false),
    });

    await t.service.decide("alice", t.ref, "team", "billing");

    expect(await t.row()).toMatchObject({ team: "billing", stored: null, status: "done" });
  });

  it("an answer logged by an earlier version at the version in force: its order is the present one", async () => {
    const t = await reviewed(
      V1_NAMES,
      { scam: { type: "noul", probability: 0.95 }, team: teamAnswer([0.4, 0.35, 0.25], false) },
      2,
    );

    await t.service.decide("alice", t.ref, "team", "bug");

    expect((await t.row())?.["stored"]).toEqual({ billing: 0.4, bug: 0.35, sales: 0.25 });
  });
});

describe("a re-apply over answers from before and after the options changed", () => {
  it("finishes, every record written: by name where the answer can be tied, NULL where not", async () => {
    // Version 2 added "legal" first and moved the rest around.
    const now = setWith(teamWith(["legal", "sales", "billing", "bug"]));
    const world = await newWorld("inline", "keep", { questions: now.questions });
    const connector = world.connector();
    await connector.install();
    const log = new FakeDecisionLog();
    const logged: [key: string, version: number, team: Answer][] = [
      // Named under version 1's three options: one is missing now.
      ["r1", 1, teamAnswer([0.4, 0.35, 0.25], true)],
      // Logged in an earlier version at version 1: its order is not the present one.
      ["r2", 1, teamAnswer([0.4, 0.35, 0.25], false)],
      // Named under the present four, in another order.
      [
        "r3",
        2,
        {
          type: "choice",
          top: "bug",
          probabilities: [0.1, 0.2, 0.3, 0.4],
          options: ["sales", "legal", "billing", "bug"],
        },
      ],
    ];
    for (const [key, version, team] of logged) {
      await world.edit(key, { title: key, body: "its text" });
      const hash = (await connector.read([key])).rows[0]?.hash ?? "";
      await log.appendAnswer({
        kind: "answer",
        key,
        version,
        model: "jev-1.14.0",
        stateHash: hash,
        answers: { scam: { type: "noul", probability: 0.95 }, team },
        usage: { inputTokens: 100, outputTokens: 8 },
        at: new Date(1_700_000_000_000),
      });
    }

    const report = await reapplyThresholds(
      now,
      { team: { confidenceAtLeast: 0.01 } },
      log,
      (key, decision, hash) => connector.write(key, decision, hash),
      2,
    );

    expect([...report.written].sort()).toEqual(["r1", "r2", "r3"]);
    const rows = await world.pg.client.query(
      `select id, team_probabilities as stored, team_confidence is not null as confident
         from public.listings order by id`,
    );
    expect(rows).toEqual([
      { id: "r1", stored: null, confident: true },
      { id: "r2", stored: null, confident: true },
      { id: "r3", stored: { legal: 0.2, sales: 0.1, billing: 0.3, bug: 0.4 }, confident: true },
    ]);
  });
});
