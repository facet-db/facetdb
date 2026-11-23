import type { Clock, EngineDeps, EngineTarget, QuestionSet } from "@facetdb/core";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresEngine } from "../engine/index.ts";
import {
  connectPostgres,
  LOCK_TIMEOUT,
  lockTimeoutStatement,
  type SqlClient,
} from "../sql/index.ts";
import {
  planStoreStep,
  runStoreStep,
  SCHEMA_VERSION,
  StoreBusyError,
  type StoreStep,
  storeInstallStatements,
  storeScript,
  storeStepStatements,
  storeVersion,
} from "../store/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";

/**
 * The store's step before the customer's table is locked, on a real Postgres. A source is installed
 * on its table, and the store beside it in the same database stands where it stood before the
 * newest store migration that builds an index (found in the store's own text, never by a number).
 * An open application transaction that appended to that index's table (row exclusive) makes the
 * index build wait, the way a build on a large log takes its time:
 * - The install's plan alone, which holds the store's statements, waits there while it holds the
 *   customer's table, so the application cannot write its own table: the hazard.
 * - The store's step, run on its own as migrate now runs it, waits there holding nothing of the
 *   customer's table: a second connection locks and writes it without waiting. Released, the step
 *   brings the store to `SCHEMA_VERSION`; what it ran is the script it prints, statement for
 *   statement; run again it changes nothing.
 * - The step pins the install's lock timeout: left behind that transaction, it stops on its own
 *   (a short limit here), naming the store table, and the store stays at its old version.
 * - The install that follows, its store statements included, waits for nothing on the store's
 *   tables while it holds the customer's table.
 * Every wait is a server state polled with a bound or a promise awaited; nothing is timed.
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

const OLD: QuestionSet = {
  questions: [SCAM],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};
const NEW: QuestionSet = { ...OLD, questions: [SCAM, VEHICLE] };

const PASSWORD = "a-long-random-password-for-store-step-order";

/** SQLSTATE `lock_not_available`: a `nowait` lock, or a lock timeout, found the lock held. */
const LOCK_NOT_AVAILABLE = "55P03";

const LISTINGS = '"public"."listings"';

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Every scratch database and connection made, dropped and closed in afterAll. */
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

function target(questionSet: QuestionSet): EngineTarget {
  return {
    project: { id: "proj_store_step", name: "Store step" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet,
  };
}

/**
 * The newest store migration that builds an index, read from the store's own text: the index's
 * name and table, and the statements of every migration before it (the store as it stood then).
 */
function beforeNewestIndex(): {
  readonly name: string;
  readonly index: string;
  readonly table: string;
  readonly earlier: readonly string[];
} {
  const statements = storeInstallStatements();
  const at = statements.findLastIndex((text) => /create index \w+ on facetdb\.\w+/.test(text));
  const found = /create index (\w+) on (facetdb\.\w+)/.exec(statements[at] ?? "");
  const recorded = statements
    .slice(0, at)
    .findLastIndex((text) => text.startsWith("insert into facetdb.store_migrations"));
  if (found === null || recorded < 0) {
    throw new Error("no store migration builds an index after another migration");
  }
  return {
    name: String(found[1]),
    index: `facetdb.${found[1]}`,
    table: String(found[2]),
    earlier: statements.slice(0, recorded + 1),
  };
}

const NEWEST_INDEX = beforeNewestIndex();

/**
 * A scratch database with `public.listings` installed for the old set (its own part only, as with a
 * store elsewhere), and the store beside it as it stood before the newest index-building migration.
 */
async function world() {
  const scratch = await createScratchDatabase();
  scratches.push(scratch);
  const connection = (): SqlClient => {
    const client = connectPostgres(scratch.url, { max: 1 });
    clients.push(client);
    return client;
  };
  const admin = connection();
  const engine = createPostgresEngine({
    connect: connectPostgres,
    pgHost: undefined,
    roleSuffix: scratch.roleSuffix,
  });
  const deps = (storeShared: boolean): EngineDeps & { readonly workerPassword: string } => ({
    clock: realClock,
    allowInsecure: false,
    storeShared,
    workerPassword: PASSWORD,
  });
  await admin.query("create table public.listings (id text primary key, title text)");
  await admin.query("insert into public.listings (id, title) values ('1', 'A bike')");
  const first = await engine.planInstall(target(OLD), scratch.url, deps(false));
  if (!first.ok) {
    throw new Error(first.refusal.message);
  }
  const installed = await engine.run(target(OLD), first.plan, scratch.url, deps(false));
  if (installed.stopped !== undefined) {
    throw new Error(`the first install stopped: ${JSON.stringify(installed.stopped)}`);
  }
  await admin.transaction(async (query) => {
    for (const statement of NEWEST_INDEX.earlier) {
      await query(statement);
    }
  });
  const behind = await storeVersion(admin.query);
  expect(behind).toMatchObject({ kind: "found", current: false });
  return { scratch, connection, admin, engine, deps };
}

type World = Awaited<ReturnType<typeof world>>;

/** Resolves when `open` is called; for holding a transaction open across connections. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The server's error code, read off the driver's error; "ok" when the work resolved. */
function outcome(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "ok",
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : String(error),
  );
}

