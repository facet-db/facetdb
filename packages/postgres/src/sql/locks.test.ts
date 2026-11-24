import type { PGlite } from "@electric-sql/pglite";
import type { QuestionSet } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type InstallStatement, installSql, pruneSql, renderStatement } from "../install/index.ts";
import { migrateStore, storeInstallStatements, storeStepStatements } from "../store/index.ts";
import { everyType, freshPglite, resetPglite } from "../testing/index.ts";
import {
  holdsOff,
  pgliteClient,
  type StatementLock,
  scriptLocks,
  statementLocks,
  UnreadStatementError,
} from "./index.ts";

/**
 * The lock list's reader: it reads every statement FacetDB's scripts hold, in every variant, names
 * each command's lock as Postgres's documentation does (the real server's `pg_locks` agrees in
 * engine/migrate-locks.db.test.ts), and stops at a statement it cannot read rather than leave its
 * lock out.
 */

const project = { id: "proj_locks", name: "Locks" };

/** Every statement of a script read in order, as a plan's text; the settings carry through. */
function readAll(statements: readonly string[]): StatementLock[][] {
  const settings = new Map<string, string>();
  return statements.map((text) => statementLocks(text, settings));
}

const texts = (statements: readonly InstallStatement[]) => statements.map(renderStatement);

/** A table whose names hold quotes, commas, spaces, parentheses and a keyword. */
const WEIRD = { schema: "my schema", table: 'we"ird, on (x)', key: "the key" } as const;

const weirdSet: QuestionSet = { ...everyType, read: ["on", "title"] };

/** The install, side-table install and prune scripts FacetDB writes, by name. */
const SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  "inline install, first (the login made)": texts(
    installSql({ table: "listings", key: "id" }, everyType, project, { workerPassword: "pw" }),
  ),
  "inline install, again": texts(installSql({ table: "listings", key: "id" }, everyType, project)),
  "inline install, onChange keep": texts(
    installSql({ table: "listings", key: "id", onChange: "keep" }, everyType, project),
  ),
  "side-table install, with readers": texts(
    installSql(
      { table: "listings", key: "id", keyType: "integer", storage: "side-table" },
      everyType,
      project,
      { sourceReaders: true, workerPassword: "pw" },
    ),
  ),
  "inline install, names that need quoting": texts(
    installSql({ table: WEIRD.table, schema: WEIRD.schema, key: WEIRD.key }, weirdSet, project, {}),
  ),
  "side-table install, names that need quoting": texts(
    installSql(
      {
        table: "odd,(t)",
        schema: WEIRD.schema,
        key: WEIRD.key,
        keyType: "text",
        storage: "side-table",
      },
      weirdSet,
      project,
    ),
  ),
  "inline prune": texts(
    pruneSql(
      { table: "listings", key: "id" },
      { ...everyType, questions: everyType.questions.slice(0, 1) },
      {
        columns: ["is_scam", "category", "quality", "facetdb_status"],
        workerSelect: ["id", "title", "description"],
      },
    ),
  ),
  "side-table prune": texts(
    pruneSql(
      { table: "listings", key: "id", keyType: "integer", storage: "side-table" },
      { ...everyType, questions: everyType.questions.slice(0, 1) },
      { columns: ["is_scam", "category", "quality"], workerSelect: ["id", "title", "body"] },
    ),
  ),
  "the store's step": storeStepStatements(),
};

