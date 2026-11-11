import type { QuestionSet } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
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
const SOURCE_ID = "src_listings";
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

/** The decision log as a worker would have left it: no install creates it yet. */
async function decisionLog(rows: readonly (readonly [source: string, key: string])[]) {
  await q(`create table facetdb.decisions (
  id bigserial primary key,
  source_id text not null,
  record_key text not null,
  kind text not null
)`);
  for (const [source, key] of rows) {
    await q(
      `insert into facetdb.decisions (source_id, record_key, kind) values ($1, $2, 'answer')`,
      [source, key],
    );
  }
}

async function runUninstall(
  options: {
    readonly typed?: string;
    readonly purge?: boolean;
    readonly dryRun?: boolean;
    readonly table?: string;
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
    source: { table: options.table ?? "listings", sourceId: SOURCE_ID },
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
      { record_key: "15:public.listings:1" },
    ]);
    expect(await count(`select 1 from facetdb.decisions`)).toBe(1);
  });

  it("with purge deletes the source's log and the schema once it is empty", async () => {
    await freshWorld();
    await install();
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
      { record_key: "13:public.orders:1" },
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
