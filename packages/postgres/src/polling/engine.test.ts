import { readFile } from "node:fs/promises";
import {
  type EngineDeps,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { pollingEngine } from "@facetdb/sql-polling";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresEngine } from "../engine/index.ts";
import type { SqlConnect } from "../sql/index.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  pollingInstallSql,
  resetPgliteWorld,
} from "../testing/index.ts";
import { postgresDialect } from "./index.ts";

/**
 * The polling engine of `@facetdb/sql-polling` over the Postgres dialect, on PGlite: the plan
 * `facetdb migrate` prints for `connector: "polling"` and what running it leaves (the columns,
 * their marks, the project's mark on facetdb_state_hash, the worker login with its rights; no
 * trigger, no jobs table), the uninstall and the prune the mark makes possible, a polling table
 * from before the mark, and `open` and doctor as the worker login. PGlite is one superuser
 * connection: the worker's calls run under `set role`.
 */

const FIXTURE = new URL("./install.listings.polling.sql", import.meta.url);

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const ADMIN = "postgres://admin@localhost/app";
const WORKER_URL = "postgres://facetdb_worker:a-long-random-password@localhost/app";
const PASSWORD = "a-long-random-password";
const clock = new FakeClock(10_000_000);
const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  warnings.splice(0);
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

const warnings: string[] = [];

/** The admin's engine: PGlite's one superuser connection. */
const admin = pollingEngine(postgresDialect, (url, options) => world.connect(url, options), {
  warn: (message) => warnings.push(message),
});

/** The worker login's connection: every statement runs as `role` on the same engine. */
function as(role: string): SqlConnect {
  return () => ({
    query: async (text, params) => {
      await world.client.query(`set role ${role}`);
      try {
        return await world.client.query(text, params);
      } finally {
        await world.client.query("reset role");
      }
    },
    transaction: (work) => world.client.transaction(work),
    pipeline: (text, paramSets) => world.client.pipeline(text, paramSets),
    close: () => Promise.resolve(),
  });
}

const worker = pollingEngine(postgresDialect, as("facetdb_worker"), {
  warn: (message) => warnings.push(message),
});

function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    urlVariable: "LISTINGS_URL",
    ...overrides,
  };
}

/** The application's table: keyed by id, with the updated_at it bumps (NOT NULL), nullable, or none. */
async function createListings(updatedAt: "not null" | "nullable" | "none" = "not null") {
  const column =
    updatedAt === "none"
      ? ""
      : `, updated_at timestamptz${updatedAt === "not null" ? " not null default now()" : ""}`;
  await world.client.query(
    `create table public.listings (id text primary key, title text, description text${column})`,
  );
}

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** `facetdb migrate`'s two calls: the plan, then its run, as the given project. */
async function migrate(overrides: Partial<EngineTarget> = {}): Promise<EnginePlan> {
  const plan = planned(
    await admin.planInstall(target(overrides), ADMIN, { ...deps, workerPassword: PASSWORD }),
  );
  const ran = await admin.run(target(overrides), plan, ADMIN, {
    ...deps,
    workerPassword: PASSWORD,
  });
  expect(ran.stopped).toBeUndefined();
  return plan;
}

async function columns(): Promise<string[]> {
  const rows = await world.client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position",
  );
  return rows.map((row) => String(row["column_name"]));
}

async function commentOf(column: string): Promise<string | null> {
  const rows = await world.client.query(
    `select col_description('public.listings'::regclass, a.attnum) as mark
       from pg_attribute a where a.attrelid = 'public.listings'::regclass and a.attname = $1`,
    [column],
  );
  const mark = rows[0]?.["mark"];
  return mark === null || mark === undefined ? null : String(mark);
}

/** The worker login's column-level rights on the table, as `privilege:column`. */
async function workerRights(): Promise<string[]> {
  const rows = await world.client.query(
    `select x.privilege_type || ':' || a.attname as right
       from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid = 'public.listings'::regclass and a.attnum > 0
        and x.grantee = (select oid from pg_roles where rolname = 'facetdb_worker')
      order by 1`,
  );
  return rows.map((row) => String(row["right"]));
}

async function policies(): Promise<string[]> {
  const rows = await world.client.query(
    "select policyname from pg_policies where tablename = 'listings' order by policyname",
  );
  return rows.map((row) => String(row["policyname"]));
}

