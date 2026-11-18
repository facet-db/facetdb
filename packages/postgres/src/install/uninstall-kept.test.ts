import { describe, expect, it } from "vitest";
import {
  count,
  everyType,
  freshWorld,
  install,
  present,
  project,
  q,
  registerSource,
  runUninstall,
  useUninstallWorld,
} from "../testing/index.ts";

/**
 * What `uninstall` keeps on PGlite: the shared queue, the store's tables and a project's pending
 * deliveries and backfills while anything still uses them. The uninstall itself is
 * uninstall.test.ts (split by subject so no file passes 10 s).
 */

useUninstallWorld();

describe("uninstall keeps what is still in use", () => {
  it("drops facetdb.projects after the purge block", async () => {
    await freshWorld();
    await install();
    await registerSource();
    const { printed } = await runUninstall({ purge: true });
    const text = printed[0] ?? "";
    expect(text.indexOf("delete from facetdb.decisions")).toBeGreaterThan(-1);
    expect(text.indexOf("drop table facetdb.projects")).toBeGreaterThan(
      text.indexOf("delete from facetdb.decisions"),
    );
    expect(await present("facetdb.projects")).toBe(false);
  });

  for (const onChange of ["reset", "keep"] as const) {
    it(`never drops facetdb.jobs while a trigger calls enqueue (${onChange})`, async () => {
      await freshWorld(["listings", "orders"]);
      await install();
      await install({ table: "orders", onChange }, everyType, {
        id: "proj_orders",
        name: "Orders",
      });
      // The second table lost its owner row (by hand), but its trigger still writes to the queue.
      await q(`delete from facetdb.table_owners where table_name = 'orders'`);
      const { result } = await runUninstall({ purge: true });
      expect(result).toMatchObject({ ok: true, applied: true });
      // The plan says so: the queue and its functions stay for the trigger, and so does the schema.
      expect(result.ok && result.plan).toMatchObject({
        markerTablesDropped: true,
        jobsTableDropped: false,
        queueTriggers: ["public.orders"],
        schemaDropped: false,
      });
      expect(await present("facetdb.jobs")).toBe(true);
      await q(`insert into public.orders (title) values ('o')`);
      expect(await count(`select 1 from facetdb.jobs`)).toBe(1);
      expect(
        await count(`select 1 from pg_proc where pronamespace = to_regnamespace('facetdb')`),
      ).toBeGreaterThan(0);
    });
  }

  it("drops facetdb.jobs once no trigger calls the queue's functions", async () => {
    await freshWorld();
    await install();
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await present("facetdb.jobs")).toBe(false);
  });

  it("reports a marked side table with no foreign key as left in place", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    const fk = await q(
      `select conname from pg_constraint where conrelid = 'facetdb.listings_answers'::regclass and contype = 'f'`,
    );
    expect(fk).toHaveLength(1);
    await q(`alter table facetdb.listings_answers drop constraint "${String(fk[0]?.["conname"])}"`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes.join("\n")).toContain(
      `left in place: "facetdb"."listings_answers" is FacetDB's side table but has no foreign key to public.listings`,
    );
    expect(result.ok && result.plan.leftInPlace).toEqual(["facetdb.listings_answers"]);
    expect(await present("facetdb.listings_answers")).toBe(true);
    expect(await present("public.listings_with_answers")).toBe(false);
  });

  it("reports nothing for a side table that still has its foreign key (it is dropped)", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true, notes: [] });
    expect(await present("facetdb.listings_answers")).toBe(false);
  });

  it("names no orphan side table while a same-named table of another schema is installed", async () => {
    await freshWorld();
    await q(`create schema b`);
    await q(`create table b.listings (id serial primary key, title text)`);
    await install({ table: "listings", schema: "b", storage: "side-table" }, everyType, {
      id: "proj_b",
      name: "Bee",
    });
    await install();
    // b's side table lost its foreign key by hand: it is FacetDB's, unmarked as anyone's.
    const fk = await q(
      `select conname from pg_constraint where conrelid = 'facetdb.listings_answers'::regclass and contype = 'f'`,
    );
    await q(`alter table facetdb.listings_answers drop constraint "${String(fk[0]?.["conname"])}"`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes.join("\n")).not.toContain("listings_answers");
    expect(await present("facetdb.listings_answers")).toBe(true);
  });
});

