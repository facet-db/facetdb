import type {
  EnginePlan,
  EngineTarget,
  PlanResult,
  Refusal,
  UninstallOptions,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  type RecordingScript,
  recordingClient,
  serverError,
  serverErrors,
} from "../testing/index.ts";
import {
  answer,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  SQL_SERVER,
  typed,
  type World,
} from "./catalog-world.ts";
import { createInstaller } from "./installer.ts";
import { render } from "./render.ts";
import { WORKER_KEPT } from "./uninstall.ts";

/**
 * The SQL Server uninstall on a recording client: what install added to one table goes in one
 * transaction, trigger first, FacetDB's marked columns only, then the table's jobs; the database's
 * queue goes once no FacetDB trigger writes to it and it holds no job, the marker table once no
 * table is installed; the worker always stays, with why; the project's name is typed back. With
 * `--purge` on a table uninstalled earlier, the plan only checks the source's side and asks the
 * source's name back.
 */

const ADMIN = "mssql://admin:an-admin-password@db.example.com:1433/listings";

const options: UninstallOptions = {
  clock: new FakeClock(0),
  allowInsecure: false,
  storeShared: false,
  purge: false,
  alsoUninstalling: [],
};

/** The orders table of the same project, installed beside the listings. */
const ORDERS: EngineTarget = { ...LISTINGS, source: "orders", table: "orders" };

/** Both tables installed in dbo, sharing the queue and the marker. */
function twoTables(): World {
  const fresh = freshWorld(SQL_SERVER);
  const withOrders: World = {
    ...fresh,
    tables: { ...fresh.tables, "dbo.orders": { columns: LISTINGS_COLUMNS, key: ["id"] } },
  };
  return installedWorld(ORDERS, installedWorld(LISTINGS, withOrders));
}