describe("the polling engine's install on Postgres", () => {
  it("plans the trigger scripts' header and the table's lock, the pinned column statements byte for byte, then the mark, the login and its rights: no trigger, no jobs table", async () => {
    await createListings();
    const plan = planned(
      await admin.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    // install.listings.polling.sql, pinned before the move: the column statements are unchanged.
    const columnsPart = plan.statements
      .filter((statement) => statement.purpose === "columns")
      .map((statement) => statement.text);
    expect(`${columnsPart.join(";\n\n")};\n`).toBe(await readFile(FIXTURE, "utf8"));
    // The header and the lock, the columns, the mark, the login, then the worker's usage of the
    // schema, its reads, its writes, and the policies' names and block.
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "settings",
      "marker",
      ...columnsPart.map(() => "columns"),
      "marker",
      "login",
      "login",
      ...Array.from({ length: 5 }, () => "grants"),
    ]);
    expect(
      plan.statements.filter((statement) => statement.purpose === "marker").map((s) => s.text),
    ).toEqual([
      `lock table "public"."listings" in share row exclusive mode`,
      `comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings'`,
    ]);
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.transactional).toBe(true);
    const script = admin.render(plan);
    expect(
      script.startsWith(
        `begin;\n\nset local standard_conforming_strings = on;\n\nset local lock_timeout = '10s';\n\nlock table "public"."listings" in share row exclusive mode;\n\nalter table "public"."listings"\n`,
      ),
    ).toBe(true);
    expect(script).not.toMatch(/create trigger|facetdb\.jobs|create schema/);
    expect(script).not.toContain(PASSWORD);
    expect(plan.statements.filter((statement) => statement.secret === true)).toHaveLength(1);
    expect(plan.notes).toEqual([
      "FacetDB polls public.listings every 10 seconds by updated_at: the application must set updated_at on every insert and every update, or a change it makes is never noticed",
    ]);
  });

  it("runs as printed: the columns and their marks, the project's mark, the worker login with its least rights", async () => {
    await createListings();
    await migrate();
    expect(await columns()).toEqual([
      "id",
      "title",
      "description",
      "updated_at",
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
      "facetdb_state_hash",
    ]);
    expect(await commentOf("is_scam")).toBe("facetdb");
    expect(await commentOf("facetdb_state_hash")).toBe("facetdb:proj_listings");
    const owned = [
      "facetdb_reviewed",
      "facetdb_state_hash",
      "facetdb_status",
      "facetdb_updated_at",
      "is_scam",
      "is_scam_probability",
    ];
    expect(await workerRights()).toEqual(
      [
        ...["description", "id", "title", "updated_at", ...owned].map((name) => `SELECT:${name}`),
        ...owned.map((name) => `UPDATE:${name}`),
      ].sort(),
    );
    expect(await policies()).toEqual(["facetdb_reads", "facetdb_writes"]);
    const capture = await world.client.query(
      `select (select count(*) from pg_trigger where not tgisinternal)::int as triggers,
              (select count(*) from information_schema.schemata where schema_name = 'facetdb')::int as schemas`,
    );
    expect(capture[0]).toEqual({ triggers: 0, schemas: 0 });
  });

  it("is idempotent: the next migrate's plan creates no login, runs, and changes nothing", async () => {
    await createListings();
    await migrate();
    const before = { columns: await columns(), rights: await workerRights() };
    const again = await migrate();
    expect(again.statements.some((statement) => statement.purpose === "login")).toBe(false);
    expect({ columns: await columns(), rights: await workerRights() }).toEqual(before);
    expect(await commentOf("facetdb_state_hash")).toBe("facetdb:proj_listings");
  });

  it("recognises a polling table installed by an earlier version by its facetdb_state_hash, and marks it on the next migrate", async () => {
    await createListings();
    // The pre-075 install: FacetDB's marked columns, the bare mark on the state hash, no project.
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, listings)) {
      await world.client.query(statement);
    }
    expect(await commentOf("facetdb_state_hash")).toBe("facetdb");
    const plan = await migrate();
    expect(plan.notes[0]).toBe(
      "public.listings was installed in polling mode before FacetDB marked a table's project; this migrate marks it as project proj_listings's, so facetdb uninstall and migrate --prune find it",
    );
    expect(await commentOf("facetdb_state_hash")).toBe("facetdb:proj_listings");
  });

  it("says when the table has no column to poll by, and why a nullable updated_at is not one", async () => {
    await createListings("none");
    const none = planned(
      await admin.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    expect(none.notes).toEqual([
      "public.listings has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour; give public.listings an updated_at, NOT NULL, that the application sets on every insert and every update; FacetDB then polls it every 10 seconds",
    ]);
    await world.client.query("drop table public.listings");
    await createListings("nullable");
    const nullable = planned(
      await admin.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    expect(nullable.notes[0]).toContain(
      "public.listings's updated_at may be NULL, and a row whose updated_at is NULL would never be read again",
    );
  });

  it("refuses, before anything runs: a missing table, an application's column, another project's table, a trigger install, side-table mode", async () => {
    const refusal = async (overrides: Partial<EngineTarget> = {}) => {
      const result = await admin.planInstall(target(overrides), ADMIN, {
        ...deps,
        workerPassword: PASSWORD,
      });
      return result.ok ? undefined : result.refusal;
    };
    expect(await refusal()).toMatchObject({
      code: "migrate-refused",
      message:
        "public.listings does not exist; FacetDB adds columns to a table, it does not create one.",
    });
    await createListings();
    await world.client.query("alter table public.listings add column is_scam text");
    expect((await refusal())?.message).toBe(
      `public.listings already has "is_scam", which FacetDB did not create; rename the question or the column.`,
    );
    await world.client.query("alter table public.listings drop column is_scam");
    await migrate({ project: { id: "proj_other", name: "Other" } });
    expect(await refusal()).toMatchObject({
      code: "migrate-refused",
      message:
        "public.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
    });
    expect(await refusal({ storage: "side-table" })).toMatchObject({ code: "polling-side-table" });
  });

  it("refuses a table a FacetDB trigger watches: a trigger install is the trigger engine's", async () => {
    await createListings();
    await world.client.query("create schema facetdb");
    await world.client.query(
      "create function facetdb.enqueue() returns trigger language plpgsql as $$ begin return new; end $$",
    );
    await world.client.query(
      "create trigger facetdb_listings before insert on public.listings for each row execute function facetdb.enqueue()",
    );
    const result = await admin.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD });
    expect(result.ok ? undefined : result.refusal.message).toContain(
      "public.listings is watched by FacetDB's trigger (facetdb_listings)",
    );
  });

  it("refuses with the contract's worker-login code when the login is missing and no password came", async () => {
    await createListings();
    const result = await admin.planInstall(target(), ADMIN, deps);
    expect(result.ok ? undefined : result.refusal).toEqual({
      code: "worker-login",
      message:
        "the worker login facetdb_worker does not exist yet, and no password was given to create it with",
      fix: "put the worker login and a long random password in LISTINGS_URL: postgres://facetdb_worker:<a long random password>@<host>/<database>; the install creates the login with that password",
    });
  });

  it("stops the run right after its lock when another project marked the table since the plan was read, and changes nothing", async () => {
    await createListings();
    const plan = planned(
      await admin.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    await migrate({ project: { id: "proj_other", name: "Other" } });
    const before = await columns();
    const ran = await admin.run(target(), plan, ADMIN, { ...deps, workerPassword: PASSWORD });
    // The mark is read again at the lock (statement 2, after the two settings), as another run
    // left it committed; the transaction rolls back.
    expect(plan.statements[2]?.text).toBe(
      `lock table "public"."listings" in share row exclusive mode`,
    );
    expect(ran.stopped).toMatchObject({ at: 2, refusal: { code: "another-project" } });
    expect(ran.ran).toEqual([]);
    expect(await columns()).toEqual(before);
    expect(await commentOf("facetdb_state_hash")).toBe("facetdb:proj_other");
  });

  it("re-reads the table before a log-only purge lets the store's purge follow", async () => {
    await createListings();
    const options = { ...deps, purge: true, alsoUninstalling: [] };
    const plan = planned(await admin.planUninstall(target(), ADMIN, options));
    expect(plan.confirm).toEqual({ kind: "source", name: "listings" });
    await migrate();
    const ran = await admin.run(target(), plan, ADMIN, deps);
    expect(ran.stopped).toMatchObject({
      at: 0,
      refusal: {
        code: "uninstall-refused",
        message:
          'the decision log of source "listings" is live again: public.listings is now installed for its project; nothing was changed',
      },
    });
  });

  it("refuses the admin URL in the trigger engine's words: in the clear to another machine, or another database's", async () => {
    const trigger = createPostgresEngine({ connect: world.connect, pgHost: undefined });
    const remote = "postgres://admin:s3cret@db.example.com/app";
    const polled = await admin.planInstall(target(), remote, deps);
    const triggered = await trigger.planInstall(target(), remote, deps);
    expect(polled.ok ? undefined : polled.refusal).toEqual(
      triggered.ok ? undefined : triggered.refusal,
    );
    const mysql = await admin.planInstall(target(), "mysql://root@localhost/app", deps);
    expect(mysql.ok ? undefined : mysql.refusal).toMatchObject({
      code: "admin-url",
      message:
        "the admin connection string is a mysql: one, and this polling engine reads Postgres (postgres://, postgresql://); no connection was made",
    });
  });
});

