import { describe, expect, it } from "vitest";
import { prune } from "./prune.ts";
import { renderSql } from "./sql.ts";
import {
  columns,
  freshWorld,
  install,
  project,
  q,
  recording,
  snapshot,
  useUninstallWorld,
  withoutCategory,
  world,
} from "./uninstall-world.ts";

/**
 * `migrate --prune` on PGlite: it drops columns on purpose, so every test reads the catalog
 * before and after. PGlite is one superuser connection: it proves the SQL and what it leaves, not
 * the roles' rights (install.db.test.ts covers those). Uninstall is uninstall.test.ts.
 */

useUninstallWorld();

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
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dropped: gone.map((column) => ({ column, reason: "no question asks it any more" })),
    });
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
