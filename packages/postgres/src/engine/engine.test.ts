import { readFile } from "node:fs/promises";
import type { EngineDeps, EnginePlan, EngineTarget, PlanResult, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlConnect } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * The Postgres engine's install on PGlite: the plan renders today's script byte for byte (the two
 * committed fixtures), tags every statement by the table it serves, runs as printed with the worker
 * password bound at its `secret` statement and nowhere else, and stops with the script's own
 * refusal when another project claims the table between the plan and the run.
 */

const FIXTURES = {
  inline: new URL("../install/install.listings.sql", import.meta.url),
  "side-table": new URL("../scan/install.listings.side-table.sql", import.meta.url),
} as const;

/** The listings example, as install.test.ts and scan.test.ts make the fixtures from it. */
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

const ADMIN = "postgres://admin@localhost/app";
const PASSWORD = "a-long-random-password";
const FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/** The store is the source's database: today's one script. */
const shared: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
/** The store is another database: the source's part only. */
const separate: EngineDeps = { ...shared, storeShared: false };

/** Every store table that is not the source's: none may appear in a source-only plan. */
const STORE_ONLY = [
  "store_migrations",
  "install",
  "sources",
  "question_set_versions",
  "decisions",
  "records",
  "credentials",
  "api_keys",
  "usage",
  "usage_reservations",
  "usage_alerts",
  "alerts",
  "alert_history",
  "heartbeats",
  "cursors",
  "webhook_outbox",
  "reserve_usage",
  "decisions_id_seq",
  "alert_history_id_seq",
  "webhook_outbox_id_seq",
];

const mentions = (name: string) => new RegExp(`(facetdb|"facetdb")\\."?${name}(?![a-z_])`);

/** One engine for the file, emptied after every test. */
let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

const engine = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});

function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: listings,
    ...overrides,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

async function listingsTable(): Promise<void> {
  await world.client.query(
    "create table public.listings (id serial primary key, title text, description text)",
  );
}

async function present(relation: string): Promise<boolean> {
  const rows = await world.client.query("select to_regclass($1) is not null as present", [
    relation,
  ]);
  return rows[0]?.["present"] === true;
}

async function workerPassword(): Promise<string> {
  const rows = await world.client.query(
    "select rolpassword from pg_authid where rolname = 'facetdb_worker'",
  );
  return String(rows[0]?.["rolpassword"]);
}

