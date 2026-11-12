import type { QuestionSet } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
import { pollingInstallSql } from "../polling/index.ts";
import type { SqlClient, SqlConnect, SqlQuery } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { type MigrateSource, migrate } from "./migrate.ts";
import { prune } from "./prune.ts";
import { type InstallStatement, type ProjectRef, renderSql } from "./sql.ts";
import { type UninstallResult, uninstall } from "./uninstall.ts";

/**
 * `migrate --prune` and `uninstall` on PGlite: these statements destroy data on purpose, so every
 * test reads the catalog before and after. PGlite is one superuser connection: it proves the SQL
 * and what it leaves, not the roles' rights (install.db.test.ts covers those).
 */

const everyType: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Scam?", stakes: "low" },
    {
      type: "choice",
      name: "category",
      instructions: "Which category?",
      options: [
        { name: "car", description: "A car" },
        { name: "flat", description: "A flat" },
      ],
      stakes: "low",
      storeProbabilities: true,
    },
    {
      type: "score",
      name: "quality",
      instructions: "How good?",
      levels: [{ name: "poor" }, { name: "fine" }, { name: "great" }],
      stakes: "low",
    },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The same set with the choice question removed. */
const withoutCategory: QuestionSet = {
  ...everyType,
  questions: everyType.questions.filter((q) => q.name !== "category"),
};

const project: ProjectRef = { id: "proj_listings", name: "Listings" };
const SOURCE_ID = "listings";
const APP_COLUMNS = ["id", "title", "description", "secret"];

let world: PgliteWorld;
const worlds: PgliteWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close();
  }
});

async function freshWorld(tables: readonly string[] = ["listings"]): Promise<PgliteWorld> {
  world = await createPgliteWorld();
  worlds.push(world);
  for (const table of tables) {
    await world.client.query(
      `create table public.${table} (id serial primary key, title text, description text, secret text)`,
    );
  }
  return world;
}

const q: SqlQuery = (text, params) => world.client.query(text, params);

async function install(
  source: MigrateSource = { table: "listings" },
  questionSet: QuestionSet = everyType,
  owner: ProjectRef = project,
): Promise<void> {
  const exists = await q(`select 1 from pg_roles where rolname = 'facetdb_worker'`);
  const result = await migrate({
    adminUrl: "postgres://admin@unused/app",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source,
      questionSet,
      project: owner,
      ...(exists.length === 0 ? { workerPassword: "a-long-random-password" } : {}),
    },
  });
  expect(result).toMatchObject({ ok: true, applied: true });
}

/**
 * A connect that records every statement the code runs inside its transaction, so a test can hold
 * the printed script against what ran. Nothing is patched: the code under test receives it.
 */
function recording(): { readonly connect: SqlConnect; readonly executed: InstallStatement[] } {
  const executed: InstallStatement[] = [];
  const client: SqlClient = {
    query: world.client.query,
    transaction: (work) =>
      world.client.transaction((query) =>
        work(async (text, params = []) => {
          executed.push({ text, params });
          return query(text, params);
        }),
      ),
    pipeline: (text, paramSets) => world.client.pipeline(text, paramSets),
    close: () => world.client.close(),
  };
  return { connect: () => client, executed };
}

async function columns(table = "listings", schema = "public"): Promise<string[]> {
  const rows = await q(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, table],
  );
  return rows.map((row) => String(row["column_name"]));
}

async function present(name: string): Promise<boolean> {
  const rows = await q(`select to_regclass($1) is not null as present`, [name]);
  return rows[0]?.["present"] === true;
}

async function count(sql: string): Promise<number> {
  return Number((await q(`select count(*)::int as n from (${sql}) s`))[0]?.["n"]);
}

