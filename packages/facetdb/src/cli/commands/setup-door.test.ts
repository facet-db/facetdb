import type {
  EngineTarget,
  InstallOptions,
  ModelProvider,
  PlanResult,
  SpendingGate,
} from "@facetdb/core";
import { FakeClock, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import type { ReloadSummary, SourceDraft } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  type GitState,
  noul,
  type ProjectConfig,
  planApply,
} from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import { CURRENT_STORE, type SqlConnect, storeAtVersions } from "../testing.ts";
import { fileQueue } from "./config-reload.ts";
import { COMMANDS } from "./index.ts";
import { STORE_CURRENT } from "./migrate.ts";
import { createSetupDoor, registeredDatabases } from "./setup-door.ts";

/**
 * The setup flow's door over the fake engine and a config file in memory: the tables and rows an
 * inspection finds, a preview through the admin connection, the plan printed exactly as `facetdb
 * migrate --dry-run` prints it for the same source (run here, the real command), and the install in
 * its order: the file written, then the plan run, the file put back when nothing stays. The admin
 * string's marked parts reach no print line and no file.
 */

const MARK_PASSWORD = "Adm1nS3cretMARK";
const MARK_USER = "admin_userMARK";
const ADMIN = `postgres://${MARK_USER}:${MARK_PASSWORD}@localhost:5432/app`;
const WORKER_URL = "postgres://facetdb_worker:worker-pw-WORKERMARK@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const PATH = "facetdb.config.ts";
const ENV = { DATABASE_URL: WORKER_URL, FACETDB_SECRET: "s".repeat(32) };

const DECLARED = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "orders",
      database: WORKER_URL,
      table: "orders",
      read: ["note"],
      questions: { is_fraud: noul("Is this order fraud?") },
    },
  ],
});

/** As the loader reads the file the exporter writes, `database: env("DATABASE_URL")`. */
const CONFIG: ProjectConfig = {
  ...DECLARED,
  sources: DECLARED.sources.map((source) => ({
    ...source,
    databaseEnv: "DATABASE_URL",
    databaseEnvNamed: true as const,
  })),
};
const TEXT = configFileSource(CONFIG);

const DRAFT: SourceDraft = {
  name: "listings",
  table: "listings",
  database: { env: "DATABASE_URL" },
  read: ["title"],
  storage: "inline",
  questions: {
    is_scam: { type: "noul", instructions: "Is this listing likely a scam?", stakes: "high" },
  },
  thresholds: {},
};

const SCRIPT_STATEMENTS = [
  "alter table public.listings add column is_scam boolean",
  "create trigger facetdb_listings after insert or update of title on public.listings",
];

