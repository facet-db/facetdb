import type { EngineDeps, EnginePlan, EngineTarget, PlanResult } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { UninstallResult } from "../install/index.ts";
import {
  decisionLog,
  everyType,
  freshWorld,
  install,
  LOG_ID,
  logOf,
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
 * The engine's plans of a purge on PGlite, as install/uninstall-purge.test.ts reads them through
 * the plan's fields: which log goes and with what counts, which stays and why, the log-only purge
 * that asks for the source's name, the re-check that refuses inside the run, and a separate store,
 * whose log is the CLI's store door's (the plan holds the source's side alone).
 */

useUninstallWorld();

const ADMIN = "postgres://admin@localhost/app";
const shared: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
const separate: EngineDeps = { ...shared, storeShared: false };
const engine = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});
const FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

function target(source = SOURCE_ID, table = "listings"): EngineTarget {
  return {
    project,
    source,
    table,
    schema: "public",
    storage: "inline",
    onChange: "reset",
    questionSet: everyType,
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

/** Today's dry run and the engine's plan of the same uninstall, from the same database. */
async function plans(options: { readonly purge: boolean; readonly source?: string }) {
  const source = options.source ?? SOURCE_ID;
  const old = okResult(
    (await runUninstall({ dryRun: true, purge: options.purge, sourceId: source })).result,
  );
  const plan = planOf(
    await engine.planUninstall(target(source), ADMIN, {
      ...shared,
      purge: options.purge,
      alsoUninstalling: [],
    }),
  );
  expect(engine.render(plan)).toBe(old.sql);
  expect(plan.notes).toEqual(old.notes);
  return { old: old.plan, plan };
}

const logs = (plan: EnginePlan, list: "removes" | "keeps") =>
  plan[list].filter((object) => object.kind === "log");

async function versions(sourceId: string): Promise<void> {
  await q(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
    [sourceId],
  );
}

describe("a plain uninstall keeps the source's log, and says how it goes later", () => {
  it("offers the later purge when no other table of the project is installed", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([[logOf("t_listings"), "1"]]);
    const { old, plan } = await plans({ purge: false, source: "t_listings" });
    const command = "facetdb uninstall --purge --source t_listings";
    expect(old.logOnlyPurge).toEqual({ source: "t_listings", command });
    const reason = `run \`${command}\` later to delete it`;
    expect(logs(plan, "keeps")).toEqual([
      {
        kind: "log",
        name: "facetdb.decisions",
        of: "t_listings",
        scope: "source",
        count: 1,
        reason,
      },
      {
        kind: "log",
        name: "facetdb.question_set_versions",
        of: "t_listings",
        scope: "source",
        count: 0,
        reason,
      },
    ]);
    expect(logs(plan, "removes")).toEqual([]);
    // The registration keeps the store in use until the log is purged.
    expect(plan.keeps.find((object) => object.kind === "store-table")?.reason).toBe(
      "the FacetDB store still registers a source, a credential or an API key",
    );
  });

  it("says the log waits for another table of the project, which may share it", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" });
    await registerSource();
    await versions(LOG_ID);
    await decisionLog([[LOG_ID, "1"]]);
    const { old, plan } = await plans({ purge: false });
    expect(old.logOnlyPurge).toBeUndefined();
    const reason = `which public.orders may share: run \`facetdb uninstall --purge --source ${SOURCE_ID}\` once no other table is installed to delete it`;
    expect(logs(plan, "keeps")).toEqual([
      { kind: "log", name: "facetdb.decisions", of: SOURCE_ID, scope: "source", count: 1, reason },
      {
        kind: "log",
        name: "facetdb.question_set_versions",
        of: SOURCE_ID,
        scope: "source",
        count: 1,
        reason,
      },
    ]);
  });
});

