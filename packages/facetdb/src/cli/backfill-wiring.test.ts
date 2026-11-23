import { createBackfill } from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../config/index.ts";
import { wireBackfill } from "./backfill-wiring.ts";
import { createStore, freshPglite, TEST_SECRET } from "./testing.ts";

/**
 * `wireBackfill` over the real store on PGlite: a backfill page lands in the store's run log named
 * as a backfill of its source, which `GET /v1/runs` reads.
 */

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:worker-password@localhost:5432/app",
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

let pglite: Awaited<ReturnType<typeof freshPglite>>;

beforeAll(async () => {
  pglite = await freshPglite();
});

afterAll(async () => {
  await pglite.close();
});

describe("the backfill's wiring", () => {
  it("writes a run row per page that queued a record, named as a backfill of the source", async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 5, 14, 0, 0));
    const store = await createStore({ pglite, secret: TEST_SECRET, clock });
    try {
      const db = new FakeDatabase({ fields: ["title"], clock, pageSize: 2 });
      for (const key of ["r1", "r2", "r3"]) {
        db.edit(key, { title: `Listing ${key}` });
      }
      const connector = new FakeConnector(db);
      await connector.install();
      const [source] = config.sources;
      if (source === undefined) {
        throw new Error("the test config has a source");
      }
      const deps = await wireBackfill({
        config,
        source,
        project: { id: "listings-app", name: "listings-app" },
        store,
        connector,
        provider: {
          ask: () => Promise.reject(new Error("a whole-set run asks the model nothing")),
        },
        clock,
        random: () => 0,
        channels: [],
        report: () => undefined,
      });

      const report = await createBackfill(deps).run({ onEstimate: () => true });

      expect(report.status).toBe("completed");
      const runs = await store.runs.page({
        projectId: "listings-app",
        source: "listings",
        limit: 50,
        offset: 0,
      });
      // Newest first: the second page (r1) after the first (r3, r2). A whole-set page only queues;
      // the worker's passes answer the records and write rows of their own.
      expect(runs.map((run) => [run.source, run.kind, run.claimed, run.answered])).toEqual([
        ["listings", "backfill", 1, 0],
        ["listings", "backfill", 2, 0],
      ]);
    } finally {
      await store.close();
    }
  });
});