function installPlan(statements: readonly string[], transactional = true): PlanResult {
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

type Rig = {
  readonly engine: SetupEngine;
  readonly database: FakeDatabase;
  readonly files: ConfigFiles & { text: string; git: GitState; readonly writes: string[] };
  readonly printed: string[];
  readonly reloads: number[];
  /** Every install the door said it ran to its end: the source, and whether the config named it. */
  readonly ran: { readonly source: string; readonly inFile: boolean }[];
  readonly reloadFails: { failing: boolean };
  readonly door: ReturnType<typeof createSetupDoor>;
  readonly installs: { target: EngineTarget; options: InstallOptions }[];
  statements: readonly string[];
  transactional: boolean;
};

/** The fake engine, whose run throws `thrown` instead when it is given (a connection lost). */
class SetupEngine extends FakeEngine {
  thrown: unknown;
  /** Runs as the install starts, before its statements: an edit of the file meanwhile, say. */
  beforeRun: (() => void) | undefined;

  override run(...args: Parameters<FakeEngine["run"]>): ReturnType<FakeEngine["run"]> {
    this.beforeRun?.();
    return this.thrown === undefined ? super.run(...args) : Promise.reject(this.thrown);
  }
}

function rig(extraEnv: Readonly<Record<string, string>> = {}): Rig {
  const clock = new FakeClock(Date.parse("2026-11-06T12:00:00Z"));
  const database = new FakeDatabase({ fields: ["title"], clock });
  for (const [key, title] of [
    ["1", "Oak table"],
    ["2", "iPhone 15, pay by gift card"],
    ["3", "Kids bike"],
  ] as const) {
    database.edit(key, { title });
  }
  const installs: Rig["installs"] = [];
  const state: { statements: readonly string[]; transactional: boolean } = {
    statements: SCRIPT_STATEMENTS,
    transactional: true,
  };
  const engine = new SetupEngine({
    name: "postgres",
    schemes: ["postgres", "postgresql"],
    label: (target) => `${target.schema ?? "public"}.${target.table}`,
    database,
    plans: {
      install: (target, options) => {
        installs.push({ target, options });
        return installPlan(state.statements, state.transactional);
      },
    },
    inspect: (options) => ({
      ok: true,
      inspection: {
        tables: ["listings", "orders"],
        ...(options.table === undefined
          ? {}
          : {
              table: {
                name: options.table,
                key: "id",
                columns: [
                  { name: "id", type: "integer" },
                  { name: "title", type: "text" },
                ],
                rows: [{ id: "3", title: "Kids bike" }],
                estimatedRows: 4_137,
              },
            }),
      },
    }),
  });
  const writes: string[] = [];
  const files = {
    text: TEXT,
    git: { kind: "clean" } as GitState,
    writes,
    read() {
      return Promise.resolve({ kind: "file" as const, text: files.text });
    },
    replace(_path: string, text: string) {
      writes.push(text);
      files.text = text;
      return Promise.resolve();
    },
    gitState() {
      return Promise.resolve(files.git);
    },
  };
  const printed: string[] = [];
  const reloads: number[] = [];
  const ran: { readonly source: string; readonly inFile: boolean }[] = [];
  const reloadFails = { failing: false };
  const provider: ModelProvider = {
    ask: (request) =>
      Promise.resolve({
        model: request.model,
        answers: {
          is_scam: {
            type: "noul",
            probability: String(request.state["title"]).includes("gift card") ? 0.94 : 0.03,
          },
        },
        usage: { inputTokens: 120, outputTokens: 0 },
      }),
  };
  const spending: SpendingGate = {
    allowsWork: () => Promise.resolve(true),
    admit: () => Promise.resolve("unlimited"),
    settle: () => Promise.resolve(),
    record: () => Promise.resolve(),
    finish: () => Promise.resolve(),
  };
  const noConnection: SqlConnect = () => {
    throw new Error("the setup opened the store, which shares the source's database here");
  };
  const reload: ReloadSummary = {
    loaded: true,
    sources: [
      {
        source: "listings",
        outcome: "not-started",
        version: null,
        message: "new in facetdb.config.ts and not answered yet",
      },
    ],
    notes: [],
  };
  const env = { ...ENV, ...extraEnv };
  const door = createSetupDoor({
    cli: { env, clock, connect: noConnection },
    databases: registeredDatabases({
      engines: [lazyEngine("postgres", () => Promise.resolve(engine))],
      env,
      // The store on the source's database, current, read at every plan.
      connect: storeAtVersions(CURRENT_STORE),
    }),
    project: { id: "listings-app", name: "listings-app" },
    ran: (source, config) => {
      ran.push({
        source: source.name,
        inFile: config.sources.some((candidate) => candidate.name === source.name),
      });
    },
    allowInsecureStore: false,
    path: PATH,
    files,
    load: () => Promise.resolve(CONFIG),
    reload: () => {
      reloads.push(1);
      return reloadFails.failing
        ? Promise.reject(new Error("the file could not be read"))
        : Promise.resolve(reload);
    },
    serial: fileQueue(),
    provider,
    spending,
    print: (line) => {
      printed.push(line);
    },
  });
  const made: Rig = {
    engine,
    database,
    files,
    printed,
    reloads,
    ran,
    reloadFails,
    door,
    installs,
    get statements() {
      return state.statements;
    },
    set statements(next) {
      state.statements = next;
    },
    get transactional() {
      return state.transactional;
    },
    set transactional(next) {
      state.transactional = next;
    },
  };
  return made;
}

/** The marked parts of the admin string, none of which may be printed or written. */
function expectNoAdmin(text: string): void {
  for (const mark of [MARK_PASSWORD, MARK_USER, ADMIN]) {
    expect(text).not.toContain(mark);
  }
}

describe("the setup door's inspection", () => {
  it("lists the tables, and for one its columns and rows, through the engine of the scheme", async () => {
    const t = rig();
    expect(await t.door.inspect(ADMIN, undefined)).toEqual({
      kind: "inspected",
      database: "Postgres",
      tables: ["listings", "orders"],
      table: null,
      // The file's first table source reads this very database: its variable is the one to suggest,
      // so one database stays one string, which a file still read through process.env needs for
      // Apply to tell its variables apart. The name alone.
      sharedWith: { source: "orders", variable: "DATABASE_URL" },
    });
    const one = await t.door.inspect(ADMIN, "listings");
    // The engine's estimate of the table's size goes to the page as it gave it.
    expect(one).toMatchObject({
      kind: "inspected",
      table: { name: "listings", key: "id", estimatedRows: 4_137 },
    });
    expect(t.engine.inspected).toEqual([null, "listings"]);
    // Another database on the same server: no source of the file reads it, nothing to suggest.
    expect(
      await t.door.inspect(
        `postgres://${MARK_USER}:${MARK_PASSWORD}@localhost:5432/other`,
        undefined,
      ),
    ).toMatchObject({ kind: "inspected", sharedWith: null });
    // A file that cannot be read suggests nothing and refuses nothing: the inspection still answers.
    t.files.read = () => Promise.reject(new Error("the disk went away"));
    expect(await t.door.inspect(ADMIN, undefined)).toMatchObject({
      kind: "inspected",
      tables: ["listings", "orders"],
      sharedWith: null,
    });
  });

  it("refuses an unknown scheme and a plaintext remote URL before anything connects", async () => {
    const t = rig();
    expect(await t.door.inspect("mongo-ish://x", undefined)).toMatchObject({
      kind: "refused",
      code: "unknown-scheme",
    });
    expect(
      await t.door.inspect(
        `postgres://${MARK_USER}:${MARK_PASSWORD}@db.example.com/app`,
        undefined,
      ),
    ).toMatchObject({ kind: "refused", code: "insecure-url" });
    expect(t.engine.inspected).toEqual([]);
  });
});

describe("the setup door's preview", () => {
  it("answers the newest rows read once through the engine's bounded read, opening no connector", async () => {
    const t = rig();
    const outcome = await t.door.preview(ADMIN, DRAFT, 20);
    expect(outcome).toMatchObject({ kind: "previewed", decided: 3, review: 0 });
    expect(outcome.kind === "previewed" && outcome.rows.map((row) => row.key)).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(t.engine.opened).toEqual([]);
    expect(t.files.writes).toEqual([]);
  });

  it("refuses FacetDB's own secrets as a source's connection variable", async () => {
    const t = rig();
    for (const variable of ["FACETDB_SECRET", "TYPESAFE_API_KEY", "FACETDB_API_KEY"]) {
      const draft = { ...DRAFT, database: { env: variable } };
      expect(await t.door.preview(ADMIN, draft, 20)).toMatchObject({ kind: "invalid" });
      const planned = await t.door.plan(ADMIN, draft);
      expect(planned).toMatchObject({
        kind: "invalid",
        issues: [
          { path: "database.env", message: expect.stringContaining("FacetDB's own secrets") },
        ],
      });
      expect(JSON.stringify(planned)).not.toContain("s".repeat(32));
    }
  });

  it("refuses a name the config has, in the loader's words", async () => {
    const t = rig();
    const outcome = await t.door.preview(ADMIN, { ...DRAFT, name: "orders" }, 20);
    expect(outcome).toMatchObject({ kind: "invalid", issues: [{ path: "name" }] });
  });
});

describe("the setup door's plan", () => {
  it("prints the install byte for byte as facetdb migrate --dry-run prints it for the same source", async () => {
    const t = rig();
    const outcome = await t.door.plan(ADMIN, DRAFT);
    if (outcome.kind !== "planned") {
      throw new Error(`not planned: ${JSON.stringify(outcome)}`);
    }
    // The project as Apply would write it, which is what migrate loads from the file then.
    const written = planApply({ path: PATH, text: TEXT, config: CONFIG }, { source: DRAFT }, ENV, {
      variable: "DATABASE_URL",
    });
    if (!written.ok) {
      throw new Error("Apply refused the draft");
    }
    const dry = await runInProcess(
      ["migrate", "--dry-run", "--source", "listings", "--admin-url", ADMIN],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        loadConfig: () => Promise.resolve(written.plan.config),
        engines: [lazyEngine("postgres", () => Promise.resolve(t.engine))],
        // The store shares the source's database: migrate reads its step there.
        connect: storeAtVersions(CURRENT_STORE),
      },
      COMMANDS,
    );
    expect(dry.code, dry.stderr).toBe(0);
    // Above the source's part, the store's step: current, so nothing to run there.
    expect(dry.stdout).toBe(
      `-- store: localhost:5432/app\n${STORE_CURRENT}\n-- source listings: localhost:5432/app\n${outcome.sql}Dry run: nothing was changed.\n`,
    );
    expect(outcome.sql).toBe(
      [
        "-- facetdb migrate: listings (public.listings)",
        "begin;",
        `${SCRIPT_STATEMENTS[0]};`,
        `${SCRIPT_STATEMENTS[1]};`,
        "commit;",
        "note: the worker login reads title and writes only FacetDB's columns",
        "",
      ].join("\n"),
    );
    expect(outcome).toMatchObject({
      table: "public.listings",
      transactional: true,
      path: PATH,
      diffPlan: written.plan.id,
      diff: written.plan.diff,
      uncommitted: null,
      estimate: { records: 3, sampled: 3 },
    });
    // The worker login's password comes from the source's variable, as migrate takes it.
    expect(t.installs.at(-1)?.options.workerPassword).toBe("worker-pw-WORKERMARK");
    expect(t.files.writes).toEqual([]);
    expect(t.engine.runs).toEqual([]);
    expectNoAdmin(JSON.stringify(outcome));
  });

  it("refuses a variable that is not set where the worker runs, saying only that", async () => {
    const t = rig();
    const outcome = await t.door.plan(ADMIN, { ...DRAFT, database: { env: "LISTINGS_URL" } });
    expect(outcome).toMatchObject({ kind: "invalid" });
    expect(JSON.stringify(outcome)).toContain(
      "is not set where the worker runs; set it to the worker login's connection string (postgres://facetdb_worker:<a long random password>@<host>/<database>: the install creates that login with that password), restart facetdb worker, then show the SQL again",
    );
  });

  it("gives the draft a where filter of the operator's, and still refuses actions", async () => {
    const t = rig();
    const withWhere = await t.door.plan(ADMIN, { ...DRAFT, where: "price > 0" });
    expect(withWhere.kind === "planned" && withWhere.diff).toContain("price > 0");
    const withActions = await t.door.plan(ADMIN, {
      ...DRAFT,
      actions: [{ plugin: "slack", action: "post", settings: {} }],
    });
    expect(withActions).toMatchObject({ kind: "invalid" });
  });
});

