import type { AlertEvent } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { pgliteClient, sourceIdOf } from "@facetdb/postgres";
import {
  createMemoryStore,
  freshPglite,
  type PGlite,
  resetPglite,
} from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDashboardReads } from "./reads.ts";

/**
 * The Home and Sources reads against the real store schema on PGlite: the store's own writers
 * (heartbeat, usage, alerts, cursors) and plain inserts where the writer is another module's (the
 * review queue, the run log, the decision log), each read scoped to its project and sources.
 */

const NOW = Date.UTC(2026, 10, 5, 14, 10);
const TODAY = Date.UTC(2026, 10, 5);
const DAY_MS = 24 * 60 * 60_000;
const PROJECT = "marketplace";
const LISTINGS = sourceIdOf(PROJECT, "listings");
const MESSAGES = sourceIdOf(PROJECT, "support_messages");
const ELSEWHERE = sourceIdOf("another", "listings");

let pglite: PGlite;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

async function rig() {
  const memory = await createMemoryStore(new FakeClock(NOW), pglite);
  closers.push(() => memory.close());
  const client = pgliteClient(pglite);
  return { store: memory.store, client, reads: createDashboardReads(client) };
}

const event = (overrides: Partial<AlertEvent> & Pick<AlertEvent, "kind">): AlertEvent => ({
  what: "Something happened.",
  project: PROJECT,
  source: "listings",
  question: null,
  did: "Nothing.",
  link: "https://docs.facetdb.dev/fix/worker",
  ...overrides,
});

