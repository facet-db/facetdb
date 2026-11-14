import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  QuestionSet,
  RunResult,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { expect } from "vitest";
import { FakeMongo, type FakePrivilege } from "../testing/index.ts";
import { planInstall } from "./install.ts";
import { runPlan } from "./run.ts";

/**
 * What install.test.ts, uninstall.test.ts and prune.test.ts share: the listings example as every
 * engine's fixture takes it (the Postgres engine's install.listings.test.ts), the admin connection
 * string of a server on this machine, and a fake server with the collection, or with the whole
 * install run on it through the plan's own commands.
 */

export const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

export const PROJECT = { id: "proj_listings", name: "Listings" };

/** The admin connection string: a server on this machine, the source's database in its path. */
export const ADMIN = "mongodb://127.0.0.1:27017/app";

export const PASSWORD = "a-long-random-password";

export const deps: EngineDeps = {
  clock: new FakeClock(0),
  allowInsecure: false,
  storeShared: false,
};

export const installOptions: InstallOptions = { ...deps, workerPassword: PASSWORD };

/** The commands a plan may send: reads, and nothing that changes the server. */
export const READS: ReadonlySet<string> = new Set([
  "hello",
  "listIndexes",
  "rolesInfo",
  "usersInfo",
  "aggregate",
  "find",
]);

export function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: PROJECT,
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    urlVariable: "LISTINGS_URL",
    ...overrides,
  };
}

export function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

export function refusalOf(result: PlanResult) {
  if (result.ok) {
    throw new Error(`planned ${JSON.stringify(result.plan.statements)}`);
  }
  return result.refusal;
}

/** A replica set's primary with the application's collection `app.listings` and nothing of FacetDB's. */
export function freshServer(): FakeMongo {
  return new FakeMongo().collection("app", "listings");
}

/** Runs a plan with the worker's password and expects it to finish. */
export async function runToEnd(
  server: FakeMongo,
  plan: EnginePlan,
  on: EngineTarget = target(),
): Promise<RunResult> {
  const result = await runPlan(server.connect, on, plan, ADMIN, {
    ...deps,
    workerPassword: PASSWORD,
  });
  expect(result.stopped).toBeUndefined();
  return result;
}

/** A server the listings install ran on, through the plan's own commands. */
export async function installedServer(on: EngineTarget = target()): Promise<FakeMongo> {
  const server = freshServer().collection("app", on.table);
  await runToEnd(server, planOf(await planInstall(server.connect, on, ADMIN, installOptions)), on);
  return server;
}

/** The worker's rights on `app.<collection>`, as the role FacetDB makes holds them. */
export function rights(collection: string, database = "app"): readonly FakePrivilege[] {
  return [
    { resource: { db: database, collection }, actions: ["find", "update", "changeStream"] },
    {
      resource: { db: database, collection: "facetdb_jobs" },
      actions: ["find", "insert", "update", "remove"],
    },
    { resource: { db: database, collection: "facetdb_meta" }, actions: ["find"] },
  ];
}