describe("a purge deletes exactly the source's log", () => {
  it("names another source's log it leaves, the old name of a renamed source", async () => {
    await freshWorld();
    await install();
    await registerSource("listings_renamed");
    await registerSource(SOURCE_ID);
    await versions(logOf("listings_renamed"));
    await decisionLog([
      [logOf("listings_renamed"), "1"],
      [logOf("listings_renamed"), "2"],
      [LOG_ID, "3"],
      ["src_other", "4"],
    ]);
    const { old, plan } = await plans({ purge: true, source: "listings_renamed" });
    expect(old.otherSourceLogs).toEqual([{ source: SOURCE_ID, decisions: 1 }]);
    expect(logs(plan, "removes")).toEqual([
      { kind: "log", name: "facetdb.decisions", of: "listings_renamed", scope: "source", count: 2 },
      {
        kind: "log",
        name: "facetdb.question_set_versions",
        of: "listings_renamed",
        scope: "source",
        count: 1,
      },
    ]);
    expect(logs(plan, "keeps")).toEqual([
      {
        kind: "log",
        name: "facetdb.decisions",
        of: SOURCE_ID,
        scope: "source",
        count: 1,
        reason: `another source of project ${project.id}: run \`facetdb uninstall --purge --source ${SOURCE_ID}\` if it was this table's under an earlier name`,
      },
    ]);
  });

  it("keeps the log tables that other sources still use", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([
      [LOG_ID, "1"],
      ["src_other", "7"],
    ]);
    const { old, plan } = await plans({ purge: true });
    expect(old.logTablesDropped).toBe(false);
    expect(logs(plan, "keeps")).toEqual(
      ["facetdb.decisions", "facetdb.question_set_versions"].map((name) => ({
        kind: "log",
        name,
        scope: "source",
        reason: "which other sources or the FacetDB store still use",
      })),
    );
  });

  it("an unresolved name deletes nothing, keeps the rows under it, and names the sources found", async () => {
    await freshWorld();
    await install();
    await registerSource("orders_src");
    await registerSource("t_listings");
    await decisionLog([
      [logOf("t_listings"), "1"],
      [logOf("nope"), "2"],
    ]);
    const { old, plan } = await plans({ purge: true, source: "nope" });
    expect(old.log).toMatchObject({ status: "not-found", logged: 1 });
    expect(logs(plan, "removes")).toEqual([]);
    expect(logs(plan, "keeps")).toEqual([
      {
        kind: "log",
        name: "facetdb.decisions",
        of: "nope",
        scope: "source",
        count: 1,
        reason: `no source named "nope" belongs to this table's project, so none of it is deleted (sources found: orders_src, t_listings)`,
      },
    ]);
  });

  it("a never-logged source: the log tables stay, and the words say none was logged", async () => {
    await freshWorld();
    await install();
    await registerSource("orders_src");
    const { plan } = await plans({ purge: true, source: "nope" });
    expect(logs(plan, "keeps")).toEqual(
      ["facetdb.decisions", "facetdb.question_set_versions"].map((name) => ({
        kind: "log",
        name,
        scope: "source",
        reason: "no decisions were ever logged for source nope",
      })),
    );
  });
});

