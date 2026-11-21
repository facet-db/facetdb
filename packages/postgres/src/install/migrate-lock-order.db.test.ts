import type {
  Clock,
  EngineDeps,
  EnginePlan,
  EngineTarget,
  OpenConnector,
  QuestionSet,
  RecordDecision,
} from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresEngine } from "../engine/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";

/**
 * The install's lock order beside a live application, statement by statement. A live suite saw one
 * run in five end with the application's insert killed as a deadlock victim: the capture trigger
 * locks the customer's table, then `facetdb.jobs`; the install locked the jobs table first (the
 * store's `create index if not exists`) and the customer's table after. Now the plan's first lock
 * is the customer's table. Here, on a real Postgres, a source installed with one question and a
 * working worker login; the plan for the set with one more question is walked on an admin
 * connection inside one transaction, and an application insert on a second connection meets it
 * right after its first lock: the insert waits at the customer's table (never inside the trigger),
 * the plan commits, and then the insert succeeds. And the reverse: an application transaction
 * holding an uncommitted insert makes the plan fail at that first lock with the lock timeout, the
 * table unchanged, and the application's own write commits. And the shared queue: an application
 * transaction that wrote another installed table first (so its trigger holds the one
 * `facetdb.jobs`) then writes the table the plan holds; the store's statements wait for nothing of
 * it, so it waits at the table and both commit. No statement of either side ends in a deadlock
 * (SQLSTATE 40P01). Every wait is a server state polled with a bound or a promise awaited; nothing
 * is timed.
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

const PASSWORD = "a-long-random-password-for-migrate-lock-order";

/** SQLSTATE `lock_not_available`: the plan's `lock_timeout` (ten seconds) passed. */
const LOCK_TIMEOUT = "55P03";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let scratch: ScratchDatabase;
/** The scratch database to drop: none when beforeAll stopped before it was made. */
const scratches: ScratchDatabase[] = [];
let admin: SqlClient;
let engine: ReturnType<typeof createPostgresEngine>;
/** Every connection and connector opened, closed in afterAll even when a test stopped halfway. */
const clients: SqlClient[] = [];
const connectors: OpenConnector[] = [];

const deps: EngineDeps = { clock: realClock, allowInsecure: false, storeShared: true };

function target(table: string, questionSet: QuestionSet): EngineTarget {
  return {
    project: { id: "proj_lock_order", name: "Lock order" },
    source: table,
    table,
    storage: "inline",
    onChange: "reset",
    questionSet,
  };
}

/** One connection of its own (a pool of one), so its backend is the one the server shows. */
function connection(): SqlClient {
  const client = connectPostgres(scratch.url, { max: 1 });
  clients.push(client);
  return client;
}

