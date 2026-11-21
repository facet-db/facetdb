import {
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type DoctorCheck,
  type EngineTarget,
  type InstallOptions,
  type PlanResult,
  reviewsOf,
  type SpendingGate,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeEngine,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import type { ReloadSummary } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  facetdb,
  noul,
  type ProjectConfig,
  type SourceConfig,
  score,
} from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import { createFleet, fileQueue, type SourceLoop } from "./config-reload.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";
import { installRuns, installVerdict } from "./install-check.ts";
import { createMigrateDoor } from "./migrate-door.ts";

/**
 * The studio's install of an added question over the fake engine: the plan printed byte for byte as
 * `facetdb migrate --source <name> --dry-run` prints the source's part (the real command, run
 * here); every change but questions added refused with the commands; the run only of the printout
 * shown, in Apply's queue, then the reload; a stop and a thrown run leave the source as it ran;
 * and, through a real fleet, a Postgres source (whose doctor cannot tell the worker login's rights)
 * switched by the reload that follows the run.
 */

const MARK_PASSWORD = "Adm1nS3cretMARK";
const MARK_USER = "admin_userMARK";
const ADMIN = `postgres://${MARK_USER}:${MARK_PASSWORD}@localhost:5432/app`;
const WORKER_URL = "postgres://facetdb_worker:worker-pw-WORKERMARK@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const PATH = "facetdb.config.ts";
const ENV = { DATABASE_URL: WORKER_URL, FACETDB_SECRET: "s".repeat(32) };

const SCAM = noul("Is this listing a scam?");
const VEHICLE = noul("Is it a vehicle?");

type Listings = Partial<Parameters<typeof facetdb>[0]["sources"][number]>;

/** The project as the loader makes it from `database: process.env.DATABASE_URL`. */
function project(listings: Listings = {}, more: readonly SourceConfig[] = []): ProjectConfig {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: SCAM },
        ...listings,
      },
      { name: "tickets", api: true, read: ["subject"], questions: { urgent: noul("Urgent?") } },
    ],
  });
  return {
    ...config,
    sources: [
      ...config.sources.map((source) =>
        source.api ? source : { ...source, databaseEnv: "DATABASE_URL" },
      ),
      ...more,
    ],
  };
}

/** What the worker runs: listings with is_scam alone. */
const RUNS = project();
/** What Apply wrote: is_vehicle added, nothing else. */
const ADDED = project({ questions: { is_scam: SCAM, is_vehicle: VEHICLE } });

const STATEMENTS = [
  'alter table "public"."listings" add column if not exists "is_vehicle" boolean',
  'grant update ("is_vehicle") on "public"."listings" to facetdb_worker',
];

