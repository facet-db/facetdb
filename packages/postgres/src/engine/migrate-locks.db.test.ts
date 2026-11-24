import type { Clock, EnginePlan, EngineTarget, PlanLock, QuestionSet } from "@facetdb/core";
import { afterAll, describe, expect, it } from "vitest";
import { PASSWORD_STATEMENT, scramVerifier } from "../install/index.ts";
import { connectPostgres, type SqlClient, type SqlQuery, scriptLocks } from "../sql/index.ts";
import { planStoreStep } from "../store/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { createPostgresEngine } from "./index.ts";

/**
 * The lock list `facetdb migrate` prints, against what a real Postgres holds. Each step is planned
 * as migrate plans it, before anything runs (the install's plan before the store's step, as migrate
 * shows them), then run as migrate runs it, in one transaction; before the commit, `pg_locks` names
 * every table and view the step holds. The list names exactly those it holds in a mode that keeps
 * the application from writing (share and above), with that mode in words, and a table new to the
 * step as `empty`: nothing the run does not take, and nothing left out. The rows a step goes
 * through follow the rows inserted, by the planner's estimate.
 */

const SCAM = {
  type: "noul",
  name: "is_scam",
  instructions: "Is this listing a scam?",
  stakes: "high",
} as const;
const VEHICLE = {
  type: "noul",
  name: "is_vehicle",
  instructions: "Is this listing a vehicle?",
  stakes: "low",
} as const;

const BOTH: QuestionSet = {
  questions: [SCAM, VEHICLE],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};
const SCAM_ONLY: QuestionSet = { ...BOTH, questions: [SCAM] };

const PASSWORD = "a-long-random-password-for-migrate-locks";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const scratches: ScratchDatabase[] = [];
const clients: SqlClient[] = [];

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const made of scratches.splice(0)) {
    await made.drop();
  }
});

function target(
  questionSet: QuestionSet,
  storage: EngineTarget["storage"] = "inline",
): EngineTarget {
  return {
    project: { id: "proj_locks", name: "Locks" },
    source: "listings",
    table: "listings",
    storage,
    onChange: "reset",
    questionSet,
  };
}

/** A scratch database with `public.listings` holding `rows` rows, analysed; its engine and a connection. */
async function world(rows: number) {
  const scratch = await createScratchDatabase();
  scratches.push(scratch);
  const client = connectPostgres(scratch.url, { max: 1 });
  clients.push(client);
  await client.query(
    "create table public.listings (id integer primary key, title text not null, description text)",
  );
  await client.query(
    `insert into public.listings (id, title) select g, 'listing ' || g from generate_series(1, ${rows}) g`,
  );
  await client.query("analyze public.listings");
  const engine = createPostgresEngine({
    connect: connectPostgres,
    pgHost: undefined,
    roleSuffix: scratch.roleSuffix,
  });
  const deps = (storeShared: boolean) => ({ clock: realClock, allowInsecure: false, storeShared });
  return {
    scratch,
    client,
    async install(
      questionSet: QuestionSet,
      storeShared: boolean,
      storage?: EngineTarget["storage"],
    ) {
      const login = await client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [
        scratch.workerRole,
      ]);
      const planned = await engine.planInstall(target(questionSet, storage), scratch.url, {
        ...deps(storeShared),
        ...(login.length === 0 ? { workerPassword: PASSWORD } : {}),
      });
      if (!planned.ok) {
        throw new Error(planned.refusal.message);
      }
      return planned.plan;
    },
    async prune(questionSet: QuestionSet) {
      const planned = await engine.planPrune(target(questionSet), scratch.url, deps(false));
      if (!planned.ok) {
        throw new Error(planned.refusal.message);
      }
      return planned.plan;
    },
    /** The store's step as migrate shows it: its statements and its list; none when it is current. */
    async storeStep(): Promise<{ statements: readonly string[]; locks: readonly PlanLock[] }> {
      const step = await planStoreStep(client.query);
      if (step.kind !== "behind") {
        return { statements: [], locks: [] };
      }
      return {
        statements: step.statements,
        locks: await scriptLocks(client, step.statements, { step: "store" }),
      };
    },
  };
}

/** The relations outside the system schemas, by oid, as they stand before a step. */
const RELATIONS = `select c.oid::text as oid, n.nspname as schema, c.relname as name, c.relkind::text as kind
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'`;

/** The relation locks this connection holds now. */
const HELD = `select l.relation::text as oid, l.mode from pg_catalog.pg_locks l
 where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted`;

/** Postgres's names for the modes that keep the application from writing, in the list's words. */
const HOLDS_OFF: Readonly<Record<string, PlanLock["mode"]>> = {
  ShareLock: "no writes",
  ShareRowExclusiveLock: "no writes",
  ExclusiveLock: "no writes",
  AccessExclusiveLock: "no reads or writes",
};

/** What a list and `pg_locks` are compared on: each table, its mode in words, and whether it is new. */
type Seen = Readonly<
  Record<string, { readonly mode: PlanLock["mode"]; readonly created: boolean }>
>;

