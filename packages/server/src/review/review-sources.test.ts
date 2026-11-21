import {
  type ActionStep,
  type Answer,
  type AnswerEntry,
  type Connector,
  type DecisionLog,
  type Question,
  type QuestionSet,
  type RecordKey,
  recordAnswer,
  reviewEntryOf,
  stateHash,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { sourceIdOf } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createReviewEndpointService } from "./service.ts";

/**
 * The sources the review endpoints know are read from the worker on every call: a source a reload
 * started opens its cards from the next request on, with no restart, and one it stopped is unknown
 * from then on, while the cards it left still name it. On the real review service of core over its
 * fakes; the per-source maps are read the same way the fleet's live lookups read them
 * (config-reload.ts, `reviewLookups`).
 */

const PROJECT = "listings-app";
const START = Date.parse("2026-11-05T10:00:00Z");
const VIEWER = "maya";

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this likely a scam?",
  stakes: "low",
};
const questionSet: QuestionSet = {
  questions: [scam],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};
const UNSURE: Answer = { type: "noul", probability: 0.5 };

function rig() {
  const clock = new FakeClock(START);
  const queue = new FakeReviewQueue();
  /** The sources whose loop the worker runs now, as the fleet lists them. */
  const names: string[] = [];
  const log = new Map<string, DecisionLog>();
  const connectors = new Map<string, Connector>();
  const actions = new Map<string, readonly ActionStep[]>();
  const questionSets = new Map<string, { questionSet: QuestionSet; version: number }>();
  const databases = new Map<string, FakeDatabase>();

  /** A reload started the loop of `name`: it is listed, and its lookups are in place. */
  function starts(name: string): void {
    const id = sourceIdOf(PROJECT, name);
    const database = new FakeDatabase({ fields: ["body"], clock });
    database.install();
    databases.set(name, database);
    connectors.set(id, new FakeConnector(database));
    log.set(id, new FakeDecisionLog());
    actions.set(id, []);
    questionSets.set(id, { questionSet, version: 1 });
    names.push(name);
  }

  /** A reload stopped the loop of `name`: it is no longer listed, and its lookups are gone. */
  function stops(name: string): void {
    const id = sourceIdOf(PROJECT, name);
    names.splice(names.indexOf(name), 1);
    connectors.delete(id);
    log.delete(id);
    actions.delete(id);
    questionSets.delete(id);
  }

  /** As the worker leaves a record of `name`: answered, logged, written needs_review, its card queued. */
  async function seed(name: string, key: RecordKey, body: string): Promise<string> {
    const id = sourceIdOf(PROJECT, name);
    const database = databases.get(name);
    const connector = connectors.get(id);
    const entries = log.get(id);
    if (database === undefined || connector === undefined || entries === undefined) {
      throw new Error(`${name} does not run`);
    }
    database.edit(key, { body });
    const hash = stateHash(["body"], { body });
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 1,
      model: "jev-1.14.0",
      stateHash: hash,
      answers: { scam: UNSURE },
      usage: { inputTokens: 100, outputTokens: 8 },
      at: new Date(clock.now()),
    };
    const written: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
    await recordAnswer(entry, questionSet, entries, (k, decision, expected) => {
      written.push(decision.decisions);
      return connector.write(k, decision, expected);
    });
    const [decisions] = written;
    if (decisions === undefined) {
      throw new Error("the seed's answer was not written");
    }
    await queue.upsert({
      source: id,
      ...reviewEntryOf({
        key,
        stateHash: hash,
        decisions,
        answers: entry.answers,
        since: entry.at,
      }),
    });
    clock.advance(1_000);
    return hash;
  }

  starts("listings");
  const service = createReviewEndpointService({
    projectId: PROJECT,
    sources: () => names,
    queue,
    log,
    connectors,
    actions,
    questionSets,
    clock,
  });
  return { service, starts, stops, seed };
}

describe("the sources the review endpoints know", () => {
  it("are the worker's now: a source it does not run is unknown, named with the ones it runs", async () => {
    const t = rig();
    const card = { source: "sellers", key: "s1", stateHash: "h1" };

    const unknown = { kind: "unknown_source", source: "sellers", known: ["listings"] };
    expect(await t.service.queue(VIEWER, { source: "sellers" }, 10)).toEqual(unknown);
    expect(await t.service.open(VIEWER, { source: "sellers" }, undefined)).toEqual(unknown);
    expect(await t.service.renew(VIEWER, card)).toEqual(unknown);
    expect(await t.service.decide(VIEWER, card, { question: "scam", value: true })).toEqual(
      unknown,
    );
    expect(await t.service.skip(VIEWER, card)).toEqual(unknown);
    expect(await t.service.release(VIEWER, card)).toEqual(unknown);
  });

  it("open a card of a source a reload started from the next call on, with no restart", async () => {
    const t = rig();
    await t.seed("listings", "r1", "Free money, DM me");
    expect(await t.service.queue(VIEWER, { source: "sellers" }, 10)).toMatchObject({
      kind: "unknown_source",
    });

    t.starts("sellers");
    const hash = await t.seed("sellers", "s1", "New here, cash only");

    expect(await t.service.queue(VIEWER, { source: "sellers" }, 10)).toMatchObject({
      kind: "queue",
      count: 1,
      cards: [{ source: "sellers", key: "s1", stateHash: hash }],
    });
    // The question filter looks across the sources the worker runs now, the new one included.
    expect(await t.service.queue(VIEWER, { question: "scam" }, 10)).toMatchObject({
      kind: "queue",
      count: 2,
    });
    const opened = await t.service.open(VIEWER, { source: "sellers" }, undefined);
    expect(opened).toMatchObject({
      kind: "opened",
      card: { source: "sellers", key: "s1", stateHash: hash, open: [{ name: "scam" }] },
    });
    const card = { source: "sellers", key: "s1", stateHash: hash };
    expect(await t.service.renew(VIEWER, card)).toMatchObject({ kind: "renewed" });
    expect(await t.service.decide(VIEWER, card, { question: "scam", value: true })).toMatchObject({
      kind: "decided",
      status: "done",
      open: [],
    });
    expect(await t.service.queue(VIEWER, { source: "sellers" }, 10)).toMatchObject({
      kind: "queue",
      count: 0,
    });
  });

  it("forget a source a reload stopped, while the cards it left still say which source they are", async () => {
    const t = rig();
    t.starts("sellers");
    await t.seed("listings", "r1", "Free money, DM me");
    await t.seed("sellers", "s1", "New here, cash only");

    t.stops("listings");

    expect(await t.service.queue(VIEWER, { source: "listings" }, 10)).toEqual({
      kind: "unknown_source",
      source: "listings",
      known: ["sellers"],
    });
    expect(await t.service.queue(VIEWER, {}, 10)).toMatchObject({
      kind: "queue",
      count: 2,
      cards: [{ source: "listings" }, { source: "sellers" }],
    });
  });
});
