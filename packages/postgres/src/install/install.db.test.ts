import type { EngineTarget, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresConnector } from "../capture/index.ts";
import { createPostgresEngine } from "../engine/index.ts";
import { connectPostgres, type SqlClient, type SqlConnect, type SqlQuery } from "../sql/index.ts";
import { createStore, sourceIdOf } from "../store/index.ts";
import { createScratchDatabase, type ScratchDatabase, TEST_SECRET } from "../testing/index.ts";
import { migrate } from "./migrate.ts";
import { prune } from "./prune.ts";
import { enqueueRole, workerRole } from "./sql.ts";
import { uninstall } from "./uninstall.ts";

/**
 * The install against a real Postgres, for what PGlite cannot prove: the worker login exists with
 * the least permission that works. Roles are cluster-wide, so the install uses the scratch
 * database's own role names (`roleSuffix`), which `scratch.drop` removes.
 */

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

const PASSWORD = "a-long-random-password-for-tests";

let scratch: ScratchDatabase;
let admin: SqlClient;
let worker: SqlClient;
/** Every connection opened so far, closed in afterAll even when beforeAll stopped halfway. */
const open: SqlClient[] = [];
/** Roles a test created besides FacetDB's, dropped once the scratch database is gone. */
const roles: string[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
  open.push(admin);
  await admin.query(
    `create table public.listings (id serial primary key, title text, description text, secret text)`,
  );
  await admin.query(
    `insert into public.listings (title, description, secret) values ('a', 'b', 'c')`,
  );
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      roleSuffix: scratch.roleSuffix,
      workerPassword: PASSWORD,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  worker = connectPostgres(scratch.as(scratch.workerRole, PASSWORD));
  open.push(worker);
});

afterAll(async () => {
  // Every step is tried whatever the ones before it did, and the first error is thrown once all
  // have been (as `scratch.drop()` does): no role a test created stays on the shared server only
  // because a close or the database's drop threw first.
  const errors: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  };
  // Newest first, so the worker's connection is gone before the admin's and the scratch database
  // can be dropped; a beforeAll that failed before `worker` existed still cleans up what it opened.
  for (const connection of open.splice(0).reverse()) {
    await attempt(() => connection.close());
  }
  await attempt(() => scratch.drop());
  for (const role of roles.splice(0).reverse()) {
    await attempt(() => scratch.admin(`drop role if exists ${role}`));
  }
  if (errors.length > 0) {
    throw errors[0];
  }
});

