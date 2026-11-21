import type { DoctorCheck } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createDoctors } from "./doctor.ts";
import type { DashboardDoor, SourceFacts, StoppedSource } from "./door.ts";
import { createHomeService, type Home, SOURCE_STOPPED_TITLE } from "./home.ts";
import type { DashboardReads } from "./reads.ts";

/**
 * Home when a source's loop failed and it stopped alone: the worker no longer runs it, so it is
 * absent from the door's sources, and the door names it among the stopped ones with why and when it
 * is tried again. The sources check fails and says "<source> stopped: <why>. Trying again at
 * <time>."; what it says of the other sources is unchanged.
 */

const PROJECT = "marketplace";
const NOW = Date.UTC(2026, 10, 5, 14, 10);

const reads: DashboardReads = {
  lastHeartbeat: () => Promise.resolve(NOW - 2_400),
  monthTokens: () => Promise.resolve(0),
  modelFailing: () => Promise.resolve([]),
  recentAlerts: () => Promise.resolve([]),
  lastDeliveries: () => Promise.resolve(new Map()),
  answered: () => Promise.resolve(0),
  decided: () => Promise.resolve({ records: 0, reviewers: 0 }),
  queue: () => Promise.resolve({ waiting: 0, oldestSince: undefined }),
  lastChange: () => Promise.resolve(undefined),
  cursors: () => Promise.resolve([]),
  answeredUnder: () => Promise.resolve(0),
  backfillFinishedAt: () => Promise.resolve(undefined),
};

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });

/** A table source whose doctor answers the checks given. */
function source(name: string, checks: readonly DoctorCheck[]): SourceFacts {
  return {
    name,
    read: ["title"],
    questions: 1,
    version: 1,
    table: {
      database: "Postgres",
      capture: "trigger",
      pushWakeup: true,
      label: `public.${name}`,
      storage: "inline",
      answersIn: "columns",
      login: { kind: "user", user: "facetdb_worker", reach: "columns" },
      doctor: () => Promise.resolve(checks),
      estimateRows: () => Promise.resolve(null),
    },
  };
}

const HEALTHY = source("listings", [ok("database", "connected"), ok("install", "installed")]);
const REFUSED = "connect ECONNREFUSED 10.0.0.7:5432";

/** A source whose loop failed 30 seconds ago, tried again in 30 seconds. */
function stoppedSource(name: string, why: string): StoppedSource {
  return {
    source: name,
    why,
    since: new Date(NOW - 30_000).toISOString(),
    retryAt: new Date(NOW + 30_000).toISOString(),
  };
}

async function homeOf(
  sources: readonly SourceFacts[],
  stopped: readonly StoppedSource[],
): Promise<Home> {
  const clock = new FakeClock(NOW);
  const door: DashboardDoor = { projectId: PROJECT, cap: undefined, sources, stopped };
  const outcome = await createHomeService({
    door,
    reads,
    doctors: createDoctors(clock),
    clock,
  }).home(PROJECT);
  if (outcome.kind !== "home") {
    throw new Error("the project is the door's own");
  }
  return outcome.home;
}

const sourcesLine = (home: Home) => home.health.checks.find((check) => check.name === "sources");

describe("Home when a source stopped alone", () => {
  it("fails the sources check, naming the source, why and when it is tried again", async () => {
    const home = await homeOf([HEALTHY], [stoppedSource("orders", REFUSED)]);

    expect(sourcesLine(home)).toEqual({
      name: "sources",
      status: "fail",
      words: `orders stopped: ${REFUSED}. Trying again at 2026-11-05 14:10 UTC.`,
    });
    expect(home.health.status).toBe("attention");
    expect(home.health.words).toBe(SOURCE_STOPPED_TITLE);
    // The other source's own line is as it was.
    expect(home.health.sources).toEqual([
      { name: "listings", verdict: "healthy", words: "as installed" },
    ]);
  });

  it("fails it when the stopped source was the only one, its why said once with one stop", async () => {
    const home = await homeOf([], [stoppedSource("orders", `${REFUSED}.`)]);

    expect(sourcesLine(home)).toEqual({
      name: "sources",
      status: "fail",
      words: `orders stopped: ${REFUSED}. Trying again at 2026-11-05 14:10 UTC.`,
    });
  });

  it("names every stopped source, in the order given", async () => {
    const home = await homeOf(
      [HEALTHY],
      [stoppedSource("orders", REFUSED), stoppedSource("issues", "GitHub answered 503")],
    );

    expect(sourcesLine(home)?.words).toBe(
      `orders stopped: ${REFUSED}. Trying again at 2026-11-05 14:10 UTC. issues stopped: GitHub answered 503. Trying again at 2026-11-05 14:10 UTC.`,
    );
  });

  it("says a source its engine refused is not tried again until it is fixed", async () => {
    const locked = "SQLite allows one worker, and worker worker-2 holds the lock on orders";
    const home = await homeOf([HEALTHY], [{ ...stoppedSource("orders", locked), retryAt: null }]);

    expect(sourcesLine(home)?.words).toBe(
      `orders stopped: ${locked}. Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.`,
    );
  });

  it("says a stopped source after a failing one, whose words and title stay first", async () => {
    const lacks = "public.listings lacks the answer columns is_vehicle";
    const home = await homeOf(
      [
        source("listings", [
          ok("database", "connected"),
          { name: "install", status: "fail", detail: lacks, fix: "run facetdb migrate" },
        ]),
      ],
      [stoppedSource("orders", REFUSED)],
    );

    expect(sourcesLine(home)?.words).toBe(
      `The install is behind facetdb.config.ts. listings: ${lacks}. Run facetdb migrate --source listings, then restart facetdb worker. orders stopped: ${REFUSED}. Trying again at 2026-11-05 14:10 UTC.`,
    );
    expect(home.health.words).toBe("The install is behind facetdb.config.ts");
  });

  it("leaves the check as it was when no source stopped", async () => {
    const home = await homeOf([HEALTHY], []);

    expect(sourcesLine(home)).toEqual({
      name: "sources",
      status: "ok",
      words: "One source, reachable and installed",
    });
    expect(home.health.status).toBe("running");
  });
});