async function backendPid(client: SqlClient): Promise<number> {
  return Number((await client.query("select pg_backend_pid() as pid"))[0]?.["pid"]);
}

/**
 * An application transaction that appended to the index's table and has not committed: it holds
 * row exclusive there, which a `create index` waits behind. Resolves once the lock is held, with
 * its backend and the release that commits it.
 */
async function appendInFlight(w: World) {
  const holder = w.connection();
  const pid = await backendPid(holder);
  const release = gate();
  const holding = gate();
  const done = holder.transaction(async (query) => {
    await query(`lock table ${NEWEST_INDEX.table} in row exclusive mode`);
    holding.open();
    await release.promise;
  });
  await holding.promise;
  return {
    pid,
    release: async () => {
      release.open();
      await done;
    },
  };
}

/**
 * Resolves once the backend `pid` waits for a lock on `relation` that `holder` holds. It polls the
 * server for a state, it times nothing: the bound only keeps a broken test from hanging.
 */
async function untilWaitingOn(w: World, pid: number, relation: string, holder: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = await w.admin.query(
      `select exists (select 1 from pg_catalog.pg_locks l
                       where l.pid = $1 and not l.granted and l.relation = to_regclass($2))
              and $3 = any(pg_catalog.pg_blocking_pids($1)) as waiting`,
      [pid, relation, holder],
    );
    if (rows[0]?.["waiting"] === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} never waited on ${relation} behind ${holder}`);
}

/** The modes the backend `pid` holds, granted, on the customer's table. */
async function locksOnListings(w: World, pid: number): Promise<string[]> {
  const rows = await w.admin.query(
    `select l.mode from pg_catalog.pg_locks l
      where l.pid = $1 and l.granted and l.relation = 'public.listings'::regclass
      order by l.mode`,
    [pid],
  );
  return rows.map((row) => String(row["mode"]));
}

/**
 * The application on its own connection: it locks its table without waiting (`nowait`) and writes
 * a row, whose trigger queues it; a wait on anything else ends at the lock timeout, never a hang.
 */
function applicationWrites(w: World, id: string): Promise<string> {
  return outcome(
    w.connection().transaction(async (query) => {
      await query("set local lock_timeout = '5s'");
      await query(`lock table ${LISTINGS} in access exclusive mode nowait`);
      await query(`insert into ${LISTINGS} (id, title) values ('${id}', 'A car')`);
    }),
  );
}

/** What a store migration changes, read from the catalog: versions, indexes, columns. */
async function storeCatalog(w: World): Promise<unknown> {
  return {
    versions: await w.admin.query(
      "select version, applied_at::text as at from facetdb.store_migrations order by version",
    ),
    indexes: await w.admin.query(
      "select indexname, indexdef from pg_indexes where schemaname = 'facetdb' order by indexname",
    ),
    columns: await w.admin.query(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'facetdb' order by table_name, ordinal_position`,
    ),
  };
}

