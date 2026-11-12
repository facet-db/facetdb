import type { QuestionSet } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { type MigrateSource, migrate } from "./migrate.ts";
import { prune } from "./prune.ts";
import type { ProjectRef } from "./sql.ts";

/**
 * `migrate --prune` and the worker's column-level select: a state column that left `read` loses the
 * worker's select in the pruned script, listed like the dropped columns; a kept one does not.
 * PGlite is one superuser connection: it proves the script and what it leaves in the catalog (the
 * grants are read from the catalog, not from a login).
 */

const both: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "Scam?", stakes: "low" }],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const titleOnly: QuestionSet = { ...both, read: ["title"] };

const project: ProjectRef = { id: "proj_listings", name: "Listings" };

let world: PgliteWorld;
const worlds: PgliteWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close();
  }
});

async function installed(source: MigrateSource = { table: "listings" }): Promise<void> {
  world = await createPgliteWorld();
  worlds.push(world);
  await world.client.query(
    `create table public.listings (id serial primary key, title text, description text, created_at timestamptz default now())`,
  );
  const result = await migrate({
    adminUrl: "postgres://admin@unused/app",
    connect: world.connect,
    print: () => undefined,
    plan: { source, questionSet: both, project, workerPassword: "a-long-random-password" },
  });
  expect(result).toMatchObject({ ok: true, applied: true });
}

/** The columns of public.listings the worker holds a select on. */
async function workerSelect(): Promise<string[]> {
  const rows = await world.client.query(
    `select column_name from information_schema.column_privileges
      where grantee = 'facetdb_worker' and table_schema = 'public' and table_name = 'listings'
        and privilege_type = 'SELECT' order by column_name`,
  );
  return rows.map((row) => String(row["column_name"]));
}

async function runPrune(questionSet: QuestionSet, options: { readonly dryRun?: boolean } = {}) {
  const printed: string[] = [];
  const result = await prune({
    adminUrl: "postgres://admin@unused/app",
    connect: world.connect,
    source: { table: "listings" },
    questionSet,
    project,
    print: (sql) => printed.push(sql),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { result, printed };
}

describe("migrate --prune revokes the worker's select on a removed state column", () => {
  it("revokes it for a column no longer in read, keeps the others, and a second prune finds nothing", async () => {
    await installed();
    expect(await workerSelect()).toContain("description");

    const { result, printed } = await runPrune(titleOnly);
    expect(result).toMatchObject({ ok: true, applied: true, dropped: [] });
    expect(printed[0]).toContain(
      `revoke select ("description") on "public"."listings" from "facetdb_worker"`,
    );
    expect(printed[0]).not.toContain(`revoke select ("title")`);
    expect(printed[0]).not.toContain(`revoke select ("id")`);
    expect(printed[0]).not.toContain(`revoke select ("created_at")`);
    expect(printed[0]).not.toContain(`revoke select ("is_scam")`);

    const after = await workerSelect();
    expect(after).not.toContain("description");
    expect(after).toEqual(expect.arrayContaining(["id", "title", "created_at", "is_scam"]));

    const second = await runPrune(titleOnly);
    expect(second.result).toMatchObject({ ok: true, applied: false, sql: "" });
    expect(second.printed).toEqual([]);
  });

  it("revokes nothing while every state column is still read", async () => {
    await installed();
    const before = await workerSelect();
    const { result, printed } = await runPrune(both);
    expect(result).toMatchObject({ ok: true, applied: false, sql: "" });
    expect(printed).toEqual([]);
    expect(await workerSelect()).toEqual(before);
  });

  it("lists the revoke in the dry run and touches nothing", async () => {
    await installed();
    const before = await workerSelect();
    const { result, printed } = await runPrune(titleOnly, { dryRun: true });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(printed[0]).toContain(`revoke select ("description")`);
    expect(await workerSelect()).toEqual(before);
  });

  it("revokes on the source table in side-table mode too", async () => {
    await installed({ table: "listings", storage: "side-table" });
    const { result, printed } = await runPrune(titleOnly);
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(printed[0]).toContain(
      `revoke select ("description") on "public"."listings" from "facetdb_worker"`,
    );
    expect(await workerSelect()).not.toContain("description");
  });
});
