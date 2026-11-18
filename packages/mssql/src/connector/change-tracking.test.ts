import {
  type BackfillProgress,
  type CursorStore,
  type EngineDeps,
  EngineRefusal,
  type EngineTarget,
  stateHash,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  createInstaller,
  MARK_QUERY,
  TRACKING_QUERY,
  tableNames,
  trackedTablesQuery,
} from "../install/index.ts";
import type { MssqlRow } from "../sql/index.ts";
import {
  answer,
  freshWorld,
  installedWorld,
  LISTINGS,
  type RecordingClient,
  recordingClient,
  SQL_SERVER,
  serverError,
  typed,
  type World,
} from "../testing/index.ts";
import {
  createMssqlConnector,
  type MssqlConnector,
  POLLER_LOCK,
  POLLER_LOCK_HELD,
  pollerLock,
  VERSION_SAVE_MS,
  versionRun,
} from "./index.ts";

/**
 * Change Tracking as the capture on the recording client and a fake store cursor: the install plan
 * (no trigger, tracking on with column tracking and FacetDB's mark, the hash column, the worker's
 * view change tracking) and its refusals, the uninstall's part, and the poll the connector's
 * `watch` runs: the version read before the changes, only inserts and state-column updates kept,
 * the rows set pending and queued in one transaction, the version stored after, a first start from
 * the install's mark, a version older than the database keeps reconciled with a warning. The real
 * server runs the same SQL in change-tracking.db.test.ts.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const ADMIN = "mssql://sa:secret@127.0.0.1:1433/listings";
const WORKER = "mssql://facetdb_worker:secret@127.0.0.1:1433/listings";
const TRACKED: EngineTarget = { ...LISTINGS, capture: "change-tracking" };
const RUN = "ct:proj_listings:listings";

function deps(clock: FakeClock): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/** Tracking as `TRACKING_QUERY` reads it: on in the database for two days, off on the table. */
type Tracking = {
  readonly databaseOn?: boolean;
  readonly retention?: number;
  readonly units?: number;
  readonly tableOn?: boolean;
  readonly columnsOn?: boolean;
  readonly mark?: { readonly name: string; readonly since: string };
};

function trackingRow(tracking: Tracking): MssqlRow {
  const on = tracking.databaseOn ?? true;
  return {
    database_on: on,
    retention_period: on ? (tracking.retention ?? 2) : null,
    retention_units: on ? (tracking.units ?? 3) : null,
    table_on: tracking.tableOn ?? false,
    columns_on: tracking.columnsOn ?? false,
    mark_name: tracking.mark?.name ?? null,
    mark_since: tracking.mark?.since ?? null,
  };
}

function planner(world: World, tracking: Tracking = {}) {
  const catalog = answer(world);
  const client = recordingClient({
    answer: (text, params) => {
      if (text === TRACKING_QUERY) {
        return [trackingRow(tracking)];
      }
      if (text === MARK_QUERY) {
        return tracking.mark === undefined
          ? []
          : [{ mark_name: tracking.mark.name, mark_since: tracking.mark.since }];
      }
      return catalog(text, params);
    },
  });
  return { client, installer: createInstaller({ connect: client.connect }) };
}

async function planOf(world: World, tracking: Tracking = {}, target = TRACKED) {
  const { installer } = planner(world, tracking);
  return installer.planInstall(target, ADMIN, {
    ...deps(new FakeClock(START)),
    workerPassword: "a long password",
  });
}