describe("the log-only purge, after a plain uninstall", () => {
  it("asks for the source's name, removes its log and what is left unused, and says what it deleted", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    okResult((await runUninstall()).result);
    const { old, plan } = await plans({ purge: true });
    expect(old.mode).toBe("log-only");
    expect(plan.confirm).toEqual({ kind: "source", name: SOURCE_ID });
    expect(plan.removes).toEqual([
      { kind: "log", name: "facetdb.decisions", of: SOURCE_ID, scope: "source", count: 1 },
      {
        kind: "log",
        name: "facetdb.question_set_versions",
        of: SOURCE_ID,
        scope: "source",
        count: 0,
      },
      { kind: "jobs-table", name: "facetdb.jobs", scope: "run" },
      { kind: "marker", name: "facetdb.table_owners", scope: "run" },
      ...[
        "api_keys",
        "credentials",
        "sources",
        "projects",
        "question_sets_in_force",
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
        "reviews",
        "users",
        "runs",
        "store_migrations",
      ].map((name) => ({
        kind: "store-table",
        name: `facetdb.${name}`,
        scope: "run",
        reason: "no project remains",
      })),
      { kind: "log", name: "facetdb.decisions", scope: "run", reason: "now empty" },
      { kind: "log", name: "facetdb.question_set_versions", scope: "run", reason: "now empty" },
      { kind: "schema", name: "facetdb", scope: "run", reason: "now empty" },
    ]);
    expect(plan.notes).toEqual([
      "public.listings has no FacetDB install left; only the decision log is purged.",
      `purge: will delete 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}".`,
    ]);

    expect(await engine.run(target(), plan, ADMIN, shared)).toEqual({
      ran: plan.statements,
      removed: plan.removes,
      notes: [
        "public.listings has no FacetDB install left; only the decision log was purged.",
        `purge: deleted 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}".`,
      ],
    });
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
  });

  it("refuses while another table of the project may read the log, in today's words", async () => {
    await freshWorld(["listings", "listing"]);
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    const refusal = {
      code: "uninstall-refused",
      message: `the decision log of source "${SOURCE_ID}" may be shared with public.listings (project ${project.id}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`,
      fix: FIX,
    };
    for (const deps of [shared, separate]) {
      expect(
        await engine.planUninstall(target(SOURCE_ID, "listing"), ADMIN, {
          ...deps,
          purge: true,
          alsoUninstalling: [],
        }),
      ).toEqual({ ok: false, refusal });
    }
  });

  it("stops with the re-check's refusal when the table is installed again before the run", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([[logOf("t_listings"), "1"]]);
    okResult((await runUninstall({ sourceId: "t_listings" })).result);
    const plan = planOf(
      await engine.planUninstall(target("t_listings"), ADMIN, {
        ...shared,
        purge: true,
        alsoUninstalling: [],
      }),
    );
    // Between the plan and its run, the table is installed again for its project.
    await install();
    const result = await engine.run(target("t_listings"), plan, ADMIN, shared);
    expect(result).toEqual({
      ran: [],
      stopped: {
        at: plan.statements.findIndex((statement) => statement.text.includes("is live again")),
        refusal: {
          code: "uninstall-refused",
          message: `the decision log of source "${logOf("t_listings")}" is live again: public.listings is now installed for its project; nothing was changed`,
          fix: FIX,
        },
      },
      removed: [],
      notes: [],
    });
    expect(await q(`select source_id from facetdb.decisions`)).toEqual([
      { source_id: logOf("t_listings") },
    ]);
  });
});