describe("the setup door's install", () => {
  async function planned(t: Rig) {
    const outcome = await t.door.plan(ADMIN, DRAFT);
    if (outcome.kind !== "planned") {
      throw new Error(`not planned: ${JSON.stringify(outcome)}`);
    }
    return { engine: outcome.engine, sql: outcome.sql, diffPlan: outcome.diffPlan, force: false };
  }

  it("writes the file, then runs the plan as shown with the worker password, then reloads", async () => {
    const t = rig();
    const shown = await planned(t);
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({ kind: "installed", table: "public.listings", path: PATH });
    expect(t.files.writes).toHaveLength(1);
    expect(t.files.writes[0]).toContain('"listings"');
    expect(t.engine.runs).toHaveLength(1);
    expect(t.engine.runs[0]?.workerPassword).toBe(true);
    expect(t.reloads).toEqual([1]);
    // The run it finished is said before the reload, for the source as the written file holds it
    // (the reload's check may count it as the worker login's rights).
    expect(t.ran).toEqual([{ source: "listings", inFile: true }]);
    for (const text of [...t.files.writes, ...t.printed, JSON.stringify(outcome)]) {
      expectNoAdmin(text);
    }
  });

  it("runs nothing and writes nothing when the database planned another script since", async () => {
    const t = rig();
    const shown = await planned(t);
    t.statements = [...SCRIPT_STATEMENTS, "grant select on public.listings to facetdb_worker"];
    expect(await t.door.install(ADMIN, DRAFT, shown)).toEqual({ kind: "plan_changed" });
    expect(t.files.writes).toEqual([]);
    expect(t.engine.runs).toEqual([]);
  });

  it("runs nothing when another engine would run the plan than the one that made it", async () => {
    const t = rig();
    const shown = await planned(t);
    expect(await t.door.install(ADMIN, DRAFT, { ...shown, engine: "mysql" })).toEqual({
      kind: "plan_changed",
    });
    expect(t.engine.runs).toEqual([]);
  });

  it("runs nothing when the diff shown is not the file's any more", async () => {
    const t = rig();
    const shown = await planned(t);
    expect(await t.door.install(ADMIN, DRAFT, { ...shown, diffPlan: "another" })).toEqual({
      kind: "stale",
    });
    expect(t.engine.runs).toEqual([]);
  });

  it("writes nothing and runs nothing over a file git keeps no copy of, unless forced", async () => {
    const t = rig();
    t.files.git = { kind: "modified" };
    const shown = await planned(t);
    expect(await t.door.install(ADMIN, DRAFT, shown)).toMatchObject({ kind: "uncommitted" });
    expect(t.files.writes).toEqual([]);
    expect(t.engine.runs).toEqual([]);
    const shownAgain = await planned(t);
    expect(await t.door.install(ADMIN, DRAFT, { ...shownAgain, force: true })).toMatchObject({
      kind: "installed",
    });
  });

  it("puts the file back when a transactional run stops: nothing stays anywhere", async () => {
    const t = rig();
    const shown = await planned(t);
    t.engine.stopNextRunAt(1, { error: `permission denied for user ${MARK_USER}` });
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({
      kind: "stopped",
      at: 1,
      purpose: "columns",
      kept: 0,
      transactional: true,
      file: "restored",
    });
    expect(t.files.text).toBe(TEXT);
    expect(t.reloads).toEqual([]);
    // A run that stopped is never said to have run to its end: the reload's rights stand-in depends
    // on it.
    expect(t.ran).toEqual([]);
  });

  it("keeps the source in the file when statements stay, so facetdb migrate can finish them", async () => {
    const t = rig();
    t.transactional = false;
    const shown = await planned(t);
    t.engine.stopNextRunAt(1, { error: "column already exists" });
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({ kind: "stopped", kept: 1, file: "kept" });
    expect(t.files.text).not.toBe(TEXT);
    expect(t.ran).toEqual([]);
  });

  it("keeps the source in the file when the run throws: whether it committed is not known", async () => {
    const t = rig();
    const shown = await planned(t);
    const thrown = Object.assign(new Error(`connection reset during commit ${ADMIN}`), {
      code: "ECONNRESET",
    });
    t.engine.thrown = thrown;
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({
      kind: "stopped",
      at: null,
      known: false,
      kept: 0,
      file: "kept",
    });
    expect(t.files.text).not.toBe(TEXT);
    // Whether it committed is not known, so it is not said to have run to its end either.
    expect(t.ran).toEqual([]);
  });

  it("never puts the file back over an edit made while the install ran", async () => {
    const t = rig();
    const shown = await planned(t);
    const edited = `${TEXT}\n// a hand edit\n`;
    t.engine.beforeRun = () => {
      t.files.text = edited;
    };
    t.engine.stopNextRunAt(0, { error: "permission denied" });
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({ kind: "stopped", kept: 0, known: true, file: "changed" });
    expect(t.files.text).toBe(edited);
  });

  it("answers installed, with the reload's failure in words, when the worker cannot reload", async () => {
    const t = rig();
    const shown = await planned(t);
    t.reloadFails.failing = true;
    const outcome = await t.door.install(ADMIN, DRAFT, shown);
    expect(outcome).toMatchObject({
      kind: "installed",
      reload: { loaded: false, fix: "restart facetdb worker: it reads the file as it is now" },
    });
    expect(t.engine.runs).toHaveLength(1);
  });
});