/** What an install leaves, for a before-and-after comparison: columns, capture, rights, marks. */
async function catalog(): Promise<unknown> {
  const q = world.client.query;
  return {
    relations: await q(
      `select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'facetdb') order by 1, 2`,
    ),
    columns: await q(
      `select column_name, data_type, col_description('public.listings'::regclass, ordinal_position) as mark
         from information_schema.columns where table_schema = 'public' and table_name = 'listings' order by ordinal_position`,
    ),
    triggers: await q(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal order by 1`,
    ),
    functions: await q(
      `select proname, proowner::regrole::text as owner from pg_proc where pronamespace = to_regnamespace('facetdb') order by 1`,
    ),
    policies: await q(`select tablename, policyname, cmd from pg_policies order by 1, 2`),
    grants: await q(
      `select table_schema, table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'facetdb_worker' order by 1, 2, 3, 4`,
    ),
    tableGrants: await q(
      `select grantee, table_name, privilege_type from information_schema.table_privileges
        where grantee in ('facetdb_worker', 'facetdb_enqueue') order by 1, 2, 3`,
    ),
    owners: (await present("facetdb.table_owners"))
      ? await q(
          "select table_schema, table_name, project_id from facetdb.table_owners order by 1, 2",
        )
      : null,
    roles: await q(`select rolname from pg_roles where rolname like 'facetdb_%' order by 1`),
  };
}

describe("the engine's identity", () => {
  it("serves postgres:// and postgresql://, with the capture connector's capabilities", () => {
    expect(engine.name).toBe("postgres");
    expect(engine.schemes).toEqual(["postgres", "postgresql"]);
    expect(engine.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: true,
      transactions: true,
      sideTable: true,
      multipleWorkers: true,
    });
  });

  it("renders a plan with nothing to do as nothing", () => {
    expect(
      engine.render({ statements: [], transactional: true, removes: [], keeps: [], notes: [] }),
    ).toBe("");
  });
});

describe("planInstall", () => {
  it("renders the listings example byte for byte, inline and side-table, with the store shared", async () => {
    await listingsTable();
    for (const storage of ["inline", "side-table"] as const) {
      const plan = planOf(
        await engine.planInstall(target({ storage }), ADMIN, {
          ...shared,
          workerPassword: PASSWORD,
        }),
      );
      expect(engine.render(plan)).toBe(await readFile(FIXTURES[storage], "utf8"));
      expect(plan).toMatchObject({ transactional: true, removes: [], keeps: [], notes: [] });
      expect(plan.confirm).toBeUndefined();
    }
    // The schema named as the config names it changes nothing.
    const named = planOf(
      await engine.planInstall(target({ schema: "public" }), ADMIN, {
        ...shared,
        workerPassword: PASSWORD,
      }),
    );
    expect(engine.render(named)).toBe(await readFile(FIXTURES.inline, "utf8"));
  });

  it("tags each statement by the table it serves: the schema, the queue, the projects and the marks are the source's", async () => {
    await listingsTable();
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    const of = (database: "source" | "store") =>
      plan.statements.filter((statement) => statement.database === database).map((s) => s.text);
    const source = of("source");
    const store = of("store");
    for (const name of STORE_ONLY) {
      expect(source.filter((text) => mentions(name).test(text))).toEqual([]);
    }
    expect(source).toEqual(
      expect.arrayContaining([
        'create schema if not exists "facetdb"',
        expect.stringMatching(/^create table if not exists "facetdb"\."jobs" \(/),
        expect.stringMatching(/^create table if not exists facetdb\.projects \(/),
        expect.stringMatching(/^create table if not exists "facetdb"\."table_owners" \(/),
        'grant usage on schema "facetdb" to "facetdb_worker"',
        'grant select, insert, update, delete on "facetdb"."jobs" to "facetdb_worker"',
        'grant select, insert, update, delete on "facetdb"."projects" to "facetdb_worker"',
      ]),
    );
    expect(store).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^create table if not exists facetdb\.store_migrations \(/),
        expect.stringMatching(/^create table if not exists facetdb\.decisions \(/),
        "insert into facetdb.store_migrations (version) values (4) on conflict (version) do nothing",
        'grant select, insert on "facetdb"."decisions" to "facetdb_worker"',
        'revoke update, delete on "facetdb"."decisions" from "facetdb_worker"',
        'grant usage, select on sequence "facetdb"."decisions_id_seq" to "facetdb_worker"',
      ]),
    );
    // Every store statement names a store table and no source one.
    for (const text of store) {
      expect(STORE_ONLY.some((name) => mentions(name).test(text))).toBe(true);
    }
    expect(plan.statements.filter((statement) => statement.secret === true)).toEqual([
      {
        database: "source",
        purpose: "login",
        text: "-- the worker password: set by `facetdb migrate` for the transaction, never printed;\n-- run by hand, this script stops at the role below with a FacetDB message and changes nothing",
        secret: true,
      },
    ]);
    expect(plan.statements.slice(0, 2).map((statement) => statement.purpose)).toEqual([
      "settings",
      "settings",
    ]);
  });

  it("plans the source's part alone with a separate store, and that part installs", async () => {
    await listingsTable();
    const sharedPlan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...separate, workerPassword: PASSWORD }),
    );
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.statements).toEqual(
      sharedPlan.statements.filter((statement) => statement.database === "source"),
    );
    const script = engine.render(plan);
    for (const name of STORE_ONLY) {
      expect(script).not.toMatch(mentions(name));
    }
    expect(plan.notes).toEqual([]);

    const run = await engine.run(target(), plan, ADMIN, {
      ...separate,
      workerPassword: PASSWORD,
    });
    expect(run).toEqual({ ran: plan.statements, removed: [], notes: [] });
    for (const relation of ["facetdb.jobs", "facetdb.projects", "facetdb.table_owners"]) {
      expect(await present(relation)).toBe(true);
    }
    for (const relation of ["facetdb.decisions", "facetdb.sources", "facetdb.store_migrations"]) {
      expect(await present(relation)).toBe(false);
    }
    // The change capture works without the store: a new row is queued.
    await world.client.query("insert into public.listings (title) values ('a')");
    expect(await world.client.query("select record_key from facetdb.jobs")).toEqual([
      { record_key: "t:15:public.listings:1" },
    ]);
  });
});

describe("run", () => {
  it("installs the plan as printed, and a second plan sets no password and changes nothing", async () => {
    await listingsTable();
    const first = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    expect(
      await engine.run(target(), first, ADMIN, { ...shared, workerPassword: PASSWORD }),
    ).toEqual({ ran: first.statements, removed: [], notes: [] });
    const hash = await workerPassword();
    expect(hash.startsWith("SCRAM-SHA-256$4096:")).toBe(true);
    const before = await catalog();

    // The login exists now: it keeps its password, which other projects may share.
    const second = planOf(
      await engine.planInstall(target(), ADMIN, {
        ...shared,
        workerPassword: "another-long-random-password",
      }),
    );
    expect(second.statements).toEqual(
      first.statements.filter((statement) => statement.secret !== true),
    );
    expect(await engine.run(target(), second, ADMIN, shared)).toEqual({
      ran: second.statements,
      removed: [],
      notes: [],
    });
    expect(await catalog()).toEqual(before);
    expect(await workerPassword()).toBe(hash);
  });

  it("puts neither the password nor a verifier in a plan, its script or a run's result", async () => {
    await listingsTable();
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    const result = await engine.run(target(), plan, ADMIN, {
      ...shared,
      workerPassword: PASSWORD,
    });
    expect(result.stopped).toBeUndefined();
    for (const text of [JSON.stringify(plan), engine.render(plan), JSON.stringify(result)]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("SCRAM-SHA-256");
    }
  });

  it("keeps the password and the verifier out of a failed run's words", async () => {
    await listingsTable();
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    // A driver that echoes a failed statement's parameters, as some do in their errors.
    const echoing: SqlConnect = () => ({
      ...world.client,
      transaction: (work) =>
        world.client.transaction((query) =>
          work(async (text, params = []) => {
            if (params.length > 0) {
              throw new Error(`could not run ${text} with ${params.join(", ")} (${PASSWORD})`);
            }
            return query(text, params);
          }),
        ),
    });
    const result = await createPostgresEngine({ connect: echoing, pgHost: undefined }).run(
      target(),
      plan,
      ADMIN,
      { ...shared, workerPassword: PASSWORD },
    );
    expect(result).toMatchObject({
      ran: [],
      stopped: { at: plan.statements.findIndex((statement) => statement.secret === true) },
      removed: [],
    });
    const words = JSON.stringify(result);
    expect(words).toContain("could not run select set_config('facetdb.worker_password', $1, true)");
    expect(words).not.toContain(PASSWORD);
    expect(words).not.toContain("SCRAM-SHA-256");
    expect(await present("facetdb.jobs")).toBe(false);
  });

  it("stops at the secret statement when the run is given no password, and changes nothing", async () => {
    await listingsTable();
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    expect(await engine.run(target(), plan, ADMIN, shared)).toEqual({
      ran: [],
      stopped: {
        at: plan.statements.findIndex((statement) => statement.secret === true),
        refusal: {
          code: "worker-password",
          message: "this plan sets the worker login's password, and the run was given none",
          fix: "set the source's connection string to the worker login with its password",
        },
      },
      removed: [],
      notes: [],
    });
    expect(await present("facetdb.jobs")).toBe(false);
  });

  it("stops at the script's own owner check when another project claimed the table since the plan", async () => {
    await listingsTable();
    const plan = planOf(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    // Another project installs on the same table between this plan and its run.
    const theirs = target({ project: { id: "proj_b", name: "Bee" } });
    const other = planOf(
      await engine.planInstall(theirs, ADMIN, { ...shared, workerPassword: PASSWORD }),
    );
    expect(
      (await engine.run(theirs, other, ADMIN, { ...shared, workerPassword: PASSWORD })).stopped,
    ).toBeUndefined();
    const before = await catalog();

    const result = await engine.run(target(), plan, ADMIN, {
      ...shared,
      workerPassword: PASSWORD,
    });
    const check = plan.statements.findIndex((statement) =>
      statement.text.includes(
        "FacetDB: %s.%s already carries FacetDB columns from another project",
      ),
    );
    expect(check).toBeGreaterThan(
      plan.statements.findIndex((statement) =>
        statement.text.startsWith('insert into "facetdb"."table_owners"'),
      ),
    );
    expect(result).toEqual({
      ran: [],
      stopped: {
        at: check,
        refusal: {
          code: "another-project",
          message:
            "public.listings already carries FacetDB columns from another project (proj_b); one table belongs to one project. Uninstall there first, or point this project at another table.",
          fix: FIX,
        },
      },
      removed: [],
      notes: [],
    });
    expect(await catalog()).toEqual(before);
    expect(await world.client.query("select id from facetdb.projects order by 1")).toEqual([
      { id: "proj_b" },
    ]);
  });
});

describe("refusals", () => {
  it("refuses as migrate does, with today's code, words and fix", async () => {
    expect(
      await engine.planInstall(target(), ADMIN, { ...shared, workerPassword: PASSWORD }),
    ).toEqual({
      ok: false,
      refusal: {
        code: "migrate-refused",
        message:
          "public.listings does not exist; FacetDB adds columns to a table, it does not create one.",
        fix: FIX,
      },
    });
    await listingsTable();
    // A login to create and no password for it: the contract's own code, before anything is
    // drafted, so the CLI says how to put the password in the source's connection string.
    expect(
      await engine.planInstall({ ...target(), urlVariable: "LISTINGS_URL" }, ADMIN, shared),
    ).toEqual({
      ok: false,
      refusal: {
        code: "worker-login",
        message:
          "the worker login facetdb_worker does not exist yet, and no password was given to create it with",
        fix: "put the worker login and a long random password in LISTINGS_URL: postgres://facetdb_worker:<a long random password>@<host>/<database>; the install creates the login with that password",
      },
    });
  });

  it("refuses a plaintext worker URL without connecting (checkUrl), in words that name its variable", () => {
    const opened = () => {
      throw new Error("a connection was opened");
    };
    const never = createPostgresEngine({ connect: opened, pgHost: undefined });
    const remote = "postgres://facetdb_worker:s3cret@db.example.com/app";
    expect(never.checkUrl({ ...target(), urlVariable: "LISTINGS_URL" }, remote, shared)).toEqual({
      code: "database-url-tls",
      message:
        "LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      fix: "add ?sslmode=require to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
    });
    expect(never.checkUrl(target(), remote, shared)?.message).toContain(
      "the source's connection string reaches db.example.com",
    );
    expect(never.checkUrl(target(), `${remote}?sslmode=require`, shared)).toBeUndefined();
    expect(never.checkUrl(target(), remote, { allowInsecure: true })).toBeUndefined();
    // A URL that names no host goes where the driver goes: the engine was built with PGHOST.
    const viaPgHost = createPostgresEngine({ connect: opened, pgHost: "db.example.com" });
    expect(
      viaPgHost.checkUrl(target(), "postgres:///app?user=facetdb_worker", shared)?.message,
    ).toContain("names no host, so the driver reaches PGHOST (db.example.com) without TLS");
  });

  it("refuses a plaintext admin URL to another machine before it connects", async () => {
    const never = createPostgresEngine({
      connect: () => {
        throw new Error("a connection was opened");
      },
      pgHost: undefined,
    });
    const remote = "postgres://admin:s3cret@db.example.com/app";
    const refusal = {
      code: "admin-url-tls",
      message:
        "the admin connection string reaches db.example.com without TLS, so the admin password would travel in the clear; no connection was made",
      fix: "add ?sslmode=require to the admin connection string, or pass --allow-insecure if that network is trusted",
    };
    expect(await never.planInstall(target(), remote, shared)).toEqual({ ok: false, refusal });
    expect(
      await never.planUninstall(target(), remote, {
        ...shared,
        purge: false,
        alsoUninstalling: [],
      }),
    ).toEqual({ ok: false, refusal });
    expect(await never.planPrune(target(), remote, shared)).toEqual({ ok: false, refusal });
    const plan: EnginePlan = {
      statements: [{ database: "source", purpose: "settings", text: "select 1" }],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
    };
    expect(await never.run(target(), plan, remote, shared)).toEqual({
      ran: [],
      stopped: { at: 0, refusal },
      removed: [],
      notes: [],
    });
    // The operator's --allow-insecure lets it connect.
    await expect(
      never.planInstall(target(), remote, { ...shared, allowInsecure: true }),
    ).rejects.toThrow("a connection was opened");
  });
});