describe("the polling engine's uninstall and prune on Postgres: the mark resolves the table", () => {
  it("removes every column of FacetDB's and the mark, the worker's rights and policies, and keeps the login, asking the project's name", async () => {
    await createListings();
    const before = await columns();
    await migrate();
    const plan = planned(
      await admin.planUninstall(target(), ADMIN, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    expect(plan.removes).toEqual([
      ...[
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
        "facetdb_state_hash",
      ].map((name) => ({ kind: "column", name, of: "public.listings", scope: "source" })),
      { kind: "policy", name: "facetdb_reads", of: "public.listings", scope: "source" },
      { kind: "policy", name: "facetdb_writes", of: "public.listings", scope: "source" },
      { kind: "grant", name: "facetdb_worker", of: "public.listings", scope: "source" },
    ]);
    expect(plan.keeps).toEqual([
      {
        kind: "grant",
        name: "facetdb_worker",
        of: "public",
        scope: "run",
        reason: "another FacetDB table in the schema may still need it",
      },
      {
        kind: "login",
        name: "facetdb_worker",
        scope: "run",
        reason: "uninstall never drops it: every project on the server may share it",
      },
    ]);
    expect(plan.confirm).toEqual({ kind: "project", name: "Listings" });
    const ran = await admin.run(target(), plan, ADMIN, deps);
    expect(ran.stopped).toBeUndefined();
    expect(ran.removed).toEqual(plan.removes);
    expect(await columns()).toEqual(before);
    expect(await policies()).toEqual([]);
    expect(await workerRights()).toEqual([]);
    const role = await world.client.query(
      "select 1 from pg_roles where rolname = 'facetdb_worker'",
    );
    expect(role).toHaveLength(1);
  });

  it("uninstalls a polling table from an earlier version as the config's project, and says so", async () => {
    await createListings();
    const before = await columns();
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, listings)) {
      await world.client.query(statement);
    }
    const plan = planned(
      await admin.planUninstall(target(), ADMIN, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    expect(plan.notes).toEqual([
      "public.listings carries no project mark (a polling install from before FacetDB marked one), so it is uninstalled as project proj_listings's",
    ]);
    expect((await admin.run(target(), plan, ADMIN, deps)).stopped).toBeUndefined();
    expect(await columns()).toEqual(before);
  });

  it("refuses another project's table, and a table with no polling install unless --purge asks for the log alone", async () => {
    await createListings();
    const uninstall = (purge: boolean) =>
      admin.planUninstall(target(), ADMIN, { ...deps, purge, alsoUninstalling: [] });
    const plain = await uninstall(false);
    expect(plain.ok ? undefined : plain.refusal).toMatchObject({
      code: "uninstall-refused",
      message:
        "FacetDB is not installed on public.listings in polling mode (it has no facetdb_state_hash of FacetDB's); run migrate first, or check the source's schema and table.",
    });
    expect(planned(await uninstall(true))).toEqual({
      statements: [],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
      confirm: { kind: "source", name: "listings" },
    });
    await migrate({ project: { id: "proj_other", name: "Other" } });
    const other = await uninstall(false);
    expect(other.ok ? undefined : other.refusal.code).toBe("uninstall-refused");
    expect(other.ok ? undefined : other.refusal.message).toContain("another project (proj_other)");
  });

  it("prunes a removed question's columns and the worker's read of a field no longer read; nothing on a table not installed", async () => {
    await createListings();
    expect(planned(await admin.planPrune(target(), ADMIN, deps)).statements).toEqual([]);
    const wider: QuestionSet = {
      ...listings,
      questions: [
        ...listings.questions,
        { type: "noul", name: "is_spam", instructions: "Spam?", stakes: "low" },
      ],
    };
    await migrate({ questionSet: wider });
    const later: QuestionSet = { ...listings, read: ["title"] };
    const plan = planned(await admin.planPrune(target({ questionSet: later }), ADMIN, deps));
    expect(plan.removes).toEqual([
      ...["is_spam", "is_spam_probability"].map((name) => ({
        kind: "column",
        name,
        of: "public.listings",
        scope: "source",
        reason: "no question asks it any more",
      })),
      {
        kind: "grant",
        name: "facetdb_worker",
        of: "description",
        scope: "source",
        reason: "read no longer lists it",
      },
    ]);
    expect(
      (await admin.run(target({ questionSet: later }), plan, ADMIN, deps)).stopped,
    ).toBeUndefined();
    expect(await columns()).not.toContain("is_spam");
    expect(await workerRights()).not.toContain("SELECT:description");
    expect(await workerRights()).toContain("SELECT:title");
  });
});

describe("the polling engine's open and doctor on Postgres, as the worker login", () => {
  it("@timing opens a connector that polls every 10 seconds by updated_at, keyed by the catalog's key", async () => {
    await createListings();
    await migrate();
    const connector = await worker.open(target(), WORKER_URL, deps);
    expect(connector.capabilities).toMatchObject({ multipleWorkers: false, pushWakeup: false });
    await world.client.query("insert into public.listings (id, title) values ('7', 'a bike')");
    const sleeps = clock.sleeps.length;
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["7"] });
    // Closed, the watch sleeps out its interval once more and ends instead of polling again.
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps.slice(sleeps)).toEqual([10_000]);
    expect(warnings).toEqual([]);
  });

  it("@timing opens a connector that reads the whole table hourly without a column to poll by, and warns once", async () => {
    await createListings("none");
    await migrate();
    const connector = await worker.open(target(), WORKER_URL, deps);
    await world.client.query("insert into public.listings (id, title) values ('7', 'a bike')");
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["7"] });
    await iterator.return?.();
    expect(warnings).toEqual([
      "public.listings has no last-changed column, so FacetDB reads the whole table every 60 minutes; give it an updated_at the application sets on every insert and every update (NOT NULL) to notice changes within 10 seconds",
    ]);
    await connector.close();
  });

  it("throws the contract's refusal for a table without a single-column key, and for a plaintext URL", async () => {
    await world.client.query("create table public.listings (title text, description text)");
    await expect(admin.open(target(), WORKER_URL, deps)).rejects.toBeInstanceOf(EngineRefusal);
    await expect(admin.open(target(), WORKER_URL, deps)).rejects.toMatchObject({
      refusal: {
        code: "primary-key",
        message:
          "public.listings needs a single-column primary key, and has none; FacetDB keys its answers by it",
      },
    });
    await expect(
      worker.open(target(), "postgres://facetdb_worker:pw@db.example.com/app", deps),
    ).rejects.toMatchObject({ refusal: { code: "database-url-tls" } });
  });

  it("checks the worker URL in the trigger engine's words", () => {
    const trigger = createPostgresEngine({ connect: world.connect, pgHost: undefined });
    for (const url of [
      "postgres://facetdb_worker:pw@db.example.com/app",
      "postgres://facetdb_worker:p@ss@db.example.com/app",
      "not a url",
    ]) {
      expect(worker.checkUrl(target(), url, { allowInsecure: false })).toEqual(
        trigger.checkUrl(target(), url, { allowInsecure: false }),
      );
    }
    expect(worker.checkUrl(target(), WORKER_URL, { allowInsecure: false })).toBeUndefined();
  });

  it("doctor says the source polls every 10 seconds with no trigger, and leaves the heartbeat to the store", async () => {
    await createListings();
    await migrate();
    const checks = await worker.doctor(target(), WORKER_URL, deps);
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["pooler", "ok"],
      ["install", "ok"],
      ["worker", "skip"],
    ]);
    expect(checks[0]?.detail).toBe(
      "logged in as facetdb_worker: listings on localhost/app (round trip 0 ms)",
    );
    expect(checks[2]?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place; FacetDB polls public.listings every 10 seconds by updated_at; no trigger",
    );
    expect(worker.checks.map((check) => check.name)).toEqual([
      "database",
      "pooler",
      "install",
      "worker",
    ]);
  });

  it("refuses to open, and doctor fails, an updated_at the application added after the install, until migrate grants the worker its read", async () => {
    await createListings("none");
    await migrate();
    await world.client.query(
      "alter table public.listings add column updated_at timestamptz not null default now()",
    );
    // `open` refuses before the first poll would fail on it, with the command that grants it.
    await expect(worker.open(target(), WORKER_URL, deps)).rejects.toMatchObject({
      refusal: {
        code: "polling-read",
        message:
          "the worker login may not read updated_at, the column FacetDB polls public.listings by",
        fix: "run facetdb migrate: it grants the worker its read of that column",
      },
    });
    const before = (await worker.doctor(target(), WORKER_URL, deps)).find(
      (check) => check.name === "install",
    );
    expect(before).toMatchObject({
      status: "fail",
      detail:
        "listings: the worker login may not read updated_at, the column FacetDB polls public.listings by",
    });
    await migrate();
    const after = (await worker.doctor(target(), WORKER_URL, deps)).find(
      (check) => check.name === "install",
    );
    expect(after?.status).toBe("ok");
    const connector = await worker.open(target(), WORKER_URL, deps);
    await connector.close();
  });

  it("doctor warns of the hourly scan without a column to poll by, and fails a table with no project mark yet", async () => {
    await createListings("none");
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, listings)) {
      await world.client.query(statement);
    }
    await world.client.query("create role facetdb_worker login password 'x'");
    await world.client.query("grant usage on schema public to facetdb_worker");
    const checks = await worker.doctor(target(), WORKER_URL, deps);
    const install = checks.find((check) => check.name === "install");
    expect(install).toMatchObject({
      status: "fail",
      detail:
        "listings: public.listings carries no project mark yet (a polling install from before FacetDB marked one)",
      fix: "run facetdb migrate: it prints the SQL first and installs what is missing",
    });
    expect(checks.find((check) => check.name === "polling")).toEqual({
      name: "polling",
      status: "warn",
      detail:
        "public.listings has no last-changed column (an updated_at or modified_at holding a time, NOT NULL), so FacetDB reads the whole table every hour",
      fix: "give public.listings an updated_at, NOT NULL, that the application sets on every insert and every update; FacetDB then polls it every 10 seconds",
    });
  });
});