/** Everything FacetDB could have left in the database, for before-and-after comparisons. */
async function snapshot(): Promise<unknown> {
  return {
    columns: await q(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('public', 'facetdb') order by 1, 2, ordinal_position`,
    ),
    relations: await q(
      `select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'facetdb') order by 1, 2`,
    ),
    triggers: await q(`select tgname from pg_trigger where not tgisinternal order by 1`),
    functions: await q(
      `select proname from pg_proc where pronamespace = to_regnamespace('facetdb') order by 1`,
    ),
    policies: await q(`select tablename, policyname from pg_policies order by 1, 2`),
    jobs: (await present("facetdb.jobs"))
      ? await q(`select record_key from facetdb.jobs order by 1`)
      : null,
    decisions: (await present("facetdb.decisions"))
      ? await q(`select source_id, record_key from facetdb.decisions order by 1, 2`)
      : null,
  };
}

/** The decision log as a worker would have left it, in the table the install made. */
async function decisionLog(rows: readonly (readonly [source: string, key: string])[]) {
  for (const [source, key] of rows) {
    await q(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ($1, $2, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
      [source, key],
    );
  }
}

/**
 * The source as the worker and backfill register it before writing its log (`ensureSource`): a
 * plugin-kind row of the project, under the config's source name, whatever the table is called.
 */
async function registerSource(name: string = SOURCE_ID, projectId: string = project.id) {
  await q(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $1, 'plugin')`,
    [name, projectId],
  );
}

async function runUninstall(
  options: {
    readonly typed?: string;
    readonly purge?: boolean;
    readonly dryRun?: boolean;
    readonly table?: string;
    readonly sourceId?: string;
    readonly connect?: SqlConnect;
  } = {},
): Promise<{
  readonly result: UninstallResult;
  readonly events: string[];
  readonly printed: string[];
}> {
  const events: string[] = [];
  const printed: string[] = [];
  const result = await uninstall({
    adminUrl: "postgres://admin@unused/app",
    connect: options.connect ?? world.connect,
    source: { table: options.table ?? "listings", sourceId: options.sourceId ?? SOURCE_ID },
    ...(options.purge === undefined ? {} : { purge: options.purge }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    print: (sql) => {
      events.push("print");
      printed.push(sql);
    },
    confirm: async ({ project: asked }) => {
      events.push(`confirm ${asked.name}`);
      return options.typed ?? "Listings";
    },
  });
  return { result, events, printed };
}

describe("migrate --prune", () => {
  it("drops exactly the columns of the removed question, and a second prune finds nothing", async () => {
    await freshWorld();
    await install();
    const before = await columns();
    const { connect, executed } = recording();
    const printed: string[] = [];
    const result = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project,
      print: (sql) => printed.push(sql),
    });
    const gone = ["category", "category_confidence", "category_probabilities"];
    expect(result).toMatchObject({ ok: true, applied: true, dropped: gone });
    expect(await columns()).toEqual(before.filter((c) => !gone.includes(c)));
    // The printed script is the statements that ran, as one string, with no parameter anywhere.
    expect(printed).toEqual([renderSql(executed)]);
    expect(executed.every((s) => s.params.length === 0)).toBe(true);
    expect(executed.filter((s) => s.text.includes("drop")).map((s) => s.text)).toEqual(
      gone.map((c) => `alter table "public"."listings" drop column "${c}"`),
    );

    const again: string[] = [];
    const second = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project,
      print: (sql) => again.push(sql),
    });
    expect(second).toMatchObject({ ok: true, applied: false, dropped: [], sql: "" });
    expect(again).toEqual([]);
  });

  it("never drops a column FacetDB did not mark, and a dry run touches nothing", async () => {
    await freshWorld();
    await install();
    // An application's column that happens to look like an answer column: not marked, kept.
    await q(`alter table public.listings add column old_answer_confidence real`);
    const before = await snapshot();
    const printed: string[] = [];
    const result = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project,
      print: (sql) => printed.push(sql),
      dryRun: true,
    });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(printed).toHaveLength(1);
    expect(printed[0]).not.toContain("old_answer_confidence");
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a table another project installed on, and one FacetDB is not on", async () => {
    await freshWorld(["listings", "orders"]);
    await install();
    const other = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project: { id: "proj_other", name: "Other" },
      print: () => undefined,
    });
    expect(other).toMatchObject({ ok: false });
    const none = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "orders" },
      questionSet: withoutCategory,
      project,
      print: () => undefined,
    });
    expect(none).toMatchObject({ ok: false });
    expect(await columns()).toContain("category");
  });

  it("in side-table mode drops the side table's columns and rebuilds the view with its grants", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    await q(`create role facetdb_test_reader nologin`);
    await q(`grant select on public.listings_with_answers to facetdb_test_reader`);
    await q(`insert into public.listings (title) values ('a')`);
    const result = await prune({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings" },
      questionSet: withoutCategory,
      project,
      print: () => undefined,
    });
    expect(result).toMatchObject({ ok: true, applied: true });
    const side = await columns("listings_answers", "facetdb");
    expect(side.filter((c) => c.startsWith("category"))).toEqual([]);
    expect(side).toContain("is_scam");
    const view = await columns("listings_with_answers");
    expect(view.filter((c) => c.startsWith("category"))).toEqual([]);
    expect(view).toEqual(expect.arrayContaining(["is_scam", "quality", "facetdb_status"]));
    expect(await q(`select facetdb_status from public.listings_with_answers`)).toEqual([
      { facetdb_status: "pending" },
    ]);
    const grant = await q(
      `select has_table_privilege('facetdb_test_reader', 'public.listings_with_answers', 'select') as ok`,
    );
    expect(grant[0]?.["ok"]).toBe(true);
  });
});