describe("a table the file already reads", () => {
  it("is refused under a new name, by plan and by install, naming the source and its commands", async () => {
    const t = rig();
    // Written another way than the file's "orders" (the loader compares the words as written), the
    // same table as the engine labels it.
    const again = { ...DRAFT, name: "orders_two", table: "public.orders" };
    const planned = await t.door.plan(ADMIN, again);
    expect(planned).toEqual({
      kind: "refused",
      code: "table-taken",
      message:
        'public.orders is already the table of the source "orders" in facetdb.config.ts, so it is not set up again under another name',
      fix: "that source is orders; finish or check its install with facetdb migrate --source orders, or take it out with facetdb uninstall --source orders",
    });
    // An install sent for the diff the file would get (no plan answered one): refused as well.
    const diff = planApply({ path: PATH, text: TEXT, config: CONFIG }, { source: again }, ENV, {
      variable: "DATABASE_URL",
    });
    if (!diff.ok) {
      throw new Error("Apply refused the draft");
    }
    const installed = await t.door.install(ADMIN, again, {
      engine: "postgres",
      sql: "anything",
      diffPlan: diff.plan.id,
      force: false,
    });
    expect(installed).toMatchObject({ kind: "refused", code: "table-taken" });
    expect(t.files.writes).toEqual([]);
    expect(t.engine.runs).toEqual([]);
    expectNoAdmin(JSON.stringify([planned, installed]));
    expect(JSON.stringify([planned, installed])).not.toContain("WORKERMARK");
  });

  it("is not refused in another schema, or behind another database's address", async () => {
    const t = rig({ ELSEWHERE_URL: "postgres://facetdb_worker:pw@db.other.example:5432/shop" });
    expect(
      await t.door.plan(ADMIN, { ...DRAFT, name: "sales_orders", table: "sales.orders" }),
    ).toMatchObject({
      kind: "planned",
    });
    // Another database: past the check, on to the store (which this rig has none of).
    await expect(
      t.door.plan("postgres://admin:pw@db.other.example:5432/shop?sslmode=require", {
        ...DRAFT,
        name: "orders_shop",
        table: "public.orders",
        database: { env: "ELSEWHERE_URL" },
      }),
    ).rejects.toThrow("the setup opened the store");
  });
});

describe("the variable the new source reads", () => {
  it("is refused when it holds no connection string FacetDB reads, saying nothing of its value", async () => {
    const t = rig();
    const outcome = await t.door.plan(ADMIN, { ...DRAFT, database: { env: "FACETDB_SECRET" } });
    expect(outcome).toMatchObject({ kind: "invalid" });
    const notUrl = rig({ NOT_A_URL: "hunter2-not-a-url" }).door;
    const refused = await notUrl.plan(ADMIN, { ...DRAFT, database: { env: "NOT_A_URL" } });
    expect(refused).toMatchObject({
      kind: "invalid",
      issues: [
        {
          message: expect.stringContaining(
            "does not hold a connection string of a database FacetDB reads; set it to the worker login's connection string (postgres://facetdb_worker:<a long random password>@<host>/<database>: the install creates that login with that password), restart facetdb worker, then show the SQL again",
          ),
        },
      ],
    });
    expect(JSON.stringify(refused)).not.toContain("hunter2");
  });
});
