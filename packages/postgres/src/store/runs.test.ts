import { RUN_LOG_RETENTION_MS, type Run } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { BACKFILL_RUN_MARK, type StoredRun } from "./runs.ts";
import { sourceIdOf } from "./source-id.ts";
import { newStore, scalar, useStoreWorld } from "./store-world.ts";

/**
 * `facetdb.runs` on PGlite: one insert per run, one delete per prune that keeps every row younger
 * than 30 days, and the page newest first, a project's own sources only, a backfill page told from
 * a pass.
 */

useStoreWorld();

const PROJECT = "listings-app";
const NOW = Date.UTC(2026, 10, 5, 14, 0, 0);

function run(source: string, startedAtMs: number, extra: Partial<Run> = {}): Run {
  return {
    source,
    kind: "pass",
    startedAt: new Date(startedAtMs),
    endedAt: new Date(startedAtMs + 1_900),
    claimed: 20,
    answered: 18,
    toReview: 2,
    errors: 0,
    discarded: 0,
    tokens: 14_900,
    ...extra,
  };
}

async function storeWithSources(projects: readonly { id: string; sources: readonly string[] }[]) {
  const world = await newStore();
  for (const project of projects) {
    await world.store.ensureProject({ id: project.id, name: project.id });
    for (const name of project.sources) {
      await world.store.ensureSource({ projectId: project.id, name, kind: "plugin" });
    }
  }
  return world;
}

const page = (source?: string, limit = 50, offset = 0) => ({
  projectId: PROJECT,
  source,
  limit,
  offset,
});

describe("the run log in the store", () => {
  it("writes one row per run, every count as given, and reads it back with the source's name", async () => {
    const { store, db } = await storeWithSources([{ id: PROJECT, sources: ["listings"] }]);
    const written = run(sourceIdOf(PROJECT, "listings"), NOW, {
      errors: 1,
      discarded: 3,
      tokens: 9_007_199_254,
    });

    await store.runs.record(written);

    expect(await scalar(db, "select count(*)::int from facetdb.runs")).toBe(1);
    expect(await store.runs.page(page())).toEqual([
      {
        source: "listings",
        kind: "pass",
        startedAt: new Date(NOW),
        endedAt: new Date(NOW + 1_900),
        claimed: 20,
        answered: 18,
        toReview: 2,
        errors: 1,
        discarded: 3,
        tokens: 9_007_199_254,
      } satisfies StoredRun,
    ]);
  });

  it("tells a backfill page from a pass of the same source", async () => {
    const { store, db } = await storeWithSources([{ id: PROJECT, sources: ["listings"] }]);
    const id = sourceIdOf(PROJECT, "listings");

    await store.runs.record(run(id, NOW, { kind: "backfill", claimed: 500 }));
    await store.runs.record(run(id, NOW + 1_000));

    expect(
      await scalar(db, "select string_agg(source_id, ',' order by id) from facetdb.runs"),
    ).toBe(`${id}${BACKFILL_RUN_MARK},${id}`);
    expect(
      (await store.runs.page(page())).map((stored) => [stored.source, stored.kind, stored.claimed]),
    ).toEqual([
      ["listings", "pass", 20],
      ["listings", "backfill", 500],
    ]);
  });

  it("pages newest first, one source or all, and only the key's own project", async () => {
    // A project whose id begins with the first's and a colon: a prefix match would show its runs.
    const { store } = await storeWithSources([
      { id: PROJECT, sources: ["listings", "messages"] },
      { id: `${PROJECT}:listings`, sources: ["x"] },
    ]);
    await store.runs.record(run(sourceIdOf(PROJECT, "listings"), NOW));
    await store.runs.record(run(sourceIdOf(PROJECT, "messages"), NOW + 2_000));
    await store.runs.record(
      run(sourceIdOf(PROJECT, "listings"), NOW + 1_000, { kind: "backfill" }),
    );
    await store.runs.record(run(sourceIdOf(`${PROJECT}:listings`, "x"), NOW + 3_000));

    const all = await store.runs.page(page());
    expect(all.map((stored) => [stored.source, stored.startedAt.getTime() - NOW])).toEqual([
      ["messages", 2_000],
      ["listings", 1_000],
      ["listings", 0],
    ]);
    const listings = await store.runs.page(page("listings"));
    expect(listings.map((stored) => stored.kind)).toEqual(["backfill", "pass"]);
    expect(await store.runs.page(page("nothing"))).toEqual([]);

    const second = await store.runs.page(page(undefined, 2, 2));
    expect(second.map((stored) => stored.startedAt.getTime() - NOW)).toEqual([0]);
  });

  it("prunes with one delete, and never a row younger than 30 days", async () => {
    const { store, db } = await storeWithSources([{ id: PROJECT, sources: ["listings"] }]);
    const id = sourceIdOf(PROJECT, "listings");
    const cutoff = NOW - RUN_LOG_RETENTION_MS;
    // Ended a millisecond before the cutoff, at it, and a day after.
    await store.runs.record(run(id, cutoff - 1_901));
    await store.runs.record(run(id, cutoff - 1_900));
    await store.runs.record(run(id, cutoff + 86_400_000));

    await store.runs.prune(new Date(cutoff));

    expect(
      await scalar(
        db,
        `select string_agg((extract(epoch from ended_at) * 1000)::bigint::text, ',' order by id)
           from facetdb.runs`,
      ),
    ).toBe(`${cutoff},${cutoff + 86_400_000 + 1_900}`);
  });
});
