import type {
  EngineDeps,
  EngineObject,
  EnginePlan,
  EngineTarget,
  KeptObject,
  PlanResult,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { UninstallResult } from "../install/index.ts";
import {
  APP_COLUMNS,
  columns,
  count,
  decisionLog,
  everyType,
  freshWorld,
  install,
  LOG_ID,
  present,
  project,
  q,
  registerSource,
  runUninstall,
  SOURCE_ID,
  useUninstallWorld,
  world,
} from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * The engine's uninstall plans on PGlite, scenario by scenario as install/uninstall.test.ts and
 * uninstall-kept.test.ts read them through `UninstallPlan`, on the same world: the plan's script is
 * today's (the old dry run's, string for string), its notes and the name typed back are the old
 * ones, and every field the CLI's words read is a remove or a keep with its words.
 */

useUninstallWorld();

const ADMIN = "postgres://admin@localhost/app";
const shared: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
const engine = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});

const LISTINGS = "public.listings";
const LOGINS: readonly KeptObject[] = ["facetdb_worker", "facetdb_enqueue"].map((name) => ({
  kind: "login",
  name,
  scope: "run",
  reason: "uninstall never drops them: every project on the server may share them",
}));
/** The store's shared tables, as the sweep drops them (written out, not computed). */
const SHARED = [
  "api_keys",
  "credentials",
  "sources",
  "projects",
  "records",
  "usage",
  "usage_reservations",
  "usage_alerts",
  "alerts",
  "alert_history",
  "heartbeats",
  "cursors",
  "install",
  "webhook_outbox",
  "store_migrations",
].map((name) => `facetdb.${name}`);

const shared_ = (reason: string): readonly EngineObject[] =>
  SHARED.map((name) => ({ kind: "store-table", name, scope: "run", reason }));

/** Without `--purge` and no log of the source's: "the decision log tables (only --purge deletes a log)". */
const LOG_TABLES_KEPT: readonly KeptObject[] = [
  "facetdb.decisions",
  "facetdb.question_set_versions",
].map((name) => ({ kind: "log", name, scope: "source", reason: "only --purge deletes a log" }));