function installPlan(statements: readonly string[], transactional: boolean): PlanResult {
  return {
    ok: true,
    plan: {
      statements: statements.map((text) => ({
        database: "source" as const,
        purpose: "columns" as const,
        text,
      })),
      transactional,
      removes: [],
      keeps: [],
      notes: ["the worker login reads title and writes only FacetDB's columns"],
    },
  };
}

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** A loop of `source` under `config`'s set, at `version`, its worker never run here. */
function loopOf(source: SourceConfig, config: ProjectConfig, version: number): SourceLoop {
  const clock = new FakeClock(0);
  const questionSet = questionSetOf(config, source);
  const connector = new FakeConnector(new FakeDatabase({ fields: source.read, clock }));
  return {
    source,
    questionSet,
    version,
    worker: createWorker({
      connector,
      provider: { ask: () => Promise.reject(new Error("these tests ask the model nothing")) },
      log: new FakeDecisionLog(),
      reviews: reviewsOf(new FakeReviewQueue(), source.name),
      actions: [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet,
      version,
      alerts: {
        modelCall: () => Promise.resolve(),
        beat: () => Promise.resolve(),
        backfillFinished: () => Promise.resolve(),
        backfillFailed: () => Promise.resolve(),
      },
      spending: UNLIMITED,
    }),
    connector,
    keyText: undefined,
    close: () => Promise.resolve(),
  };
}

/** The fake engine, whose run throws `thrown` instead when it is given (a connection lost). */
class MigrateEngine extends FakeEngine {
  thrown: unknown;

  override run(...args: Parameters<FakeEngine["run"]>): ReturnType<FakeEngine["run"]> {
    return this.thrown === undefined ? super.run(...args) : Promise.reject(this.thrown);
  }
}

function rig(file: ProjectConfig = ADDED) {
  const state = {
    file,
    statements: STATEMENTS as readonly string[],
    transactional: true,
    loadFails: false,
  };
  const installs: { target: EngineTarget; options: InstallOptions }[] = [];
  const engine = new MigrateEngine({
    name: "postgres",
    schemes: ["postgres", "postgresql"],
    label: (target) => `${target.schema ?? "public"}.${target.table}`,
    plans: {
      install: (target, options) => {
        installs.push({ target, options });
        return installPlan(state.statements, state.transactional);
      },
    },
  });
  const loops = new Map<string, SourceLoop>(
    RUNS.sources.map((source) => [source.name, loopOf(source, RUNS, 3)]),
  );
  const reloads: number[] = [];
  const ran: { readonly source: SourceConfig; readonly config: ProjectConfig }[] = [];
  const reload: ReloadSummary = {
    loaded: true,
    sources: [{ source: "listings", outcome: "restarted", version: 4, message: "switched" }],
    notes: [],
  };
  const serial = fileQueue();
  const door = createMigrateDoor({
    cli: {
      engines: [lazyEngine("postgres", () => Promise.resolve(engine))],
      env: ENV,
      clock: new FakeClock(Date.parse("2026-11-10T12:00:00Z")),
      connect: () => {
        throw new Error("the store shares the source's database here: nothing opens it");
      },
    },
    project: { id: "listings-app", name: "listings-app" },
    allowInsecureStore: false,
    path: PATH,
    load: () =>
      state.loadFails
        ? Promise.reject(new ConfigError([{ path: "sources.0.read", message: "is empty" }]))
        : Promise.resolve(state.file),
    running: (name) => loops.get(name),
    ran: (source, config) => {
      ran.push({ source, config });
    },
    reload: () => {
      reloads.push(1);
      return Promise.resolve(reload);
    },
    serial,
  });
  return { state, engine, installs, loops, reloads, ran, door, serial };
}

/** None of the admin string's marked parts, nor the worker's password, is in `text`. */
function expectNoSecret(text: string): void {
  for (const mark of [MARK_PASSWORD, MARK_USER, ADMIN, "worker-pw-WORKERMARK"]) {
    expect(text).not.toContain(mark);
  }
}

async function planned(t: ReturnType<typeof rig>, name = "listings") {
  const outcome = await t.door.plan(name, ADMIN);
  if (outcome.kind !== "planned") {
    throw new Error(`not planned: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("the migrate door's plan", () => {
  it("prints the source's part byte for byte as facetdb migrate --source --dry-run prints it", async () => {
    const t = rig();
    const outcome = await planned(t);
    const dry = await runInProcess(
      ["migrate", "--dry-run", "--source", "listings", "--admin-url", ADMIN],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        loadConfig: () => Promise.resolve(ADDED),
        engines: [lazyEngine("postgres", () => Promise.resolve(t.engine))],
        connect: () => {
          throw new Error("the store shares the source's database: migrate opens no store");
        },
      },
      COMMANDS,
    );
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toBe(`${outcome.sql}Dry run: nothing was changed.\n`);
    expect(outcome).toEqual({
      kind: "planned",
      engine: "postgres",
      table: "public.listings",
      sql: [
        "-- facetdb migrate: listings (public.listings)",
        "begin;",
        `${STATEMENTS[0]};`,
        `${STATEMENTS[1]};`,
        "commit;",
        "note: the worker login reads title and writes only FacetDB's columns",
        "",
      ].join("\n"),
      transactional: true,
      questions: ["is_vehicle"],
      storeElsewhere: false,
    });
    // The whole set as the file holds it now, and the worker's password from its variable.
    expect(
      t.installs.at(-1)?.target.questionSet.questions.map((question) => question.name),
    ).toEqual(["is_scam", "is_vehicle"]);
    expect(t.installs.at(-1)?.options.workerPassword).toBe("worker-pw-WORKERMARK");
    expect(t.engine.runs).toEqual([]);
    expectNoSecret(JSON.stringify(outcome));
  });

  it("refuses a name the file does not have, an API source, and a source the worker does not run", async () => {
    const sellers: SourceConfig = {
      ...ADDED.sources[0],
      name: "sellers",
      table: "sellers",
    } as SourceConfig;
    const t = rig(project({ questions: { is_scam: SCAM, is_vehicle: VEHICLE } }, [sellers]));
    expect(await t.door.plan("nope", ADMIN)).toMatchObject({
      kind: "refused",
      code: "unknown-source",
      fix: "pick one of: listings, tickets, sellers",
    });
    expect(await t.door.plan("tickets", ADMIN)).toMatchObject({
      kind: "refused",
      code: "api-source",
    });
    const started = await t.door.plan("sellers", ADMIN);
    expect(started).toMatchObject({ kind: "refused", code: "not-running" });
    expect(started.kind === "refused" && started.fix).toBe(
      "run facetdb migrate --source sellers on this machine (it prints the SQL first), then restart facetdb worker",
    );
    expect(t.installs).toEqual([]);
  });

  it("refuses every change but questions added, with the commands that make it from a terminal", async () => {
    const changes: readonly Listings[] = [
      // A question removed, with one added.
      { questions: { is_vehicle: VEHICLE } },
      // read changed, with a question added.
      { read: ["title", "description"], questions: { is_scam: SCAM, is_vehicle: VEHICLE } },
      // where, storage, the table.
      { where: "price > 0", questions: { is_scam: SCAM, is_vehicle: VEHICLE } },
      { storage: "side-table", questions: { is_scam: SCAM, is_vehicle: VEHICLE } },
      { table: "public.listings_v2", questions: { is_scam: SCAM, is_vehicle: VEHICLE } },
      // A type changed: the same name, now a score, beside a question added.
      { questions: { is_scam: score("How scammy?", ["low", "high"]), is_vehicle: VEHICLE } },
    ];
    for (const change of changes) {
      const t = rig(project(change));
      const outcome = await t.door.plan("listings", ADMIN);
      expect(outcome, JSON.stringify(change)).toMatchObject({
        kind: "refused",
        code: "migrate-by-hand",
      });
      expect(outcome.kind === "refused" && outcome.fix).toContain(
        "run facetdb migrate --source listings on this machine",
      );
      expect(outcome.kind === "refused" && outcome.fix).toContain("restart facetdb worker");
      expect(t.installs).toEqual([]);
    }
    // Nothing changed, or only the wording (a reload takes it): nothing to install.
    for (const file of [RUNS, project({ questions: { is_scam: noul("Is this a fraud?") } })]) {
      expect(await rig(file).door.plan("listings", ADMIN)).toMatchObject({
        kind: "refused",
        code: "nothing-to-install",
      });
    }
  });

  it("refuses an admin string of another kind of database, in the setup's words, before anything connects", async () => {
    const t = rig();
    const outcome = await t.door.plan("listings", `mysql://${MARK_USER}:${MARK_PASSWORD}@db/app`);
    expect(outcome).toMatchObject({ kind: "refused", code: "admin-url-scheme" });
    expect(outcome.kind === "refused" && outcome.message).toContain(
      "so the two name different kinds of database; nothing was connected",
    );
    expect(t.installs).toEqual([]);
  });

  it("says why a file that does not load cannot be installed from", async () => {
    const t = rig();
    t.state.loadFails = true;
    expect(await t.door.plan("listings", ADMIN)).toMatchObject({
      kind: "refused",
      code: "config_unreadable",
    });
  });
});