describe("reading every script FacetDB writes", () => {
  it.each(Object.entries(SCRIPTS))("%s: every statement is read", (_name, statements) => {
    expect(statements.length).toBeGreaterThan(0);
    expect(() => readAll(statements)).not.toThrow();
  });

  it("names a table whose name holds quotes, commas and a keyword as Postgres reads it", () => {
    const locks = readAll(SCRIPTS["inline install, names that need quoting"] ?? []).flat();
    const listed = locks.filter((one) => holdsOff(one.mode));
    expect(listed[0]).toMatchObject({
      relation: { schema: WEIRD.schema, name: WEIRD.table },
      mode: "access exclusive",
    });
    // Every other lock is on FacetDB's own schema: the name was read whole, never split.
    const others = listed.filter((one) => one.relation.name !== WEIRD.table);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((one) => one.relation.schema === "facetdb")).toBe(true);
  });

  it("finds the side table and its view through the script's own settings", () => {
    const locks = readAll(SCRIPTS["side-table install, with readers"] ?? []).flat();
    const tables = new Set(
      locks
        .filter((one) => holdsOff(one.mode))
        .map((one) => `${one.relation.schema}.${one.relation.name}`),
    );
    expect(tables).toContain("facetdb.listings_answers");
    expect(tables).toContain("public.listings_with_answers");
    expect(tables).toContain("public.listings");
  });

  it("takes every lock of the store's step only when what it makes is missing", () => {
    // So the same statements in an install's plan, run after the step, lock nothing.
    const inStep = new Set(storeInstallStatements());
    for (const [index, locks] of readAll(storeStepStatements()).entries()) {
      for (const one of locks.filter((taken) => holdsOff(taken.mode))) {
        expect(one.when.length, storeStepStatements()[index]).toBeGreaterThan(0);
      }
    }
    expect(inStep.size).toBeGreaterThan(0);
  });
});

describe("each command's lock, as Postgres's documentation names it", () => {
  const one = (text: string) => readAll([text]).flat();

  it.each([
    ['lock table "public"."t" in access exclusive mode', "access exclusive", false],
    ['lock table "public"."t" in share mode', "share", false],
    ["create index i on facetdb.decisions (source_id, id)", "share", true],
    ["create index concurrently i on facetdb.decisions (id)", "share update exclusive", true],
    [
      'alter table "public"."t"\n  add column if not exists "a" boolean,\n  add column if not exists "s" text not null default \'pending\'',
      "access exclusive",
      false,
    ],
    ["alter table facetdb.t add column c bigint not null default 0", "access exclusive", false],
    [
      "alter table facetdb.t add column c timestamptz default clock_timestamp()",
      "access exclusive",
      true,
    ],
    ["alter table facetdb.t alter column endpoint drop not null", "access exclusive", false],
    [
      "alter table facetdb.t drop constraint k, add constraint k2 primary key (a, b)",
      "access exclusive",
      true,
    ],
    [
      "alter table facetdb.t add constraint k check (a is not null or b is not null)",
      "access exclusive",
      true,
    ],
    ["alter table facetdb.t add constraint k check (a > 0) not valid", "access exclusive", false],
    ['alter table "public"."t" drop column "is_spam"', "access exclusive", false],
    ['alter table "facetdb"."t_answers" enable row level security', "access exclusive", false],
    [
      'create trigger "facetdb_t" before insert or update of "on", "title"\n  on "public"."t" for each row execute function "facetdb"."enqueue"(\'id\', \'t:8:public.t:\')',
      "share row exclusive",
      false,
    ],
    ['create policy "p" on "public"."t" for select to "w" using (true)', "access exclusive", false],
    ['drop view if exists "public"."t_with_answers"', "access exclusive", false],
    ['drop trigger if exists "facetdb_t" on "public"."t"', "access exclusive", false],
  ] as const)("%s", (text, mode, everyRow) => {
    const [first] = one(text);
    expect(first).toMatchObject({ mode, everyRow });
  });

  it("takes no table lock to grant, revoke, read, set, or make a function, a role or a schema", () => {
    for (const text of [
      'grant select ("id", "title") on "public"."t" to "facetdb_worker"',
      'grant update ("held_by", "probe_at") on "facetdb"."question_set_versions" to "w"',
      '-- a note\nrevoke select ("x") on "public"."t" from "w"',
      "set local lock_timeout = '10s'",
      "select pg_advisory_xact_lock(hashtext('facetdb.store_migrations'))",
      "create or replace function facetdb.f() returns int language sql as $$ select 1 $$",
      'alter function "facetdb"."enqueue"() owner to "facetdb_enqueue"',
      'create schema if not exists "facetdb"',
      "-- the worker password: set by `facetdb migrate` for the transaction, never printed",
    ]) {
      expect(
        one(text).filter((taken) => holdsOff(taken.mode)),
        text,
      ).toEqual([]);
    }
  });

  it("holds off neither reads nor writes to comment, insert, update or delete", () => {
    for (const text of [
      `comment on column "public"."t"."a" is 'facetdb'`,
      "insert into facetdb.store_migrations (version) values (12) on conflict (version) do nothing",
      "update facetdb.jobs set record_key = 'x' where record_key = 'y'",
      "delete from facetdb.jobs where record_key = 'x'",
    ]) {
      const locks = one(text);
      expect(locks.length, text).toBe(1);
      expect(
        locks.some((taken) => holdsOff(taken.mode)),
        text,
      ).toBe(false);
    }
  });

  it("makes a new table, locking what its foreign keys reference, only when it is missing", () => {
    const locks = one(
      "create table if not exists facetdb.sources (\n  id text primary key,\n  project_id text not null references facetdb.projects (id)\n)",
    );
    expect(locks).toEqual([
      {
        relation: { schema: "facetdb", name: "sources" },
        mode: "access exclusive",
        everyRow: false,
        creates: true,
        when: [`to_regclass('"facetdb"."sources"') is null`],
      },
      {
        relation: { schema: "facetdb", name: "projects" },
        mode: "share row exclusive",
        everyRow: false,
        creates: false,
        when: [`to_regclass('"facetdb"."sources"') is null`],
      },
    ]);
  });

  it("reads a do block's guarded statement under the block's own condition, settings filled in", () => {
    const settings = new Map<string, string>();
    statementLocks(
      "select set_config('facetdb.install_schema', 'public', true), set_config('facetdb.install_table', 'listings', true)",
      settings,
    );
    const [policy] = statementLocks(
      `do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('facetdb.install_schema')
                   and tablename = current_setting('facetdb.install_table')
                   and policyname = 'facetdb_reads') then
    execute format('create policy %I on %I.%I for select to %I using (true)',
                   'facetdb_reads', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'facetdb_worker');
  end if;
end $$`,
      settings,
    );
    expect(policy).toMatchObject({
      relation: { schema: "public", name: "listings" },
      mode: "access exclusive",
    });
    expect(policy?.when).toEqual([
      `not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = 'public'
                   and tablename = 'listings'
                   and policyname = 'facetdb_reads')`,
    ]);
  });
});