function target(table = "listings", overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project,
    source: SOURCE_ID,
    table,
    schema: "public",
    storage: "inline",
    onChange: "reset",
    questionSet: everyType,
    ...overrides,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function okResult(result: UninstallResult) {
  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`);
  }
  return result;
}

/**
 * Today's dry run and the engine's plan of the same uninstall, read from the same database: the
 * script, the notes and the name to type back are one, so the rest of each test reads the words.
 */
async function plans(
  options: {
    readonly purge?: boolean;
    readonly table?: string;
    readonly source?: string;
    readonly also?: readonly string[];
  } = {},
) {
  const purge = options.purge ?? false;
  const table = options.table ?? "listings";
  const source = options.source ?? SOURCE_ID;
  const also = options.also ?? [];
  const old = okResult(
    (
      await runUninstall({
        dryRun: true,
        purge,
        table,
        sourceId: source,
        alsoUninstalling: also.map((other) => ({ schema: "public", table: other })),
      })
    ).result,
  );
  const plan = planOf(
    await engine.planUninstall(target(table, { source }), ADMIN, {
      ...shared,
      purge,
      alsoUninstalling: also.map((other) => target(other)),
    }),
  );
  expect(engine.render(plan)).toBe(old.sql);
  expect(plan.notes).toEqual(old.notes);
  expect(plan.confirm).toEqual({
    kind: old.plan.mode === "log-only" ? "source" : "project",
    name: old.plan.confirmName,
  });
  expect(plan.transactional).toBe(true);
  return { old: old.plan, plan };
}

const own = (kind: EngineObject["kind"], name: string, of = LISTINGS): EngineObject => ({
  kind,
  name,
  of,
  scope: "source",
});

/** What one inline install of `everyType` on a table leaves there, as its uninstall removes it. */
function tableObjects(table: string, marked: readonly string[]): readonly EngineObject[] {
  const of = `public.${table}`;
  return [
    ...marked.map((column) => own("column", column, of)),
    own("trigger", `facetdb_${table}`, of),
    own("policy", "facetdb_reads", of),
    own("policy", "facetdb_writes", of),
    own("jobs-table", "facetdb.jobs", of),
    own("grant", "facetdb_worker", of),
  ];
}

const run = (kind: EngineObject["kind"], name: string, more: Partial<EngineObject> = {}) =>
  ({ kind, name, scope: "run", ...more }) as EngineObject;

const FUNCTIONS = ["facetdb.enqueue", "facetdb.enqueue_keep"].map((name) =>
  run("function", name, { reason: "no trigger uses them any more" }),
);

describe("planUninstall, as the old plan read it", () => {
  it("without purge: the table's objects, the run's, the log tables kept; the run removes them all", async () => {
    await freshWorld();
    await install();
    await decisionLog([[LOG_ID, "1"]]);
    await q(`insert into public.listings (title) values ('a')`);
    const { old, plan } = await plans();
    expect(old.tableRemoval?.columns).toHaveLength(11);
    expect(plan.removes).toEqual([
      ...tableObjects("listings", old.tableRemoval?.columns ?? []),
      run("grant", "facetdb_worker", { of: "public" }),
      ...FUNCTIONS,
      run("jobs-table", "facetdb.jobs"),
      run("marker", "facetdb.table_owners"),
      ...shared_("no project remains"),
    ]);
    expect(plan.keeps).toEqual([...LOG_TABLES_KEPT, ...LOGINS]);

    // What ran is what was printed; as the run's last, it reports every object it removed.
    const result = await engine.run(target(), plan, ADMIN, shared);
    expect(result).toEqual({ ran: plan.statements, removed: plan.removes, notes: [] });
    expect(await columns()).toEqual(APP_COLUMNS);
    expect(await count(`select 1 from pg_trigger where not tgisinternal`)).toBe(0);
    for (const gone of ["facetdb.jobs", "facetdb.table_owners", "facetdb.projects"]) {
      expect(await present(gone)).toBe(false);
    }
    expect(await q(`select source_id from facetdb.decisions`)).toEqual([{ source_id: LOG_ID }]);
  });

  it("with purge: the source's log entries go with their counts, then the log tables and the schema", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    const { old, plan } = await plans({ purge: true });
    expect(old).toMatchObject({ logTablesDropped: true, schemaDropped: true });
    expect(plan.removes).toEqual([
      ...tableObjects("listings", old.tableRemoval?.columns ?? []),
      { kind: "log", name: "facetdb.decisions", of: SOURCE_ID, scope: "source", count: 1 },
      {
        kind: "log",
        name: "facetdb.question_set_versions",
        of: SOURCE_ID,
        scope: "source",
        count: 0,
      },
      run("grant", "facetdb_worker", { of: "public" }),
      ...FUNCTIONS,
      run("jobs-table", "facetdb.jobs"),
      run("marker", "facetdb.table_owners"),
      ...shared_("no project remains"),
      run("log", "facetdb.decisions", { reason: "now empty" }),
      run("log", "facetdb.question_set_versions", { reason: "now empty" }),
      run("schema", "facetdb", { reason: "now empty" }),
    ]);
    expect(plan.keeps).toEqual(LOGINS);
    expect(plan.notes).toEqual([
      `purge: will delete 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}".`,
    ]);

    expect(await engine.run(target(), plan, ADMIN, shared)).toEqual({
      ran: plan.statements,
      removed: plan.removes,
      notes: [
        `purge: deleted 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}".`,
      ],
    });
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
  });

  it("another project's table: the project's entry goes, the shared tables stay and say why", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" }, everyType, { id: "proj_orders", name: "Orders" });
    await q(`insert into public.orders (title) values ('o')`);
    const { old, plan } = await plans({ purge: true });
    expect(old).toMatchObject({
      otherTables: [{ name: "public.orders", schema: "public", projectId: "proj_orders" }],
      otherProjects: ["proj_orders"],
      sharedTablesDropped: false,
      queuedElsewhere: 1,
      queueTriggers: ["public.orders"],
    });
    expect(plan.removes).toEqual([
      ...tableObjects("listings", old.tableRemoval?.columns ?? []),
      run("marker", "facetdb.projects", { of: project.id, reason: "nothing of it remains" }),
      run("log", "facetdb.decisions", { reason: "now empty" }),
      run("log", "facetdb.question_set_versions", { reason: "now empty" }),
    ]);
    expect(plan.keeps).toEqual([
      ...shared_("public.orders is still installed and project proj_orders remains"),
      ...LOGINS,
    ]);
    expect(plan.notes).toEqual([
      `purge: no decisions were ever logged for source "${SOURCE_ID}", nothing to purge.`,
    ]);
  });

  it("in side-table mode removes the side table and the view, and one policy", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    const { old, plan } = await plans();
    expect(old.tableRemoval?.columns).toEqual([]);
    expect(plan.removes.filter((object) => object.scope === "source")).toEqual([
      own("side-table", "facetdb.listings_answers"),
      own("view", "public.listings_with_answers"),
      own("trigger", "facetdb_listings"),
      own("policy", "facetdb_reads"),
      own("jobs-table", "facetdb.jobs"),
      own("grant", "facetdb_worker"),
    ]);
  });

  it("refuses a table FacetDB is not installed on, in today's words", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    const old = (await runUninstall({ table: "orders" })).result;
    expect(old.ok).toBe(false);
    expect(
      await engine.planUninstall(target("orders"), ADMIN, {
        ...shared,
        purge: false,
        alsoUninstalling: [],
      }),
    ).toEqual({
      ok: false,
      refusal: {
        code: "uninstall-refused",
        message: old.ok ? "" : old.reason,
        fix: "change the table or the config as the message says, then run the command again; nothing was changed",
      },
    });
  });
});

