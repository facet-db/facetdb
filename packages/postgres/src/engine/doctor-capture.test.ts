import type {
  DoctorCheck,
  EngineDeps,
  EnginePlan,
  EngineTarget,
  PlanResult,
  QuestionSet,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlConnect } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * The `capture` check beside `install` on PGlite: what means the install is gone (the trigger
 * dropped or disabled, the jobs table, the facetdb schema or the table itself gone, a catalog the
 * worker login may no longer read) fails `capture`, which the worker raises Connector lost access
 * on; what an install merely behind facetdb.config.ts lacks (an answer column, a trigger watching
 * other columns) fails `install` only, which raises nothing. Each fact keeps the words it had under
 * `install`, and the next migrate restores what `capture` missed. Read under the worker login, as
 * the worker reads it.
 */

const listings: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "Scam?", stakes: "high" }],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The same source with a question added in the file and not migrated yet. */
const withUrgency: QuestionSet = {
  ...listings,
  questions: [
    ...listings.questions,
    { type: "noul", name: "is_urgent", instructions: "Urgent?", stakes: "low" },
  ],
};

const ADMIN = "postgres://admin@localhost/app";
const WORKER_URL = "postgres://facetdb_worker:a-long-random-password@localhost/app";
const deps: EngineDeps = {
  clock: new FakeClock(10_000_000),
  allowInsecure: false,
  storeShared: false,
};
const REINSTALL = "run facetdb migrate: it prints the SQL first and installs what is missing";

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

const admin = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});

/** The worker login's connection: every statement runs as `facetdb_worker` on PGlite's one session. */
const asWorker: SqlConnect = () => ({
  query: async (text, params) => {
    await world.client.query("set role facetdb_worker");
    try {
      return await world.client.query(text, params);
    } finally {
      await world.client.query("reset role");
    }
  },
  transaction: (work) => world.client.transaction(work),
  pipeline: (text, paramSets) => world.client.pipeline(text, paramSets),
  close: () => Promise.resolve(),
});

const worker = createPostgresEngine({ connect: asWorker, pgHost: undefined });

function target(questionSet: QuestionSet = listings): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** `facetdb migrate` for the target, as the admin: the install, or what it lacks. */
async function migrate(questionSet: QuestionSet = listings): Promise<void> {
  const options = { ...deps, workerPassword: "a-long-random-password" };
  const plan = planOf(await admin.planInstall(target(questionSet), ADMIN, options));
  expect((await admin.run(target(questionSet), plan, ADMIN, options)).stopped).toBeUndefined();
}

async function installed(): Promise<void> {
  await world.client.query(
    "create table public.listings (id text primary key, title text, description text)",
  );
  await migrate();
}

/** The `capture` and `install` checks, as the worker login reads them. */
async function checksOf(questionSet: QuestionSet = listings) {
  const checks = await worker.doctor(target(questionSet), WORKER_URL, deps);
  const named = (name: string): DoctorCheck | undefined =>
    checks.find((check) => check.name === name);
  return { capture: named("capture"), install: named("install"), checks };
}

const CAPTURE_OK: DoctorCheck = {
  name: "capture",
  status: "ok",
  detail: "facetdb schema, jobs table and trigger are in place, the trigger enabled",
};
const INSTALL_OK: DoctorCheck = {
  name: "install",
  status: "ok",
  detail: "answer columns are in place, and the trigger watches the columns the questions read",
};