/** A plan's lock list; a plan whose list could not be made fails the test with why. */
function planned(plan: EnginePlan): readonly PlanLock[] {
  const { locks } = plan;
  if (locks === undefined || "unlisted" in locks) {
    throw new Error(`the plan lists no locks: ${locks === undefined ? "none" : locks.unlisted}`);
  }
  return locks.listed;
}

function listed(locks: readonly PlanLock[]): Seen {
  return Object.fromEntries(
    locks.map((lock) => [lock.table, { mode: lock.mode, created: lock.rows === "empty" }]),
  );
}

type Relation = { readonly schema: string; readonly name: string; readonly kind: string };

async function relations(query: SqlQuery): Promise<Map<string, Relation>> {
  return new Map(
    (await query(RELATIONS)).map((row) => [
      String(row["oid"]),
      { schema: String(row["schema"]), name: String(row["name"]), kind: String(row["kind"]) },
    ]),
  );
}

/**
 * Runs `statements` in one transaction (a `secret` one as the engine's run binds it) and returns
 * what the transaction holds just before its commit: every table and view held in a mode that keeps
 * the application from writing, with the strongest such mode, and whether it is new to the step.
 */
async function held(
  client: SqlClient,
  statements: readonly (string | EnginePlan["statements"][number])[],
): Promise<Seen> {
  const before = await relations(client.query);
  const names = new Set([...before.values()].map((one) => `${one.schema}.${one.name}`));
  return client.transaction(async (query) => {
    for (const statement of statements) {
      if (typeof statement === "string") {
        await query(statement);
      } else if (statement.secret === true) {
        await query(PASSWORD_STATEMENT, [scramVerifier(PASSWORD)]);
      } else {
        await query(statement.text);
      }
    }
    const now = await relations(query);
    const seen: Record<string, { mode: PlanLock["mode"]; created: boolean }> = {};
    for (const row of await query(HELD)) {
      const oid = String(row["oid"]);
      const relation = before.get(oid) ?? now.get(oid);
      const mode = HOLDS_OFF[String(row["mode"])];
      // Tables and views only: an index goes with its table, a sequence with its column.
      if (
        relation === undefined ||
        mode === undefined ||
        !["r", "p", "v", "m"].includes(relation.kind)
      ) {
        continue;
      }
      const table = `${relation.schema}.${relation.name}`;
      const strongest = seen[table]?.mode === "no reads or writes" ? "no reads or writes" : mode;
      seen[table] = { mode: strongest, created: !names.has(table) };
    }
    return seen;
  });
}