describe("a run of several uninstalls: each table's objects with it, the run's once", () => {
  it("plans the same statements whatever the run, and the run's objects from either table", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" });
    await q(`insert into public.orders (title) values ('o')`);
    const alone = await plans();
    // The project still has another table: its entry and the shared tables stay, and say so.
    expect(alone.plan.keeps).toEqual([
      ...LOG_TABLES_KEPT,
      ...shared_("project proj_listings still has another installed table (public.orders)"),
      ...LOGINS,
    ]);
    const first = await plans({ also: ["orders"] });
    const second = await plans({ table: "orders", also: ["listings"] });
    // `alsoUninstalling` changes words, never statements.
    expect(first.plan.statements).toEqual(alone.plan.statements);
    const scoped = (plan: EnginePlan, scope: EngineObject["scope"]) =>
      plan.removes.filter((object) => object.scope === scope);
    expect(scoped(first.plan, "source")).toEqual(
      tableObjects("listings", first.old.tableRemoval?.columns ?? []),
    );
    expect(scoped(second.plan, "source")).toEqual(
      tableObjects("orders", second.old.tableRemoval?.columns ?? []),
    );
    const theRun = [
      run("grant", "facetdb_worker", { of: "public" }),
      ...FUNCTIONS,
      run("jobs-table", "facetdb.jobs"),
      run("marker", "facetdb.table_owners"),
      ...shared_("no project remains"),
    ];
    expect(scoped(first.plan, "run")).toEqual(theRun);
    expect(scoped(second.plan, "run")).toEqual(theRun);
    expect(first.plan.keeps).toEqual([...LOG_TABLES_KEPT, ...LOGINS]);

    // The first table's run leaves the run's objects to the second, whose run removes them.
    expect(await engine.run(target(), first.plan, ADMIN, shared)).toEqual({
      ran: first.plan.statements,
      removed: scoped(first.plan, "source"),
      notes: [],
    });
    expect(await present("facetdb.jobs")).toBe(true);
    expect(await engine.run(target("orders"), second.plan, ADMIN, shared)).toEqual({
      ran: second.plan.statements,
      removed: second.plan.removes,
      notes: [],
    });
    for (const gone of ["facetdb.jobs", "facetdb.table_owners", "facetdb.projects"]) {
      expect(await present(gone)).toBe(false);
    }
  });
});