async function denied(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("the worker login on a real Postgres", () => {
  it("reads the key, the state columns and FacetDB's own columns", async () => {
    const rows = await worker.query(
      `select id, title, description, facetdb_status, facetdb_reviewed, is_scam from public.listings`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["facetdb_status"]).toBe("pending");
  });

  it("cannot read a column outside the state", async () => {
    expect(await denied(() => worker.query(`select secret from public.listings`))).toContain(
      "permission denied",
    );
  });

  it("updates its own columns only", async () => {
    await worker.query(
      `update public.listings set is_scam = true, is_scam_probability = 0.97, facetdb_status = 'done', facetdb_updated_at = now() where id = 1 and facetdb_reviewed = false`,
    );
    const rows = await admin.query(
      `select is_scam, facetdb_status from public.listings where id = 1`,
    );
    expect(rows[0]).toMatchObject({ is_scam: true, facetdb_status: "done" });
    expect(
      await denied(() => worker.query(`update public.listings set title = 'x' where id = 1`)),
    ).toContain("permission denied");
    expect(
      await denied(() => worker.query(`update public.listings set secret = 'x' where id = 1`)),
    ).toContain("permission denied");
  });

  it("works the queue and nothing else in the facetdb schema", async () => {
    await admin.query(`update public.listings set title = 'changed' where id = 1`);
    const queued = await worker.query(`select record_key from facetdb.jobs`);
    expect(queued.map((row) => row["record_key"])).toEqual(["t:15:public.listings:1"]);
    await worker.query(
      `update facetdb.jobs set claimed_at = now(), claimed_by = 'w1' where record_key = 't:15:public.listings:1'`,
    );
    await worker.query(`delete from facetdb.jobs where claimed_by = 'w1'`);
    expect(await worker.query(`select record_key from facetdb.jobs`)).toEqual([]);
    expect(await denied(() => worker.query(`select * from facetdb.table_owners`))).toContain(
      "permission denied",
    );
    expect(await denied(() => worker.query(`drop table facetdb.jobs`))).toContain("must be owner");
  });

  it("needs no superuser and the role is not one", async () => {
    const rows = await admin.query(
      `select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = $1`,
      [scratch.workerRole],
    );
    expect(rows[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });

  it("runs the trigger as the enqueue role, which cannot log in", async () => {
    const owners = await admin.query(
      `select proname, proowner::regrole::text as owner, prosecdef from pg_proc
        where pronamespace = 'facetdb'::regnamespace order by proname`,
    );
    expect(owners).toEqual([
      { proname: "enqueue", owner: scratch.enqueueRole, prosecdef: true },
      { proname: "enqueue_keep", owner: scratch.enqueueRole, prosecdef: true },
      // The store's function runs with its caller's rights, so its owner lends it none.
      { proname: "reserve_usage", owner: expect.any(String), prosecdef: false },
    ]);
    const login = connectPostgres(scratch.as(scratch.enqueueRole, "anything"));
    try {
      await expect(login.query("select 1")).rejects.toThrow(
        /not permitted to log in|authentication failed/,
      );
    } finally {
      await login.close();
    }
  });

  it("opens the store, records a heartbeat, appends a decision and claims a job: no create, no ownership", async () => {
    // The worker's first start on a database `migrate` installed. The login holds no CREATE on the
    // database or the schema and owns nothing, and the store issues no DDL.
    const rights = await admin.query(
      `select has_database_privilege($1, current_database(), 'create') as database,
              has_schema_privilege($1, 'facetdb', 'create') as schema,
              (select count(*)::int from pg_class c
                where c.relnamespace = 'facetdb'::regnamespace and c.relowner = $1::regrole) as owned`,
      [scratch.workerRole],
    );
    expect(rights[0]).toEqual({ database: false, schema: false, owned: 0 });

    const statements: string[] = [];
    const record =
      (query: SqlQuery): SqlQuery =>
      (text, params) => {
        statements.push(text);
        return query(text, params);
      };
    /** A worker-login client that records every statement text it is given. */
    const recorded = (): SqlClient => {
      const base = connectPostgres(scratch.as(scratch.workerRole, PASSWORD));
      return {
        query: record(base.query),
        transaction: (work) => base.transaction((query) => work(record(query))),
        pipeline: (text, paramSets) => {
          statements.push(text);
          return base.pipeline(text, paramSets);
        },
        close: () => base.close(),
      };
    };
    const recording = recorded();
    const store = await createStore({
      url: scratch.as(scratch.workerRole, PASSWORD),
      pgHost: undefined,
      connect: () => recording,
      secret: TEST_SECRET,
      clock: new FakeClock(1_700_000_000_000),
      allowInsecure: true,
    });
    // The table source's capture connector, as `facetdb worker` opens it (cli/table-connector.ts)
    // under the same login: the start path of the worker command, short of the CLI itself.
    const capture = createPostgresConnector({
      workerUrl: scratch.as(scratch.workerRole, PASSWORD),
      connect: recorded,
      source: { table: "listings", key: "id" },
      questionSet: listings,
      clock: new FakeClock(1_700_000_000_000),
      workerId: "w1",
    });
    try {
      // What `runWorkers` does first: the project, each source and its question-set version (a
      // second record of the same set is the restart case, which inserts nothing), the heartbeat.
      await store.ensureProject({ id: "proj_listings", name: "Listings" });
      await store.ensureSource({ projectId: "proj_listings", name: "listings", kind: "plugin" });
      const sourceId = sourceIdOf("proj_listings", "listings");
      expect((await store.questionSets.record(sourceId, listings)).version).toBe(1);
      expect((await store.questionSets.record(sourceId, listings)).version).toBe(1);
      await admin.query(`update public.listings set title = 'asked again' where id = 1`);
      expect(await capture.claim(5)).toEqual(["1"]);
      await capture.ack(["1"]);
      await store.alerts.saveHeartbeat("proj_listings", 1_700_000_000_000);
      expect(await store.alerts.lastHeartbeat("proj_listings")).toBe(1_700_000_000_000);
      await store.log(sourceId).appendAnswer({
        kind: "answer",
        key: "1",
        version: 1,
        model: "jev-1.14.0",
        stateHash: "a".repeat(64),
        answers: { is_scam: { type: "noul", probability: 0.25 } },
        usage: { inputTokens: 10, outputTokens: 2 },
        at: new Date("2026-11-01T20:00:00Z"),
      });
      const queue = store.connector({
        sourceId: sourceId,
        fields: ["title"],
        workerId: "w1",
      });
      await queue.enqueue(["k1"]);
      expect(await queue.claim(1)).toEqual(["k1"]);
      // Spending as the worker login: the store's function runs on its EXECUTE grant.
      const admitted = await store.usage.reserve("proj_listings", "2026-11", 10, 100, 0, 60_000);
      expect(admitted).toEqual({ reservation: expect.any(String), monthTotal: 0 });
      expect(
        await store.usage.finish("proj_listings", "2026-11", admitted.reservation ?? "", 7),
      ).toBe(7);
      // The webhook outbox (@facetdb/server) is a store table too; the worker queues and claims in
      // it with the same login (a run on Supabase failed here: the worker had created it).
      const reserved = await recording.query(
        "select nextval(pg_get_serial_sequence('facetdb.webhook_outbox', 'id'))::text as id",
      );
      await recording.query(
        `insert into facetdb.webhook_outbox (id, project_id, endpoint, payload, created_at, next_attempt_at)
         values ($1::bigint, 'proj_listings', 'https://hooks.example.com/f', '{}', 1, 1)`,
        [reserved[0]?.["id"]],
      );
      const claimedRows = await recording.query(
        `update facetdb.webhook_outbox set attempts = attempts + 1, claimed_by = 'w1'
          where delivered_at is null returning id::text as id`,
      );
      expect(claimedRows).toEqual([{ id: String(reserved[0]?.["id"]) }]);
    } finally {
      await capture.close();
      await store.close();
    }
    expect(statements.length).toBeGreaterThan(0);
    expect(
      statements.filter((text) => /^\s*(create|alter|drop|grant|revoke)\b/i.test(text)),
    ).toEqual([]);
  });

  it("holds exactly select and insert on the decision log and the versions, after an upgrade too", async () => {
    const privileges = () =>
      admin.query(
        `select table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
           from information_schema.table_privileges
          where table_schema = 'facetdb' and grantee = $1
            and table_name in ('decisions', 'question_set_versions')
          group by 1 order by 1`,
        [scratch.workerRole],
      );
    const appendOnly = [
      { table_name: "decisions", privileges: "INSERT, SELECT" },
      { table_name: "question_set_versions", privileges: "INSERT, SELECT" },
    ];
    expect(await privileges()).toEqual(appendOnly);
    for (const statement of [
      "update facetdb.decisions set note = 'x'",
      "delete from facetdb.decisions",
      "update facetdb.question_set_versions set content_hash = 'x'",
      "delete from facetdb.question_set_versions",
    ]) {
      expect(await denied(() => worker.query(statement))).toContain("permission denied");
    }
    // An earlier install granted update and delete too: migrate takes them back.
    await admin.query(
      `grant update, delete on facetdb.decisions, facetdb.question_set_versions to ${scratch.workerRole}`,
    );
    const again = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table: "listings" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
        roleSuffix: scratch.roleSuffix,
      },
    });
    expect(again).toMatchObject({ ok: true, applied: true });
    expect(await privileges()).toEqual(appendOnly);
  });

  it("a password given on a later run is the one that logs in", async () => {
    const result = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table: "listings" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
        roleSuffix: scratch.roleSuffix,
        workerPassword: "a-second-long-random-password",
      },
    });
    expect(result).toMatchObject({ ok: true, workerPasswordApplied: true });
    const stale = connectPostgres(scratch.as(scratch.workerRole, PASSWORD));
    const fresh = connectPostgres(scratch.as(scratch.workerRole, "a-second-long-random-password"));
    try {
      await expect(stale.query("select 1")).rejects.toThrow();
      expect(await fresh.query("select 1 as one")).toEqual([{ one: 1 }]);
    } finally {
      await stale.close();
      await fresh.close();
    }
  });
});