describe("the trigger engine beside a polling install in the same database", () => {
  const trigger = () => createPostgresEngine({ connect: world.connect, pgHost: undefined });

  async function triggerRefusal(overrides: Partial<EngineTarget> = {}) {
    const result = await trigger().planInstall(target(overrides), ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    return result.ok ? undefined : result.refusal;
  }

  it("refuses another project's polling table as it refuses another project's owner row: the same code and words", async () => {
    await createListings();
    await migrate({ project: { id: "proj_other", name: "Other" } });
    const before = await columns();
    expect(await triggerRefusal()).toEqual({
      code: "migrate-refused",
      message:
        "public.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
      fix: "change the table or the config as the message says, then run the command again; nothing was changed",
    });
    expect(await columns()).toEqual(before);
  });

  it("refuses this project's polling table, and one polled by an earlier version, saying it is installed in polling mode", async () => {
    const polled = `public.listings is installed in polling mode (connector: "polling"; facetdb_state_hash carries its mark), and a trigger install beside it would adopt its columns. Keep connector: "polling" for this source, or run facetdb uninstall with connector: "polling" first, then migrate without it.`;
    await createListings();
    await migrate();
    expect(await triggerRefusal()).toMatchObject({ code: "migrate-refused", message: polled });
    await world.client.query("drop table public.listings");
    await createListings();
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, listings)) {
      await world.client.query(statement);
    }
    expect(await triggerRefusal()).toMatchObject({ code: "migrate-refused", message: polled });
  });

  it("uninstalling a trigger table keeps the worker's usage of a schema a polling table is in", async () => {
    // Its own schema: `public` grants usage to every role through PUBLIC, which would hide a revoke.
    await world.client.query("create schema shop");
    for (const name of ["listings", "orders"]) {
      await world.client.query(
        `create table shop.${name} (id text primary key, title text, description text, updated_at timestamptz not null default now())`,
      );
    }
    const polledTarget = target({ schema: "shop" });
    const triggered = target({ schema: "shop", table: "orders", source: "orders" });
    await migrate({ schema: "shop" });
    const install = trigger();
    const installed = await install.planInstall(triggered, ADMIN, deps);
    if (!installed.ok) {
      throw new Error(installed.refusal.message);
    }
    expect((await install.run(triggered, installed.plan, ADMIN, deps)).stopped).toBeUndefined();

    const uninstall = await install.planUninstall(triggered, ADMIN, {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    if (!uninstall.ok) {
      throw new Error(uninstall.refusal.message);
    }
    // The plan does not promise the revoke, and the run does not make it.
    expect(
      uninstall.plan.removes.some((object) => object.kind === "grant" && object.of === "shop"),
    ).toBe(false);
    expect((await install.run(triggered, uninstall.plan, ADMIN, deps)).stopped).toBeUndefined();
    const usage = await world.client.query(
      `select exists (select 1 from pg_catalog.pg_namespace n
                        cross join lateral pg_catalog.aclexplode(n.nspacl) a
                       where n.nspname = 'shop' and a.privilege_type = 'USAGE'
                         and a.grantee = (select oid from pg_roles where rolname = 'facetdb_worker')) as held`,
    );
    expect(usage[0]?.["held"]).toBe(true);
    // And the polling source still works as the worker: open reads the catalog, a poll reads rows.
    await world.client.query("insert into shop.listings (id, title) values ('7', 'a bike')");
    const connector = await worker.open(polledTarget, WORKER_URL, deps);
    expect(await connector.read(["7"])).toMatchObject({ missing: [] });
    await connector.close();
  });

  it("never counts a facetdb:-marked column as one of its own: uninstall leaves it in place", async () => {
    await createListings();
    const install = trigger();
    const installed = await install.planInstall(target(), ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    if (!installed.ok) {
      throw new Error(installed.refusal.message);
    }
    await install.run(target(), installed.plan, ADMIN, { ...deps, workerPassword: PASSWORD });
    await world.client.query("alter table public.listings add column facetdb_state_hash text");
    await world.client.query(
      "comment on column public.listings.facetdb_state_hash is 'facetdb:proj_other'",
    );
    const uninstall = await install.planUninstall(target(), ADMIN, {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    if (!uninstall.ok) {
      throw new Error(uninstall.refusal.message);
    }
    expect(
      uninstall.plan.removes.filter((object) => object.kind === "column").map((one) => one.name),
    ).not.toContain("facetdb_state_hash");
    expect((await install.run(target(), uninstall.plan, ADMIN, deps)).stopped).toBeUndefined();
    expect(await columns()).toEqual([
      "id",
      "title",
      "description",
      "updated_at",
      "facetdb_state_hash",
    ]);
  });
});

describe("a source that names its last-changed column on Postgres (lastChanged)", () => {
  /** The application's table with the guess's updated_at and the changed_on it really bumps. */
  async function createWithChangedOn() {
    await world.client.query(
      "create table public.listings (id text primary key, title text, description text, updated_at timestamptz not null default now(), changed_on timestamptz not null default now())",
    );
  }

  it('lastChanged: "changed_on" polls by it: the note says so, the worker reads it and not updated_at, open polls it with no warning, doctor names it', async () => {
    await createWithChangedOn();
    const plan = await migrate({ lastChanged: "changed_on" });
    expect(plan.notes).toEqual([
      "FacetDB polls public.listings every 10 seconds by changed_on, the column lastChanged names: the application must set changed_on on every insert and every update, or a change it makes is never noticed",
    ]);
    const rights = await workerRights();
    expect(rights).toContain("SELECT:changed_on");
    expect(rights).not.toContain("SELECT:updated_at");
    const connector = await worker.open(target({ lastChanged: "changed_on" }), WORKER_URL, deps);
    await world.client.query("insert into public.listings (id, title) values ('7', 'a bike')");
    const sleeps = clock.sleeps.length;
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["7"] });
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps.slice(sleeps)).toEqual([10_000]);
    expect(warnings).toEqual([]);
    const checks = await worker.doctor(target({ lastChanged: "changed_on" }), WORKER_URL, deps);
    expect(checks.find((check) => check.name === "install")?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place; FacetDB polls public.listings every 10 seconds by changed_on, the column lastChanged names; no trigger",
    );
    expect(checks.some((check) => check.name === "polling")).toBe(false);
  });

  it("lastChanged: false reads the whole table every hour beside an updated_at: the note says so, and neither the worker nor doctor warns", async () => {
    await createListings();
    const plan = await migrate({ lastChanged: false });
    expect(plan.notes).toEqual([
      "FacetDB reads public.listings whole every hour, as lastChanged: false says, so a change is noticed within the hour; name in lastChanged a column holding a time, NOT NULL, that the application sets on every insert and every update, and FacetDB polls it every 10 seconds",
    ]);
    // No column to poll by: the worker is given no read of updated_at.
    expect(await workerRights()).not.toContain("SELECT:updated_at");
    const connector = await worker.open(target({ lastChanged: false }), WORKER_URL, deps);
    await world.client.query("insert into public.listings (id, title) values ('7', 'a bike')");
    const sleeps = clock.sleeps.length;
    const iterator = connector.watch()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: ["7"] });
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps.slice(sleeps)).toEqual([3_600_000]);
    expect(warnings).toEqual([]);
    const checks = await worker.doctor(target({ lastChanged: false }), WORKER_URL, deps);
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["pooler", "ok"],
      ["install", "ok"],
      ["worker", "skip"],
    ]);
    expect(checks[2]?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place; FacetDB reads public.listings whole every hour, as lastChanged: false says; no trigger",
    );
  });

  it('lastChanged: "nope" is refused before any statement: migrate, then the worker and doctor in the same words', async () => {
    await createListings();
    const before = await columns();
    const refused = await admin.planInstall(target({ lastChanged: "nope" }), ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    const refusal = {
      code: "last-changed-column",
      message:
        "public.listings has no column nope, which lastChanged names as the column FacetDB polls by",
      fix: "name a column of public.listings that holds a time, NOT NULL, set by the application on every insert and every update, in lastChanged, or write lastChanged: false to read the whole table every hour on purpose",
    };
    expect(refused).toEqual({ ok: false, refusal });
    expect(await columns()).toEqual(before);
    // Installed with the guess, then the config names a column the table lacks.
    await migrate();
    await expect(
      worker.open(target({ lastChanged: "nope" }), WORKER_URL, deps),
    ).rejects.toMatchObject({ refusal });
    const checks = await worker.doctor(target({ lastChanged: "nope" }), WORKER_URL, deps);
    expect(checks.find((check) => check.name === "polling")).toEqual({
      name: "polling",
      status: "fail",
      detail: refusal.message,
      fix: refusal.fix,
    });
  });

  it("refuses a named column that holds no time, and one that may be NULL", async () => {
    await createListings("nullable");
    const refusal = async (lastChanged: string) => {
      const result = await admin.planInstall(target({ lastChanged }), ADMIN, {
        ...deps,
        workerPassword: PASSWORD,
      });
      return result.ok ? undefined : result.refusal;
    };
    expect(await refusal("title")).toEqual({
      code: "last-changed-column",
      message:
        "public.listings's title, which lastChanged names, holds text, not a point in time, so FacetDB cannot tell which rows changed since its last poll",
      fix: "name a column of public.listings that holds a time (a timestamp or a date), NOT NULL, set by the application on every insert and every update, in lastChanged, or write lastChanged: false to read the whole table every hour on purpose",
    });
    expect(await refusal("updated_at")).toMatchObject({
      code: "last-changed-column",
      message:
        "public.listings's updated_at, which lastChanged names, may be NULL, and a row whose updated_at is NULL would never be read again",
    });
  });
});