describe("uninstall keeps a project's pending state", () => {
  async function outbox(rows: readonly (readonly [delivered: boolean, gaveUp: boolean])[]) {
    for (const [delivered, gaveUp] of rows) {
      await q(
        `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at, delivered_at, gave_up_at)
         values ($1, 'https://hooks.example.com/f', '{}', 1, 1, $2, $3)`,
        [project.id, delivered ? 2 : null, gaveUp ? 2 : null],
      );
    }
  }

  it("keeps the project and the outbox while a delivery is pending, and the note counts it", async () => {
    await freshWorld();
    await install();
    await outbox([
      [false, false],
      [false, false],
      [true, false],
      [false, true],
    ]);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      pendingDeliveries: 2,
      projectKeptBy: ["pending-deliveries"],
      sharedTablesDropped: false,
    });
    expect(result.ok && result.notes).toContain(
      `2 webhook deliveries of project ${project.id} still pending: the project and the webhook outbox stay until each is delivered or given up (retried for 24 hours).`,
    );
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: project.id }]);
    expect(await count(`select 1 from facetdb.webhook_outbox`)).toBe(4);
    expect(await present("facetdb.table_owners")).toBe(false);
  });

  it("drops the outbox with the project once every delivery is delivered or given up", async () => {
    await freshWorld();
    await install();
    await outbox([
      [true, false],
      [false, true],
    ]);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true, notes: [] });
    expect(result.ok && result.plan).toMatchObject({
      pendingDeliveries: 0,
      projectKeptBy: [],
      sharedTablesDropped: true,
    });
    expect(await present("facetdb.projects")).toBe(false);
    expect(await present("facetdb.webhook_outbox")).toBe(false);
  });

  it("never drops a pending delivery whose project row is gone", async () => {
    await freshWorld();
    await install();
    await q(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ('proj_gone', 'https://hooks.example.com/f', '{}', 1, 1)`,
    );
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      sharedTablesDropped: false,
      pendingDeliveries: 0,
      pendingElsewhere: 1,
      otherProjects: [],
    });
    expect(await count(`select 1 from facetdb.webhook_outbox`)).toBe(1);
  });

  it("keeps the project row while an unfinished backfill cursor exists, and says which run", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.cursors (run, cursor, done) values ('v1', 'c-17', false)`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      projectKeptBy: ["cursors"],
      unfinishedCursors: ["v1"],
    });
    expect(result.ok && result.notes).toContain(
      `the project ${project.id} and the store's shared tables stay because of an unfinished backfill cursor that names no source (run v1); it was written before a backfill kept its place per source, no backfill resumes it any more, and it keeps the shared tables until it is deleted: delete from facetdb.cursors where run in ('v1');`,
    );
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: project.id }]);
    expect(await present("facetdb.cursors")).toBe(true);
  });

  /** The source's resume rows: its backfills' places, a stream's token, a CT version. */
  const OWN_RUNS = [
    `backfill:${project.id}:listings:all@v1`,
    `backfill:${project.id}:listings:only@v2:category`,
    `ct:${project.id}:listings`,
    `mongo:${project.id}:listings`,
  ];
  /** Rows that are not this source's: another source of the project, and a project whose id holds a colon. */
  const OTHER_RUNS = [
    `backfill:${project.id}:orders:all@v1`,
    `backfill:${project.id}:listings:x:all@v1`,
    `mongo:${project.id}:listings_old`,
  ];

  async function resumeRows(runs: readonly string[]): Promise<void> {
    for (const run of runs) {
      await q(`insert into facetdb.cursors (run, cursor, done) values ($1, 'c-17', false)`, [run]);
    }
  }

  it("deletes the source's resume rows with a plain uninstall, and never counts them as an unfinished backfill", async () => {
    await freshWorld();
    await install();
    // Another project keeps the shared tables, so what the delete leaves is there to read.
    await q(`insert into facetdb.projects (id, name) values ('proj_b', 'B')`);
    await resumeRows([...OWN_RUNS, ...OTHER_RUNS]);
    const { result, printed } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      projectKeptBy: [],
      resumeRows: [...OWN_RUNS].sort(),
    });
    expect(result.ok && result.notes.join("\n")).not.toContain("backfill cursor");
    expect(printed[0]).toContain(
      `select set_config('facetdb.resume_source', '${project.id}:listings', true)`,
    );
    expect(
      (await q(`select run from facetdb.cursors`)).map((row) => String(row["run"])).sort(),
    ).toEqual([...OTHER_RUNS].sort());
    // Nothing of the project remains, so its row went: the source's rows kept nothing.
    expect(await q(`select id from facetdb.projects order by id`)).toEqual([{ id: "proj_b" }]);
  });

  it("lets the shared-table sweep go once only a source's resume rows are left", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await resumeRows(OWN_RUNS);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan).toMatchObject({
      projectKeptBy: [],
      unfinishedCursors: [],
      sharedTablesDropped: true,
      schemaDropped: true,
    });
    expect(await present("facetdb.cursors")).toBe(false);
    expect(await count(`select 1 from pg_namespace where nspname = 'facetdb'`)).toBe(0);
  });

  it("counts records only through the project's own sources", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.projects (id, name) values ('proj_x', 'X')`);
    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ('src_x', 'proj_x', 'xs', 'api')`,
    );
    const record = (source: string) =>
      q(
        `insert into facetdb.records (source_id, record_key, state, hash, status) values ($1, 'k', '{}', 'h', 'pending')`,
        [source],
      );
    await record("src_x");
    const theirs = await runUninstall({ dryRun: true });
    // Another project's source keeps the store in use, but its records are not this project's.
    expect(theirs.result.ok && theirs.result.plan.projectKeptBy).toEqual(["store-in-use"]);

    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ('src_api', '${project.id}', 'api', 'api')`,
    );
    await record("src_api");
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan.projectKeptBy).toEqual(["store-in-use", "records"]);
    expect(await q(`select id from facetdb.projects order by id`)).toEqual([
      { id: project.id },
      { id: "proj_x" },
    ]);
  });

  it("a finished cursor keeps nothing (a re-run starts from the top)", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.cursors (run, cursor, done) values ('v1', null, true)`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.plan.projectKeptBy).toEqual([]);
    expect(await present("facetdb.projects")).toBe(false);
  });
});
