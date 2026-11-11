import { readFile, writeFile } from "node:fs/promises";
import type { QuestionSet } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlClient, SqlConnect } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { type MigratePlan, type MigrateResult, migrate } from "./migrate.ts";
import { ENQUEUE_ROLE, installSql, queueKeyPrefix, renderSql, WORKER_ROLE } from "./sql.ts";

/**
 * The listings example: public.listings keyed by id, the state columns title and description, one
 * noul question is_scam. Its complete install script is the committed fixture
 * install.listings.sql; the generator must reproduce it byte for byte. The fixture is read with
 * readFile, never written by the test (`UPDATE_FIXTURES=1` rewrites it on purpose, and the diff is
 * reviewed).
 */
const FIXTURE = new URL("./install.listings.sql", import.meta.url);

const listings: QuestionSet = {
  questions: [
    {
      type: "noul",
      name: "is_scam",
      instructions: "Is this listing likely a scam?",
      stakes: "high",
    },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const project = { id: "proj_listings", name: "Listings" };

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

let world: PgliteWorld;
const worlds: PgliteWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close();
  }
});

async function listingsTable(
  options: {
    readonly table?: string;
    readonly extraColumns?: string;
    readonly compositeKey?: boolean;
  } = {},
): Promise<PgliteWorld> {
  world = await createPgliteWorld();
  worlds.push(world);
  const name = options.table ?? "listings";
  const composite = options.compositeKey === true;
  const key = composite ? "id integer, region text" : "id serial primary key";
  await world.client.query(
    `create table public."${name.replaceAll('"', '""')}" (${key}, title text, description text, secret text${options.extraColumns ?? ""}${composite ? ", primary key (id, region)" : ""})`,
  );
  return world;
}