describe("the lock list migrate prints, against pg_locks on a real Postgres", () => {
  it("a first install, the store on the source's own database: the store's step makes its tables, the install locks the customer's table", async () => {
    const at = await world(300);
    const install = await at.install(BOTH, true);
    const store = await at.storeStep();
    expect(store.locks.length).toBeGreaterThan(0);
    expect(store.locks.every((lock) => lock.step === "store" && lock.rows === "empty")).toBe(true);
    expect(listed(store.locks)).toEqual(await held(at.client, store.statements));
    expect(planned(install)).toEqual([
      { step: "install", table: "public.listings", mode: "no reads or writes", rows: "none" },
      { step: "install", table: "facetdb.table_owners", mode: "no reads or writes", rows: "empty" },
      { step: "install", table: "facetdb.projects", mode: "no writes", rows: "none" },
    ]);
    expect(listed(planned(install))).toEqual(await held(at.client, install.statements));
  });

  it("a current install: the store takes no lock, and the install locks only the customer's table", async () => {
    const at = await world(10);
    const first = await at.install(BOTH, true);
    await held(at.client, (await at.storeStep()).statements);
    await held(at.client, first.statements);
    const store = await at.storeStep();
    expect(store.locks).toEqual([]);
    const again = await at.install(BOTH, true);
    expect(planned(again)).toEqual([
      { step: "install", table: "public.listings", mode: "no reads or writes", rows: "none" },
    ]);
    expect(listed(planned(again))).toEqual(await held(at.client, again.statements));
  });

  it("an upgrade from store version 11: migration 12's two columns lock the versions' table, touching no row", async () => {
    const at = await world(10);
    const first = await at.install(BOTH, true);
    await held(at.client, (await at.storeStep()).statements);
    await held(at.client, first.statements);
    // The store as version 11 left it: no hold columns, no row for 12.
    await at.client.query(
      "alter table facetdb.question_set_versions drop column held_by, drop column probe_at",
    );
    await at.client.query("delete from facetdb.store_migrations where version = 12");
    const install = await at.install(BOTH, true);
    const store = await at.storeStep();
    expect(store.locks).toEqual([
      {
        step: "store",
        table: "facetdb.question_set_versions",
        mode: "no reads or writes",
        rows: "none",
      },
    ]);
    expect(listed(store.locks)).toEqual(await held(at.client, store.statements));
    expect(planned(install)).toEqual([
      { step: "install", table: "public.listings", mode: "no reads or writes", rows: "none" },
    ]);
    expect(listed(planned(install))).toEqual(await held(at.client, install.statements));
  });

  it("a first install with the store elsewhere: the queue, the projects and the marks are new in the source's database", async () => {
    const at = await world(10);
    const install = await at.install(BOTH, false);
    expect(planned(install)).toEqual([
      { step: "install", table: "public.listings", mode: "no reads or writes", rows: "none" },
      { step: "install", table: "facetdb.projects", mode: "no reads or writes", rows: "empty" },
      { step: "install", table: "facetdb.jobs", mode: "no reads or writes", rows: "empty" },
      { step: "install", table: "facetdb.table_owners", mode: "no reads or writes", rows: "empty" },
    ]);
    expect(listed(planned(install))).toEqual(await held(at.client, install.statements));
  });

  it("a prune: dropping a removed question's columns locks the customer's table, touching no row; nothing to prune locks nothing", async () => {
    const at = await world(10);
    const before = await at.prune(BOTH);
    expect(planned(before)).toEqual([]);
    const first = await at.install(BOTH, false);
    await held(at.client, first.statements);
    const prune = await at.prune(SCAM_ONLY);
    expect(planned(prune)).toEqual([
      { step: "prune", table: "public.listings", mode: "no reads or writes", rows: "none" },
    ]);
    expect(listed(planned(prune))).toEqual(await held(at.client, prune.statements));
    expect(await at.prune(SCAM_ONLY)).toMatchObject({ statements: [], locks: { listed: [] } });
  });

  it("side-table mode: the side table and the view beside the table, first and again", async () => {
    const at = await world(10);
    const first = await at.install(BOTH, false, "side-table");
    expect(listed(planned(first))).toEqual(await held(at.client, first.statements));
    expect(planned(first)).toContainEqual({
      step: "install",
      table: "facetdb.listings_answers",
      mode: "no reads or writes",
      rows: "empty",
    });
    const again = await at.install(BOTH, false, "side-table");
    expect(planned(again)).toEqual([
      { step: "install", table: "public.listings", mode: "no reads or writes", rows: "none" },
      {
        step: "install",
        table: "facetdb.listings_answers",
        mode: "no reads or writes",
        rows: "none",
      },
      {
        step: "install",
        table: "public.listings_with_answers",
        mode: "no reads or writes",
        rows: "none",
      },
    ]);
    expect(listed(planned(again))).toEqual(await held(at.client, again.statements));
  });

  it("the rows a step goes through follow the rows inserted: an index built on the decision log", async () => {
    const at = await world(10);
    const first = await at.install(BOTH, true);
    await held(at.client, (await at.storeStep()).statements);
    await held(at.client, first.statements);
    // The store as it stood before migration 6 built `decisions_by_time`.
    await at.client.query("drop index facetdb.decisions_by_time");
    await at.client.query("delete from facetdb.store_migrations where version = 6");
    const log = async (rows: number) => {
      await at.client.query(
        `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
         select 'proj_locks:listings', g::text, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now()
           from generate_series(1, ${rows}) g`,
      );
      await at.client.query("analyze facetdb.decisions");
    };
    await log(1200);
    expect((await at.storeStep()).locks).toEqual([
      { step: "store", table: "facetdb.decisions", mode: "no writes", rows: 1200 },
    ]);
    await log(3800);
    const store = await at.storeStep();
    expect(store.locks).toEqual([
      { step: "store", table: "facetdb.decisions", mode: "no writes", rows: 5000 },
    ]);
    expect(listed(store.locks)).toEqual(await held(at.client, store.statements));
  });

  it("plans promptly while another session holds the customer's table in access exclusive mode: the list never queues behind it", async () => {
    const at = await world(10);
    // Another session's transaction holds the table, as a migrate in another terminal or an
    // application's `lock table` would, and stays open until the test lets it go.
    const holder = connectPostgres(at.scratch.url, { max: 1 });
    clients.push(holder);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holderDone = holder.transaction(async (query) => {
      await query("lock table public.listings in access exclusive mode");
      locked();
      await gate;
    });
    await holding;
    /** The plan, or `waited` when it has not come back within 5 seconds. */
    const within = (plan: Promise<EnginePlan>) =>
      Promise.race([
        plan,
        new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 5000)),
      ]);
    try {
      // A first install: nothing of FacetDB's on the table yet.
      const fresh = await within(at.install(BOTH, false));
      expect(fresh).not.toBe("waited");
      expect(fresh).toMatchObject({ locks: { listed: expect.any(Array) } });
    } finally {
      release();
      await holderDone;
    }
    // Installed, so the list's conditions read the table's trigger and policies, then held again.
    await held(at.client, (await at.install(BOTH, false)).statements);
    let releaseAgain: () => void = () => undefined;
    const gateAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    let lockedAgain: () => void = () => undefined;
    const holdingAgain = new Promise<void>((resolve) => {
      lockedAgain = resolve;
    });
    const holderAgain = holder.transaction(async (query) => {
      await query("lock table public.listings in access exclusive mode");
      lockedAgain();
      await gateAgain;
    });
    await holdingAgain;
    try {
      const again = await within(at.install(BOTH, false));
      expect(again).not.toBe("waited");
      expect(again).toMatchObject({ locks: { listed: expect.any(Array) } });
    } finally {
      releaseAgain();
      await holderAgain;
    }
  });
});