describe("the store's step runs before the customer's table is locked", () => {
  it("the install's plan alone would build the store's index holding the customer's table: the application waits", async () => {
    const w = await world();
    const planned = await w.engine.planInstall(target(NEW), w.scratch.url, w.deps(true));
    if (!planned.ok) {
      throw new Error(planned.refusal.message);
    }
    const statements = planned.plan.statements.map((statement) => statement.text);
    const lock = statements.indexOf(`lock table ${LISTINGS} in access exclusive mode`);
    const build = statements.findIndex((text) =>
      text.includes(`create index ${NEWEST_INDEX.name} on`),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(lock);

    const append = await appendInFlight(w);
    const walker = w.connection();
    const pid = await backendPid(walker);
    // The plan as printed, in one transaction, rolled back at its end: the hazard, not a run.
    const walked = outcome(
      walker.transaction(async (query) => {
        for (const text of statements) {
          await query(text);
        }
        throw new Error("rolled back");
      }),
    );
    await untilWaitingOn(w, pid, NEWEST_INDEX.table, append.pid);
    expect(await locksOnListings(w, pid)).toContain("AccessExclusiveLock");
    expect(await applicationWrites(w, "2")).toBe(LOCK_NOT_AVAILABLE);
    await append.release();
    expect(await walked).toBe("Error: rolled back");
  });

  it("the store's step waits at the index holding nothing of the customer's table, reaches SCHEMA_VERSION, and runs what it prints", async () => {
    const w = await world();
    const step: StoreStep = await planStoreStep(w.admin.query);
    if (step.kind !== "behind") {
      throw new Error(`the store is ${step.kind}, not behind`);
    }
    expect(step.mayCreate).toBe(true);
    expect(step.statements).toEqual(storeStepStatements());
    // What migrate prints for the store's step, before it asks.
    const printed = storeScript(step.statements);

    const append = await appendInFlight(w);
    const stepClient = w.connection();
    const pid = await backendPid(stepClient);
    const ran: string[] = [];
    const recording: SqlClient = {
      ...stepClient,
      transaction: (work) =>
        stepClient.transaction((query) =>
          work((text, params) => {
            ran.push(text);
            return query(text, params);
          }),
        ),
    };
    const stepped = outcome(runStoreStep(recording, step.statements));
    await untilWaitingOn(w, pid, NEWEST_INDEX.table, append.pid);
    // While the store's index waits to build, the customer's table is free: the application locks
    // it and writes it at once, and its trigger queues the record.
    expect(await locksOnListings(w, pid)).toEqual([]);
    expect(await applicationWrites(w, "2")).toBe("ok");
    const queued = await w.admin.query(
      "select count(*)::int as n from facetdb.jobs where record_key like '%:2'",
    );
    expect(queued[0]?.["n"]).toBe(1);

    await append.release();
    expect(await stepped).toBe("ok");
    expect(await storeVersion(w.admin.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    expect(await planStoreStep(w.admin.query)).toEqual({ kind: "current" });
    const index = await w.admin.query("select to_regclass($1) is not null as built", [
      NEWEST_INDEX.index,
    ]);
    expect(index[0]?.["built"]).toBe(true);
    // The SQL run is the SQL printed, statement for statement.
    expect(ran).toEqual(step.statements);
    expect(storeScript(ran)).toBe(printed);

    // Run again, the step changes nothing.
    const before = await storeCatalog(w);
    await runStoreStep(w.admin, storeStepStatements());
    expect(await storeCatalog(w)).toEqual(before);
  });

  it("the store's step stops at its lock timeout behind a transaction left open on a store table, naming the table, and leaves the store where it was", async () => {
    const w = await world();
    const before = await storeVersion(w.admin.query);
    // The install's own limit, printed in the step right after the store's lock.
    const step = await planStoreStep(w.admin.query);
    if (step.kind !== "behind") {
      throw new Error(`the store is ${step.kind}, not behind`);
    }
    expect(step.statements[1]).toBe(lockTimeoutStatement(LOCK_TIMEOUT));
    expect(step.statements[1]).toBe("set local lock_timeout = '10s'");
    // A short limit so the test does not wait ten seconds: the same statement, another figure.
    const short = await planStoreStep(w.admin.query, "200ms");
    if (short.kind !== "behind") {
      throw new Error(`the store is ${short.kind}, not behind`);
    }
    expect(short.statements[1]).toBe("set local lock_timeout = '200ms'");

    const append = await appendInFlight(w);
    try {
      // It stops on its own while the transaction still holds the table: nothing released it.
      const stopped = await runStoreStep(w.connection(), short.statements).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(stopped).toBeInstanceOf(StoreBusyError);
      expect(stopped).toMatchObject({
        table: NEWEST_INDEX.table,
        message: `the FacetDB store's table ${NEWEST_INDEX.table} is held by another transaction, so the store's migration stopped waiting for it; nothing was changed`,
      });
    } finally {
      await append.release();
    }
    // One transaction, rolled back whole: the store stands where it stood.
    expect(await storeVersion(w.admin.query)).toEqual(before);
    const index = await w.admin.query("select to_regclass($1) is null as absent", [
      NEWEST_INDEX.index,
    ]);
    expect(index[0]?.["absent"]).toBe(true);
  });

  it("after the store's step, the install's store statements wait for nothing while it holds the customer's table", async () => {
    const w = await world();
    await runStoreStep(w.admin, storeStepStatements());
    const append = await appendInFlight(w);
    try {
      const planned = await w.engine.planInstall(target(NEW), w.scratch.url, w.deps(true));
      if (!planned.ok) {
        throw new Error(planned.refusal.message);
      }
      // The plan's own lock timeout (ten seconds) would stop it at any wait on the store's tables.
      const result = await w.engine.run(target(NEW), planned.plan, w.scratch.url, w.deps(true));
      expect(result.stopped).toBeUndefined();
    } finally {
      await append.release();
    }
    const columns = await w.admin.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'listings' and column_name = 'is_vehicle'`,
    );
    expect(columns).toHaveLength(1);
  });
});