describe("the migrate door's run", () => {
  it("runs the plan shown, then asks the worker to reload, and writes no file", async () => {
    const t = rig();
    const shown = await planned(t);
    const outcome = await t.door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql });
    expect(outcome).toEqual({
      kind: "migrated",
      table: "public.listings",
      reload: {
        loaded: true,
        sources: [{ source: "listings", outcome: "restarted", version: 4, message: "switched" }],
        notes: [],
      },
    });
    expect(t.engine.runs).toHaveLength(1);
    expect(t.engine.runs[0]?.statements.map((statement) => statement.text)).toEqual(STATEMENTS);
    expect(t.engine.runs[0]?.workerPassword).toBe(true);
    expect(t.reloads).toHaveLength(1);
    // The run is told to the reload's check for the source as the file holds it.
    expect(t.ran.map((entry) => entry.source.questions.map((question) => question.name))).toEqual([
      ["is_scam", "is_vehicle"],
    ]);
    expect(t.ran[0]?.config).toBe(ADDED);
    expectNoSecret(JSON.stringify(outcome));
  });

  it("answers plan_changed and runs nothing when the printout is not the one shown", async () => {
    const t = rig();
    const shown = await planned(t);
    t.state.statements = [...STATEMENTS, "create index on public.listings (is_vehicle)"];
    expect(await t.door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql })).toEqual({
      kind: "plan_changed",
    });
    // Another engine than the plan's is another script.
    t.state.statements = STATEMENTS;
    expect(await t.door.run("listings", ADMIN, { engine: "mysql", sql: shown.sql })).toEqual({
      kind: "plan_changed",
    });
    expect(t.engine.runs).toEqual([]);
    expect(t.reloads).toEqual([]);
    expect(t.ran).toEqual([]);
  });

  it("refuses at the run what changed in the file since the plan: questions no longer only added", async () => {
    const t = rig();
    const shown = await planned(t);
    t.state.file = project({ read: ["title", "price"], questions: { is_vehicle: VEHICLE } });
    expect(
      await t.door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql }),
    ).toMatchObject({ kind: "refused", code: "migrate-by-hand" });
    expect(t.engine.runs).toEqual([]);
  });

  it("stops as the engine says, with no reload, so the source keeps the version it ran", async () => {
    const t = rig();
    const shown = await planned(t);
    t.engine.stopNextRunAt(1, {
      error: `permission denied for table listings (${MARK_USER} at worker-pw-WORKERMARK)`,
    });
    const outcome = await t.door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql });
    expect(outcome).toMatchObject({
      kind: "stopped",
      table: "public.listings",
      at: 1,
      purpose: "columns",
      known: true,
      transactional: true,
      why: { kind: "error" },
    });
    // The source's own password is hidden by the door; the admin's by the service.
    expect(JSON.stringify(outcome)).not.toContain("worker-pw-WORKERMARK");
    expect(t.reloads).toEqual([]);
    expect(t.ran).toEqual([]);
  });

  it("calls a run that threw unknown, and reloads nothing", async () => {
    const t = rig();
    const shown = await planned(t);
    t.engine.thrown = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outcome = await t.door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql });
    expect(outcome).toMatchObject({ kind: "stopped", known: false, at: null, kept: 0 });
    expect(t.reloads).toEqual([]);
    expect(t.ran).toEqual([]);
  });

  it("waits for a write of Apply's in the same queue before it plans again", async () => {
    const t = rig();
    const shown = await planned(t);
    let release: () => void = () => undefined;
    const order: string[] = [];
    const apply = t.serial(
      () =>
        new Promise<void>((done) => {
          release = () => {
            order.push("apply");
            done();
          };
        }),
    );
    const run = t.door
      .run("listings", ADMIN, { engine: shown.engine, sql: shown.sql })
      .then((outcome) => {
        order.push(outcome.kind);
      });
    await Promise.resolve();
    expect(t.engine.runs).toEqual([]);
    release();
    await Promise.all([apply, run]);
    expect(order).toEqual(["apply", "migrated"]);
  });
});