async function planned(
  world: World,
  target: EngineTarget = LISTINGS,
  more: Partial<UninstallOptions> = {},
  url: string = ADMIN,
) {
  const client = recordingClient({ answer: answer(world) });
  const result = await createInstaller({ connect: client.connect }).planUninstall(target, url, {
    ...options,
    ...more,
  });
  return { result, client };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf(result: PlanResult): Refusal {
  if (result.ok) {
    throw new Error("planned, not refused");
  }
  return result.refusal;
}

/**
 * The uninstall of the installed listings example, statement by statement, as printed and as run
 * (the script's frame and the hand-run guard between them are install.test.ts's to prove).
 */
const LISTINGS_UNINSTALL: readonly string[] = [
  "set lock_timeout 10000",
  "drop trigger if exists [dbo].[facetdb_listings]",
  // The worker's reads of the columns that stay; its rights on FacetDB's columns go with them.
  "if database_principal_id(N'facetdb_worker') is not null\n  revoke select ([id], [title], [description]) on [dbo].[listings] from [facetdb_worker]",
  "alter table [dbo].[listings] drop column if exists [is_scam]",
  "alter table [dbo].[listings] drop column if exists [is_scam_probability]",
  "alter table [dbo].[listings] drop column if exists [facetdb_status]",
  "alter table [dbo].[listings] drop column if exists [facetdb_updated_at]",
  "alter table [dbo].[listings] drop column if exists [facetdb_reviewed]",
  `if object_id(N'[dbo].[facetdb_jobs]', N'U') is not null
  delete from [dbo].[facetdb_jobs] where [table_name] = N'[dbo].[listings]'`,
  `if object_id(N'[dbo].[facetdb_jobs]', N'U') is not null
begin
  if not exists (select 1 from sys.triggers t join sys.sql_modules m on m.object_id = t.object_id
                  where t.parent_class = 1 and t.name like N'facetdb[_]%'
                    and charindex(N'facetdb_jobs', m.definition) > 0)
     and not exists (select 1 from [dbo].[facetdb_jobs])
    drop table [dbo].[facetdb_jobs];
end`,
  `if object_id(N'[dbo].[facetdb_table_owners]', N'U') is not null
  delete from [dbo].[facetdb_table_owners] where [table_schema] = N'dbo' and [table_name] = N'listings'`,
  `if object_id(N'[dbo].[facetdb_table_owners]', N'U') is not null
begin
  if not exists (select 1 from [dbo].[facetdb_table_owners])
    drop table [dbo].[facetdb_table_owners];
end`,
];

describe("uninstall", () => {
  it("removes what install added, trigger first, in one transaction, and keeps the worker with why", async () => {
    const plan = planOf((await planned(installedWorld())).result);
    expect(plan.statements.map((statement) => statement.text)).toEqual(LISTINGS_UNINSTALL);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "capture",
      "grants",
      ...["columns", "columns", "columns", "columns", "columns"],
      "data",
      "cleanup",
      "marker",
      "cleanup",
    ]);
    const script = render(plan);
    for (const text of LISTINGS_UNINSTALL) {
      expect(script).toContain(`${text};\ngo\n`);
    }
    expect(plan.transactional).toBe(true);
    expect(new Set(plan.statements.map((statement) => statement.database))).toEqual(
      new Set(["source"]),
    );
    expect(plan.statements.some((statement) => statement.secret === true)).toBe(false);
    const own = { of: "dbo.listings", scope: "source" } as const;
    expect(plan.removes).toEqual([
      { kind: "trigger", name: "facetdb_listings", ...own },
      { kind: "grant", name: "facetdb_worker", ...own },
      ...[
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ].map((name) => ({ kind: "column", name, ...own })),
      { kind: "jobs-table", name: "dbo.facetdb_jobs", ...own, count: 0 },
      { kind: "marker", name: "dbo.facetdb_table_owners", ...own },
      {
        kind: "jobs-table",
        name: "dbo.facetdb_jobs",
        scope: "run",
        reason: "no trigger uses it any more",
      },
      { kind: "marker", name: "dbo.facetdb_table_owners", scope: "run", reason: "now empty" },
    ]);
    expect(plan.keeps).toEqual([
      { kind: "login", name: "facetdb_worker", scope: "run", reason: WORKER_KEPT },
    ]);
    expect(WORKER_KEPT).toBe(
      "uninstall never drops it: every project in this database may share it",
    );
    expect(plan.notes).toEqual([]);
  });

  it("asks for the name of the project that installed the table, typed back before anything runs", async () => {
    const other = installedWorld({ ...LISTINGS, project: { id: "proj_b", name: "Bee" } });
    expect(planOf((await planned(installedWorld())).result).confirm).toEqual({
      kind: "project",
      name: "Listings",
    });
    expect(planOf((await planned(other)).result).confirm).toEqual({ kind: "project", name: "Bee" });
  });

  it("drops FacetDB's marked columns only, a removed question's included, never one of the application's", async () => {
    const world = installedWorld();
    const table = world.tables["dbo.listings"];
    const withMore: World = {
      ...world,
      tables: {
        ...world.tables,
        "dbo.listings": {
          key: ["id"],
          columns: [
            ...(table?.columns ?? []),
            typed("notes", "nvarchar(max)"),
            typed("old_question", "bit", { marked: true }),
          ],
        },
      },
    };
    const plan = planOf((await planned(withMore)).result);
    const dropped = plan.statements
      .filter((statement) => statement.purpose === "columns")
      .map((statement) => /drop column if exists \[(.*)\]$/.exec(statement.text)?.[1]);
    expect(dropped).toEqual([
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
      "old_question",
    ]);
    expect(render(plan)).not.toContain("[notes]");
  });

  it("counts the table's queued jobs it deletes", async () => {
    const plan = planOf(
      (await planned({ ...installedWorld(), queued: { "[dbo].[listings]": 3 } })).result,
    );
    expect(plan.removes).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      of: "dbo.listings",
      scope: "source",
      count: 3,
    });
    expect(plan.removes).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      scope: "run",
      reason: "no trigger uses it any more",
    });
  });

  it("keeps the queue while another FacetDB trigger writes to it, or another table's jobs are in it", async () => {
    const world = twoTables();
    const alone = planOf((await planned(world)).result);
    expect(alone.keeps).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      scope: "run",
      reason: "a trigger on dbo.orders still uses it",
    });
    expect(alone.removes).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      of: "dbo.listings",
      scope: "source",
      count: 0,
    });
    expect(alone.removes.some((object) => object.scope === "run")).toBe(false);
    // The statement checks again at run time, so it never drops a queue a trigger writes to.
    expect(render(alone)).toContain("charindex(N'facetdb_jobs', m.definition) > 0)");
    const leftJobs: World = {
      ...installedWorld(),
      queued: { "[dbo].[listings]": 1, "[dbo].[orders]": 2 },
    };
    expect(planOf((await planned(leftJobs)).result).keeps).toContainEqual({
      kind: "jobs-table",
      name: "dbo.facetdb_jobs",
      scope: "run",
      count: 2,
      reason: "it holds 2 queued jobs of other tables",
    });
  });

  it("keeps the marker table and the queue while another table is installed, and the run's last table drops them", async () => {
    const world = twoTables();
    const alone = planOf((await planned(world)).result);
    expect(alone.keeps).toContainEqual({
      kind: "marker",
      name: "dbo.facetdb_table_owners",
      scope: "run",
      reason: "dbo.orders is still installed",
    });
    const both = planOf((await planned(world, LISTINGS, { alsoUninstalling: [ORDERS] })).result);
    expect(both.removes.filter((object) => object.scope === "run")).toEqual([
      {
        kind: "jobs-table",
        name: "dbo.facetdb_jobs",
        scope: "run",
        reason: "no trigger uses it any more",
      },
      { kind: "marker", name: "dbo.facetdb_table_owners", scope: "run", reason: "now empty" },
    ]);
    // The other table only changes the words: the statements are the same.
    expect(both.statements).toEqual(alone.statements);
  });

  it("refuses a table FacetDB is not installed on, and one that does not exist", async () => {
    expect(refusalOf((await planned(freshWorld())).result)).toEqual({
      code: "not-installed",
      message:
        "FacetDB is not installed on dbo.listings (dbo.facetdb_table_owners has no row for it)",
      fix: "run facetdb migrate first, or check the source's table and schema in facetdb.config.ts",
    });
    const gone: World = { ...installedWorld(), tables: {} };
    expect(refusalOf((await planned(gone)).result)).toMatchObject({
      code: "not-installed",
      message: "dbo.listings does not exist; there is nothing of FacetDB's on it to remove",
    });
  });

  it("refuses a plaintext admin connection string before connecting", async () => {
    const { result, client } = await planned(
      installedWorld(),
      LISTINGS,
      {},
      "mssql://admin:pw@db.example.com/app?encrypt=false",
    );
    expect(refusalOf(result).code).toBe("admin-url-tls");
    expect(client.connected).toEqual([]);
  });
});