describe("a log-only purge against a concurrent install, on two connections", () => {
  const archive = { id: "proj_archive", name: "Archive" };
  const SOURCE = "t_archive";
  /** The id the worker writes the source's log under. */
  const ARCHIVE_LOG = sourceIdOf(archive.id, SOURCE);

  /** Installs `public.archive` for its project; `connect` lets a test hold the transaction open. */
  const installArchive = (connect?: SqlConnect) =>
    migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      ...(connect === undefined ? {} : { connect }),
      plan: {
        source: { table: "archive" },
        questionSet: listings,
        project: archive,
        roleSuffix: scratch.roleSuffix,
      },
    });

  /** Whether some session of this scratch database waits for a lock on `facetdb.table_owners`. */
  async function ownersLockAwaited(): Promise<boolean> {
    const rows = await admin.query(
      `select exists (select 1 from pg_catalog.pg_locks
                       where database = (select oid from pg_catalog.pg_database where datname = current_database())
                         and relation = 'facetdb.table_owners'::regclass and not granted) as waiting`,
    );
    return rows[0]?.["waiting"] === true;
  }

  it("waits for the install's owner row inside its transaction, sees it, and deletes nothing", async () => {
    // The suite's `listings` goes first, with a plain uninstall, so the archive is the only table.
    expect(
      await uninstall({
        adminUrl: scratch.url,
        source: { table: "listings", name: "listings", projectId: "proj_listings" },
        roleSuffix: scratch.roleSuffix,
        print: () => undefined,
        confirm: () => Promise.resolve("Listings"),
      }),
    ).toMatchObject({ ok: true, applied: true });
    await admin.query(
      `create table public.archive (id serial primary key, title text, description text)`,
    );
    expect(await installArchive()).toMatchObject({ ok: true, applied: true });
    // The worker's registration of the source, and its log, as a first start leaves them.
    await admin.query(
      `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $3, 'plugin')`,
      [ARCHIVE_LOG, archive.id, SOURCE],
    );
    await admin.query(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ($1, '1', 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
      [ARCHIVE_LOG],
    );
    const plain = await uninstall({
      adminUrl: scratch.url,
      source: { table: "archive", name: SOURCE, projectId: archive.id },
      roleSuffix: scratch.roleSuffix,
      print: () => undefined,
      confirm: () => Promise.resolve(archive.name),
    });
    expect(plain).toMatchObject({ ok: true, applied: true });

    // A second connection installs the table again and holds its transaction open before the
    // commit: its owner row is written, not yet visible.
    let ranAll = (): void => undefined;
    const installed = new Promise<void>((resolve) => {
      ranAll = resolve;
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding: SqlConnect = (url, options) => {
      const base = connectPostgres(url, options);
      return {
        ...base,
        transaction: <T>(work: (query: SqlQuery) => Promise<T>) =>
          base.transaction(async (query) => {
            const result = await work(query);
            ranAll();
            await held;
            return result;
          }),
      };
    };

    let concurrent: Promise<unknown> = Promise.resolve();
    let releaser: Promise<void> = Promise.resolve();
    try {
      const result = await uninstall({
        adminUrl: scratch.url,
        source: { table: "archive", name: SOURCE, projectId: archive.id },
        roleSuffix: scratch.roleSuffix,
        purge: true,
        print: () => undefined,
        // Every check before the confirmation found the source unused; the install starts now,
        // and is let commit only once the purge's transaction waits for the owner rows' lock.
        confirm: async () => {
          concurrent = installArchive(holding);
          await installed;
          releaser = (async () => {
            for (let polls = 0; !(await ownersLockAwaited()); polls += 1) {
              if (polls > 10_000) {
                throw new Error("the purge never waited for the owner rows' lock");
              }
            }
            release();
          })();
          return SOURCE;
        },
      });
      await releaser;
      expect(await concurrent).toMatchObject({ ok: true, applied: true });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).toContain(
        `the decision log of source "${ARCHIVE_LOG}" is live again: public.archive is now installed for its project; nothing was changed`,
      );
    } finally {
      // Whatever failed above, the held install commits and its connection closes.
      release();
      await Promise.allSettled([concurrent, releaser]);
    }
    expect(
      await admin.query(`select record_key from facetdb.decisions where source_id = $1`, [
        ARCHIVE_LOG,
      ]),
    ).toEqual([{ record_key: "1" }]);
    expect(
      await admin.query(`select id from facetdb.sources where id = $1`, [ARCHIVE_LOG]),
    ).toEqual([{ id: ARCHIVE_LOG }]);
  });
});