describe("the install with capture: change-tracking", () => {
  it("plans no trigger: tracking on the table with column tracking and FacetDB's mark, facetdb_state_hash, and the worker's view change tracking", async () => {
    const planned = await planOf(freshWorld(SQL_SERVER));
    if (!planned.ok) throw new Error(planned.refusal.message);
    const texts = planned.plan.statements.map((statement) => statement.text);
    expect(texts.some((text) => text.includes("create trigger"))).toBe(false);
    const capture = texts.find((text) => text.includes("enable change_tracking"));
    expect(capture).toContain(
      "alter table [dbo].[listings] enable change_tracking with (track_columns_updated = on);",
    );
    expect(capture).toContain("@name = N'facetdb_tracking_enabled', @value = @since");
    expect(texts).toContain("grant view change tracking on [dbo].[listings] to [facetdb_worker]");
    expect(texts).toContain(
      "grant select ([facetdb_state_hash])\n  on [dbo].[listings] to [facetdb_worker]",
    );
    expect(texts).toContain(
      "grant update ([facetdb_state_hash])\n  on [dbo].[listings] to [facetdb_worker]",
    );
    expect(texts.some((text) => text.includes("add [facetdb_state_hash] varchar(64) null"))).toBe(
      true,
    );
    expect(planned.plan.notes[0]).toBe(
      "dbo.listings is watched by Change Tracking, with no trigger: the worker reads its changes every second, and sets facetdb_status to pending itself on the rows whose state columns changed",
    );
  });

  it("marks a table tracked already as found, so uninstall leaves its tracking on, and drops a trigger left from the trigger capture", async () => {
    const planned = await planOf(installedWorld(LISTINGS, freshWorld(SQL_SERVER)), {
      tableOn: true,
      columnsOn: true,
    });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const texts = planned.plan.statements.map((statement) => statement.text);
    expect(texts).toContain("drop trigger if exists [dbo].[facetdb_listings]");
    expect(texts.some((text) => text.includes("enable change_tracking"))).toBe(false);
    expect(texts.find((text) => text.includes("facetdb_tracking_found"))).toContain(
      "exec sys.sp_addextendedproperty @name = N'facetdb_tracking_found'",
    );
    expect(planned.plan.notes).toContain(
      "Change Tracking was on for dbo.listings already: FacetDB reads it and leaves it as it is, and uninstall leaves it on",
    );
  });

  it("refuses while tracking is off in the database, with the statement its owner runs", async () => {
    const planned = await planOf(freshWorld(SQL_SERVER), { databaseOn: false });
    expect(planned).toEqual({
      ok: false,
      refusal: {
        code: "change-tracking-off",
        message:
          "Change Tracking is off in the database listings, and capture: \"change-tracking\" reads dbo.listings's changes from it; turning it on serves every table of the database, so it is the database admin's to do, not FacetDB's install",
        fix: "as the database's owner (or a login with ALTER on the database), run: alter database [listings] set change_tracking = on (change_retention = 2 days, auto_cleanup = on); then run facetdb migrate again",
      },
    });
  });

  it("refuses a retention under two days, read in minutes, hours or days", async () => {
    for (const [retention, units, words] of [
      [36, 2, "36 hours"],
      [1, 3, "1 day"],
      [90, 1, "90 minutes"],
    ] as const) {
      const planned = await planOf(freshWorld(SQL_SERVER), { retention, units });
      expect(planned).toMatchObject({ ok: false, refusal: { code: "change-tracking-retention" } });
      if (!planned.ok) {
        expect(planned.refusal.message).toContain(`for ${words}, under the two days FacetDB needs`);
        expect(planned.refusal.fix).toBe(
          "as the database's owner, run: alter database [listings] set change_tracking (change_retention = 2 days); then run facetdb migrate again",
        );
      }
    }
    expect(await planOf(freshWorld(SQL_SERVER), { retention: 48, units: 2 })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a table tracked without its columns, and side-table mode with this capture", async () => {
    expect(await planOf(freshWorld(SQL_SERVER), { tableOn: true, columnsOn: false })).toMatchObject(
      { ok: false, refusal: { code: "change-tracking-columns" } },
    );
    expect(
      await planOf(freshWorld(SQL_SERVER), {}, { ...TRACKED, storage: "side-table" }),
    ).toMatchObject({ ok: false, refusal: { code: "side-table" } });
  });

  // Refused before any statement, in the trigger capture's words.
  it("refuses a rowversion state field and a memory-optimized table, before any statement", async () => {
    const fresh = freshWorld(SQL_SERVER);
    const listingsTable = fresh.tables["dbo.listings"];
    if (listingsTable === undefined) throw new Error("no listings");
    const versioned: World = {
      ...fresh,
      tables: {
        "dbo.listings": {
          ...listingsTable,
          columns: [...listingsTable.columns, typed("row_version", "timestamp")],
        },
      },
    };
    const reading: EngineTarget = {
      ...TRACKED,
      questionSet: { ...TRACKED.questionSet, read: ["title", "row_version"] },
    };
    const { client, installer } = planner(versioned);
    const refused = await installer.planInstall(reading, ADMIN, {
      ...deps(new FakeClock(START)),
      workerPassword: "a long password",
    });
    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: "state-column",
        message: expect.stringContaining("the state field row_version is a rowversion column"),
        fix: "remove it from the source's read list in facetdb.config.ts, and list the columns the model reads instead",
      },
    });
    expect(client.transactions.size).toBe(0);
    const memory: World = {
      ...fresh,
      tables: { "dbo.listings": { ...listingsTable, memoryOptimized: true } },
    };
    expect(await planOf(memory)).toMatchObject({
      ok: false,
      refusal: {
        code: "memory-optimized",
        message: expect.stringContaining("and no Change Tracking, so FacetDB could not watch it"),
      },
    });
  });

  it("the trigger capture reads nothing of Change Tracking", async () => {
    const { client, installer } = planner(freshWorld(SQL_SERVER));
    await installer.planInstall(LISTINGS, ADMIN, {
      ...deps(new FakeClock(START)),
      workerPassword: "a long password",
    });
    expect(client.statements.some((statement) => statement.text === TRACKING_QUERY)).toBe(false);
  });
});