async function backendPid(client: SqlClient): Promise<number> {
  return Number((await client.query(`select pg_backend_pid() as pid`))[0]?.["pid"]);
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

/** Resolves when `open` is called; for holding a transaction open across connections. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Plans the install of `questionSet` on `table` with the admin string. */
async function plan(table: string, questionSet: QuestionSet): Promise<EnginePlan> {
  const planned = await engine.planInstall(target(table, questionSet), scratch.url, {
    ...deps,
    workerPassword: PASSWORD,
  });
  if (!planned.ok) {
    throw new Error(planned.refusal.message);
  }
  return planned.plan;
}

/** The application's table with the old set installed, as the engine's run applies it. */
async function installedTable(table: string): Promise<void> {
  await admin.query(`create table public.${table} (id text primary key, title text)`);
  const first = await plan(table, OLD);
  const result = await engine.run(target(table, OLD), first, scratch.url, {
    ...deps,
    workerPassword: PASSWORD,
  });
  if (result.stopped !== undefined) {
    throw new Error(`the first install stopped: ${JSON.stringify(result.stopped)}`);
  }
}

/** Where the plan locks the customer's table, and where it alters it. */
function landmarks(planned: EnginePlan, table: string) {
  const lock = planned.statements.findIndex(
    (statement) => statement.text === `lock table "public"."${table}" in access exclusive mode`,
  );
  const alter = planned.statements.findIndex((statement) =>
    statement.text.startsWith(`alter table "public"."${table}"`),
  );
  return { lock, alter };
}

/**
 * Runs the plan's statements in order, as printed, on `walker` inside one transaction (what the
 * engine's run does, without its reading of the owner); `between` runs right after the statement
 * at index `after` returns, inside the transaction. Resolves with the index of the statement that
 * failed and its SQLSTATE, or with "ok" once the transaction committed.
 */
async function walk(
  walker: SqlClient,
  planned: EnginePlan,
  after: number,
  between: () => Promise<void>,
): Promise<{ readonly code: string; readonly at: number }> {
  let at = -1;
  const code = await outcome(
    walker.transaction(async (query) => {
      for (const [index, statement] of planned.statements.entries()) {
        at = index;
        await query(statement.text);
        if (index === after) {
          await between();
        }
      }
      at = planned.statements.length;
    }),
  );
  return { code, at };
}

/**
 * Resolves once the backend `pid` waits for a lock on `public.<table>` that `holder` holds. It polls
 * the server for a state, it times nothing: the bound only keeps a broken test from hanging.
 */
async function untilWaitingAtTable(pid: number, table: string, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = await admin.query(
      `select exists (select 1 from pg_catalog.pg_locks l
                       where l.pid = $1 and not l.granted
                         and l.relation = (select c.oid from pg_catalog.pg_class c
                                            where c.relnamespace = 'public'::regnamespace and c.relname = $2))
              and $3 = any(pg_catalog.pg_blocking_pids($1)) as waiting`,
      [pid, table, holder],
    );
    if (rows[0]?.["waiting"] === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `the application's insert never waited at public.${table} behind the plan's first lock`,
  );
}

/** Which of `relations` (schema-qualified) the backend `pid` holds a row-exclusive lock on, by name. */
async function rowExclusiveHeld(pid: number, relations: readonly string[]): Promise<string[]> {
  const rows = await admin.query(
    `select c.relname from pg_catalog.pg_locks l
       join pg_catalog.pg_class c on c.oid = l.relation
      where l.pid = $1 and l.granted and l.mode = 'RowExclusiveLock'
        and c.oid = any(array(select to_regclass(r) from unnest($2::text[]) as r))
      order by c.relname`,
    [pid, relations],
  );
  return rows.map((row) => String(row["relname"]));
}

/**
 * The modes the backend `pid` holds on `facetdb.jobs` that conflict with the trigger's insert
 * (row exclusive): share, share row exclusive, exclusive and access exclusive.
 */
async function queueLocksAgainstInserts(pid: number): Promise<string[]> {
  const rows = await admin.query(
    `select l.mode from pg_catalog.pg_locks l
      where l.pid = $1 and l.relation = 'facetdb.jobs'::regclass
        and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      order by l.mode`,
    [pid],
  );
  return rows.map((row) => String(row["mode"]));
}

/** What the install leaves on a table, for "unchanged": columns, comments, triggers, rights. */
async function installed(table: string): Promise<unknown> {
  return {
    columns: await admin.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by column_name`,
      [table],
    ),
    comments: await admin.query(
      `select a.attname, col_description(a.attrelid, a.attnum) as comment
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'public'::regnamespace and c.relname = $1
          and a.attnum > 0 and not a.attisdropped
        order by a.attname`,
      [table],
    ),
    triggers: await admin.query(
      `select t.tgname, pg_get_triggerdef(t.oid) as definition
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
        where c.relnamespace = 'public'::regnamespace and c.relname = $1 and not t.tgisinternal
        order by t.tgname`,
      [table],
    ),
    rights: await admin.query(
      `select grantee, column_name, privilege_type
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = $1 and grantee = $2
        order by column_name, privilege_type`,
      [table, scratch.workerRole],
    ),
  };
}

async function opened(
  table: string,
  questionSet: QuestionSet,
  workerId: string,
): Promise<OpenConnector> {
  const connector = await engine.open(
    target(table, questionSet),
    scratch.as(scratch.workerRole, PASSWORD),
    { ...deps, workerId },
  );
  connectors.push(connector);
  return connector;
}

/** A decided "no" for each question named. */
function decided(names: readonly string[]): RecordDecision {
  return {
    decisions: Object.fromEntries(
      names.map((name) => [
        name,
        { kind: "decided" as const, value: false, probabilityOrConfidence: 0.1 },
      ]),
    ),
    status: "done",
  };
}

/** The worker claims `key` (and nothing else of the table), reads it, writes `names` and acks. */
async function answered(connector: OpenConnector, key: string, names: readonly string[]) {
  expect(await connector.claim(5)).toEqual([key]);
  const { rows } = await connector.read([key]);
  const { written } = await connector.write(key, decided(names), rows[0]?.hash ?? "");
  await connector.ack([key]);
  return written;
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  scratches.push(scratch);
  admin = connectPostgres(scratch.url);
  clients.push(admin);
  engine = createPostgresEngine({
    connect: connectPostgres,
    pgHost: undefined,
    roleSuffix: scratch.roleSuffix,
  });
});

afterAll(async () => {
  for (const connector of connectors.splice(0)) {
    await connector.close();
  }
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const made of scratches.splice(0)) {
    await made.drop();
  }
});

describe("the install's lock order beside a live application", () => {
  it("takes the customer's table first, so an insert after that lock waits at the table and succeeds once the plan commits", async () => {
    const table = "listings";
    await installedTable(table);
    // The worker login at work before the plan: the application's row is asked and answered.
    const old = await opened(table, OLD, "old-set");
    await admin.query(`insert into public.listings (id, title) values ('before', 'before')`);
    expect(await answered(old, "before", ["is_scam"])).toBe(true);

    const planned = await plan(table, NEW);
    // The login exists: no password to bind, so the walk runs the printed text as it is.
    expect(planned.statements.some((statement) => statement.secret === true)).toBe(false);
    const { lock, alter } = landmarks(planned, table);
    expect(lock).toBeGreaterThan(0);
    expect(alter).toBeGreaterThan(lock);
    // Only the transaction's settings come before it: no statement on the store's tables does.
    expect(planned.statements.slice(0, lock).map((statement) => statement.text)).toEqual([
      "set local standard_conforming_strings = on",
      "set local lock_timeout = '10s'",
    ]);

    const walker = connection();
    const application = connection();
    const walkerPid = await backendPid(walker);
    const applicationPid = await backendPid(application);
    let inserted: Promise<string> | undefined;
    const walked = await walk(walker, planned, lock, async () => {
      // Between the plan's first lock and the customer's `alter table`: the application inserts.
      inserted = outcome(
        application.query(`insert into public.listings (id, title) values ($1, $2)`, [
          "during",
          "during",
        ]),
      );
      await untilWaitingAtTable(applicationPid, table, walkerPid);
    });
    expect(walked).toEqual({ code: "ok", at: planned.statements.length });
    // The insert returns only now that the plan has committed, and it succeeded: neither side
    // ended in a deadlock (40P01) or any other error.
    expect(await inserted).toBe("ok");

    expect(
      await admin.query(
        `select id, is_vehicle, facetdb_status from public.listings where id = 'during'`,
      ),
    ).toEqual([{ id: "during", is_vehicle: null, facetdb_status: "pending" }]);
    // The trigger queued it: a worker of the new set claims it and writes both questions.
    const fresh = await opened(table, NEW, "new-set");
    expect(await answered(fresh, "during", ["is_scam", "is_vehicle"])).toBe(true);
  });

  it("fails at its first lock with the lock timeout while an application transaction holds an uncommitted insert, the table unchanged", {
    timeout: 45_000,
  }, async () => {
    const table = "held";
    await installedTable(table);
    const planned = await plan(table, NEW);
    const { lock } = landmarks(planned, table);
    expect(lock).toBeGreaterThan(0);
    const before = await installed(table);

    // The application's transaction: one insert (the trigger queues it, so it holds the table
    // and the jobs table), then open until the plan has failed.
    const holding = gate();
    const release = gate();
    const application = connection();
    const applicationPid = await backendPid(application);
    const committed = outcome(
      application.transaction(async (query) => {
        await query(`insert into public.held (id, title) values ('open', 'open')`);
        holding.open();
        await release.promise;
      }),
    );
    let walked: { readonly code: string; readonly at: number };
    try {
      await holding.promise;
      // The trigger's order: the application holds the table and, from the trigger, the queue (the
      // order a live suite saw deadlock against a queue-first install).
      expect(await rowExclusiveHeld(applicationPid, ["public.held", "facetdb.jobs"])).toEqual([
        "held",
        "jobs",
      ]);
      // Bounded by the plan's own `lock_timeout` (ten seconds), set by its second statement.
      walked = await walk(connection(), planned, -1, async () => undefined);
    } finally {
      // Whatever failed above, the application's transaction ends here, not at afterAll's close.
      release.open();
    }

    expect(walked).toEqual({ code: LOCK_TIMEOUT, at: lock });
    // The application's write is never the statement that fails.
    expect(await committed).toBe("ok");
    expect(
      await admin.query(`select id, facetdb_status from public.held where id = 'open'`),
    ).toEqual([{ id: "open", facetdb_status: "pending" }]);
    expect(await installed(table)).toEqual(before);
    expect(
      await admin.query(
        `select count(*)::int as n from information_schema.columns
            where table_schema = 'public' and table_name = 'held' and column_name like 'is_vehicle%'`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("locks nothing of the shared queue while it holds the table, so an application transaction that wrote another installed table first never deadlocks with it", async () => {
    // Two installed tables of one database, one queue: the reviewer's cycle (round 1). An
    // application transaction inserts into `messages` (its trigger's insert holds the queue until
    // the commit), the plan for `offers` holds `offers` and runs the store's statements, and the
    // same transaction then inserts into `offers`. A store statement that waited for the queue
    // (`create index if not exists`'s share lock) would close a cycle there.
    await installedTable("messages");
    await installedTable("offers");
    const planned = await plan("offers", NEW);
    const { lock, alter } = landmarks(planned, "offers");
    expect(lock).toBeGreaterThan(0);
    expect(alter).toBeGreaterThan(lock);
    // The store's statements lie between the table's lock and its `alter table`.
    expect(
      planned.statements
        .slice(lock + 1, alter)
        .some((statement) => statement.text.includes(`"jobs"`)),
    ).toBe(true);

    const walker = connection();
    const application = connection();
    const walkerPid = await backendPid(walker);
    const applicationPid = await backendPid(application);
    const holding = gate();
    const proceed = gate();
    const committed = outcome(
      application.transaction(async (query) => {
        await query(`insert into public.messages (id, title) values ('first', 'first')`);
        holding.open();
        await proceed.promise;
        await query(`insert into public.offers (id, title) values ('second', 'second')`);
      }),
    );
    let walked: { readonly code: string; readonly at: number };
    try {
      await holding.promise;
      expect(await rowExclusiveHeld(applicationPid, ["public.messages", "facetdb.jobs"])).toEqual([
        "jobs",
        "messages",
      ]);
      // Past every store statement, right before the customer's `alter table`. A store statement
      // that waited for the application would stop the walk there at the plan's lock timeout
      // (55P03), never reaching this point.
      walked = await walk(walker, planned, alter - 1, async () => {
        expect(await queueLocksAgainstInserts(walkerPid)).toEqual([]);
        // The same application transaction now writes the table the plan holds: it waits at it.
        proceed.open();
        await untilWaitingAtTable(applicationPid, "offers", walkerPid);
      });
    } finally {
      // Whatever failed above, the application's transaction goes on to its end here.
      proceed.open();
    }

    expect(walked).toEqual({ code: "ok", at: planned.statements.length });
    // Its second insert went through once the plan committed, and the transaction committed:
    // neither side ended in a deadlock (40P01) or any other error.
    expect(await committed).toBe("ok");
    expect(
      await admin.query(
        `select id, is_vehicle, facetdb_status from public.offers where id = 'second'`,
      ),
    ).toEqual([{ id: "second", is_vehicle: null, facetdb_status: "pending" }]);
    expect(
      await admin.query(`select id, facetdb_status from public.messages where id = 'first'`),
    ).toEqual([{ id: "first", facetdb_status: "pending" }]);
  });
});
