import { describe, expect, it } from "vitest";
import type { SqlClient } from "../sql/index.ts";
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
  recording,
  registerSource,
  runUninstall,
  snapshot,
  useUninstallWorld,
  withoutCategory,
  world,
} from "../testing/index.ts";
import { prune } from "./prune.ts";
import { renderSql } from "./sql.ts";

/**
 * `uninstall` on PGlite: these statements destroy data on purpose, so every test reads the
 * catalog before and after. PGlite is one superuser connection: it proves the SQL and what it
 * leaves, not the roles' rights (install.db.test.ts covers those). `migrate --prune` is
 * uninstall-prune.test.ts, the purge of a decision log uninstall-purge.test.ts, and what an
 * uninstall keeps while it is in use uninstall-kept.test.ts (split by subject so no file passes
 * 10 s).
 */

useUninstallWorld();

describe("uninstall", () => {
  it("without purge removes what install added, keeps the decision log, and installs again", async () => {
    await freshWorld();
    await install();
    await decisionLog([[LOG_ID, "1"]]);
    await q(`insert into public.listings (title) values ('a')`);
    expect(await count(`select 1 from facetdb.jobs`)).toBe(1);

    const { result, events } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(events).toEqual(["print", "confirm Listings"]);
    expect(await columns()).toEqual(APP_COLUMNS);
    expect(await count(`select 1 from pg_trigger where not tgisinternal`)).toBe(0);
    expect(await count(`select 1 from pg_policies`)).toBe(0);
    expect(
      await count(`select 1 from pg_proc where pronamespace = to_regnamespace('facetdb')`),
    ).toBe(0);
    for (const gone of ["facetdb.jobs", "facetdb.table_owners", "facetdb.projects"]) {
      expect(await present(gone)).toBe(false);
    }
    expect(await q(`select source_id, record_key from facetdb.decisions`)).toEqual([
      { source_id: LOG_ID, record_key: "1" },
    ]);
    // The application writes as before, with nothing of FacetDB's in the way.
    await q(`update public.listings set title = 'b' where id = 1`);

    await install();
    expect(await columns()).toContain("is_scam");
    await q(`update public.listings set title = 'c' where id = 1`);
    expect(await q(`select record_key from facetdb.jobs`)).toEqual([
      { record_key: "t:15:public.listings:1" },
    ]);
    expect(await count(`select 1 from facetdb.decisions`)).toBe(1);
  });

  it("with purge deletes the source's log and the schema once it is empty", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      confirmName: "Listings",
      tableRemoval: {
        columns: expect.arrayContaining(["is_scam", "facetdb_status"]),
        sideTable: undefined,
        view: undefined,
        trigger: "facetdb_listings",
      },
      logTablesDropped: true,
      sharedTablesDropped: true,
      markerTablesDropped: true,
      jobsTableDropped: true,
      queueTriggers: [],
      schemaDropped: true,
      otherTables: [],
      otherProjects: [],
      pendingElsewhere: 0,
      leftInPlace: [],
    });
    expect(await present("facetdb.decisions")).toBe(false);
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("with purge keeps another source's log rows, and the schema that holds them", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([
      [LOG_ID, "1"],
      ["src_other", "7"],
    ]);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan.logTablesDropped).toBe(false);
    expect(await q(`select source_id, record_key from facetdb.decisions`)).toEqual([
      { source_id: "src_other", record_key: "7" },
    ]);
  });

  it.each(["40P01", "55P03"])(
    "a script that loses to a concurrent command (%s) changes nothing and says to run it again",
    async (code) => {
      await freshWorld();
      await install();
      const before = await snapshot();
      // The database's own refusal, as the driver reports it: the transaction rolled back.
      const losing: SqlClient = {
        ...world.client,
        transaction: () => Promise.reject(Object.assign(new Error("lost the race"), { code })),
      };
      const { result } = await runUninstall({ connect: () => losing });
      expect(result).toEqual({
        ok: false,
        reason:
          "another FacetDB command was running on this database at the same time; nothing was changed. Run it again.",
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("a wrong confirmation runs nothing", async () => {
    await freshWorld();
    await install();
    await decisionLog([[LOG_ID, "1"]]);
    await q(`insert into public.listings (title) values ('a')`);
    const before = await snapshot();
    const { connect, executed } = recording();
    for (const typed of ["listings", "Listing", "", "proj_listings"]) {
      const { result, events } = await runUninstall({ typed, purge: true, connect });
      expect(result).toMatchObject({ ok: false });
      expect(events).toEqual(["print", "confirm Listings"]);
    }
    expect(executed).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("prints exactly what it runs, as one transaction with no parameter", async () => {
    await freshWorld();
    await install();
    const { connect, executed } = recording();
    const { result, printed } = await runUninstall({ purge: true, connect });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(printed).toEqual([renderSql(executed)]);
    expect(result.ok && result.sql).toBe(printed[0]);
    expect(executed.every((s) => s.params.length === 0)).toBe(true);
    expect(printed[0]?.startsWith("begin;")).toBe(true);
    expect(printed[0]?.endsWith("commit;\n")).toBe(true);
  });

  it("a dry run prints, asks nothing and changes nothing", async () => {
    await freshWorld();
    await install();
    const before = await snapshot();
    const { result, events } = await runUninstall({ dryRun: true, purge: true });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(events).toEqual(["print"]);
    expect(await snapshot()).toEqual(before);
  });

  it("leaves another installed table working: its trigger, the functions and its queue entries", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" }, everyType, { id: "proj_orders", name: "Orders" });
    await q(`insert into public.listings (title) values ('a')`);
    await q(`insert into public.orders (title) values ('o')`);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      otherTables: [{ name: "public.orders", schema: "public", projectId: "proj_orders" }],
      otherProjects: ["proj_orders"],
      projectKeptBy: [],
      sharedTablesDropped: false,
      markerTablesDropped: false,
      jobsTableDropped: false,
      queuedElsewhere: 1,
      queueTriggers: ["public.orders"],
      schemaDropped: false,
    });
    expect(await q(`select record_key from facetdb.jobs`)).toEqual([
      { record_key: "t:13:public.orders:1" },
    ]);
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: "proj_orders" }]);
    expect(await q(`select table_name from facetdb.table_owners`)).toEqual([
      { table_name: "orders" },
    ]);
    await q(`insert into public.orders (title) values ('p')`);
    expect(await count(`select 1 from facetdb.jobs`)).toBe(2);
    expect(await columns("orders")).toContain("is_scam");
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("keeps the store's shared tables and their rows while another project (a polling one, no table owner) remains", async () => {
    await freshWorld();
    await install();
    // A project the worker registered for a polling-mode source: no table_owners row, no source.
    await q(`insert into facetdb.projects (id, name) values ('proj_polling', 'Polling')`);
    await q(
      `insert into facetdb.usage (project_id, month, input_tokens) values ('proj_polling', '2026-11', 4200)`,
    );
    await q(
      `insert into facetdb.cursors (run, cursor, done) values ('proj_polling', 'c-17', false)`,
    );
    await q(`insert into facetdb.heartbeats (project, at) values ('proj_polling', 1)`);

    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    // An unfinished cursor names no project, so it keeps the uninstalled one's row too.
    expect(result.ok && result.plan.projectKeptBy).toEqual(["cursors"]);
    expect(await q(`select id from facetdb.projects order by id`)).toEqual([
      { id: "proj_listings" },
      { id: "proj_polling" },
    ]);
    expect(await q(`select input_tokens::int as n from facetdb.usage`)).toEqual([{ n: 4200 }]);
    expect(await q(`select cursor from facetdb.cursors`)).toEqual([{ cursor: "c-17" }]);
    expect(await q(`select at::int as at from facetdb.heartbeats`)).toEqual([{ at: 1 }]);
    for (const kept of [
      "facetdb.usage_reservations",
      "facetdb.usage_alerts",
      "facetdb.alerts",
      "facetdb.alert_history",
      "facetdb.install",
      "facetdb.store_migrations",
      "facetdb.sources",
    ]) {
      expect(await present(kept)).toBe(true);
    }
  });

  it("keeps the uninstalling project's own usage and heartbeats when it also runs a polling source", async () => {
    await freshWorld();
    await install();
    // The same project as the uninstalled table, with state from a polling-mode source (no table owner).
    await q(
      `insert into facetdb.usage (project_id, month, input_tokens) values ('${project.id}', '2026-11', 4200)`,
    );
    await q(`insert into facetdb.heartbeats (project, at) values ('${project.id}', 1)`);
    await q(`insert into facetdb.cursors (run, cursor, done) values ('v1', 'c-17', false)`);

    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: project.id }]);
    expect(await q(`select input_tokens::int as n from facetdb.usage`)).toEqual([{ n: 4200 }]);
    expect(await q(`select at::int as at from facetdb.heartbeats`)).toEqual([{ at: 1 }]);
    expect(await q(`select cursor from facetdb.cursors`)).toEqual([{ cursor: "c-17" }]);
    expect(await present("facetdb.table_owners")).toBe(false);
  });

  it("deletes the uninstalling project's worker heartbeat rows and nobody else's, whatever else keeps the project", async () => {
    await freshWorld();
    await install();
    // A running worker's row and a dead one's, both of this project; a project that remains has its own.
    await q(`insert into facetdb.projects (id, name) values ('proj_other', 'Other')`);
    await q(`insert into facetdb.heartbeats (project, at) values ('${project.id}', 1)`);
    await q(
      `insert into facetdb.worker_heartbeats (project, worker, at) values
         ('${project.id}', 'worker-live', 5), ('${project.id}', 'worker-dead', 1), ('proj_other', 'worker-other', 2)`,
    );

    const { result } = await runUninstall();

    expect(result).toMatchObject({ ok: true, applied: true });
    // The project's own heartbeat still keeps it; the workers' rows are not state that keeps one.
    expect(result.ok && result.plan.projectKeptBy).toEqual(["heartbeats"]);
    expect(await q(`select project, worker from facetdb.worker_heartbeats`)).toEqual([
      { project: "proj_other", worker: "worker-other" },
    ]);
  });

  it("drops the worker heartbeats table with the other shared tables once no project remains", async () => {
    await freshWorld();
    await install();
    await q(
      `insert into facetdb.worker_heartbeats (project, worker, at) values ('${project.id}', 'worker-dead', 1)`,
    );

    const { result } = await runUninstall();

    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await present("facetdb.worker_heartbeats")).toBe(false);
  });

  it("in side-table mode drops the side table and the view and leaves the table as it was", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    await q(`insert into public.listings (title) values ('a')`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan.tableRemoval).toEqual({
      columns: [],
      sideTable: "facetdb.listings_answers",
      view: "public.listings_with_answers",
      trigger: "facetdb_listings",
      policies: ["facetdb_reads"],
      workerGrants: true,
      schemaUsage: true,
    });
    expect(await present("public.listings_with_answers")).toBe(false);
    expect(await present("facetdb.listings_answers")).toBe(false);
    expect(await columns()).toEqual(APP_COLUMNS);
    expect(await q(`select title from public.listings`)).toEqual([{ title: "a" }]);
  });

  it("leaves alone the side table of a same-named table in another schema", async () => {
    await freshWorld();
    await q(`create schema b`);
    await q(`create table b.listings (id serial primary key, title text)`);
    await install({ table: "listings", schema: "b", storage: "side-table" }, everyType, {
      id: "proj_b",
      name: "Bee",
    });
    await install();
    await q(`insert into b.listings (title) values ('theirs')`);
    await q(
      `insert into facetdb.listings_answers (id, is_scam, facetdb_status) values (1, true, 'done')`,
    );
    const side = await columns("listings_answers", "facetdb");

    const pruned = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project,
      print: () => undefined,
    });
    expect(pruned).toMatchObject({ ok: true, applied: true });
    expect(await columns()).not.toContain("category");
    expect(await columns("listings_answers", "facetdb")).toEqual(side);

    const { result, printed } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(printed[0]).not.toContain("listings_answers");
    expect(await columns()).toEqual(APP_COLUMNS);
    expect(await q(`select id, is_scam from facetdb.listings_answers`)).toEqual([
      { id: 1, is_scam: true },
    ]);
    expect(await q(`select is_scam from b.listings_with_answers`)).toEqual([{ is_scam: true }]);
  });

  it("refuses a table FacetDB is not installed on", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    const { result, events } = await runUninstall({ table: "orders" });
    expect(result).toMatchObject({ ok: false });
    expect(events).toEqual([]);
  });
});

describe("a run of several uninstalls (alsoUninstalling)", () => {
  it("forecasts what the whole run leaves, not what this table's script alone leaves", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    await install({ table: "orders" });
    await q(`insert into public.orders (title) values ('o')`);
    const alone = await runUninstall({ dryRun: true });
    expect(alone.result.ok && alone.result.plan).toMatchObject({
      otherTables: [{ name: "public.orders", schema: "public", projectId: project.id }],
      projectKeptBy: ["another-table"],
      sharedTablesDropped: false,
      jobsTableDropped: false,
    });
    const before = await snapshot();
    const run = await runUninstall({
      dryRun: true,
      alsoUninstalling: [{ schema: "public", table: "orders" }],
    });
    expect(run.result.ok && run.result.plan).toMatchObject({
      otherTables: [],
      projectKeptBy: [],
      sharedTablesDropped: true,
      markerTablesDropped: true,
      jobsTableDropped: true,
      queuedElsewhere: 0,
      queueTriggers: [],
    });
    // The script is the same either way: the run's other tables only change the forecast.
    expect(run.printed).toEqual(alone.printed);
    expect(await snapshot()).toEqual(before);
  });
});