describe("the uninstall of a table Change Tracking watches", () => {
  async function uninstallOf(mark: { readonly name: string; readonly since: string }) {
    const world = installedWorld(LISTINGS, freshWorld(SQL_SERVER));
    const { installer } = planner(
      {
        ...world,
        grants: [
          ...world.grants,
          { schema: "dbo", object: "listings", permission: "VIEW CHANGE TRACKING" },
        ],
      },
      { mark },
    );
    const planned = await installer.planUninstall(TRACKED, ADMIN, {
      ...deps(new FakeClock(START)),
      purge: false,
      alsoUninstalling: [],
    });
    if (!planned.ok) throw new Error(planned.refusal.message);
    return planned.plan;
  }

  it("turns tracking off where FacetDB's install turned it on, its mark and the worker's right gone", async () => {
    const plan = await uninstallOf({ name: "facetdb_tracking_enabled", since: "7" });
    const texts = plan.statements.map((statement) => statement.text);
    expect(texts).toContain(
      "if exists (select 1 from sys.change_tracking_tables where object_id = object_id(N'[dbo].[listings]', N'U'))\n  alter table [dbo].[listings] disable change_tracking",
    );
    expect(texts.find((text) => text.includes("sp_dropextendedproperty"))).toContain(
      "@name = N'facetdb_tracking_enabled'",
    );
    expect(texts).toContain(
      "if database_principal_id(N'facetdb_worker') is not null\n  revoke view change tracking on [dbo].[listings] from [facetdb_worker]",
    );
    expect(plan.notes).toEqual([
      "Change Tracking on dbo.listings is turned off, because FacetDB's install turned it on; if another reader of the table's changes has relied on it since, turn it on again after the uninstall: alter table [dbo].[listings] enable change_tracking with (track_columns_updated = on)",
    ]);
    // Among what goes, so the confirmation says it, and only where it is turned off.
    expect(plan.removes.filter((object) => object.kind === "change-tracking")).toEqual([
      {
        kind: "change-tracking",
        name: "dbo.listings",
        of: "dbo.listings",
        scope: "source",
        reason: "FacetDB's install turned it on",
      },
    ]);
    expect(plan.keeps.some((object) => object.kind === "change-tracking")).toBe(false);
  });

  it("leaves tracking on where it was on before the install", async () => {
    const plan = await uninstallOf({ name: "facetdb_tracking_found", since: "7" });
    const texts = plan.statements.map((statement) => statement.text);
    expect(texts.some((text) => text.includes("disable change_tracking"))).toBe(false);
    expect(texts.find((text) => text.includes("sp_dropextendedproperty"))).toContain(
      "@name = N'facetdb_tracking_found'",
    );
    expect(plan.notes).toEqual([
      "Change Tracking stays on for dbo.listings: it was on before FacetDB's install",
    ]);
    expect(plan.removes.some((object) => object.kind === "change-tracking")).toBe(false);
    // Among what stays, so the confirmation says it.
    expect(plan.keeps.filter((object) => object.kind === "change-tracking")).toEqual([
      {
        kind: "change-tracking",
        name: "dbo.listings",
        of: "dbo.listings",
        scope: "source",
        reason: "it was on before FacetDB's install",
      },
    ]);
  });

  it("names a table Change Tracking watches among those that keep the queue", async () => {
    const world = installedWorld(LISTINGS, freshWorld(SQL_SERVER));
    const catalog = answer(world);
    const tracked = trackedTablesQuery(tableNames(LISTINGS));
    const client = recordingClient({
      answer: (text, params) =>
        text === tracked ? [{ table_schema: "dbo", table_name: "orders" }] : catalog(text, params),
    });
    const planned = await createInstaller({ connect: client.connect }).planUninstall(
      LISTINGS,
      ADMIN,
      { ...deps(new FakeClock(START)), purge: false, alsoUninstalling: [] },
    );
    if (!planned.ok) throw new Error(planned.refusal.message);
    expect(planned.plan.keeps).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      scope: "run",
      reason: "the worker still queues the changes Change Tracking keeps of dbo.orders in it",
    });
  });
});

/** The store's cursors as a map. */
function memoryCursors(): CursorStore & { readonly saved: Map<string, BackfillProgress> } {
  const saved = new Map<string, BackfillProgress>();
  return {
    saved,
    load: async (run) => saved.get(run),
    save: async (run, progress) => {
      saved.set(run, progress);
    },
  };
}

const VERSIONS = "select convert(nvarchar(20), change_tracking_current_version()) as now";
const CHANGES = "declare @since bigint = convert(bigint, @p1);";
const STATES =
  "select convert(nvarchar(322), t.[id]) as k, convert(nvarchar(max), t.[title]) as s0, convert(nvarchar(max), t.[description]) as s1, cast(0 as bit) as x from [dbo].[listings] t with (readcommittedlock, readpast) where t.[id] in (";
/** The connector's own `read`, which waits on a held row as the worker's read does. */
const READ =
  "select convert(nvarchar(322), t.[id]) as k, convert(nvarchar(max), t.[title]) as s0, convert(nvarchar(max), t.[description]) as s1, cast(0 as bit) as x from [dbo].[listings] t where t.[id] in (";
const QUEUE = "declare @seen table";
const RECONCILE = "select top (@p1) convert(nvarchar(322), t.[id]) as k";

/** A database whose versions, changes and rows the test sets as it goes. */
class Tracked {
  readonly clock = new FakeClock(START);
  readonly cursors = memoryCursors();
  readonly warnings: string[] = [];
  client: RecordingClient;
  now = "10";
  /** NULL when tracking is off for the table, or the worker may not read it. */
  min: string | null = "0";
  mark: string | undefined = "4";
  changes: string[] = [];
  /** How many rows of a queuing statement an application transaction holds (read past). */
  held = 0;
  /**
   * The oldest valid version from the third read on, when a cleanup moves it: a first poll from a
   * stored version reads it at the start, before the pages and after them.
   */
  minAfter: string | undefined;
  /** An error the next queuing statement fails with (after `failQueueSkip` more succeed). */
  failQueue: Error | undefined;
  failQueueSkip = 0;
  /** Whether this process's session gets the poller's lock. */
  polls = true;
  /** The answers of the next checks before a queuing transaction; `polls` once they run out. */
  checks: boolean[] = [];
  /** The lock statement whose next run fails, and with what. */
  lockFails: { readonly on: "take" | "check"; readonly error: Error } | undefined;
  /** Each changed key's `sys_change_version`: 9 when absent. */
  readonly versionOf = new Map<string, string>();
  /** The lines the connector said, whether it polls or claims only. */
  readonly notes: string[] = [];
  /** Whether the worker may update `facetdb_state_hash`, as the server answers it. */
  hashWritable = true;
  /** Each row's state and its stored hash. */
  rows = new Map<string, { title: string; description: string; hash: string | null }>();