/** Resolves when the returned function is called; for holding a transaction open across connections. */
function gate<T>(): { readonly promise: Promise<T>; readonly open: (value: T) => void } {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The statements of this database's backends that wait for a lock, once there is one. It polls the
 * server for a state, it times nothing: the bound only keeps a broken test from hanging.
 */
async function lockWaits(): Promise<string[]> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = await admin.query(
      `select query from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (rows.length > 0) {
      return rows.map((row) => String(row["query"]));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend ever waited for a lock: the claim did not wait for the other one");
}

describe("two installs and two admins on a real Postgres", () => {
  /**
   * Another project's install, held open on its own connection right after its claim (the owner
   * check runs inside the transaction; this shows it across two real connections).
   */
  async function claimHeld(table: string, projectId: string) {
    const claimed = gate<undefined>();
    const finish = gate<"commit" | "rollback">();
    const other = connectPostgres(scratch.url);
    open.push(other);
    const done = other
      .transaction(async (query) => {
        await query(
          `insert into facetdb.projects (id, name) values ($1, $1) on conflict (id) do nothing`,
          [projectId],
        );
        await query(
          `insert into facetdb.table_owners (table_schema, table_name, project_id) values ('public', $1, $2)`,
          [table, projectId],
        );
        claimed.open(undefined);
        if ((await finish.promise) === "rollback") {
          throw new Error("rolled back on purpose");
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "rolled back on purpose")) {
          throw error;
        }
      });
    await claimed.promise;
    return { finish: finish.open, done };
  }

  function install(table: string, projectId: string) {
    return migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table },
        questionSet: listings,
        project: { id: projectId, name: projectId },
        roleSuffix: scratch.roleSuffix,
      },
    });
  }

  async function hasStatus(table: string): Promise<boolean> {
    const rows = await admin.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = 'facetdb_status'`,
      [table],
    );
    return rows.length > 0;
  }

  it("the second claim waits for the first, reads the committed owner and rolls back", async () => {
    await admin.query(
      `create table public.raced_commit (id serial primary key, title text, description text)`,
    );
    const first = await claimHeld("raced_commit", "proj_first");
    const second = install("raced_commit", "proj_second");
    try {
      // The second install's inspection saw no owner (the first is not committed): it waits at its claim.
      expect((await lockWaits()).join("\n")).toContain("table_owners");
    } finally {
      // Released whatever happened, so a failed assertion never leaves the second waiting out its lock.
      first.finish("commit");
      await first.done;
    }
    const result = await second;
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("another project (proj_first)");
    }
    expect(await hasStatus("raced_commit")).toBe(false);
    expect(
      await admin.query(
        `select project_id from facetdb.table_owners where table_name = 'raced_commit'`,
      ),
    ).toEqual([{ project_id: "proj_first" }]);
  });

  it("the second claim takes the table when the first rolls back", async () => {
    await admin.query(
      `create table public.raced_rollback (id serial primary key, title text, description text)`,
    );
    const first = await claimHeld("raced_rollback", "proj_first");
    const second = install("raced_rollback", "proj_second");
    try {
      expect((await lockWaits()).join("\n")).toContain("table_owners");
    } finally {
      first.finish("rollback");
      await first.done;
    }
    expect(await second).toMatchObject({ ok: true, applied: true });
    expect(await hasStatus("raced_rollback")).toBe(true);
    expect(
      await admin.query(
        `select project_id from facetdb.table_owners where table_name = 'raced_rollback'`,
      ),
    ).toEqual([{ project_id: "proj_second" }]);
  });

  it("prune's revoke of a state column, run by an admin who did not make the grant", async () => {
    // The table belongs to the application's role; the installer was another admin (here the
    // server's superuser, whose grants Postgres records as the owner's). Roles are cluster-wide, so
    // their names are this scratch database's own.
    const owner = `${scratch.name}_owner`;
    const member = `${scratch.name}_member`;
    const outsider = `${scratch.name}_outsider`;
    const password = "a-long-random-password-for-admins";
    roles.push(owner, member, outsider);
    await admin.query(`create role ${owner} nologin`);
    await admin.query(`create role ${member} login password '${password}' in role ${owner}`);
    await admin.query(`create role ${outsider} login password '${password}'`);
    await admin.query(
      `create table public.pruned (id serial primary key, title text, description text, notes text)`,
    );
    await admin.query(`alter table public.pruned owner to ${owner}`);
    for (const role of [member, outsider]) {
      await admin.query(`grant usage on schema facetdb to ${role}`);
      await admin.query(`grant select on facetdb.table_owners, facetdb.projects to ${role}`);
    }
    // The outsider may read the table (an analytics admin, say): some right on it, no grant option.
    await admin.query(`grant select on public.pruned to ${outsider}`);
    const wider = { ...listings, read: ["title", "description", "notes"] };
    const installed = await migrate({
      adminUrl: scratch.url,
      print: () => undefined,
      plan: {
        source: { table: "pruned" },
        questionSet: wider,
        project: { id: "proj_listings", name: "Listings" },
        roleSuffix: scratch.roleSuffix,
      },
    });
    expect(installed).toMatchObject({ ok: true, applied: true });
    const grants = () =>
      admin.query(
        `select x.grantor::regrole::text as grantor
           from pg_catalog.pg_attribute a cross join lateral pg_catalog.aclexplode(a.attacl) x
          where a.attrelid = 'public.pruned'::regclass and a.attname = 'notes'
            and x.privilege_type = 'SELECT' and x.grantee = $1::regrole`,
        [scratch.workerRole],
      );
    expect(await grants()).toEqual([{ grantor: owner }]);
    const pruneAs = (role: string) =>
      prune({
        adminUrl: scratch.as(role, password),
        source: { table: "pruned" },
        questionSet: listings,
        project: { id: "proj_listings", name: "Listings" },
        roleSuffix: scratch.roleSuffix,
        print: () => undefined,
      });

    // An admin with some right on the table but neither its owner nor in the owner's role: Postgres
    // runs the revoke, warns, and takes nothing back. Prune once reported it applied, and listed it
    // again on every run; now the script's own check after the revokes raises, and the transaction
    // rolls back having changed nothing.
    const byOutsider = await pruneAs(outsider);
    expect(byOutsider).toMatchObject({ ok: false });
    if (!byOutsider.ok) {
      expect(byOutsider.reason).toContain("still reads notes");
      expect(byOutsider.reason).toContain("as the table's owner or a member of its role");
    }
    expect(await grants()).toEqual([{ grantor: owner }]);
    // A member of the owner's role revokes as the owner, who made the grant: it is gone.
    const byMember = await pruneAs(member);
    expect(byMember).toMatchObject({ ok: true, applied: true });
    if (byMember.ok) {
      expect(byMember.sql).toContain(
        "-- A revoke takes back only grants made by the role running it",
      );
    }
    expect(await grants()).toEqual([]);
    expect(await denied(() => worker.query(`select notes from public.pruned`))).toContain(
      "permission denied",
    );
  });

  it("an upgrade whose revoke on the logs took nothing back refuses, naming the grantor and who must run it", async () => {
    // A DBA, not the owner of the store's tables, granted the worker update on the versions: the
    // owner's revoke takes back only the owner's own grants, and the driver drops Postgres's warning.
    const dba = `${scratch.name}_dba`;
    roles.push(dba);
    await admin.query(`create role ${dba} nologin`);
    await admin.query(`grant usage on schema facetdb to ${dba}`);
    await admin.query(`grant update on facetdb.question_set_versions to ${dba} with grant option`);
    const asDba = (statement: string) =>
      admin.transaction(async (query) => {
        await query(`set local role ${dba}`);
        await query(statement);
      });
    await asDba(`grant update on facetdb.question_set_versions to ${scratch.workerRole}`);
    const again = () =>
      migrate({
        adminUrl: scratch.url,
        print: () => undefined,
        plan: {
          source: { table: "listings" },
          questionSet: listings,
          project: { id: "proj_listings", name: "Listings" },
          roleSuffix: scratch.roleSuffix,
        },
      });
    const refused = await again();
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) {
      expect(refused.reason).toContain(`UPDATE on question_set_versions granted by ${dba}`);
      expect(refused.reason).toContain("or a member of its role");
    }
    await asDba(`revoke update on facetdb.question_set_versions from ${scratch.workerRole}`);
    expect(await again()).toMatchObject({ ok: true, applied: true });
  });
});

