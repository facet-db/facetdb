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

const choice = (storeProbabilities: boolean): QuestionSet["questions"][number] => ({
  type: "choice",
  name: "category",
  instructions: "Which category?",
  options: [
    { name: "car", description: "A car" },
    { name: "flat", description: "A flat" },
  ],
  stakes: "low",
  storeProbabilities,
});

/** Dropped columns of a question no longer in the set, as `PruneResult.dropped` lists them. */
const unasked = (...columns: readonly string[]) =>
  columns.map((column) => ({ column, reason: "no question asks it any more" }));

const withProbabilities: QuestionSet = { ...both, questions: [...both.questions, choice(true)] };
const probabilitiesOff: QuestionSet = { ...both, questions: [...both.questions, choice(false)] };

async function columnNames(relation: string, schema = "public"): Promise<string[]> {
  const rows = await world.client.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, relation],
  );
  return rows.map((row) => String(row["column_name"]));
}

async function installed(
  source: MigrateSource = { table: "listings" },
  questionSet: QuestionSet = both,
): Promise<void> {
  world = await createPgliteWorld();
  worlds.push(world);
  await world.client.query(
    `create table public.listings (id serial primary key, title text, description text, created_at timestamptz default now())`,
  );
  const result = await migrate({
    adminUrl: "postgres://admin@unused/app",
    connect: world.connect,
    print: () => undefined,
    plan: { source, questionSet, project, workerPassword: "a-long-random-password" },
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
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dropped: [],
      revoked: ["description"],
    });
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
    expect(result).toMatchObject({ ok: true, applied: false, revoked: [], sql: "" });
    expect(printed).toEqual([]);
    expect(await workerSelect()).toEqual(before);
  });

  it("says who must run the revoke, and refuses, changing nothing, when it took nothing back", async () => {
    await installed();
    // An admin who may read the table but neither owns it nor is in its owner's role: Postgres runs
    // its revoke with a warning and takes back nothing (install.db.test.ts shows it on a server).
    await world.client.query(`create role other_admin`);
    await world.client.query(`grant select on public.listings to other_admin`);
    await world.client.query(`grant usage on schema facetdb to other_admin`);
    await world.client.query(
      `grant select on facetdb.table_owners, facetdb.projects to other_admin`,
    );
    const before = await workerSelect();
    await world.client.query(`set role other_admin`);
    let refused: Awaited<ReturnType<typeof runPrune>>;
    try {
      refused = await runPrune(titleOnly);
    } finally {
      await world.client.query(`reset role`);
    }
    expect(refused.printed[0]).toContain(
      "-- A revoke takes back only grants made by the role running it, and install's grants on the table\n-- are its owner's: run this as the table's owner or a member of its role.\nrevoke select",
    );
    expect(refused.result).toMatchObject({ ok: false });
    if (!refused.result.ok) {
      expect(refused.result.reason).toContain("the worker login still reads description");
    }
    expect(await workerSelect()).toEqual(before);
    // The owner's run takes it back.
    expect((await runPrune(titleOnly)).result).toMatchObject({ ok: true, applied: true });
    expect(await workerSelect()).not.toContain("description");
  });

  it("lets another grantor's grant stay with a note naming it, instead of refusing every prune", async () => {
    await installed();
    // A DBA granted the worker the same column on its own: the owner cannot revoke that grant.
    await world.client.query(`create role table_dba`);
    await world.client.query(
      `grant select (description) on public.listings to table_dba with grant option`,
    );
    await world.client.query(`set role table_dba`);
    try {
      await world.client.query(`grant select (description) on public.listings to facetdb_worker`);
    } finally {
      await world.client.query(`reset role`);
    }
    const { result } = await runPrune(titleOnly);
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      notes: ["description: a grant by table_dba remains; only that role can revoke it"],
    });
    // Install's grant is gone; the DBA's is the one left.
    const grantors = await world.client.query(
      `select x.grantor::regrole::text as grantor
         from pg_attribute a cross join lateral aclexplode(a.attacl) x
        where a.attrelid = 'public.listings'::regclass and a.attname = 'description'
          and x.grantee = 'facetdb_worker'::regrole`,
    );
    expect(grantors).toEqual([{ grantor: "table_dba" }]);
    expect((await runPrune(both)).result).toMatchObject({ ok: true, notes: [] });
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

describe("migrate --prune drops the columns of removed questions only", () => {
  it("keeps the _probabilities column of a question still in the set and names it", async () => {
    await installed({ table: "listings" }, withProbabilities);
    expect(await columnNames("listings")).toContain("category_probabilities");

    const { result, printed } = await runPrune(probabilitiesOff);
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      dropped: [],
      kept: ["category_probabilities: kept (storeProbabilities is off)"],
      sql: "",
    });
    expect(printed).toEqual([]);
    expect(await columnNames("listings")).toEqual(
      expect.arrayContaining(["category", "category_confidence", "category_probabilities"]),
    );
  });

  it("says a column went because its question changed type", async () => {
    // `category` was a choice; now it is a yes-or-no question of the same name.
    await installed({ table: "listings" }, withProbabilities);
    const asNoul: QuestionSet = {
      ...both,
      questions: [
        ...both.questions,
        { type: "noul", name: "category", instructions: "A car?", stakes: "low" },
      ],
    };
    const { result } = await runPrune(asNoul, { dryRun: true });
    expect(result.ok && result.dropped).toEqual([
      { column: "category_confidence", reason: "its question changed type" },
      { column: "category_probabilities", reason: "its question changed type" },
    ]);
  });

  it("drops all of a removed question's columns, and none of a kept one's", async () => {
    await installed({ table: "listings" }, withProbabilities);
    const { result, printed } = await runPrune(both);
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dropped: unasked("category", "category_confidence", "category_probabilities"),
      kept: [],
    });
    expect(printed[0]).toContain(`drop column "category_probabilities"`);
    expect(await columnNames("listings")).not.toContain("category_probabilities");
    expect(await columnNames("listings")).toContain("is_scam");
  });

  it("drops a removed question's columns and keeps the kept probabilities of another", async () => {
    const other: QuestionSet["questions"][number] = {
      type: "score",
      name: "quality",
      instructions: "How good?",
      levels: [{ name: "poor" }, { name: "fine" }, { name: "great" }],
      stakes: "low",
    };
    await installed(
      { table: "listings" },
      { ...withProbabilities, questions: [...withProbabilities.questions, other] },
    );
    const { result } = await runPrune(probabilitiesOff);
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dropped: unasked("quality", "quality_confidence", "quality_expected"),
      kept: ["category_probabilities: kept (storeProbabilities is off)"],
    });
    const after = await columnNames("listings");
    expect(after).toContain("category_probabilities");
    expect(after).not.toContain("quality");
  });

  it("in side-table mode keeps the column in the side table and in the rebuilt view", async () => {
    const other: QuestionSet["questions"][number] = {
      type: "score",
      name: "quality",
      instructions: "How good?",
      levels: [{ name: "poor" }, { name: "fine" }],
      stakes: "low",
    };
    await installed(
      { table: "listings", storage: "side-table" },
      { ...withProbabilities, questions: [...withProbabilities.questions, other] },
    );
    const { result } = await runPrune(probabilitiesOff);
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dropped: unasked("quality", "quality_confidence", "quality_expected"),
      kept: ["category_probabilities: kept (storeProbabilities is off)"],
    });
    expect(await columnNames("listings_answers", "facetdb")).toContain("category_probabilities");
    expect(await columnNames("listings_with_answers")).toContain("category_probabilities");
    expect(await columnNames("listings_with_answers")).not.toContain("quality");
  });
});