  constructor(world: World = installedWorld(LISTINGS, freshWorld(SQL_SERVER))) {
    const catalog = answer(world);
    let versionReads = 0;
    this.client = recordingClient({
      fail: (text) => {
        if (text.startsWith(QUEUE) && this.failQueue !== undefined) {
          if (this.failQueueSkip > 0) {
            this.failQueueSkip -= 1;
            return undefined;
          }
          const error = this.failQueue;
          this.failQueue = undefined;
          return error;
        }
        const lockText = { take: POLLER_LOCK, check: POLLER_LOCK_HELD };
        if (this.lockFails !== undefined && text === lockText[this.lockFails.on]) {
          const { error } = this.lockFails;
          this.lockFails = undefined;
          return error;
        }
        return undefined;
      },
      answer: (text, params) => {
        if (text.startsWith(VERSIONS)) {
          versionReads += 1;
          const min = versionReads > 2 && this.minAfter !== undefined ? this.minAfter : this.min;
          return [{ now: this.now, min }];
        }
        if (text === POLLER_LOCK) return [{ held: this.polls ? 1 : 0 }];
        if (text === POLLER_LOCK_HELD)
          return [{ held: (this.checks.shift() ?? this.polls) ? 1 : 0 }];
        if (text.startsWith(QUEUE)) {
          // The keys of the statement this database's `held` many rows of are taken by.
          const keys = params.slice(1).filter((_, index) => index % 3 === 0);
          return keys.slice(0, this.held).map((skipped) => ({ skipped }));
        }
        if (text.startsWith("select has_perms_by_name(@p1, N'OBJECT', N'UPDATE'")) {
          return [{ writable: this.hashWritable ? 1 : 0 }];
        }
        if (text === MARK_QUERY) {
          return this.mark === undefined
            ? []
            : [{ mark_name: "facetdb_tracking_enabled", mark_since: this.mark }];
        }
        if (text.startsWith(CHANGES)) {
          return this.changes.map((k) => ({ k, v: this.versionOf.get(k) ?? "9" }));
        }
        if (text.startsWith(STATES) || text.startsWith(READ)) {
          return params.flatMap((key) => {
            const row = this.rows.get(String(key));
            return row === undefined
              ? []
              : [{ k: String(key), s0: row.title, s1: row.description, x: false }];
          });
        }
        if (text.startsWith(RECONCILE)) {
          return [...this.rows].map(([k, row]) => ({
            k,
            s0: row.title,
            s1: row.description,
            x: false,
            h: row.hash,
          }));
        }
        return catalog(text, params);
      },
    });
  }

  hashOf(key: string): string {
    const row = this.rows.get(key);
    if (row === undefined) throw new Error(`no row ${key}`);
    return stateHash(["title", "description"], { title: row.title, description: row.description });
  }

  async connector(): Promise<MssqlConnector> {
    return createMssqlConnector(TRACKED, WORKER, {
      clock: this.clock,
      connect: (url) => this.client.connect(url),
      cursors: this.cursors,
      warn: (line) => {
        this.warnings.push(line);
      },
      note: (line) => {
        this.notes.push(line);
      },
    });
  }

  /** The keys each queuing statement was sent, with their hashes, in order. */
  queued(): readonly (readonly unknown[])[] {
    return this.client.statements
      .filter((statement) => statement.text.startsWith(QUEUE))
      .map((statement) => statement.params);
  }

  statementsLike(start: string) {
    return this.client.statements.filter((statement) => statement.text.startsWith(start));
  }
}