describe("a worker login created between an install's plan and its run", () => {
  it("keeps the password the other project's migrate gave it: the run stops at its secret statement", async () => {
    // Roles of their own (a second suffix), so the login is absent when this install is planned.
    const suffix = `${scratch.roleSuffix}r`;
    const login = workerRole(suffix);
    roles.push(login, enqueueRole(suffix));
    const engine = createPostgresEngine({
      connect: connectPostgres,
      pgHost: undefined,
      roleSuffix: suffix,
    });
    const deps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true } as const;
    const target = (table: string, id: string): EngineTarget => ({
      project: { id, name: id },
      source: table,
      table,
      storage: "inline",
      onChange: "reset",
      questionSet: listings,
    });
    for (const table of ["race_mine", "race_theirs"]) {
      await admin.query(
        `create table public.${table} (id serial primary key, title text, description text)`,
      );
    }
    const mine = target("race_mine", "proj_mine");
    const theirs = target("race_theirs", "proj_theirs");
    const MINE = "my-long-random-password-for-tests";
    const THEIRS = "their-long-random-password-for-tests";
    const planned = await engine.planInstall(mine, scratch.url, { ...deps, workerPassword: MINE });
    if (!planned.ok) {
      throw new Error(planned.refusal.message);
    }
    expect(planned.plan.statements.some((statement) => statement.secret === true)).toBe(true);

    // Meanwhile, another project's migrate creates the login with its own password.
    const other = await engine.planInstall(theirs, scratch.url, {
      ...deps,
      workerPassword: THEIRS,
    });
    if (!other.ok) {
      throw new Error(other.refusal.message);
    }
    const ranTheirs = await engine.run(theirs, other.plan, scratch.url, {
      ...deps,
      workerPassword: THEIRS,
    });
    expect(ranTheirs.stopped).toBeUndefined();

    const result = await engine.run(mine, planned.plan, scratch.url, {
      ...deps,
      workerPassword: MINE,
    });
    expect(result).toMatchObject({
      ran: [],
      stopped: {
        at: planned.plan.statements.findIndex((statement) => statement.secret === true),
        refusal: { code: "worker-login-created", fix: "run facetdb migrate again, which keeps it" },
      },
    });
    // Theirs still logs in; mine never became the login's password; nothing of mine was installed.
    const asTheirs = connectPostgres(scratch.as(login, THEIRS));
    const asMine = connectPostgres(scratch.as(login, MINE));
    try {
      expect(await asTheirs.query("select 1 as one")).toEqual([{ one: 1 }]);
      await expect(asMine.query("select 1")).rejects.toThrow();
    } finally {
      await asTheirs.close();
      await asMine.close();
    }
    expect(
      await admin.query(
        "select table_name from facetdb.table_owners where table_name in ('race_mine', 'race_theirs') order by 1",
      ),
    ).toEqual([{ table_name: "race_theirs" }]);
  });

  it("serializes two first installs on the login's lock: the second waits, then stops at its secret statement", async () => {
    const suffix = `${scratch.roleSuffix}s`;
    const login = workerRole(suffix);
    roles.push(login, enqueueRole(suffix));
    // The first run's transaction stays open after its last statement, the lock held, until the
    // test lets it commit; `reached` says it got there. Only the run's: the read-only transaction
    // the planning reads its lock list in holds nothing and goes through.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held: SqlConnect = (url, options) => {
      const inner = connectPostgres(url, options);
      return {
        ...inner,
        transaction: (work) =>
          inner.transaction(async (query) => {
            const sent: string[] = [];
            const done = await work((text, params) => {
              sent.push(text);
              return query(text, params);
            });
            if (sent[0] !== "set transaction read only") {
              reached();
              await gate;
            }
            return done;
          }),
      };
    };
    const first = createPostgresEngine({ connect: held, pgHost: undefined, roleSuffix: suffix });
    const second = createPostgresEngine({
      connect: connectPostgres,
      pgHost: undefined,
      roleSuffix: suffix,
    });
    const deps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true } as const;
    const target = (table: string): EngineTarget => ({
      project: { id: `proj_${table}`, name: table },
      source: table,
      table,
      storage: "inline",
      onChange: "reset",
      questionSet: listings,
    });
    for (const table of ["lock_first", "lock_second"]) {
      await admin.query(
        `create table public.${table} (id serial primary key, title text, description text)`,
      );
    }
    const FIRST = "the-first-long-random-password-for-tests";
    const SECOND = "the-second-long-random-password-for-tests";
    // Both planned while the login is absent: both would create it.
    const planned = async (engine: typeof first, table: string, password: string) => {
      const result = await engine.planInstall(target(table), scratch.url, {
        ...deps,
        workerPassword: password,
      });
      if (!result.ok) {
        throw new Error(result.refusal.message);
      }
      return result.plan;
    };
    const firstPlan = await planned(first, "lock_first", FIRST);
    const secondPlan = await planned(second, "lock_second", SECOND);

    const firstRun = first.run(target("lock_first"), firstPlan, scratch.url, {
      ...deps,
      workerPassword: FIRST,
    });
    await holding;
    const secondRun = second.run(target("lock_second"), secondPlan, scratch.url, {
      ...deps,
      workerPassword: SECOND,
    });
    // The second waits on the login's lock (within its 10-second lock_timeout), then the first commits.
    const waiting = async () =>
      Number(
        (
          await admin.query(
            `select count(*)::int as n from pg_catalog.pg_locks l
              join pg_catalog.pg_database d on d.oid = l.database
             where l.locktype = 'advisory' and not l.granted and d.datname = current_database()`,
          )
        )[0]?.["n"],
      );
    for (let tries = 0; (await waiting()) === 0; tries += 1) {
      expect(tries).toBeLessThan(200);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    expect((await firstRun).stopped).toBeUndefined();
    expect(await secondRun).toMatchObject({
      ran: [],
      stopped: {
        at: secondPlan.statements.findIndex((statement) => statement.secret === true),
        refusal: { code: "worker-login-created" },
      },
    });
    const asFirst = connectPostgres(scratch.as(login, FIRST));
    const asSecond = connectPostgres(scratch.as(login, SECOND));
    try {
      expect(await asFirst.query("select 1 as one")).toEqual([{ one: 1 }]);
      await expect(asSecond.query("select 1")).rejects.toThrow();
    } finally {
      await asFirst.close();
      await asSecond.close();
    }
  });
});