/** Runs migrate on the world; `workerPassword: undefined` means a run without one. */
async function run(
  overrides: {
    readonly source?: MigratePlan["source"];
    readonly project?: MigratePlan["project"];
    readonly workerPassword?: string | undefined;
    readonly rotateWorkerPassword?: boolean;
  } = {},
  options: { readonly dryRun?: boolean; readonly connect?: SqlConnect } = {},
): Promise<{ readonly result: MigrateResult; readonly printed: string[] }> {
  const printed: string[] = [];
  const password =
    "workerPassword" in overrides ? overrides.workerPassword : "a-long-random-password";
  const result = await migrate({
    adminUrl: "postgres://admin@unused/listings",
    connect: options.connect ?? world.connect,
    print: (sql) => printed.push(sql),
    plan: {
      source: overrides.source ?? { table: "listings" },
      questionSet: listings,
      project: overrides.project ?? project,
      ...(password === undefined ? {} : { workerPassword: password }),
      ...(overrides.rotateWorkerPassword === undefined
        ? {}
        : { rotateWorkerPassword: overrides.rotateWorkerPassword }),
    },
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { result, printed };
}

/** The catalog as a later install must leave it: columns, triggers, functions, policies, grants. */
async function catalog(): Promise<unknown> {
  const q = world.client.query;
  return {
    columns: await q(
      `select column_name, data_type, is_nullable, column_default, col_description('public.listings'::regclass, ordinal_position) as mark
         from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position`,
    ),
    triggers: await q(
      `select tgname, tgenabled, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'public.listings'::regclass and not tgisinternal order by tgname`,
    ),
    functions: await q(
      `select proname, prosecdef, proconfig, proowner::regrole::text as owner from pg_proc where pronamespace = 'facetdb'::regnamespace order by proname`,
    ),
    policies: await q(
      `select policyname, cmd, roles::text from pg_policies where tablename = 'listings' order by policyname`,
    ),
    grants: await q(
      `select table_schema, table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'facetdb_worker' order by table_schema, table_name, column_name, privilege_type`,
    ),
    tableGrants: await q(
      `select grantee, table_schema, table_name, privilege_type from information_schema.table_privileges
        where grantee in ('facetdb_worker', 'facetdb_enqueue') and table_schema = 'facetdb' order by grantee, table_name, privilege_type`,
    ),
    owners: await q(
      `select table_schema, table_name, project_id from facetdb.table_owners order by 1, 2`,
    ),
    roles: await q(
      `select rolname, rolcanlogin, rolsuper from pg_roles where rolname like 'facetdb_%' order by rolname`,
    ),
  };
}

async function jobs(): Promise<string[]> {
  const rows = await world.client.query(`select record_key from facetdb.jobs order by record_key`);
  return rows.map((row) => String(row["record_key"]));
}

async function status(id: number): Promise<string> {
  const rows = await world.client.query(
    `select facetdb_status from public.listings where id = $1`,
    [id],
  );
  return String(rows[0]?.["facetdb_status"]);
}

async function workerPasswordHash(): Promise<string> {
  const rows = await world.client.query(`select rolpassword from pg_authid where rolname = $1`, [
    WORKER_ROLE,
  ]);
  return String(rows[0]?.["rolpassword"]);
}

describe("installSql", () => {
  it("reproduces the listings example byte for byte", async () => {
    const sql = renderSql(
      installSql({ table: "listings", key: "id" }, listings, project, {
        workerPassword: "a-long-random-password",
      }),
    );
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("interpolates no value and quotes every identifier", () => {
    const statements = installSql({ table: "listings", key: "id" }, listings, project, {
      workerPassword: "hunter2-hunter2",
    });
    const texts = statements.map((s) => s.text).join("\n");
    expect(texts).not.toContain("hunter2");
    expect(texts).not.toContain(project.id);
    expect(texts).toContain("security definer set search_path = ''");
    expect(texts).toContain('"public"."listings"');
    for (const name of ["is_scam", "is_scam_probability", "facetdb_status", "title"]) {
      expect(texts).toContain(`"${name}"`);
    }
    const rendered = renderSql(statements);
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain("'proj_listings'");
  });

  it("adds the columns of every question type with their types", () => {
    const texts = installSql({ table: "listings", key: "id" }, everyType, project)
      .map((s) => s.text)
      .join("\n");
    expect(texts).toContain('"is_scam" boolean');
    expect(texts).toContain('"is_scam_probability" real');
    expect(texts).toContain('"category" text');
    expect(texts).toContain('"category_confidence" real');
    expect(texts).toContain('"category_probabilities" jsonb');
    expect(texts).toContain('"quality" text');
    expect(texts).toContain('"quality_confidence" real');
    expect(texts).toContain('"quality_expected" real');
    expect(texts).not.toContain('"quality_probabilities"');
  });

  it("puts a name that needs quoting only where it is quoted or bound", () => {
    const statements = installSql(
      { table: 'odd"na$$me', schema: "My Schema", key: "Id" },
      listings,
      project,
    );
    const texts = statements.map((s) => s.text).join("\n");
    expect(texts).toContain('"My Schema"."odd""na$$me"');
    expect(texts).toContain("'Id', 't:20:My Schema.odd\"na$$me:'");
    const inBlocks = statements.filter((s) => s.text.startsWith("do $$")).map((s) => s.text);
    for (const block of inBlocks) {
      expect(block).not.toContain("odd");
      expect(block).not.toContain("My Schema");
    }
  });

  it("gives no table a queue prefix that another table's keys start with", () => {
    const plain = queueKeyPrefix({ table: "a" });
    const colon = queueKeyPrefix({ table: "a:b" });
    expect(plain).toBe("t:8:public.a:");
    expect(colon.startsWith(plain)).toBe(false);
    expect(`${colon}1`.startsWith(plain)).toBe(false);
    expect(queueKeyPrefix({ table: "a", schema: "s" })).not.toBe(plain);
  });
});

describe("migrate on PGlite", () => {
  it("prints before it runs and a dry run touches nothing", async () => {
    await listingsTable();
    const { result, printed } = await run({}, { dryRun: true });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("create trigger");
    expect(printed[0]).not.toContain("a-long-random-password");
    const columns = await world.client.query(
      `select column_name from information_schema.columns where table_name = 'listings' and column_name = 'facetdb_status'`,
    );
    expect(columns).toHaveLength(0);
  });

  it("installs, and a second run changes nothing", async () => {
    await listingsTable();
    const first = await run();
    expect(first.result).toMatchObject({
      ok: true,
      key: "id",
      applied: true,
      changed: true,
      workerPasswordApplied: true,
    });
    const before = await catalog();
    const hash = await workerPasswordHash();
    const second = await run({ workerPassword: undefined });
    expect(second.result).toMatchObject({
      ok: true,
      applied: true,
      changed: false,
      workerPasswordApplied: false,
    });
    expect(await catalog()).toEqual(before);
    expect(await workerPasswordHash()).toBe(hash);
  });

  it("owns the trigger functions by a no-login role that can only insert into the queue", async () => {
    await listingsTable();
    await run();
    const functions = await world.client.query(
      `select proname, proowner::regrole::text as owner from pg_proc where pronamespace = 'facetdb'::regnamespace order by proname`,
    );
    expect(functions).toEqual([
      { proname: "enqueue", owner: ENQUEUE_ROLE },
      { proname: "enqueue_keep", owner: ENQUEUE_ROLE },
    ]);
    const role = await world.client.query(
      `select rolcanlogin, rolsuper from pg_roles where rolname = $1`,
      [ENQUEUE_ROLE],
    );
    expect(role).toEqual([{ rolcanlogin: false, rolsuper: false }]);
    const grants = await world.client.query(
      `select table_schema, table_name, privilege_type from information_schema.table_privileges where grantee = $1 order by 1, 2, 3`,
      [ENQUEUE_ROLE],
    );
    expect(grants).toEqual([
      { table_schema: "facetdb", table_name: "jobs", privilege_type: "INSERT" },
    ]);
  });

  it("fires on insert and on a state column, never on FacetDB's own columns", async () => {
    await listingsTable();
    await run();
    await world.client.query(`insert into public.listings (title, description) values ('a', 'b')`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
    expect(await status(1)).toBe("pending");
    await world.client.query(`delete from facetdb.jobs`);
    await world.client.query(
      `update public.listings set facetdb_status = 'done', is_scam = false, is_scam_probability = 0.1 where id = 1`,
    );
    expect(await jobs()).toEqual([]);
    expect(await status(1)).toBe("done");
    await world.client.query(`update public.listings set secret = 'x' where id = 1`);
    expect(await jobs()).toEqual([]);
    await world.client.query(`update public.listings set title = 'changed' where id = 1`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
    expect(await status(1)).toBe("pending");
    await world.client.query(`update public.listings set description = 'again' where id = 1`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
  });

  it("onChange keep enqueues the change and leaves the status", async () => {
    await listingsTable();
    await run({ source: { table: "listings", onChange: "keep" } });
    await world.client.query(`insert into public.listings (title, description) values ('a', 'b')`);
    await world.client.query(`delete from facetdb.jobs`);
    await world.client.query(`update public.listings set facetdb_status = 'done' where id = 1`);
    await world.client.query(`update public.listings set title = 'changed' where id = 1`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
    expect(await status(1)).toBe("done");
  });

  it("installs on a table whose name holds quotes and dollar signs", async () => {
    await listingsTable({ table: 'price$$"list' });
    const { result } = await run({ source: { table: 'price$$"list' } });
    expect(result).toMatchObject({ ok: true, applied: true });
    await world.client.query(
      `insert into public."price$$""list" (title, description) values ('a', 'b')`,
    );
    expect(await jobs()).toEqual(['t:19:public.price$$"list:1']);
    const policies = await world.client.query(
      `select policyname from pg_policies where tablename = $1 order by 1`,
      ['price$$"list'],
    );
    expect(policies.map((p) => p["policyname"])).toEqual(["facetdb_reads", "facetdb_writes"]);
  });

  it("a password given later resets the worker's password", async () => {
    await listingsTable();
    await run();
    const hash = await workerPasswordHash();
    const again = await run({ workerPassword: "another-long-random-password" });
    expect(again.result).toMatchObject({ ok: true, workerPasswordApplied: true });
    expect(await workerPasswordHash()).not.toBe(hash);
  });

  it("refuses a column of the application's that a question would take", async () => {
    await listingsTable({ extraColumns: ", is_scam text" });
    const { result, printed } = await run();
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("is_scam");
    }
    expect(printed).toEqual([]);
  });

  it("refuses a composite primary key and a missing table", async () => {
    await listingsTable({ compositeKey: true });
    const composite = await run();
    expect(composite.result).toMatchObject({ ok: false });
    if (!composite.result.ok) {
      expect(composite.result.reason).toContain("composite");
    }
    const missing = await run({ source: { table: "nothing_here" } });
    expect(missing.result).toMatchObject({ ok: false });
  });

  it("refuses a table another project installed on", async () => {
    await listingsTable();
    await run();
    const other = await run({ project: { id: "proj_other", name: "Other" } });
    expect(other.result).toMatchObject({ ok: false });
    if (!other.result.ok) {
      expect(other.result.reason).toContain("proj_listings");
    }
    const same = await run({ workerPassword: undefined });
    expect(same.result).toMatchObject({ ok: true });
  });

  it("refuses a first install without a worker password, and a superuser worker role", async () => {
    await listingsTable();
    const { result } = await run({ workerPassword: undefined });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("password");
    }
    await world.client.query(`create role facetdb_worker superuser login`);
    const superuser = await run();
    expect(superuser.result).toMatchObject({ ok: false });
    if (!superuser.result.ok) {
      expect(superuser.result.reason).toContain("superuser");
    }
  });

  it("closes the admin connection on success, refusal and failure", async () => {
    await listingsTable();
    const closes: string[] = [];
    const wrap = (label: string, fail: boolean): SqlConnect => {
      return () => {
        const inner: SqlClient = world.client;
        return {
          query: inner.query,
          transaction: fail
            ? () => Promise.reject(new Error("the server went away"))
            : (work) => inner.transaction(work),
          close: async () => {
            closes.push(label);
          },
        };
      };
    };
    await expect(run({}, { connect: wrap("failure", true) })).rejects.toThrow("went away");
    const refused = await run(
      { source: { table: "nothing_here" } },
      { connect: wrap("refusal", false) },
    );
    expect(refused.result.ok).toBe(false);
    const ok = await run({}, { connect: wrap("success", false) });
    expect(ok.result.ok).toBe(true);
    expect(closes).toEqual(["failure", "refusal", "success"]);
  });

  it("needs no superuser: a createrole admin that owns the table installs, twice, and rotates", async () => {
    await listingsTable();
    await world.client.query(`create role app_admin createrole login`);
    await world.client.query(`grant create on database postgres to app_admin`);
    await world.client.query(`alter table public.listings owner to app_admin`);
    await world.client.query(`grant all on schema public to app_admin`);
    await world.client.query(`set role app_admin`);
    try {
      expect((await run()).result).toMatchObject({ ok: true, applied: true });
      expect((await run({ workerPassword: undefined })).result).toMatchObject({ ok: true });
      expect(
        (await run({ workerPassword: "a-rotated-long-random-password" })).result,
      ).toMatchObject({ ok: true, workerPasswordApplied: true });
    } finally {
      await world.client.query(`reset role`);
    }
    const owners = await world.client.query(
      `select proowner::regrole::text as owner from pg_proc where pronamespace = 'facetdb'::regnamespace`,
    );
    expect(owners).toEqual([{ owner: ENQUEUE_ROLE }, { owner: ENQUEUE_ROLE }]);
    const create = await world.client.query(
      `select has_schema_privilege($1, 'facetdb', 'CREATE') as can_create`,
      [ENQUEUE_ROLE],
    );
    expect(create).toEqual([{ can_create: false }]);
    await world.client.query(`insert into public.listings (title, description) values ('a', 'b')`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
  });

  it("refuses a password that would lock another project out, unless rotated on purpose", async () => {
    await listingsTable();
    await world.client.query(
      `create table public.other (id serial primary key, title text, description text)`,
    );
    await run();
    const hash = await workerPasswordHash();
    const second = await run({
      source: { table: "other" },
      project: { id: "proj_other", name: "Other" },
      workerPassword: "a-different-long-random-password",
    });
    expect(second.result).toMatchObject({ ok: false });
    if (!second.result.ok) {
      expect(second.result.reason).toContain("proj_listings");
    }
    expect(await workerPasswordHash()).toBe(hash);
    const reused = await run({
      source: { table: "other" },
      project: { id: "proj_other", name: "Other" },
      workerPassword: undefined,
    });
    expect(reused.result).toMatchObject({ ok: true, workerPasswordApplied: false });
    const rotated = await run({
      source: { table: "other" },
      project: { id: "proj_other", name: "Other" },
      workerPassword: "a-different-long-random-password",
      rotateWorkerPassword: true,
    });
    expect(rotated.result).toMatchObject({ ok: true, workerPasswordApplied: true });
    expect(await workerPasswordHash()).not.toBe(hash);
  });

  it("refuses an enqueue role FacetDB did not create", async () => {
    await listingsTable();
    await world.client.query(`create role facetdb_enqueue login`);
    const { result } = await run();
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain(ENQUEUE_ROLE);
    }
  });

  it("stores a SCRAM verifier, never the password, and prints one transaction", async () => {
    await listingsTable();
    const { result, printed } = await run();
    expect(result).toMatchObject({ ok: true });
    expect(await workerPasswordHash()).toMatch(/^SCRAM-SHA-256\$4096:/);
    const texts = result.ok ? result.statements.map((s) => String(s.params[0] ?? "")) : [];
    expect(texts.join("\n")).not.toContain("a-long-random-password");
    expect(printed[0]?.startsWith("begin;\n")).toBe(true);
    expect(printed[0]?.endsWith("commit;\n")).toBe(true);
    expect(printed[0]).toContain("set local lock_timeout = '10s'");
  });

  it("prints no password statement, and run by hand the script stops at the role and changes nothing", async () => {
    await listingsTable();
    const { printed } = await run({}, { dryRun: true });
    const script = printed[0] ?? "";
    expect(script).not.toContain("set_config('facetdb.worker_password'");
    expect(script).not.toContain("<the worker password");
    // The whole printed script, as psql -f would run it, on a fresh cluster.
    await expect(world.db.exec(script)).rejects.toThrow(
      /worker login facetdb_worker does not exist/,
    );
    // PGlite is one session: the failed script leaves its transaction open and aborted, as psql would.
    await world.db.exec("rollback");
    const columns = await world.client.query(
      `select column_name from information_schema.columns where table_name = 'listings' and column_name = 'facetdb_status'`,
    );
    expect(columns).toHaveLength(0);
    expect(
      await world.client.query(`select 1 from pg_roles where rolname = 'facetdb_worker'`),
    ).toEqual([]);
  });

  it("queues keys under a length-prefixed table name", async () => {
    await listingsTable();
    await run();
    await world.client.query(`insert into public.listings (title, description) values ('a', 'b')`);
    expect(await jobs()).toEqual(["t:15:public.listings:1"]);
  });

  it("refuses a marked column whose question changed type", async () => {
    await listingsTable();
    await run();
    const changed: QuestionSet = {
      ...listings,
      questions: [
        {
          type: "choice",
          name: "is_scam",
          instructions: "Which?",
          options: [
            { name: "yes", description: "y" },
            { name: "no", description: "n" },
          ],
          stakes: "low",
          storeProbabilities: false,
        },
      ],
    };
    const result = await migrate({
      adminUrl: "postgres://admin@unused/listings",
      connect: world.connect,
      print: () => undefined,
      plan: { source: { table: "listings" }, questionSet: changed, project },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("is_scam is boolean");
    }
  });

  it("refuses a generated primary key, a FacetDB role with memberships, and a name holding the body tag", async () => {
    world = await createPgliteWorld();
    worlds.push(world);
    await world.client.query(
      `create table public.listings (n integer, id integer generated always as (n * 2) stored primary key, title text, description text)`,
    );
    const generated = await run();
    expect(generated.result).toMatchObject({ ok: false });
    if (!generated.result.ok) {
      expect(generated.result.reason).toContain("generated");
    }

    await listingsTable();
    await world.client.query(`create role facetdb_worker login`);
    await world.client.query(`grant pg_read_all_data to facetdb_worker`);
    const member = await run();
    expect(member.result).toMatchObject({ ok: false });
    if (!member.result.ok) {
      expect(member.result.reason).toContain("pg_read_all_data");
    }

    await listingsTable({ table: "odd$fdb$name" });
    const tagged = await run({ source: { table: "odd$fdb$name" } });
    expect(tagged.result).toMatchObject({ ok: false });
    if (!tagged.result.ok) {
      expect(tagged.result.reason).toContain("$fdb$");
    }
  });

  it("refuses a state field that is one of FacetDB's own columns", async () => {
    await listingsTable();
    for (const read of [
      ["title", "is_scam"],
      ["title", "facetdb_status"],
    ]) {
      const printed: string[] = [];
      const result = await migrate({
        adminUrl: "postgres://admin@unused/listings",
        connect: world.connect,
        print: (sql) => printed.push(sql),
        plan: {
          source: { table: "listings" },
          questionSet: { ...listings, read },
          project,
          workerPassword: "a-long-random-password",
        },
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.reason).toContain(read[1]);
      }
      expect(printed).toEqual([]);
    }
  });
});