describe("the poll watch runs with capture: change-tracking", () => {
  it("starts from the install's mark, reads the version before the changes, queues the changed rows in a transaction, then stores the version", async () => {
    const db = new Tracked();
    db.changes = ["1", "2"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.rows.set("2", { title: "Car", description: "Blue", hash: null });
    const connector = await db.connector();
    await connector.tracked?.poll();

    const texts = db.client.statements.map((statement) => statement.text);
    const versionsAt = texts.findIndex((text) => text.startsWith(VERSIONS));
    const changesAt = texts.findIndex((text) => text.startsWith(CHANGES));
    expect(versionsAt).toBeGreaterThan(-1);
    expect(changesAt).toBeGreaterThan(versionsAt);
    const changes = db.statementsLike(CHANGES)[0];
    // Since the mark's version; inserts and the updates of a state column only.
    expect(changes?.params).toEqual(["4", 1000]);
    expect(changes?.text).toContain("from changetable(changes [dbo].[listings], @since) ct");
    expect(changes?.text).toContain("where ct.sys_change_operation <> N'D'");
    expect(changes?.text).toContain(
      "ct.sys_change_operation = N'I' or ct.sys_change_columns is null or change_tracking_is_column_in_mask(columnproperty(object_id(N'[dbo].[listings]', N'U'), N'title', 'ColumnId'), ct.sys_change_columns) = 1 or change_tracking_is_column_in_mask(columnproperty(object_id(N'[dbo].[listings]', N'U'), N'description', 'ColumnId'), ct.sys_change_columns) = 1",
    );
    const queue = db.statementsLike(QUEUE)[0];
    expect(queue?.transaction).toBe(1);
    expect(db.client.transactions.get(1)).toBe("committed");
    // Each key with the hash read and whether its claim may be cleared: a first sight, so yes.
    expect(queue?.params).toEqual([
      "[dbo].[listings]",
      "1",
      db.hashOf("1"),
      true,
      "2",
      db.hashOf("2"),
      true,
    ]);
    // The rows are read past when an application holds them, and compared by their stored hash.
    expect(queue?.text).toContain(
      "cast(case when t.[facetdb_state_hash] is null or t.[facetdb_state_hash] <> v.[h] then 1 else 0 end as bit)",
    );
    expect(queue?.text).toContain("join [dbo].[listings] t with (updlock, rowlock, readpast)");
    expect(queue?.text).toContain(
      "update t set [facetdb_status] = 'pending'\n  from [dbo].[listings] t with (rowlock, readpast)\n  join @seen q on t.[id] = try_convert(int, q.[k])\n where q.[moved] = 1 and (t.[facetdb_status] is null or t.[facetdb_status] <> 'pending');",
    );
    // A claim held on a queued key is cleared, as the trigger clears it, so a stale ack leaves the job.
    expect(queue?.text).toContain(
      "update j set [claimed_by] = null, [claimed_at] = null, [claim_token] = null\n  from [dbo].[facetdb_jobs] j\n  join @seen q on j.[table_name] = @p1 and j.[record_key] = q.[k]\n where q.[moved] = 1 and q.[clear] = 1 and j.[claim_token] is not null;",
    );
    expect(queue?.text).toContain("insert into [dbo].[facetdb_jobs] ([table_name], [record_key])");
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
    expect(db.warnings).toEqual([]);
  });

  it("resumes from the stored version, and stores a version that queued nothing once a minute", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    const connector = await db.connector();
    await connector.tracked?.poll();
    expect(db.statementsLike(CHANGES)[0]?.params).toEqual(["8", 1000]);
    // Nothing changed of the state: the version is stored, the first time.
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
    expect(db.queued()).toEqual([]);
    expect(db.statementsLike(MARK_QUERY)).toEqual([]);

    db.now = "12";
    await connector.tracked?.poll();
    expect(db.statementsLike(CHANGES)[1]?.params).toEqual(["10", 1000]);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
    db.clock.advance(VERSION_SAVE_MS);
    db.now = "13";
    await connector.tracked?.poll();
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "13", done: false });

    // A poll at the version it stands at reads no change.
    const before = db.statementsLike(CHANGES).length;
    await connector.tracked?.poll();
    expect(db.statementsLike(CHANGES)).toHaveLength(before);
  });

  it("leaves the version where it was when an application transaction held a row of the batch, and reads the same changes again", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    db.changes = ["1", "2"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.rows.set("2", { title: "Car", description: "Blue", hash: null });
    db.held = 1;
    const connector = await db.connector();
    await connector.tracked?.poll();
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "8", done: false });
    db.held = 0;
    db.now = "11";
    await connector.tracked?.poll();
    expect(db.statementsLike(CHANGES).map((statement) => statement.params[0])).toEqual(["8", "8"]);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "11", done: false });
  });

  it("retries a poll that lost a deadlock or gave up on a lock on the next tick, its version kept; any other error stops the watch", async () => {
    for (const number of [1205, 1222]) {
      const db = new Tracked();
      db.cursors.saved.set(RUN, { cursor: "8", done: false });
      db.changes = ["1"];
      db.rows.set("1", { title: "Bike", description: "Red", hash: null });
      db.failQueue = serverError("Transaction was deadlocked on lock resources", number);
      const connector = await db.connector();
      await expect(connector.tracked?.poll()).resolves.toBeUndefined();
      expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "8", done: false });
      await connector.tracked?.poll();
      expect(db.queued()).toHaveLength(2);
      expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
    }
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    db.changes = ["1"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.failQueue = serverError("Invalid column name 'facetdb_state_hash'.", 207);
    await expect((await db.connector()).tracked?.poll()).rejects.toThrow("Invalid column name");
  });

  it("reconciles when the oldest valid version moved past its version while it read the changes", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    db.changes = ["1"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.minAfter = "9";
    const connector = await db.connector();
    await connector.tracked?.poll();
    expect(db.warnings).toHaveLength(1);
    expect(db.warnings[0]).toMatch(
      /^listings: the changes of dbo\.listings since version 8 were cleaned up while the worker read them: the oldest the database still has is version 9\. FacetDB reads every row/,
    );
    expect(db.statementsLike(RECONCILE)).toHaveLength(1);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
  });

  it("reconciles a stored version older than the database keeps: one warning, every row read once, the moved and the never-answered ones queued, then on from the version read first", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "3", done: false });
    db.min = "6";
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.rows.set("2", { title: "Car", description: "Blue", hash: null });
    db.rows.set("3", { title: "Van", description: "White", hash: null });
    const untouched = db.rows.get("2");
    if (untouched !== undefined) untouched.hash = db.hashOf("2");
    const moved = db.rows.get("3");
    if (moved !== undefined) moved.hash = "a hash of another state";
    const connector = await db.connector();
    await connector.tracked?.poll();

    expect(db.warnings).toEqual([
      "listings: the changes of dbo.listings since version 3, where the worker stopped, are gone: the database keeps them for its retention, and the oldest it still has is version 6; the worker was stopped longer than that. FacetDB reads every row of dbo.listings once and queues each whose state changed since its last answer, or that has none, then follows changes again from version 10",
    ]);
    expect(db.statementsLike(CHANGES)).toEqual([]);
    expect(db.queued()).toEqual([
      ["[dbo].[listings]", "1", db.hashOf("1"), true, "3", db.hashOf("3"), true],
    ]);
    expect(db.statementsLike(RECONCILE)[0]?.text).toContain(
      "t.[facetdb_state_hash] as h from [dbo].[listings] t order by t.[id]",
    );
    // The reconcile has no version to come back to: it waits on a held row rather than pass it.
    expect(db.statementsLike(QUEUE)[0]?.text).toContain(
      "join [dbo].[listings] t with (updlock, rowlock) on",
    );
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });

    db.now = "11";
    await connector.tracked?.poll();
    expect(db.statementsLike(CHANGES)[0]?.params).toEqual(["10", 1000]);
    expect(db.warnings).toHaveLength(1);
  });

  it("reconciles on a first start when the changes since the install are gone, and a version ahead of the database's", async () => {
    const first = new Tracked();
    first.min = "6";
    const connector = await first.connector();
    await connector.tracked?.poll();
    expect(first.warnings[0]).toMatch(
      /^listings: the changes of dbo\.listings since FacetDB's install \(version 4\) are gone/,
    );

    const ahead = new Tracked();
    ahead.cursors.saved.set(RUN, { cursor: "40", done: false });
    await (await ahead.connector()).tracked?.poll();
    expect(ahead.warnings[0]).toMatch(
      /^listings: the version stored for dbo\.listings, 40, is ahead of the database's own, 10/,
    );
    expect(ahead.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
  });

  it("refuses to start without FacetDB's mark, and says when tracking is off or unreadable", async () => {
    const unmarked = new Tracked();
    unmarked.mark = undefined;
    await expect((await unmarked.connector()).tracked?.poll()).rejects.toThrow(
      'listings: dbo.listings carries no mark of FacetDB\'s Change Tracking install, so there is no version to start following its changes from; run facetdb migrate with capture: "change-tracking", then start the worker again',
    );
    const off = new Tracked();
    off.cursors.saved.set(RUN, { cursor: "8", done: false });
    off.min = null;
    await expect((await off.connector()).tracked?.poll()).rejects.toThrow(
      "listings: Change Tracking is off for dbo.listings, or the worker login may not read it (view change tracking)",
    );
  });

  it("write stores the hash of the state it decided on; the trigger capture's write does not", async () => {
    const db = new Tracked();
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    const connector = await db.connector();
    const { rows } = await connector.read(["1"]);
    const hash = rows[0]?.hash ?? "";
    await connector.write(
      "1",
      {
        decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.9 } },
        status: "done",
      },
      hash,
    );
    const update = db.client.statements.find((statement) =>
      statement.text.includes("update t set"),
    );
    expect(update?.text).toContain("[facetdb_state_hash] = @p");
    expect(update?.params).toContain(hash);
    expect(connector.tracked).toBeDefined();
    const plain = await createMssqlConnector(LISTINGS, WORKER, {
      clock: db.clock,
      connect: (url) => db.client.connect(url),
    });
    expect(plain.tracked).toBeUndefined();
  });

  it("with the trigger, write keeps facetdb_state_hash current while the table still carries FacetDB's column and the worker may update it", async () => {
    const installed = installedWorld(LISTINGS, freshWorld(SQL_SERVER));
    const table = installed.tables["dbo.listings"];
    if (table === undefined) throw new Error("the world has the listings table");
    const world: World = {
      ...installed,
      tables: {
        ...installed.tables,
        "dbo.listings": {
          ...table,
          columns: [...table.columns, typed("facetdb_state_hash", "varchar(64)", { marked: true })],
        },
      },
    };
    for (const writable of [true, false]) {
      const db = new Tracked(world);
      db.hashWritable = writable;
      db.rows.set("1", { title: "Bike", description: "Red", hash: null });
      const connector = await createMssqlConnector(LISTINGS, WORKER, {
        clock: db.clock,
        connect: (url) => db.client.connect(url),
      });
      const { rows } = await connector.read(["1"]);
      const hash = rows[0]?.hash ?? "";
      await connector.write(
        "1",
        {
          decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.9 } },
          status: "done",
        },
        hash,
      );
      const update = db.client.statements.find((statement) =>
        statement.text.includes("update t set"),
      );
      expect(update?.text.includes("[facetdb_state_hash] = @p")).toBe(writable);
    }
  });

  it("watch refuses in words when the connector was made without the store's cursors", async () => {
    const db = new Tracked();
    const connector = await createMssqlConnector(TRACKED, WORKER, {
      clock: db.clock,
      connect: (url) => db.client.connect(url),
    });
    await expect(connector.watch()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "this SQL Server connector was made without the store's cursors",
    );
  });

  it("refuses to open with side-table mode", async () => {
    const db = new Tracked();
    await expect(
      createMssqlConnector({ ...TRACKED, storage: "side-table" }, WORKER, {
        clock: db.clock,
        connect: (url) => db.client.connect(url),
      }),
    ).rejects.toBeInstanceOf(EngineRefusal);
  });

  it("keeps its version under ct:<project>:<source>, and names its lock by the table, hashed past 255 characters", () => {
    expect(versionRun(TRACKED)).toBe(RUN);
    expect(pollerLock({ schema: "dbo", table: "listings" })).toBe("facetdb:ct:dbo.listings");
    expect(pollerLock({ schema: "s".repeat(128), table: "t".repeat(128) })).toMatch(
      /^facetdb:ct:[0-9a-f]{64}$/,
    );
  });

  it("polls only while its session holds the poller's lock, says once which it does, and takes over when the lock comes free", async () => {
    const db = new Tracked();
    db.polls = false;
    db.changes = ["1"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    const connector = await db.connector();
    await connector.tracked?.poll();
    await connector.tracked?.poll();
    expect(db.statementsLike(VERSIONS)).toEqual([]);
    expect(db.queued()).toEqual([]);
    expect(connector.tracked?.polling()).toBe(false);
    // The lock is asked for on a session of its own, the same every tick.
    const locks = db.statementsLike(POLLER_LOCK);
    expect(locks.map((statement) => statement.params)).toEqual([
      ["facetdb:ct:dbo.listings"],
      ["facetdb:ct:dbo.listings"],
    ]);
    db.polls = true;
    await connector.tracked?.poll();
    expect(db.queued()).toHaveLength(1);
    expect(connector.tracked?.polling()).toBe(true);
    expect(db.notes).toEqual([
      "listings: claiming only: another worker polls Change Tracking for dbo.listings; this one takes over if it stops",
      "listings: this worker takes over polling Change Tracking for dbo.listings: the worker that polled it stopped",
    ]);
  });

  it("clears a claim only at its first sight of a change: a re-read of the same changes, its version held back, never clears one again", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    db.changes = ["1", "2"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    db.rows.set("2", { title: "Car", description: "Blue", hash: null });
    db.held = 1;
    db.versionOf.set("1", "9");
    db.versionOf.set("2", "9");
    const connector = await db.connector();
    await connector.tracked?.poll();
    await connector.tracked?.poll();
    // Key 1 was held the first time (so not seen), key 2 was queued and its claim cleared.
    const [first, second] = db.queued();
    expect(first).toEqual([
      "[dbo].[listings]",
      "1",
      db.hashOf("1"),
      true,
      "2",
      db.hashOf("2"),
      true,
    ]);
    expect(second).toEqual([
      "[dbo].[listings]",
      "1",
      db.hashOf("1"),
      true,
      "2",
      db.hashOf("2"),
      false,
    ]);
    // A version moved by a write of FacetDB's own columns (the poll's pending update) is no new
    // sight; a new state of key 2 is, and its claim is cleared again.
    db.versionOf.set("2", "10");
    await connector.tracked?.poll();
    expect(db.queued()[2]?.[6]).toBe(false);
    db.held = 0;
    db.rows.set("2", { title: "Car", description: "Green", hash: null });
    await connector.tracked?.poll();
    expect(db.queued()[3]?.[5]).toBe(db.hashOf("2"));
    expect(db.queued()[3]?.[6]).toBe(true);
  });
});