describe("the dashboard's reads of the store", () => {
  it("read the heartbeat and the month's usage of the project", async () => {
    const { store, reads } = await rig();
    expect(await reads.lastHeartbeat(PROJECT)).toBeUndefined();
    await store.alerts.saveHeartbeat(PROJECT, NOW - 2_000);
    await store.alerts.saveHeartbeat("another", NOW);
    expect(await reads.lastHeartbeat(PROJECT)).toBe(NOW - 2_000);

    expect(await reads.monthTokens(PROJECT, "2026-11")).toBe(0);
    await store.usage.add(PROJECT, "2026-11", 76_190_477);
    await store.usage.add(PROJECT, "2026-10", 5);
    await store.usage.add("another", "2026-11", 9);
    expect(await reads.monthTokens(PROJECT, "2026-11")).toBe(76_190_477);
  });

  it("read the project's active model-failing alerts and its newest alert history, newest first", async () => {
    const { store, reads } = await rig();
    const failing = event({
      kind: "model_failing",
      what: "6 of 100 model calls failed in the last 5 minutes.",
    });
    await store.alerts.setActive("model_failing|marketplace|listings|", {
      event: failing,
      raisedAt: NOW,
      lastSentAt: NOW,
    });
    await store.alerts.setActive("worker_not_running|marketplace|listings|", {
      event: event({ kind: "worker_not_running" }),
      raisedAt: NOW,
      lastSentAt: NOW,
    });
    await store.alerts.setActive("model_failing|another|listings|", {
      event: event({ kind: "model_failing", project: "another" }),
      raisedAt: NOW,
      lastSentAt: NOW,
    });
    expect(await reads.modelFailing(PROJECT)).toEqual([failing]);

    for (let minute = 0; minute < 12; minute += 1) {
      await store.alerts.append({
        at: NOW + minute * 60_000,
        key: `backfill_finished|marketplace|listings|`,
        phase: "raised",
        severity: "information",
        event: event({ kind: "backfill_finished", what: `run ${minute}` }),
        delivered: true,
      });
    }
    await store.alerts.append({
      at: NOW + 99 * 60_000,
      key: "backfill_finished|another|listings|",
      phase: "raised",
      severity: "information",
      event: event({ kind: "backfill_finished", project: "another" }),
      delivered: true,
    });
    const recent = await reads.recentAlerts(PROJECT, 10);
    expect(recent.map((record) => record.event.what)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((minute) => `run ${minute}`),
    );
    expect(await reads.backfillFinishedAt(PROJECT, "listings")).toBe(NOW + 11 * 60_000);
    expect(await reads.backfillFinishedAt(PROJECT, "support_messages")).toBeUndefined();
  });

  it("count the log by UTC day, answers and people's decisions apart, for the sources named", async () => {
    const { client, reads } = await rig();
    const log = async (source: string, key: string, at: number, human?: string) => {
      await client.query(
        human === undefined
          ? `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
             values ($1, $2, 'answer', 3, 'h', 'jev-1.14.0', '{}'::jsonb, '{}'::jsonb, to_timestamp($3::double precision / 1000))`
          : `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, question, value, reviewer, at)
             values ($1, $2, 'human', 3, 'h', 'is_scam', 'true'::jsonb, $4, to_timestamp($3::double precision / 1000))`,
        human === undefined ? [source, key, at] : [source, key, at, human],
      );
    };
    await log(LISTINGS, "1", TODAY);
    await log(LISTINGS, "2", TODAY + DAY_MS - 1);
    await log(MESSAGES, "1", NOW);
    await log(LISTINGS, "3", TODAY - 1);
    await log(LISTINGS, "4", TODAY + DAY_MS);
    await log(ELSEWHERE, "1", NOW);
    await log(LISTINGS, "1", NOW, "hailey");
    await log(LISTINGS, "1", NOW, "hailey");
    await log(MESSAGES, "7", NOW, "abebe");
    await log(LISTINGS, "9", TODAY - 1, "hailey");

    const today = { from: TODAY, to: TODAY + DAY_MS };
    expect(await reads.answered([LISTINGS, MESSAGES], today)).toBe(3);
    expect(await reads.answered([LISTINGS, MESSAGES], { from: TODAY - DAY_MS, to: TODAY })).toBe(1);
    expect(await reads.answered([], today)).toBe(0);
    expect(await reads.decided([LISTINGS, MESSAGES], today)).toEqual({ records: 2, reviewers: 2 });
    // Records answered under a version: each record once, however often it was asked.
    await log(LISTINGS, "1", NOW + 1);
    expect(await reads.answeredUnder(LISTINGS, 3)).toBe(4);
    expect(await reads.answeredUnder(LISTINGS, 2)).toBe(0);
  });

  it("read the review queue's size and its oldest card for the sources named", async () => {
    const { client, reads } = await rig();
    expect(await reads.queue([LISTINGS])).toEqual({ waiting: 0, oldestSince: undefined });
    const card = (source: string, key: string, since: number) =>
      client.query(
        `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
         values ($1, $2, 'h', '["is_scam"]'::jsonb, '{}'::jsonb, to_timestamp($3::double precision / 1000))`,
        [source, key, since],
      );
    await card(LISTINGS, "1", NOW - 14 * 60_000);
    await card(LISTINGS, "2", NOW - 60_000);
    await card(MESSAGES, "1", NOW);
    await card(ELSEWHERE, "1", NOW - DAY_MS);
    expect(await reads.queue([LISTINGS, MESSAGES])).toEqual({
      waiting: 3,
      oldestSince: NOW - 14 * 60_000,
    });
  });

  it("read the last change from the run log's newest pass that claimed something", async () => {
    const { client, reads } = await rig();
    expect(await reads.lastChange(LISTINGS)).toBeUndefined();
    const run = (source: string, started: number, claimed: number) =>
      client.query(
        `insert into facetdb.runs (source_id, started_at, ended_at, claimed, answered, to_review, errors, discarded, tokens)
         values ($1, to_timestamp($2::double precision / 1000), to_timestamp($2::double precision / 1000), $3, $3, 0, 0, 0, 0)`,
        [source, started, claimed],
      );
    await run(LISTINGS, NOW - 60_000, 2);
    await run(LISTINGS, NOW - 12_000, 1);
    await run(LISTINGS, NOW - 1_000, 0);
    await run(ELSEWHERE, NOW, 5);
    expect(await reads.lastChange(LISTINGS)).toBe(NOW - 12_000);
  });

  it("read the backfill cursors under a run key's prefix", async () => {
    const { store, reads } = await rig();
    await store.cursors.save(`backfill:${PROJECT}:listings:all@v3`, { cursor: "{}", done: false });
    await store.cursors.save(`backfill:${PROJECT}:listings:all@v2`, { cursor: null, done: true });
    await store.cursors.save(`backfill:${PROJECT}:messages:all@v1`, { cursor: null, done: true });
    await store.cursors.save("mongo:listings", { cursor: "token", done: false });
    expect(await reads.cursors(`backfill:${PROJECT}:listings:`)).toEqual([
      { run: `backfill:${PROJECT}:listings:all@v2`, done: true },
      { run: `backfill:${PROJECT}:listings:all@v3`, done: false },
    ]);
  });
});