describe("uninstall", () => {
  it("without purge removes what install added, keeps the decision log, and installs again", async () => {
    await freshWorld();
    await install();
    await decisionLog([[SOURCE_ID, "1"]]);
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
      { source_id: SOURCE_ID, record_key: "1" },
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
    await decisionLog([[SOURCE_ID, "1"]]);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await present("facetdb.decisions")).toBe(false);
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("with purge keeps another source's log rows, and the schema that holds them", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([
      [SOURCE_ID, "1"],
      ["src_other", "7"],
    ]);
    const { result } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: true, applied: true });
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
    await decisionLog([[SOURCE_ID, "1"]]);
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

  it("in side-table mode drops the side table and the view and leaves the table as it was", async () => {
    await freshWorld();
    await install({ table: "listings", storage: "side-table" });
    await q(`insert into public.listings (title) values ('a')`);
    const { result } = await runUninstall();
    expect(result).toMatchObject({ ok: true, applied: true });
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

describe("uninstall --purge is tied to the table it uninstalls", () => {
  async function purgeWith(sourceId: string, options: { readonly dryRun?: boolean } = {}) {
    const printed: string[] = [];
    const result = await uninstall({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings", sourceId },
      purge: true,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      print: (sql) => printed.push(sql),
      confirm: async () => "Listings",
    });
    return { result, printed };
  }

  const logRows = async () =>
    q(`select source_id, record_key from facetdb.decisions order by 1, 2`);

  it("a made-up id deletes nothing, and the output says so", async () => {
    await freshWorld();
    await install();
    await decisionLog([
      [SOURCE_ID, "1"],
      ["src_other", "7"],
    ]);
    const { result } = await purgeWith("src_made_up");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes).toContain(
      `purge: no decisions were ever logged for source "src_made_up", nothing to purge.`,
    );
    expect(await logRows()).toEqual([
      { source_id: "listings", record_key: "1" },
      { source_id: "src_other", record_key: "7" },
    ]);
    // The table itself is uninstalled all the same.
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("another source's id is not deleted through this table, even one that exists in the log", async () => {
    await freshWorld();
    await install();
    await decisionLog([["src_other", "7"]]);
    const { result } = await purgeWith("src_other");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
  });

  it.each(["src_1", "prod_listings"])(
    "a live API source of the same project is not purged through this table, named by %s",
    async (given) => {
      await freshWorld();
      await install();
      await q(
        `insert into facetdb.sources (id, project_id, name, kind) values ('src_1', '${project.id}', 'prod_listings', 'api')`,
      );
      await q(
        `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ('src_1', 1, 'h', '{}')`,
      );
      await decisionLog([
        ["src_1", "1"],
        ["src_1", "2"],
        [SOURCE_ID, "3"],
      ]);
      const { result } = await purgeWith(given);
      expect(result).toMatchObject({ ok: true, applied: true });
      // The API source's id has log rows (they are not this table's); its name has none.
      expect(result.ok && result.notes.join("\n")).toContain(
        given === "src_1"
          ? `no source named "src_1" belongs to this table or its project, so no decision was deleted`
          : `no decisions were ever logged for source "prod_listings", nothing to purge`,
      );
      expect(await logRows()).toEqual([
        { source_id: "listings", record_key: "3" },
        { source_id: "src_1", record_key: "1" },
        { source_id: "src_1", record_key: "2" },
      ]);
      expect(await count(`select 1 from facetdb.question_set_versions`)).toBe(1);
    },
  );

  it("does not purge a live store source whose id is the table's own name", async () => {
    await freshWorld();
    await install();
    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ('listings', '${project.id}', 'other', 'plugin')`,
    );
    await decisionLog([[SOURCE_ID, "1"]]);
    const { result } = await purgeWith("listings");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes.join("\n")).toContain("so no decision was deleted");
    expect(await logRows()).toEqual([{ source_id: "listings", record_key: "1" }]);
  });

  it("does not take a store source of another project for this table's", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.projects (id, name) values ('proj_x', 'X')`);
    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ('src_x', 'proj_x', 'xs', 'api')`,
    );
    await decisionLog([["src_x", "1"]]);
    const { result } = await purgeWith("xs");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await logRows()).toEqual([{ source_id: "src_x", record_key: "1" }]);
  });

  it("a dry run says what the purge will delete and deletes nothing", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([[SOURCE_ID, "1"]]);
    const { result } = await purgeWith(SOURCE_ID, { dryRun: true });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(result.ok && result.notes.join("\n")).toContain(
      `will delete 1 decision(s) and 0 question-set version(s) of source "listings"`,
    );
    expect(await logRows()).toHaveLength(1);
  });

  describe("after an uninstall without purge (the owner row is gone)", () => {
    it("a log-only purge deletes the matching source's log and says what it deleted", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([
        [SOURCE_ID, "1"],
        [SOURCE_ID, "2"],
        ["src_other", "7"],
      ]);
      expect((await runUninstall()).result).toMatchObject({ ok: true, applied: true });
      expect(await runUninstall({ purge: true, typed: "listings" })).toMatchObject({
        result: { ok: true },
      });
      // Not installed any more, so the second run was the log-only purge.
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
    });

    it("prints a script that only touches the log, asks for the source's name, and reports the count", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([
        [SOURCE_ID, "1"],
        ["src_other", "7"],
      ]);
      await runUninstall();
      const { connect, executed } = recording();
      const asked: string[] = [];
      const printed: string[] = [];
      const result = await uninstall({
        adminUrl: "postgres://admin@unused/app",
        connect,
        source: { table: "listings", sourceId: SOURCE_ID },
        purge: true,
        print: (sql) => printed.push(sql),
        confirm: async ({ project: asking }) => {
          asked.push(asking.name);
          return "listings";
        },
      });
      expect(asked).toEqual(["listings"]);
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(result.ok && result.notes).toEqual([
        "public.listings has no FacetDB install left; only the decision log was purged.",
        `purge: deleted 1 decision(s) and 0 question-set version(s) of source "listings".`,
      ]);
      expect(printed).toEqual([renderSql(executed)]);
      // Nothing of the table's: what it may drop besides the log is the store's, once unused.
      expect(printed[0]).not.toMatch(
        /alter table|drop trigger|drop column|delete from "facetdb"\."jobs"|listings_answers/,
      );
      expect(await columns()).toEqual(APP_COLUMNS);
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
    });

    it("a made-up name refuses and changes nothing; a wrong confirmation runs nothing", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([[SOURCE_ID, "1"]]);
      await runUninstall();
      const before = await snapshot();

      const { connect, executed } = recording();
      const madeUp = await runUninstall({ purge: true, connect, sourceId: "nope" });
      expect(madeUp.result).toMatchObject({ ok: false });
      expect(madeUp.events).toEqual([]);
      const wrong = await runUninstall({ purge: true, connect, typed: "other" });
      expect(wrong.result).toMatchObject({ ok: false });
      expect(wrong.events).toEqual(["print", "confirm listings"]);
      expect(executed).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

    it("never reaches the log of a source that is still live (a typo'd table, a store source)", async () => {
      await freshWorld(["listings", "listing"]);
      await install();
      await registerSource();
      await decisionLog([[SOURCE_ID, "1"]]);
      // `listing` has no owner row; the live `listings` source carries the log. The store does not
      // record which table a source reads, so any installed table makes it possibly live.
      const typo = await runUninstall({ purge: true, table: "listing", sourceId: "listings" });
      expect(typo.result).toMatchObject({ ok: false });
      expect(typo.result.ok === false && typo.result.reason).toBe(
        `the decision log of source "listings" may be shared with public.listings (project ${project.id}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`,
      );
      expect(typo.events).toEqual([]);
      expect(await logRows()).toEqual([{ source_id: "listings", record_key: "1" }]);

      // A store source (plugin or API) of that name is live too, whatever the table argument.
      await q(
        `insert into facetdb.sources (id, project_id, name, kind) values ('listing', '${project.id}', 'listing', 'api')`,
      );
      await decisionLog([["listing", "9"]]);
      const live = await runUninstall({ purge: true, table: "listing", sourceId: "listing" });
      expect(live.result).toMatchObject({ ok: false });
      expect(await logRows()).toHaveLength(2);
    });

    it("without purge the table stays refused", async () => {
      await freshWorld();
      await install();
      await runUninstall();
      const { result } = await runUninstall();
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).toContain("facetdb.table_owners has no row");
    });

    it("the schema goes with the last log row", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([[SOURCE_ID, "1"]]);
      await runUninstall();
      const { result } = await runUninstall({ purge: true, typed: "listings" });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(
        true,
      );
    });
  });
});

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

describe("uninstall --purge finds the log by the source's id", () => {
  const logRows = async () =>
    q(`select source_id, record_key from facetdb.decisions order by 1, 2`);

  async function versions(sourceId: string): Promise<void> {
    await q(
      `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
      [sourceId],
    );
  }

  it.each(["t_listings", "listings_renamed"])(
    "a purge of source %s on table listings deletes exactly that source's log",
    async (name) => {
      const renamed = name === "listings_renamed";
      await freshWorld();
      await install();
      await registerSource(name);
      if (renamed) {
        // The source was `listings` before the rename: the worker registered that row then, and
        // registers the new name after; the old log stays under the old id.
        await registerSource(SOURCE_ID);
      }
      await versions(name);
      await versions("src_other");
      await decisionLog([
        [name, "1"],
        [name, "2"],
        [SOURCE_ID, "3"],
        ["src_other", "4"],
      ]);
      const { connect, executed } = recording();
      const { result, printed } = await runUninstall({ purge: true, sourceId: name, connect });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(result.ok && result.plan.log).toEqual({
        status: "found",
        given: name,
        sourceId: name,
        decisions: 2,
        versions: 1,
      });
      expect(result.ok && result.notes).toContain(
        `purge: deleted 2 decision(s) and 1 question-set version(s) of source "${name}".`,
      );
      expect(result.ok && result.plan.otherSourceLogs).toEqual(
        renamed ? [{ source: SOURCE_ID, decisions: 1 }] : [],
      );
      const oldName = `left in place: the decision log of source "${SOURCE_ID}" (1 decision(s)), another source of this project in the FacetDB store; if it was this table's source under an earlier name, delete it with: facetdb uninstall --purge --source ${SOURCE_ID}`;
      expect(result.ok && result.notes.includes(oldName)).toBe(renamed);
      expect(await logRows()).toEqual([
        { source_id: SOURCE_ID, record_key: "3" },
        { source_id: "src_other", record_key: "4" },
      ]);
      expect(await q(`select source_id from facetdb.question_set_versions`)).toEqual([
        { source_id: "src_other" },
      ]);
      expect(printed).toEqual([renderSql(executed)]);
      expect(printed[0]).not.toContain("source_id = ''");
      if (renamed) {
        // The note's command: the old name's log, now that no table is installed.
        const old = await runUninstall({ purge: true, sourceId: SOURCE_ID, typed: SOURCE_ID });
        expect(old.result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
        expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "4" }]);
      }
    },
  );

  it("an unresolved purge prints no delete, says why and names the sources it found", async () => {
    await freshWorld();
    await install();
    await registerSource("orders_src");
    await registerSource("t_listings");
    // Rows under the given name that no registration of the project claims: never purged here.
    await decisionLog([
      ["t_listings", "1"],
      ["nope", "2"],
    ]);
    for (const dryRun of [true, false]) {
      const { result, printed } = await runUninstall({ purge: true, sourceId: "nope", dryRun });
      expect(result).toMatchObject({ ok: true, applied: !dryRun });
      expect(result.ok && result.plan.log).toEqual({
        status: "not-found",
        given: "nope",
        found: ["orders_src", "t_listings"],
        logged: 1,
      });
      expect(result.ok && result.notes.join("\n")).toContain(
        `no source named "nope" belongs to this table or its project, so no decision was deleted (the script has no delete of the log). The project's sources in the FacetDB store: orders_src, t_listings.`,
      );
      expect(printed[0]).not.toContain("delete from facetdb.decisions");
      expect(printed[0]).not.toContain("source_id = ''");
      expect(printed[0]).not.toContain("facetdb.uninstall_source");
    }
    expect(await logRows()).toEqual([
      { source_id: "nope", record_key: "2" },
      { source_id: "t_listings", record_key: "1" },
    ]);
  });

  it("a plain uninstall names the log it leaves and the command that purges it later", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([["t_listings", "1"]]);
    const { result } = await runUninstall({ sourceId: "t_listings" });
    expect(result).toMatchObject({ ok: true, applied: true });
    const command = "facetdb uninstall --purge --source t_listings";
    expect(result.ok && result.plan).toMatchObject({
      mode: "table",
      purge: false,
      log: { status: "found", sourceId: "t_listings", decisions: 1, versions: 0 },
      logOnlyPurge: { source: "t_listings", command },
      // The source's registration keeps the store in use until the log is purged.
      projectKeptBy: ["store-in-use"],
      sharedTablesDropped: false,
    });
    expect(result.ok && result.notes).toEqual([
      `the decision log of source "t_listings" stays (1 decision(s), 0 question-set version(s)); to delete it later: ${command}`,
    ]);

    const later = await runUninstall({ purge: true, sourceId: "t_listings", typed: "t_listings" });
    expect(later.result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
    expect(later.result.ok && later.result.plan).toMatchObject({
      log: { status: "found", sourceId: "t_listings", decisions: 1 },
      projectKeptBy: [],
      sharedTablesDropped: true,
    });
    // The log went with its last row, and nothing is left using the store: the project, the shared
    // tables and the schema go too.
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
  });

  describe("two projects whose sources share a name write one log", () => {
    const bee: ProjectRef = { id: "proj_b", name: "Bee" };
    const shared = `the decision log of source "${SOURCE_ID}" may be shared with staging.listings (project proj_b), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`;

    /** A on public.listings, B on staging.listings, both sources named `listings`. */
    async function twoProjects(options: { readonly installB: boolean }) {
      await freshWorld();
      await q(`create schema staging`);
      await q(
        `create table staging.listings (id serial primary key, title text, description text, secret text)`,
      );
      await install();
      if (options.installB) {
        await install({ table: "listings", schema: "staging" }, everyType, bee);
      }
      // The worker registers `id = name` with `on conflict (id) do nothing`: A's row wins, B's
      // registration is skipped, and both write their log under `listings`.
      await registerSource(SOURCE_ID, project.id);
      await q(
        `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $1, 'plugin') on conflict (id) do nothing`,
        [SOURCE_ID, bee.id],
      );
      await versions(SOURCE_ID);
      await decisionLog([
        [SOURCE_ID, "a1"],
        [SOURCE_ID, "b1"],
        ["src_other", "7"],
      ]);
    }

    const uninstallB = () =>
      uninstall({
        adminUrl: "postgres://admin@unused/app",
        connect: world.connect,
        source: { table: "listings", schema: "staging", sourceId: SOURCE_ID },
        print: () => undefined,
        confirm: async () => bee.name,
      });

    it("A's purge is refused while B is installed; once B is uninstalled it deletes exactly the log", async () => {
      await twoProjects({ installB: true });
      const before = await snapshot();
      for (const dryRun of [true, false]) {
        const { result, events } = await runUninstall({ purge: true, dryRun });
        expect(result).toEqual({ ok: false, reason: shared });
        expect(events).toEqual([]);
      }
      expect(await snapshot()).toEqual(before);
      expect(await count(`select 1 from facetdb.question_set_versions`)).toBe(1);

      // A plain uninstall of A still runs, and says the log waits for B.
      const plain = await runUninstall({ dryRun: true });
      expect(plain.result.ok && plain.result.plan.logOnlyPurge).toBeUndefined();
      expect(plain.result.ok && plain.result.notes).toContain(
        `the decision log of source "${SOURCE_ID}" stays (2 decision(s), 1 question-set version(s)); it can be purged once no other table is installed in this database (facetdb uninstall --purge --source ${SOURCE_ID}).`,
      );

      expect(await uninstallB()).toMatchObject({ ok: true, applied: true });
      const { result } = await runUninstall({ purge: true });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
      // Its last version gone, the versions table went with it (nothing else uses the store).
      expect(await present("facetdb.question_set_versions")).toBe(false);
    });

    it("a log-only purge after A's plain uninstall is refused while B is installed", async () => {
      await twoProjects({ installB: true });
      expect((await runUninstall()).result).toMatchObject({ ok: true, applied: true });
      const { result, events } = await runUninstall({ purge: true, typed: SOURCE_ID });
      expect(result).toEqual({ ok: false, reason: shared });
      expect(events).toEqual([]);
      expect(await count(`select 1 from facetdb.decisions where source_id = 'listings'`)).toBe(2);

      expect(await uninstallB()).toMatchObject({ ok: true, applied: true });
      const later = await runUninstall({ purge: true, typed: SOURCE_ID });
      expect(later.result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
    });

    it("re-checks inside the transaction: B installed after A's checks stops A's purge", async () => {
      await twoProjects({ installB: false });
      const result = await uninstall({
        adminUrl: "postgres://admin@unused/app",
        connect: world.connect,
        source: { table: "listings", sourceId: SOURCE_ID },
        purge: true,
        print: () => undefined,
        confirm: async () => {
          await install({ table: "listings", schema: "staging" }, everyType, bee);
          return project.name;
        },
      });
      expect(result).toEqual({ ok: false, reason: shared });
      expect(await count(`select 1 from facetdb.decisions where source_id = 'listings'`)).toBe(2);
      expect(await columns()).toContain("is_scam");
    });
  });

  it("refuses --purge on a polling-mode table (no owner row) with the plain refusal", async () => {
    await freshWorld(["listings", "orders"]);
    await install({ table: "orders" }, everyType, { id: "proj_orders", name: "Orders" });
    // A polling-mode source: FacetDB's marked columns on the table, no trigger, no owner row.
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, everyType)) {
      await q(statement);
    }
    await q(`insert into facetdb.projects (id, name) values ('proj_polling', 'Polling')`);
    await registerSource(SOURCE_ID, "proj_polling");
    await decisionLog([[SOURCE_ID, "1"]]);
    const before = await snapshot();
    const { result, events } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("facetdb.table_owners has no row");
    expect(result.ok === false && result.reason).not.toContain("only the decision log");
    expect(events).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("re-checks inside the transaction: an install that lands after the checks is never purged", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([["t_listings", "1"]]);
    await runUninstall({ sourceId: "t_listings" });

    const result = await uninstall({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings", sourceId: "t_listings" },
      purge: true,
      print: () => undefined,
      // Between the checks and the transaction, the table is installed again for its project.
      confirm: async () => {
        await install();
        return "t_listings";
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain(
      `the decision log of source "t_listings" is live again: public.listings is now installed for its project; nothing was changed`,
    );
    expect(await logRows()).toEqual([{ source_id: "t_listings", record_key: "1" }]);
    expect(await columns()).toContain("is_scam");
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
    expect(result.ok && result.plan.sharedTablesDropped).toBe(false);
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
      `the project ${project.id} and the store's shared tables stay because of an unfinished backfill cursor (run v1); it keeps the shared tables until the backfill finishes or the cursor is deleted.`,
    );
    expect(await q(`select id from facetdb.projects`)).toEqual([{ id: project.id }]);
    expect(await present("facetdb.cursors")).toBe(true);
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