describe("the reload after the door's run", () => {
  /** What PostgreSQL's doctor reads under the worker login: the columns, and no rights check. */
  const POSTGRES_CHECKS: readonly DoctorCheck[] = [
    { name: "database", status: "ok", detail: "connected as facetdb_worker" },
    { name: "install", status: "ok", detail: "public.listings has FacetDB's columns" },
  ];

  it("switches a Postgres source the doctor alone cannot tell about, once, for the source as run", async () => {
    const t = rig();
    const runs = installRuns();
    const versions = new Map<string, number>([["listings", 3]]);
    const state: { file: ProjectConfig; checks: readonly DoctorCheck[] } = {
      file: ADDED,
      checks: POSTGRES_CHECKS,
    };
    const fleet = createFleet({
      open: (source, config) => {
        const version = (versions.get(source.name) ?? 0) + 1;
        versions.set(source.name, version);
        return Promise.resolve(loopOf(source, config, version));
      },
      installed: (source, config) =>
        Promise.resolve(installVerdict("Postgres", state.checks, runs.took(source, config))),
      load: () => Promise.resolve(state.file),
      beat: () => Promise.resolve(),
      // The swap's heartbeat waits for ever: nothing here runs the loops.
      clock: { sleep: () => new Promise(() => undefined) },
      print: () => undefined,
      onPass: () => () => undefined,
    });
    await fleet.open(RUNS);
    versions.set("listings", 3);

    // Without a run of the door's, the doctor cannot tell: the source waits for migrate and a restart.
    const before = await fleet.reload();
    expect(before.loaded && before.sources[0]).toMatchObject({ outcome: "kept" });
    expect(fleet.pending()[0]?.checkAgain).toBe(false);

    const door = createMigrateDoor({
      cli: {
        engines: [lazyEngine("postgres", () => Promise.resolve(t.engine))],
        env: ENV,
        clock: new FakeClock(0),
        connect: () => {
          throw new Error("no store here");
        },
      },
      project: { id: "listings-app", name: "listings-app" },
      allowInsecureStore: false,
      path: PATH,
      load: () => Promise.resolve(state.file),
      running: (name) => fleet.loop(name),
      ran: (source, config) => {
        runs.ran(source, config);
      },
      reload: () => fleet.reload(),
      serial: fileQueue(),
    });
    const shown = await door.plan("listings", ADMIN);
    if (shown.kind !== "planned") {
      throw new Error("not planned");
    }
    const outcome = await door.run("listings", ADMIN, { engine: shown.engine, sql: shown.sql });
    expect(outcome.kind === "migrated" && outcome.reload).toMatchObject({
      loaded: true,
      sources: [
        {
          source: "listings",
          outcome: "restarted",
          version: 4,
          message: expect.stringContaining("then answers with version 4"),
        },
        { source: "tickets", outcome: "unchanged", version: 1, message: null },
      ],
    });
    // The run is spent: it stood in for one reading only.
    expect(runs.took(ADDED.sources[0] as SourceConfig, ADDED)).toBe(false);
  });

  it("never stands in for columns the doctor finds missing", () => {
    const missing: readonly DoctorCheck[] = [
      { name: "install", status: "fail", detail: "public.listings lacks the column is_vehicle" },
    ];
    expect(installVerdict("Postgres", missing, true)).toEqual({
      kind: "missing",
      missing: "public.listings lacks the column is_vehicle",
    });
    expect(installVerdict("Postgres", [], true)).toMatchObject({ kind: "cannot-tell" });
  });

  it("is spent by the first reading, and is for the source as the file held it", () => {
    const runs = installRuns();
    const listings = ADDED.sources[0] as SourceConfig;
    runs.ran(listings, ADDED);
    const edited = project({ questions: { is_scam: SCAM, is_vehicle: noul("A car?") } });
    expect(runs.took(edited.sources[0] as SourceConfig, edited)).toBe(false);
    runs.ran(listings, ADDED);
    expect(runs.took(listings, ADDED)).toBe(true);
    expect(runs.took(listings, ADDED)).toBe(false);
  });
});
