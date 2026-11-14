import type { QuestionSet } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import {
  type MigrateSource,
  migrate,
  type ProjectRef,
  type ScriptStatement,
  type TableName,
  type UninstallResult,
  uninstall,
} from "../install/index.ts";
import type { SqlClient, SqlConnect, SqlQuery } from "../sql/index.ts";
import { sourceIdOf } from "../store/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "./pglite.ts";

/**
 * The world the `migrate --prune` and `uninstall` tests share (install/uninstall.test.ts,
 * uninstall-prune.test.ts, uninstall-purge.test.ts and uninstall-kept.test.ts, split by subject so
 * no file passes 10 s), and the engine's tests of the same scenarios (engine/):
 * one PGlite per test file, a `listings` table, the install, and the catalog readers. Each file
 * calls `useUninstallWorld()` once at its top.
 */

export const everyType: QuestionSet = {
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
export const withoutCategory: QuestionSet = {
  ...everyType,
  questions: everyType.questions.filter((q) => q.name !== "category"),
};

export const project: ProjectRef = { id: "proj_listings", name: "Listings" };
/** The source's name in the config, as `--source` takes it. */
export const SOURCE_ID = "listings";
/** The id its log is written under: the project and the name. */
export const LOG_ID = sourceIdOf(project.id, SOURCE_ID);
export const APP_COLUMNS = ["id", "title", "description", "secret"];

/**
 * The test file's engine, booted once and emptied after every test: a boot per test cost
 * 440 ms. A live binding: `useUninstallWorld` sets it before the file's first test.
 */
export let world: PgliteWorld;

/** Boots the file's engine before its first test, empties it after each, and closes it at the end. */
export function useUninstallWorld(): void {
  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterEach(async () => {
    await resetPgliteWorld(world);
  });

  afterAll(async () => {
    await world.close();
  });
}

/** The application's tables on the emptied engine, as a fresh database would hold them. */
export async function freshWorld(tables: readonly string[] = ["listings"]): Promise<PgliteWorld> {
  for (const table of tables) {
    await world.client.query(
      `create table public.${table} (id serial primary key, title text, description text, secret text)`,
    );
  }
  return world;
}

export const q: SqlQuery = (text, params) => world.client.query(text, params);

export async function install(
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
export function recording(): {
  readonly connect: SqlConnect;
  readonly executed: ScriptStatement[];
} {
  const executed: ScriptStatement[] = [];
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

export async function columns(table = "listings", schema = "public"): Promise<string[]> {
  const rows = await q(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, table],
  );
  return rows.map((row) => String(row["column_name"]));
}

export async function present(name: string): Promise<boolean> {
  const rows = await q(`select to_regclass($1) is not null as present`, [name]);
  return rows[0]?.["present"] === true;
}

export async function count(sql: string): Promise<number> {
  return Number((await q(`select count(*)::int as n from (${sql}) s`))[0]?.["n"]);
}

/** Everything FacetDB could have left in the database, for before-and-after comparisons. */
export async function snapshot(): Promise<unknown> {
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
export async function decisionLog(rows: readonly (readonly [source: string, key: string])[]) {
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
 * plugin-kind row of the project, under the config's source name, whatever the table is called,
 * with the id `sourceIdOf(project, name)`.
 */
export async function registerSource(name: string = SOURCE_ID, projectId: string = project.id) {
  await q(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $3, 'plugin')`,
    [sourceIdOf(projectId, name), projectId, name],
  );
}

/** The log id of a source of this file's project. */
export const logOf = (name: string) => sourceIdOf(project.id, name);

export async function runUninstall(
  options: {
    readonly typed?: string;
    readonly purge?: boolean;
    readonly dryRun?: boolean;
    readonly table?: string;
    readonly sourceId?: string;
    readonly connect?: SqlConnect;
    readonly alsoUninstalling?: readonly TableName[];
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
    source: {
      table: options.table ?? "listings",
      name: options.sourceId ?? SOURCE_ID,
      projectId: project.id,
    },
    ...(options.purge === undefined ? {} : { purge: options.purge }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.alsoUninstalling === undefined
      ? {}
      : { alsoUninstalling: options.alsoUninstalling }),
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