describe("uninstall --purge", () => {
  it("of an installed table is the same plan: the store's door deletes the log after the run", async () => {
    const plain = planOf((await planned(installedWorld())).result);
    const purge = planOf((await planned(installedWorld(), LISTINGS, { purge: true })).result);
    expect(purge).toEqual(plain);
  });

  it("of a table uninstalled earlier only checks the source's side, and asks the source's name back", async () => {
    const plan = planOf((await planned(freshWorld(), LISTINGS, { purge: true })).result);
    expect(plan).toEqual({
      statements: [
        {
          database: "source",
          purpose: "marker",
          text: `if object_id(N'[dbo].[facetdb_listings]', N'TR') is not null
  throw 51000, N'FacetDB: the decision log of source "listings" is live again: dbo.listings has a FacetDB trigger; nothing was changed', 1;
if object_id(N'[dbo].[facetdb_table_owners]', N'U') is not null
begin
  if exists (select 1 from [dbo].[facetdb_table_owners] with (updlock, holdlock) where [project_id] = N'proj_listings')
    throw 51000, N'FacetDB: the decision log of source "listings" is live again: a table of project proj_listings is now installed; nothing was changed', 1;
end`,
        },
      ],
      transactional: true,
      removes: [],
      keeps: [{ kind: "login", name: "facetdb_worker", scope: "run", reason: WORKER_KEPT }],
      notes: ["dbo.listings has no FacetDB install left; only the decision log is purged."],
      confirm: { kind: "source", name: "listings" },
    });
  });

  it("refuses a log-only purge while another table of the project is installed, which may be the source's now", async () => {
    const world = installedWorld(ORDERS, {
      ...freshWorld(),
      tables: { "dbo.orders": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    });
    expect(refusalOf((await planned(world, LISTINGS, { purge: true })).result)).toMatchObject({
      code: "uninstall-refused",
      message:
        'the decision log of source "listings" may be shared with dbo.orders (project proj_listings), which is still installed; uninstall that table first, or keep the log. Nothing was changed.',
    });
  });

  it("takes a table with FacetDB's columns left but no marker row for an install, not for a log-only purge", async () => {
    const unmarked: World = { ...installedWorld(), marker: [] };
    expect(refusalOf((await planned(unmarked, LISTINGS, { purge: true })).result).code).toBe(
      "not-installed",
    );
  });
});

describe("uninstall's run", () => {
  async function run(plan: EnginePlan, script: RecordingScript = {}) {
    const client = recordingClient(script);
    const result = await createInstaller({ connect: client.connect }).run(LISTINGS, plan, ADMIN, {
      clock: new FakeClock(0),
      allowInsecure: false,
      storeShared: false,
    });
    return { result, client };
  }

  /** The shared tables' existence, as the run's last check reads it. */
  const gone = (queue: boolean, marker: boolean): RecordingScript => ({
    answer: (text) =>
      text.startsWith("select object_id(")
        ? [{ queue: queue ? null : 1117, marker: marker ? null : 1118 }]
        : undefined,
  });

  it("reports the run-scoped removes only when it was the run's last, from inside its transaction", async () => {
    const plan = planOf((await planned(installedWorld())).result);
    const last = await run(plan, gone(true, true));
    expect(last.result).toEqual({ ran: plan.statements, removed: plan.removes, notes: [] });
    expect(last.client.statements.at(-1)).toMatchObject({
      text: "select object_id(N'[dbo].[facetdb_jobs]', N'U') as queue, object_id(N'[dbo].[facetdb_table_owners]', N'U') as marker",
      transaction: 1,
    });
    const source = plan.removes.filter((object) => object.scope === "source");
    for (const [queue, marker] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const first = await run(plan, gone(queue, marker));
      expect(first.result.removed).toEqual(source);
      expect(first.client.transactions.get(1)).toBe("committed");
    }
  });

  it("says a log-only purge's note in the past once it ran", async () => {
    const plan = planOf((await planned(freshWorld(), LISTINGS, { purge: true })).result);
    const { result } = await run(plan);
    expect(result.notes).toEqual([
      "dbo.listings has no FacetDB install left; only the decision log was purged.",
    ]);
  });

  it("stops with uninstall-refused when a log-only purge's re-check finds the source live again", async () => {
    const plan = planOf((await planned(freshWorld(), LISTINGS, { purge: true })).result);
    const message =
      'FacetDB: the decision log of source "listings" is live again: dbo.listings has a FacetDB trigger; nothing was changed';
    const { result, client } = await run(plan, { fail: () => serverError(message, 51000) });
    expect(result).toEqual({
      ran: [],
      stopped: {
        at: 0,
        refusal: {
          code: "uninstall-refused",
          message: message.slice("FacetDB: ".length),
          fix: "check what the message says, then run facetdb uninstall again",
        },
      },
      removed: [],
      notes: [],
    });
    expect(client.transactions.get(1)).toBe("rolled back");
  });

  it("rolls everything back when a drop fails, and says every error the server gave for it", async () => {
    const plan = planOf((await planned(installedWorld())).result);
    const at = plan.statements.findIndex((statement) =>
      statement.text.includes("drop column if exists [facetdb_status]"),
    );
    // An index of the application's on the column: SQL Server answers with two errors, which
    // tedious hands over as one AggregateError with no message and no number of its own.
    const { result, client } = await run(plan, {
      fail: (text) =>
        text.includes("drop column if exists [facetdb_status]")
          ? serverErrors(
              {
                message: "The index 'ix_listings_status' is dependent on column 'facetdb_status'.",
                number: 5074,
              },
              {
                message:
                  "ALTER TABLE DROP COLUMN facetdb_status failed because one or more objects access this column.",
                number: 4922,
              },
            )
          : undefined,
    });
    expect(result).toEqual({
      ran: [],
      stopped: {
        at,
        error:
          "The index 'ix_listings_status' is dependent on column 'facetdb_status'. ALTER TABLE DROP COLUMN facetdb_status failed because one or more objects access this column.",
      },
      removed: [],
      notes: [],
    });
    expect(client.transactions.get(1)).toBe("rolled back");
  });

  it("takes back the worker's read of created_at too, which install gave it for scan", async () => {
    const fresh = freshWorld(SQL_SERVER);
    const world = installedWorld(LISTINGS, {
      ...fresh,
      tables: {
        "dbo.listings": {
          columns: [...LISTINGS_COLUMNS, typed("created_at", "datetime2(7)")],
          key: ["id"],
        },
      },
    });
    const plan = planOf((await planned(world)).result);
    expect(plan.statements.map((statement) => statement.text)).toContain(
      "if database_principal_id(N'facetdb_worker') is not null\n  revoke select ([id], [title], [description], [created_at]) on [dbo].[listings] from [facetdb_worker]",
    );
  });
});