describe("a statement the reader does not know", () => {
  it.each([
    "vacuum full facetdb.decisions",
    "cluster facetdb.decisions using decisions_by_record",
    "alter table facetdb.decisions set tablespace other",
    "truncate facetdb.jobs",
    "do $$ declare s text := 'drop table x'; begin execute s; end $$",
    "do $$ begin for r in select 1 loop alter table facetdb.jobs add column x int; end loop; end $$",
  ])("stops the list: %s", (text) => {
    expect(() => readAll([text])).toThrow(UnreadStatementError);
  });
});

describe("the list a script's locks make, on PGlite", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshPglite();
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(async () => {
    await resetPglite(db);
  });

  it("a fresh store: every table new and empty; a current one: nothing", async () => {
    const client = pgliteClient(db);
    const fresh = await scriptLocks(client, storeStepStatements(), { step: "store" });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((one) => one.rows === "empty" && one.step === "store")).toBe(true);
    expect(fresh.map((one) => one.table)).toContain("facetdb.decisions");
    await migrateStore(client);
    expect(await scriptLocks(client, storeStepStatements(), { step: "store" })).toEqual([]);
  });

  it("a store behind by migration 12: only its table, which no row of is touched", async () => {
    const client = pgliteClient(db);
    await migrateStore(client);
    await client.query(
      "alter table facetdb.question_set_versions drop column held_by, drop column probe_at",
    );
    await client.query("delete from facetdb.store_migrations where version = 12");
    expect(await scriptLocks(client, storeStepStatements(), { step: "store" })).toEqual([
      {
        step: "store",
        table: "facetdb.question_set_versions",
        mode: "no reads or writes",
        rows: "none",
      },
    ]);
  });

  it("an index to build: no writes, about as many rows as the planner counts", async () => {
    const client = pgliteClient(db);
    await migrateStore(client);
    await client.query("drop index facetdb.decisions_by_time");
    await client.query(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       select 'p:s', g::text, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now() from generate_series(1, 240) g`,
    );
    await client.query("analyze facetdb.decisions");
    expect(await scriptLocks(client, storeStepStatements(), { step: "store" })).toEqual([
      { step: "store", table: "facetdb.decisions", mode: "no writes", rows: 240 },
    ]);
  });
});