describe("with the store in another database", () => {
  /** A source-only install, as `facetdb migrate` makes one with the store elsewhere. */
  async function installSeparate(): Promise<void> {
    const options = { ...separate, workerPassword: "a-long-random-password" };
    const plan = planOf(await engine.planInstall(target(), ADMIN, options));
    expect((await engine.run(target(), plan, ADMIN, options)).stopped).toBeUndefined();
  }

  it("plans the source's side alone: no log, no store table, no word of either", async () => {
    await freshWorld();
    await installSeparate();
    // A logged source, as the worker leaves it, so the shared plan resolves a log to purge (without
    // one both plans had no source to name, and the equality below held by accident). The tables
    // are made here only for the shared plan to read; the separate plan never looks.
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    await q(
      `insert into facetdb.cursors (run, cursor, done) values ('backfill:${LOG_ID}:all@v1', 'k', false)`,
    );
    const sharedPlan = planOf(
      await engine.planUninstall(target(), ADMIN, { ...shared, purge: true, alsoUninstalling: [] }),
    );
    const plan = planOf(
      await engine.planUninstall(target(), ADMIN, {
        ...separate,
        purge: true,
        alsoUninstalling: [],
      }),
    );
    expect(sharedPlan.statements.some((statement) => statement.database === "store")).toBe(true);
    expect(engine.render(sharedPlan)).toContain("delete from facetdb.decisions");
    // The shared plan names the source it purges, and guards its log on the source's side, before
    // anything changes: in table mode the guard's owner-row branch never fires (the table holds its
    // owner row), so the separate plan, whose log the store door purges, carries neither.
    const named = (text: string) => text.includes("facetdb.uninstall_source");
    const guard = (text: string) => text.includes("may be shared with");
    expect(sharedPlan.statements.filter((statement) => guard(statement.text))).toHaveLength(1);
    expect(
      plan.statements.some((statement) => named(statement.text) || guard(statement.text)),
    ).toBe(false);
    expect(plan.statements).toEqual(
      sharedPlan.statements
        .filter((statement) => statement.database === "source" && !guard(statement.text))
        .map((statement) =>
          named(statement.text)
            ? {
                ...statement,
                text: statement.text.replace(
                  `, set_config('facetdb.uninstall_source', '${LOG_ID}', true)`,
                  "",
                ),
              }
            : statement,
        ),
    );
    expect(engine.render(plan)).not.toMatch(
      /delete from facetdb\.decisions|drop table facetdb\.decisions/,
    );
    const store = [...plan.removes, ...plan.keeps].filter(
      (object) => object.kind === "log" || object.kind === "store-table",
    );
    expect(store).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.confirm).toEqual({ kind: "project", name: project.name });
    expect(plan.keeps).toEqual(
      expect.arrayContaining([
        { kind: "login", name: "facetdb_worker", scope: "run", reason: expect.any(String) },
      ]),
    );
  });

  it("plans a log-only purge with the source-side checks only, and the source's name to type back", async () => {
    await freshWorld();
    await install();
    okResult((await runUninstall()).result);
    const plan = planOf(
      await engine.planUninstall(target(), ADMIN, {
        ...separate,
        purge: true,
        alsoUninstalling: [],
      }),
    );
    expect(plan.confirm).toEqual({ kind: "source", name: SOURCE_ID });
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    // The checks of the source's side: the table live again, another table of the project.
    expect(plan.statements.some((statement) => statement.text.includes("is live again"))).toBe(
      true,
    );
    expect(plan.statements.some((statement) => statement.text.includes("may be shared with"))).toBe(
      true,
    );
    expect(engine.render(plan)).not.toContain("delete from facetdb.decisions");
    expect(plan.notes).toEqual([
      "public.listings has no FacetDB install left; only the decision log is purged.",
    ]);
    expect(
      [...plan.removes, ...plan.keeps].filter(
        (object) => object.kind === "log" || object.kind === "store-table",
      ),
    ).toEqual([]);
  });

  it("refuses when a store an earlier DATABASE_URL left in this database would go with the sweep", async () => {
    await freshWorld();
    // The store in the source's database, as an earlier migrate installed it; DATABASE_URL now
    // elsewhere.
    await install();
    expect(
      await engine.planUninstall(target(), ADMIN, {
        ...separate,
        purge: false,
        alsoUninstalling: [],
      }),
    ).toEqual({
      ok: false,
      refusal: {
        code: "store-left-behind",
        message:
          "this database still holds a FacetDB store (facetdb.store_migrations and the tables beside it) from when DATABASE_URL named it, and with the store now elsewhere this uninstall would drop those tables without naming them; nothing was changed",
        fix: "run facetdb uninstall with DATABASE_URL naming this database by the same host, port and database name as the source's connection string: it then removes the source's install and that store together, and names everything it drops. A pooler's host and the direct host (Supabase's) reach one database but read as two, so write both the same way; until they match, the uninstall stays refused rather than drop a store that may be another project's",
      },
    });
    // With the store here again, the same uninstall names every one of those tables.
    const plan = planOf(
      await engine.planUninstall(target(), ADMIN, {
        ...shared,
        purge: false,
        alsoUninstalling: [],
      }),
    );
    expect(plan.removes.filter((object) => object.kind === "store-table")).not.toEqual([]);
  });
});