/** As tedious reports a connection the server ended (`kill`): the driver's code, no server number. */
function socketLost(): Error {
  return Object.assign(new Error("Connection lost - socket hang up"), { code: "ESOCKET" });
}

/** `count` changed rows, keys 1 to `count`, none answered yet: more than one queuing chunk past 500. */
function manyChanges(db: Tracked, count: number): readonly string[] {
  const keys = Array.from({ length: count }, (_, index) => String(index + 1));
  db.changes = keys;
  for (const key of keys) {
    db.rows.set(key, { title: `Listing ${key}`, description: "d", hash: null });
  }
  return keys;
}

/** Whether each key of a queuing statement's parameters may have its claim cleared, in order. */
function clears(params: readonly unknown[] | undefined): readonly unknown[] {
  return (params ?? []).filter((_, index) => index > 0 && index % 3 === 0);
}

// The pass runs on the pool while the lock lives on a session of its own.
describe("the poller's lock through a pass", () => {
  const CLAIMING =
    "listings: claiming only: another worker polls Change Tracking for dbo.listings; this one takes over if it stops";
  const POLLS = "listings: this worker polls Change Tracking for dbo.listings";
  const AGAIN =
    "listings: this worker polls Change Tracking for dbo.listings again: it took its lock back";

  it("checks the lock on its session right before each queuing transaction, the reconcile's too", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    manyChanges(db, 600);
    const connector = await db.connector();
    await connector.tracked?.poll();
    const order = db.client.statements
      .map((statement) => statement.text)
      .filter((text) => text === POLLER_LOCK_HELD || text.startsWith(QUEUE))
      .map((text) => (text === POLLER_LOCK_HELD ? "check" : "queue"));
    expect(order).toEqual(["check", "queue", "check", "queue"]);
    expect(db.statementsLike(POLLER_LOCK_HELD)[0]?.params).toEqual(["facetdb:ct:dbo.listings"]);
    // The reconcile queues through the same door.
    const lost = new Tracked();
    lost.cursors.saved.set(RUN, { cursor: "not a version", done: false });
    lost.rows.set("1", { title: "Bike", description: "Red", hash: null });
    await (await lost.connector()).tracked?.poll();
    expect(lost.statementsLike(POLLER_LOCK_HELD)).toHaveLength(1);
    expect(lost.queued()).toHaveLength(1);
  });

  it("stops queuing when the lock is gone in the middle of a pass, says so, stores nothing, and takes the lock back later", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    manyChanges(db, 600);
    // The first chunk's check finds the lock, the second's does not.
    db.checks = [true, false];
    const connector = await db.connector();
    await expect(connector.tracked?.poll()).resolves.toBeUndefined();
    expect(db.queued()).toHaveLength(1);
    expect(clears(db.queued()[0])).toHaveLength(500);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "8", done: false });
    expect(connector.tracked?.polling()).toBe(false);
    expect(db.notes).toEqual([
      POLLS,
      "listings: this worker stopped queuing the changes of dbo.listings in the middle of a pass: its session no longer holds the lock on polling Change Tracking, and another worker may poll now; what it queued stays, its version is not stored, and it asks for the lock again at the next tick",
    ]);

    // Another worker holds it at the next tick; then it comes free and this one polls again, from
    // the stored version, every change read again (at least once).
    db.polls = false;
    await connector.tracked?.poll();
    expect(db.queued()).toHaveLength(1);
    db.polls = true;
    await connector.tracked?.poll();
    expect(connector.tracked?.polling()).toBe(true);
    expect(db.statementsLike(CHANGES).map((statement) => statement.params[0])).toEqual(["8", "8"]);
    expect(db.queued()).toHaveLength(3);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
    // Another worker held the lock in between, so this one takes over from it.
    expect(db.notes.slice(2)).toEqual([
      CLAIMING,
      "listings: this worker takes over polling Change Tracking for dbo.listings: the worker that polled it stopped",
    ]);
  });

  it("remembers each committed chunk as seen: a later chunk's lost deadlock leaves the first chunk's claims alone at the next tick", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    manyChanges(db, 600);
    db.failQueue = serverError("Transaction was deadlocked on lock resources", 1205);
    db.failQueueSkip = 1;
    const connector = await db.connector();
    await expect(connector.tracked?.poll()).resolves.toBeUndefined();
    expect(db.client.transactions.get(1)).toBe("committed");
    expect(db.client.transactions.get(2)).toBe("rolled back");
    await connector.tracked?.poll();
    const [, , again, rest] = db.queued();
    // The first 500 were queued and their claims cleared at the first pass: never again.
    expect(new Set(clears(again))).toEqual(new Set([false]));
    expect(clears(again)).toHaveLength(500);
    // The 100 the deadlock rolled back are a first sight still.
    expect(new Set(clears(rest))).toEqual(new Set([true]));
    expect(clears(rest)).toHaveLength(100);
    expect(db.cursors.saved.get(RUN)).toEqual({ cursor: "10", done: false });
  });

  it("reads a lock connection the server dropped as not held for that tick, then takes the lock again on a new one, the watch going on", async () => {
    const db = new Tracked();
    db.changes = ["1"];
    db.rows.set("1", { title: "Bike", description: "Red", hash: null });
    const connector = await db.connector();
    await connector.tracked?.poll();
    expect(db.queued()).toHaveLength(1);

    db.lockFails = { on: "take", error: socketLost() };
    db.rows.set("1", { title: "Bike", description: "Blue", hash: null });
    db.now = "11";
    const reads = db.statementsLike(VERSIONS).length;
    await expect(connector.tracked?.poll()).resolves.toBeUndefined();
    expect(connector.tracked?.polling()).toBe(false);
    expect(db.statementsLike(VERSIONS)).toHaveLength(reads);

    await connector.tracked?.poll();
    expect(connector.tracked?.polling()).toBe(true);
    expect(db.queued()).toHaveLength(2);
    expect(db.notes).toEqual([
      POLLS,
      "listings: the connection that held this worker's lock on polling Change Tracking for dbo.listings was lost (Connection lost - socket hang up); this worker claims only for this tick and asks for the lock again on a new connection at the next",
      AGAIN,
    ]);
  });

  it("stops a pass whose lock connection was dropped in its middle, and ends the watch on a server's error from the lock's statement", async () => {
    const db = new Tracked();
    db.cursors.saved.set(RUN, { cursor: "8", done: false });
    manyChanges(db, 600);
    // The lock was taken at the tick's start; its connection is gone by the first chunk's check.
    db.lockFails = { on: "check", error: socketLost() };
    const connector = await db.connector();
    await expect(connector.tracked?.poll()).resolves.toBeUndefined();
    expect(db.queued()).toHaveLength(0);
    expect(connector.tracked?.polling()).toBe(false);
    expect(db.notes.at(-1)).toBe(
      "listings: this worker stopped queuing the changes of dbo.listings in the middle of a pass: the connection that held its lock on polling Change Tracking was lost (Connection lost - socket hang up), and another worker may poll now; what it queued stays, its version is not stored, and it asks for the lock again at the next tick",
    );

    const denied = new Tracked();
    denied.lockFails = {
      on: "take",
      error: serverError("The EXECUTE permission was denied on the object 'sp_getapplock'.", 229),
    };
    await expect((await denied.connector()).tracked?.poll()).rejects.toThrow(
      "The EXECUTE permission was denied",
    );
  });

  // What the lock session's error means decides between "not held" and the end.
  it("reads the socket-class errors as a dropped connection, and ends the watch in words on a refused login", async () => {
    for (const code of ["ESOCKET", "ECONNRESET", "ETIMEOUT"]) {
      const db = new Tracked();
      db.lockFails = {
        on: "take",
        error: Object.assign(new Error(`the driver said ${code}`), { code }),
      };
      const connector = await db.connector();
      await expect(connector.tracked?.poll()).resolves.toBeUndefined();
      expect(connector.tracked?.polling()).toBe(false);
      expect(db.notes.at(-1)).toContain(`was lost (the driver said ${code})`);
      await connector.tracked?.poll();
      expect(connector.tracked?.polling()).toBe(true);
    }
    // A disabled login or a changed password, met on the reconnect: every tick would meet it.
    const db = new Tracked();
    db.lockFails = {
      on: "take",
      error: Object.assign(new Error("Login failed for user 'facetdb_worker'."), {
        code: "ELOGIN",
      }),
    };
    const connector = await db.connector();
    await expect(connector.tracked?.poll()).rejects.toThrow(
      "listings: the worker login could not log in again on the connection that holds the lock on polling Change Tracking for dbo.listings (Login failed for user 'facetdb_worker'.); the login may be disabled or its password changed: check the login and the password in LISTINGS_URL, then start the worker again",
    );
    expect(db.notes.some((line) => line.includes("was lost"))).toBe(false);
  });

  it("reads a server error of severity 20 or above as a dropped connection, one below it as the end of the watch", async () => {
    // A kill while the lock's statement runs: 596, severity 21, among the server's errors for the
    // statement, which tedious hands over as one AggregateError (serverFailure keeps the severity).
    const killed = new Tracked();
    killed.cursors.saved.set(RUN, { cursor: "8", done: false });
    manyChanges(killed, 600);
    killed.lockFails = {
      on: "check",
      error: new AggregateError([
        Object.assign(
          serverError(
            "Cannot continue the execution because the session is in the kill state.",
            596,
          ),
          { class: 21, code: "EREQUEST" },
        ),
        Object.assign(serverError("A severe error occurred on the current command.", 0), {
          class: 11,
          code: "EREQUEST",
        }),
      ]),
    };
    const connector = await killed.connector();
    await expect(connector.tracked?.poll()).resolves.toBeUndefined();
    expect(killed.queued()).toHaveLength(0);
    expect(killed.notes.at(-1)).toContain(
      "the connection that held its lock on polling Change Tracking was lost (Cannot continue the execution because the session is in the kill state. A severe error occurred on the current command.)",
    );
    await connector.tracked?.poll();
    expect(connector.tracked?.polling()).toBe(true);
    expect(killed.queued()).toHaveLength(2);

    const refused = new Tracked();
    refused.lockFails = {
      on: "take",
      error: Object.assign(
        serverError("The EXECUTE permission was denied on the object 'sp_getapplock'.", 229),
        { class: 14, code: "EREQUEST" },
      ),
    };
    await expect((await refused.connector()).tracked?.poll()).rejects.toThrow(
      "The EXECUTE permission was denied",
    );
  });
});