describe("doctor-capture: the install gone fails capture, an install behind the file fails install", () => {
  it("lists capture before install, and passes both on a fresh install", async () => {
    expect(worker.checks.map((check) => check.name)).toEqual([
      "database",
      "pooler",
      "capture",
      "install",
      "worker",
    ]);
    expect(worker.checks.find((check) => check.name === "capture")?.looksAt).toBe(
      "reads that changes are still queued: the facetdb schema, the jobs table and the trigger, present and enabled",
    );
    await installed();
    const { capture, install, checks } = await checksOf();
    expect(capture).toEqual(CAPTURE_OK);
    expect(install).toEqual(INSTALL_OK);
    // The order the worker's verdict reads them in: the first failure names the source's state.
    expect(checks.map((check) => check.name)).toEqual([
      "database",
      "pooler",
      "capture",
      "install",
      "worker",
    ]);
  });

  it("a dropped trigger fails capture in its words and passes install; the next migrate restores it", async () => {
    await installed();
    await world.client.query("drop trigger facetdb_listings on public.listings");
    const dropped = await checksOf();
    expect(dropped.capture).toEqual({
      name: "capture",
      status: "fail",
      detail:
        "listings: public.listings has no trigger facetdb_listings, so changes are not queued",
      fix: REINSTALL,
    });
    // With no trigger there is nothing it watches to judge: the install says only what it holds.
    expect(dropped.install).toEqual({
      name: "install",
      status: "ok",
      detail: "answer columns are in place",
    });

    await migrate();
    const restored = await checksOf();
    expect(restored.capture).toEqual(CAPTURE_OK);
    expect(restored.install).toEqual(INSTALL_OK);
  });

  it("a disabled trigger fails capture and passes install; the next migrate enables it again", async () => {
    await installed();
    await world.client.query("alter table public.listings disable trigger facetdb_listings");
    const disabled = await checksOf();
    expect(disabled.capture).toEqual({
      name: "capture",
      status: "fail",
      detail: "listings: the trigger facetdb_listings on public.listings is disabled",
      fix: REINSTALL,
    });
    expect(disabled.install).toEqual(INSTALL_OK);

    await migrate();
    expect((await checksOf()).capture).toEqual(CAPTURE_OK);
  });

  it("a dropped jobs table fails capture and passes install; the next migrate makes it again", async () => {
    await installed();
    await world.client.query("drop table facetdb.jobs");
    const gone = await checksOf();
    expect(gone.capture).toEqual({
      name: "capture",
      status: "fail",
      detail: "listings: the jobs table facetdb.jobs does not exist",
      fix: REINSTALL,
    });
    expect(gone.install).toEqual(INSTALL_OK);

    await migrate();
    expect((await checksOf()).capture).toEqual(CAPTURE_OK);
  });

  it("a dropped facetdb schema fails capture with each fact it took along", async () => {
    await installed();
    await world.client.query("drop schema facetdb cascade");
    const { capture, install } = await checksOf();
    expect(capture).toEqual({
      name: "capture",
      status: "fail",
      // The trigger's function lived in the schema, so the trigger went with it.
      detail:
        "listings: the facetdb schema does not exist; listings: public.listings has no trigger facetdb_listings, so changes are not queued",
      fix: REINSTALL,
    });
    expect(install).toEqual({
      name: "install",
      status: "ok",
      detail: "answer columns are in place",
    });
  });

  it("a table that is gone fails capture, and the install is not looked at", async () => {
    await installed();
    await world.client.query("drop table public.listings cascade");
    const { capture, install } = await checksOf();
    expect(capture).toEqual({
      name: "capture",
      status: "fail",
      detail: "listings: the table public.listings does not exist",
      fix: REINSTALL,
    });
    expect(install).toEqual({
      name: "install",
      status: "skip",
      detail: "not checked: the table does not exist",
    });
  });

  it("a catalog the worker login may no longer read fails capture: its right on the facetdb schema was revoked", async () => {
    await installed();
    await world.client.query("revoke usage on schema facetdb from facetdb_worker");
    const { capture, install } = await checksOf();
    expect(capture).toMatchObject({ name: "capture", status: "fail", fix: REINSTALL });
    expect(capture?.detail).toMatch(
      /^listings: the catalog could not be read as facetdb_worker: permission denied for schema facetdb/,
    );
    expect(install).toEqual({
      name: "install",
      status: "skip",
      detail: "not checked: the catalog could not be read as facetdb_worker",
    });
  });

  it("an added question fails install only, and the migrate that installs it passes both", async () => {
    await installed();
    const behind = await checksOf(withUrgency);
    expect(behind.capture).toEqual(CAPTURE_OK);
    expect(behind.install).toEqual({
      name: "install",
      status: "fail",
      detail: "listings: public.listings lacks the answer columns is_urgent, is_urgent_probability",
      fix: REINSTALL,
    });

    await migrate(withUrgency);
    const forward = await checksOf(withUrgency);
    expect(forward.capture).toEqual(CAPTURE_OK);
    expect(forward.install).toEqual(INSTALL_OK);
  });

  it("a trigger watching other columns than the questions read fails install only", async () => {
    await installed();
    const narrower: QuestionSet = { ...listings, read: ["title"] };
    const { capture, install } = await checksOf(narrower);
    expect(capture).toEqual(CAPTURE_OK);
    expect(install).toEqual({
      name: "install",
      status: "fail",
      detail:
        "listings: the trigger on public.listings watches description,title, not the columns the questions read (title)",
      fix: REINSTALL,
    });
  });

  it("a dropped trigger on an install also behind the file fails both, capture first", async () => {
    await installed();
    await world.client.query("drop trigger facetdb_listings on public.listings");
    const { checks } = await checksOf(withUrgency);
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.name);
    // The worker's verdict reads the first failure: the dropped trigger, never the added question.
    expect(failed[0]).toBe("capture");
    expect(failed).toContain("install");
  });
});
