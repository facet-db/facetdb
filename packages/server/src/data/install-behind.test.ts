import type { DoctorCheck } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createDoctors } from "./doctor.ts";
import type { DashboardDoor, SourceFacts } from "./door.ts";
import { createHomeService, type Home } from "./home.ts";
import type { DashboardReads } from "./reads.ts";
import { createSourcesService } from "./sources.ts";

/**
 * Home's sentence for a source whose database answers but lacks what facetdb.config.ts asks for:
 * someone added a question, did not migrate, and read "Connector lost access". The doctor's verdict
 * says which check failed, so only the install check reads as a missing install.
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
const fail = (name: string, detail: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix: "run facetdb migrate",
});
const skip = (name: string): DoctorCheck => ({
  name,
  status: "skip",
  detail: "not checked: the database check did not pass",
});

const LACKS = "public.listings lacks the answer columns is_vehicle, is_vehicle_probability";

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

async function homeOf(...sources: SourceFacts[]): Promise<Home> {
  const clock = new FakeClock(NOW);
  const door: DashboardDoor = { projectId: PROJECT, cap: undefined, sources, stopped: [] };
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

describe("Home when a source's install is behind facetdb.config.ts", () => {
  it("says the install is behind, names the source, what is missing and the command, not that the connector lost access", async () => {
    const home = await homeOf(
      source("listings", [
        ok("database", "logged in as facetdb_worker: listings on db.example.com/app"),
        fail("install", `listings: ${LACKS}`),
      ]),
    );

    expect(home.health.words).toBe("The install is behind facetdb.config.ts");
    expect(sourcesLine(home)).toEqual({
      name: "sources",
      status: "fail",
      words: `The install is behind facetdb.config.ts. listings: ${LACKS}. Run facetdb migrate --source listings, then restart facetdb worker.`,
    });
    expect(JSON.stringify(home)).not.toContain("Connector lost access");
  });

  it("names the source once when doctor's words do not start with it", async () => {
    const home = await homeOf(
      source("listings", [ok("database", "connected"), fail("install", LACKS)]),
    );

    expect(sourcesLine(home)?.words).toBe(
      `The install is behind facetdb.config.ts. listings: ${LACKS}. Run facetdb migrate --source listings, then restart facetdb worker.`,
    );
  });

  it("keeps the failing verdict of the source in the Sources list, as before", async () => {
    const home = await homeOf(
      source("listings", [ok("database", "connected"), fail("install", LACKS)]),
    );

    expect(home.health.sources).toEqual([{ name: "listings", verdict: "failing", words: LACKS }]);
  });

  it("still says Connector lost access for a failing login, grant or connection", async () => {
    const home = await homeOf(
      source("listings", [
        fail("database", '"listings" cannot connect to db: Access denied for user facetdb_worker'),
        skip("install"),
      ]),
      source("orders", [ok("database", "connected"), fail("grants", "orders: no SELECT on note")]),
    );

    expect(home.health.words).toBe("Connector lost access");
    expect(sourcesLine(home)?.words).toBe(
      'Connector lost access. listings: "listings" cannot connect to db: Access denied for user facetdb_worker orders: orders: no SELECT on note',
    );
    expect(JSON.stringify(home)).not.toContain("The install is behind");
  });

  it("says both when one source lost access and another's install is behind, the lost access naming the state", async () => {
    const home = await homeOf(
      source("listings", [ok("database", "connected"), fail("install", `listings: ${LACKS}`)]),
      source("orders", [fail("database", "orders cannot connect"), skip("install")]),
    );

    expect(home.health.words).toBe("Connector lost access");
    expect(sourcesLine(home)?.words).toBe(
      `Connector lost access. orders: orders cannot connect The install is behind facetdb.config.ts. listings: ${LACKS}. Run facetdb migrate --source listings, then restart facetdb worker.`,
    );
  });

  it("says a dropped trigger is Connector lost access in the capture check's words, never an install behind", async () => {
    const dropped =
      "listings: public.listings has no trigger facetdb_listings, so changes are not queued";
    const home = await homeOf(
      source("listings", [
        ok("database", "connected"),
        fail("capture", dropped),
        ok("install", "answer columns are in place"),
      ]),
    );

    expect(home.health.words).toBe("Connector lost access");
    expect(sourcesLine(home)?.words).toBe(`Connector lost access. listings: ${dropped}`);
    expect(JSON.stringify(home)).not.toContain("The install is behind");

    // A question added on top: the capture fails first, so the source has still lost access.
    const both = await homeOf(
      source("listings", [
        ok("database", "connected"),
        fail("capture", dropped),
        fail("install", `listings: ${LACKS}`),
      ]),
    );
    expect(both.health.words).toBe("Connector lost access");
    expect(sourcesLine(both)?.words).toBe(`Connector lost access. listings: ${dropped}`);
  });

  it("shows the capture's failure on the Sources page's install line, and the install's otherwise", async () => {
    const dropped =
      "listings: public.listings has no trigger facetdb_listings, so changes are not queued";
    const clock = new FakeClock(NOW);
    const sourcesOf = async (...facts: SourceFacts[]) => {
      const outcome = await createSourcesService({
        door: { projectId: PROJECT, cap: undefined, sources: facts, stopped: [] },
        reads,
        doctors: createDoctors(clock),
        clock,
      }).sources(PROJECT);
      if (outcome.kind !== "sources") {
        throw new Error("the project is the door's own");
      }
      return outcome.sources.map((row) => [row.name, row.verdict, row.install]);
    };

    expect(
      await sourcesOf(
        source("listings", [
          ok("database", "connected"),
          fail("capture", dropped),
          ok("install", "answer columns are in place"),
        ]),
        source("orders", [
          ok("database", "connected"),
          ok("capture", "in place"),
          fail("install", LACKS),
        ]),
        source("offers", [ok("database", "connected"), skip("capture"), skip("install")]),
      ),
    ).toEqual([
      ["listings", "failing", { status: "fail", words: dropped }],
      ["orders", "failing", { status: "fail", words: LACKS }],
      [
        "offers",
        "healthy",
        { status: "skip", words: "not checked: the database check did not pass" },
      ],
    ]);
  });

  it("gives each source behind its own command", async () => {
    const home = await homeOf(
      source("listings", [ok("database", "connected"), fail("install", "listings is behind")]),
      source("orders", [ok("database", "connected"), fail("install", "orders is behind")]),
    );

    expect(sourcesLine(home)?.words).toBe(
      "The install is behind facetdb.config.ts. listings: listings is behind. Run facetdb migrate --source listings, then restart facetdb worker. orders: orders is behind. Run facetdb migrate --source orders, then restart facetdb worker.",
    );
  });
});