describe("what an uninstall keeps while it is in use", () => {
  async function outbox(rows: readonly (readonly [delivered: boolean, gaveUp: boolean])[]) {
    for (const [delivered, gaveUp] of rows) {
      await q(
        `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at, delivered_at, gave_up_at)
         values ($1, 'https://hooks.example.com/f', '{}', 1, 1, $2, $3)`,
        [project.id, delivered ? 2 : null, gaveUp ? 2 : null],
      );
    }
  }

  it("pending deliveries keep the project and the shared tables, with the count in the words", async () => {
    await freshWorld();
    await install();
    await outbox([
      [false, false],
      [false, false],
      [true, false],
    ]);
    const { old, plan } = await plans();
    expect(old).toMatchObject({ pendingDeliveries: 2, projectKeptBy: ["pending-deliveries"] });
    expect(plan.keeps.filter((object) => object.kind === "store-table")).toEqual(
      shared_("project proj_listings still has 2 pending webhook deliveries"),
    );
    expect(plan.notes).toContain(
      `2 webhook deliveries of project ${project.id} still pending: the project and the webhook outbox stay until each is delivered or given up (retried for 24 hours).`,
    );
  });

  it("an unfinished backfill keeps them, naming its run, and so do usage and heartbeats", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.cursors (run, cursor, done) values ('v1', 'c-17', false)`);
    const cursor = await plans();
    expect(cursor.plan.keeps.filter((object) => object.kind === "store-table")).toEqual(
      shared_("a backfill is unfinished (run v1; it finishes, or its cursor is deleted)"),
    );
    expect(cursor.plan.notes).toEqual([
      `the project ${project.id} and the store's shared tables stay because of an unfinished backfill cursor (run v1); it keeps the shared tables until the backfill finishes or the cursor is deleted.`,
    ]);
    await q(
      `insert into facetdb.usage (project_id, month, input_tokens) values ('${project.id}', '2026-11', 4200)`,
    );
    await q(`insert into facetdb.heartbeats (project, at) values ('${project.id}', 1)`);
    const usage = await plans();
    expect(usage.plan.keeps.filter((object) => object.kind === "store-table")).toEqual(
      shared_(
        "project proj_listings still has usage and worker heartbeats and a backfill is unfinished (run v1; it finishes, or its cursor is deleted)",
      ),
    );
  });

  it("a trigger with no owner row keeps the queue and the functions, and says which", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" }, everyType, { id: "proj_orders", name: "Orders" });
    await q(`delete from facetdb.table_owners where table_name = 'orders'`);
    const { old, plan } = await plans({ purge: true });
    expect(old).toMatchObject({ markerTablesDropped: true, queueTriggers: ["public.orders"] });
    expect(plan.removes.filter((object) => object.scope === "run")).toEqual(
      expect.arrayContaining([run("marker", "facetdb.table_owners")]),
    );
    expect(plan.removes.some((object) => object.kind === "function")).toBe(false);
    const reason = "a trigger on public.orders still uses them";
    expect(plan.keeps).toEqual(
      expect.arrayContaining([
        { ...run("jobs-table", "facetdb.jobs"), reason },
        { ...run("function", "facetdb.enqueue"), reason },
        { ...run("function", "facetdb.enqueue_keep"), reason },
      ]),
    );
  });

  it("queued jobs of a table outside the run keep the queue, with their count", async () => {
    await freshWorld();
    await install();
    // A job of a table this run does not touch, its owner row gone (a hand-made install).
    await q(`insert into facetdb.jobs (record_key) values ('t:13:public.orders:7')`);
    const { old, plan } = await plans();
    expect(old).toMatchObject({ markerTablesDropped: true, queuedElsewhere: 1, queueTriggers: [] });
    expect(plan.keeps).toEqual(
      expect.arrayContaining([
        {
          ...run("jobs-table", "facetdb.jobs", { count: 1 }),
          reason: "it holds 1 queued job of other tables",
        },
      ]),
    );
  });

  it("names a marked side table with no foreign key as left in place", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    const fk = await q(
      `select conname from pg_constraint where conrelid = 'facetdb.listings_answers'::regclass and contype = 'f'`,
    );
    await q(`alter table facetdb.listings_answers drop constraint "${String(fk[0]?.["conname"])}"`);
    const { old, plan } = await plans();
    expect(old.leftInPlace).toEqual(["facetdb.listings_answers"]);
    expect(plan.keeps).toEqual(
      expect.arrayContaining([
        {
          kind: "side-table",
          name: "facetdb.listings_answers",
          scope: "source",
          reason: "see the note above",
        },
      ]),
    );
    expect(plan.notes.join("\n")).toContain(
      `left in place: "facetdb"."listings_answers" is FacetDB's side table but has no foreign key to public.listings`,
    );
  });
});
