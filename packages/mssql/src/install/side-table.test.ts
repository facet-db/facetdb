import { readFile, writeFile } from "node:fs/promises";
import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  RecordDecision,
  Refusal,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createMssqlConnector, MSSQL_CAPABILITIES } from "../connector/index.ts";
import {
  AZURE_SQL,
  answer,
  everyType,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  listings,
  recordingClient,
  SQL_SERVER,
  typed,
  type World,
  type WorldColumn,
} from "../testing/index.ts";
import { createInstaller } from "./installer.ts";
import { ownedColumns } from "./objects.ts";
import { ONE_TRANSACTION, render } from "./render.ts";
import { sameView } from "./side-table.ts";

/**
 * Side-table mode on SQL Server on a recording client, no server: the listings example with
 * `storage: "side-table"` renders the committed fixture install.listings.side-table.sql byte for
 * byte (on Azure SQL, as install.listings.sql), and the table gains no column; the trigger writes
 * the side row's status, never the table; the worker reads the key and the state on the table and
 * writes the side table alone; a second plan is empty; what side-table mode refuses; uninstall and
 * prune; the connector's SQL in this mode. A real server runs the same plans and the contract suite
 * in ../connector/side-table.db.test.ts.
 */

const FIXTURE = new URL("./install.listings.side-table.sql", import.meta.url);
const ADMIN = "mssql://admin:an-admin-password@db.example.com:1433/listings";
const PASSWORD = "a-long-random-pass'word";

const deps: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: false };
const withPassword: InstallOptions = { ...deps, workerPassword: PASSWORD };

/** The listings example in side-table mode. */
const SIDE: EngineTarget = { ...LISTINGS, storage: "side-table" };

const SIDE_TABLE = "[dbo].[facetdb_listings_answers]";
const VIEW = "[dbo].[listings_with_answers]";

/** What the fixture's plan tells the operator besides the script. */
const FIXTURE_NOTES = [
  `dbo.listings now has a trigger, facetdb_listings: an application statement on the table with an OUTPUT clause and no INTO fails (error 334), as Entity Framework Core 7 and later write by default; declare the trigger to EF Core (HasTrigger("facetdb_listings") on the table's entity), or, once FacetDB offers it, watch the table with Change Tracking instead of a trigger`,
  "dbo.listings gains no column: its answers go in dbo.facetdb_listings_answers, whose foreign key references dbo.listings, so deleting a row there deletes its answers; until facetdb uninstall removes dbo.facetdb_listings_answers, SQL Server refuses truncate table dbo.listings (error 4712), dropping the table (error 3726), switching a partition in or out of it (error 4967) and changing its primary key, such as an int key made bigint (error 3725), and so an ORM migration that rebuilds the table (drops it and creates it again, as Prisma does for some changes) fails; uninstall before such a migration, then run facetdb migrate again",
  "read the answers through the view dbo.listings_with_answers (every column of dbo.listings, then FacetDB's): a login granted select on the view alone reads it while the view, dbo.listings and dbo.facetdb_listings_answers share an owner, as they do when the table has none of its own; if dbo.listings was given an owner other than its schema's, a reader also needs select on dbo.listings; a record without an answer yet reads facetdb_status 'pending'",
];

async function planned(
  world: World,
  target: EngineTarget = SIDE,
  options: InstallOptions = withPassword,
) {
  const client = recordingClient({ answer: answer(world) });
  const installer = createInstaller({ connect: client.connect });
  const result = await installer.planInstall(target, ADMIN, options);
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

async function fixturePlan(): Promise<EnginePlan> {
  return planOf((await planned(freshWorld(AZURE_SQL))).result);
}

/** The text of the plan's statement that starts with `start`. */
function textOf(plan: EnginePlan, start: string): string {
  const found = plan.statements.find((statement) => statement.text.startsWith(start));
  if (found === undefined) {
    throw new Error(`no statement starts with ${start}`);
  }
  return found.text;
}

/** The listings database with the table's columns replaced. */
function withColumns(columns: readonly WorldColumn[], key: readonly string[] = ["id"]): World {
  return { ...freshWorld(AZURE_SQL), tables: { "dbo.listings": { columns, key } } };
}

describe("the listings example in side-table mode", () => {
  it("renders byte for byte as the committed fixture install.listings.side-table.sql", async () => {
    const sql = render(await fixturePlan());
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
    expect(sql.split("\n")[0]).toBe(ONE_TRANSACTION);
  });

  it("adds no column to the table: nothing alters it, and its columns are FacetDB's side table's", async () => {
    const plan = await fixturePlan();
    for (const { text } of plan.statements) {
      expect(text).not.toMatch(/alter table \[dbo\]\.\[listings\] /);
      expect(text).not.toContain(
        "sp_addextendedproperty @name = N'facetdb', @value = N'facetdb',\n    @level0type = N'SCHEMA', @level0name = N'dbo',\n    @level1type = N'TABLE', @level1name = N'listings'",
      );
    }
    const side = textOf(plan, `if object_id(N'${SIDE_TABLE}', N'U') is null`);
    for (const column of ownedColumns(listings)) {
      expect(side).toContain(`[${column.name}] ${column.type} null,`);
    }
    // Both keys are named under FacetDB's prefix, as every object it adds.
    expect(side).toContain(
      "[id] int not null constraint [facetdb_listings_answers_pkey] primary key,",
    );
    expect(side).toContain(
      "constraint [facetdb_listings_answers_fkey] foreign key ([id]) references [dbo].[listings] ([id])\n      on delete cascade on update cascade",
    );
    expect(side).toContain("@level1type = N'TABLE', @level1name = N'facetdb_listings_answers'");
  });

  it("runs as one transaction in install order: the side table, the view and its mark, the queue, the trigger, the worker, the grants", async () => {
    const plan = await fixturePlan();
    expect(plan).toMatchObject({
      transactional: true,
      removes: [],
      keeps: [],
      notes: FIXTURE_NOTES,
    });
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      ...["columns", "columns", "columns"],
      "queue",
      ...["capture", "capture"],
      "login",
      ...["grants", "grants", "grants", "grants"],
    ]);
    // `create or alter view` begins its own batch, the guard before it a batch apart.
    expect(render(plan)).toContain(`set noexec on;\ngo\n\ncreate or alter view ${VIEW}\nas\n`);
  });

  it("makes the view of every column of the table, then FacetDB's, a record without a side row pending and not reviewed", async () => {
    const view = textOf(await fixturePlan(), "create or alter view");
    expect(view).toBe(`create or alter view ${VIEW}
as
select t.[id],
       t.[title],
       t.[description],
       a.[is_scam],
       a.[is_scam_probability],
       coalesce(a.[facetdb_status], 'pending') as [facetdb_status],
       a.[facetdb_updated_at],
       coalesce(a.[facetdb_reviewed], cast(0 as bit)) as [facetdb_reviewed]
  from [dbo].[listings] t
  left join ${SIDE_TABLE} a on a.[id] = t.[id]`);
    expect(view).not.toContain("schemabinding");
  });

  it("puts the side row back to pending, or makes one, from the trigger, and never writes the table", async () => {
    const trigger = textOf(await fixturePlan(), "create trigger");
    expect(trigger).toContain(`update a set [facetdb_status] = 'pending'
      from ${SIDE_TABLE} a
      join inserted i on i.[id] = a.[id]
     where a.[facetdb_status] is null or a.[facetdb_status] <> 'pending';`);
    expect(trigger).toContain(`insert into ${SIDE_TABLE} ([id], [facetdb_status])
    select i.[id], 'pending'
      from inserted i
     where not exists (select 1 from ${SIDE_TABLE} a with (readcommittedlock) where a.[id] = i.[id]);`);
    // Read committed whatever the application's level, before anything else is read.
    expect(trigger).toContain(
      "  set nocount on;\n  -- FacetDB's reads here run at read committed whatever the application's level; SQL Server gives\n  -- the application its own level back when the trigger returns.\n  set transaction isolation level read committed;\n  -- A statement that changed no row",
    );
    expect(trigger).not.toContain("update t ");
    expect(trigger).not.toContain("merge");
    // The capture half is inline's: the empty firing returns first, the jobs as before.
    expect(trigger).toContain("if not exists (select 1 from inserted) return;");
    expect(trigger).toContain("insert into [dbo].[facetdb_jobs] ([table_name], [record_key])");
    const keep = textOf(
      planOf((await planned(freshWorld(AZURE_SQL), { ...SIDE, onChange: "keep" })).result),
      "create trigger",
    );
    expect(keep).toContain("     where a.[facetdb_status] is null;");
  });

  it("grants the worker the key and the state of the table, select, insert and update on the side table, nothing on the view", async () => {
    const grants = (await fixturePlan()).statements
      .filter((statement) => statement.purpose === "grants")
      .map((statement) => statement.text);
    expect(grants).toEqual([
      "grant select ([id], [title], [description])\n  on [dbo].[listings] to [facetdb_worker]",
      `grant select, insert, update on ${SIDE_TABLE} to [facetdb_worker]`,
      "grant select, insert, update, delete on [dbo].[facetdb_jobs] to [facetdb_worker]",
      "grant select on [dbo].[facetdb_table_owners] to [facetdb_worker]",
    ]);
    expect(grants.join("\n")).not.toContain(VIEW);
    expect(grants.join("\n")).not.toContain("grant update ([");
  });

  it("repeats a text key's type and collation in the side table, so the foreign key takes it", async () => {
    const world = withColumns(
      [typed("code", "nvarchar(40)"), ...LISTINGS_COLUMNS.slice(1)],
      ["code"],
    );
    const side = textOf(
      planOf((await planned(world)).result),
      `if object_id(N'${SIDE_TABLE}', N'U') is null`,
    );
    expect(side).toContain(
      "[code] nvarchar(40) collate SQL_Latin1_General_CP1_CI_AS not null constraint [facetdb_listings_answers_pkey] primary key,",
    );
  });
});

describe("a second plan in side-table mode", () => {
  it("has no statement on the installed database", async () => {
    const plan = planOf((await planned(installedWorld(SIDE))).result);
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("adds a later question's columns to the side table and makes the view again with them, keeping the grants", async () => {
    const later: EngineTarget = { ...SIDE, questionSet: everyType };
    const plan = planOf((await planned(installedWorld(SIDE), later)).result);
    const added = plan.statements.filter((statement) => statement.text.startsWith("if col_length"));
    expect(added.map((statement) => statement.text)).toEqual([
      `if col_length(N'${SIDE_TABLE}', N'category') is null\n  alter table ${SIDE_TABLE} add [category] nvarchar(255) null`,
      `if col_length(N'${SIDE_TABLE}', N'category_confidence') is null\n  alter table ${SIDE_TABLE} add [category_confidence] real null`,
      `if col_length(N'${SIDE_TABLE}', N'category_probabilities') is null\n  alter table ${SIDE_TABLE} add [category_probabilities] nvarchar(max) null`,
      `if col_length(N'${SIDE_TABLE}', N'quality') is null\n  alter table ${SIDE_TABLE} add [quality] nvarchar(255) null`,
      `if col_length(N'${SIDE_TABLE}', N'quality_confidence') is null\n  alter table ${SIDE_TABLE} add [quality_confidence] real null`,
      `if col_length(N'${SIDE_TABLE}', N'quality_expected') is null\n  alter table ${SIDE_TABLE} add [quality_expected] real null`,
    ]);
    // The side table's columns as they are, then the new ones: the view lists them in that order.
    const view = textOf(plan, "create or alter view");
    expect(view).toContain(
      "a.[is_scam],\n       a.[is_scam_probability],\n       coalesce(a.[facetdb_status], 'pending') as [facetdb_status],",
    );
    expect(view).toContain("a.[quality_expected]\n  from");
    // No right is missing on the side table: the worker holds it whole.
    expect(
      plan.statements.some((statement) => statement.text.startsWith("grant select, insert")),
    ).toBe(false);
    expect(plan.notes).toEqual([]);
  });

  it("makes the view again, alone, when the application added a column to the table", async () => {
    const installed = installedWorld(SIDE);
    const table = installed.tables["dbo.listings"];
    if (table === undefined) {
      throw new Error("no listings");
    }
    const world: World = {
      ...installed,
      tables: {
        ...installed.tables,
        "dbo.listings": { ...table, columns: [...table.columns, typed("price", "int")] },
      },
    };
    const plan = planOf((await planned(world)).result);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      "columns",
    ]);
    expect(textOf(plan, "create or alter view")).toContain("t.[price],\n       a.[is_scam]");
  });

  it("reads a view's stored text as SQL Server keeps it: create or alter view comes back as create   view", () => {
    const wanted = `create or alter view ${VIEW}\nas\nselect 1`;
    expect(sameView(`create   view ${VIEW}\r\nas\r\nselect 1;`, wanted)).toBe(true);
    expect(sameView(`create view ${VIEW}\nas\nselect 2`, wanted)).toBe(false);
  });
});

describe("refusals in side-table mode", () => {
  async function refused(world: World, target: EngineTarget = SIDE): Promise<Refusal> {
    const { result, client } = await planned(world, target);
    expect(client.transactions.size).toBe(0);
    expect(client.openConnections()).toBe(0);
    return refusalOf(result);
  }

  it("refuses a table whose side table's keys would pass SQL Server's 128 characters, before connecting", async () => {
    // facetdb_<table>_answers_pkey is the longest name: 8 + 107 + 8 + 5 = 128 fits, 108 does not.
    const table = "t".repeat(108);
    const { result, client } = await planned(freshWorld(), { ...SIDE, table });
    expect(refusalOf(result)).toMatchObject({
      code: "name-length",
      message: expect.stringContaining(`facetdb_${table}_answers_pkey`),
      fix: `rename the table so that facetdb_${table}_answers is at most 123 characters, or keep storage "inline"`,
    });
    expect(client.connected).toEqual([]);
    const fits = await planned(freshWorld(), { ...SIDE, table: "t".repeat(107) });
    expect(refusalOf(fits.result).code).toBe("no-table");
  });

  it("refuses SQL Server 2016 before Service Pack 1, which has no create or alter view", async () => {
    const rtm: World = {
      ...freshWorld(SQL_SERVER),
      server: { ...SQL_SERVER, majorVersion: 13, build: 1601 },
    };
    expect(await refused(rtm)).toEqual({
      code: "server-version",
      message:
        "this server is SQL Server 2016 before Service Pack 1 (build 13.0.1601); side-table mode makes its view dbo.listings_with_answers with create or alter view, which came with Service Pack 1 (build 13.0.4001)",
      fix: 'install SQL Server 2016 Service Pack 1 or a later update on the server, or keep storage "inline" for the source in facetdb.config.ts',
    });
    const sp1: World = { ...rtm, server: { ...rtm.server, build: 4001 } };
    expect((await planned(sp1)).result.ok).toBe(true);
    // Inline mode needs no view, and installs on that server.
    expect((await planned(rtm, LISTINGS)).result.ok).toBe(true);
  });

  it("refuses a memory-optimized table: no foreign key joins it to a disk-based one", async () => {
    const fresh = freshWorld();
    const world: World = {
      ...fresh,
      tables: { "dbo.listings": { columns: LISTINGS_COLUMNS, key: ["id"], memoryOptimized: true } },
    };
    expect(await refused(world)).toMatchObject({
      code: "memory-optimized",
      message: expect.stringContaining("dbo.listings is a memory-optimized table"),
    });
  });

  it("refuses a table installed inline, and inline on a table installed in side-table mode: one copy of the answers", async () => {
    expect(await refused(installedWorld(LISTINGS))).toMatchObject({
      code: "storage-mode",
      message: expect.stringContaining(
        "dbo.listings carries FacetDB columns from an inline install (is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed)",
      ),
    });
    expect(await refused(installedWorld(SIDE), LISTINGS)).toMatchObject({
      code: "storage-mode",
      message:
        "dbo.listings is installed in side-table mode (its answers are in dbo.facetdb_listings_answers); installing inline would keep a second copy of them on the table",
    });
  });

  it("refuses a column of the table that a question would take, since the view shows both", async () => {
    const world = withColumns([...LISTINGS_COLUMNS, typed("is_scam", "bit")]);
    expect(await refused(world)).toMatchObject({
      code: "column-collision",
      message:
        "dbo.listings already has a column named is_scam that is not FacetDB's, and dbo.listings_with_answers shows the table's columns beside FacetDB's",
    });
  });

  it("refuses an object of the side table's or the view's name that FacetDB did not make", async () => {
    for (const [name, type, role] of [
      ["facetdb_listings_answers", "U", "answers table for dbo.listings"],
      ["listings_with_answers", "V", "view of dbo.listings with its answers"],
      ["listings_with_answers", "U", "view of dbo.listings with its answers"],
    ] as const) {
      const world: World = { ...freshWorld(), objects: [{ schema: "dbo", name, type }] };
      expect(await refused(world)).toEqual({
        code: "name-taken",
        message: `dbo.${name} already exists and is not FacetDB's ${role}`,
        fix: `rename that object, or keep FacetDB on another table: dbo.${name} is the name FacetDB gives its ${role}`,
      });
    }
  });

  it("refuses a question whose type changed in the side table", async () => {
    const installed = installedWorld(SIDE);
    const side = installed.tables["dbo.facetdb_listings_answers"];
    if (side === undefined) {
      throw new Error("no side table");
    }
    const world: World = {
      ...installed,
      tables: {
        ...installed.tables,
        "dbo.facetdb_listings_answers": {
          ...side,
          columns: side.columns.map((column) =>
            column.name === "is_scam" ? typed("is_scam", "nvarchar(255)") : column,
          ),
        },
      },
    };
    expect(await refused(world)).toMatchObject({
      code: "column-type",
      message: expect.stringContaining("dbo.facetdb_listings_answers: is_scam is nvarchar(255)"),
    });
  });
});

describe("uninstall and prune in side-table mode", () => {
  const uninstallOptions = { ...deps, purge: false, alsoUninstalling: [] };

  it("uninstall drops the trigger, the view, then the side table, after the project's name, and never a column of the table", async () => {
    const client = recordingClient({ answer: answer(installedWorld(SIDE)) });
    const plan = planOf(
      await createInstaller({ connect: client.connect }).planUninstall(
        SIDE,
        ADMIN,
        uninstallOptions,
      ),
    );
    const texts = plan.statements.map((statement) => statement.text);
    const at = (text: string) => texts.indexOf(text);
    expect(at("drop trigger if exists [dbo].[facetdb_listings]")).toBe(1);
    expect(at(`drop view if exists ${VIEW}`)).toBeGreaterThan(1);
    expect(at(`drop table if exists ${SIDE_TABLE}`)).toBe(at(`drop view if exists ${VIEW}`) + 1);
    expect(texts.some((text) => text.includes("drop column"))).toBe(false);
    expect(texts).toContain(
      "if database_principal_id(N'facetdb_worker') is not null\n  revoke select ([id], [title], [description]) on [dbo].[listings] from [facetdb_worker]",
    );
    expect(plan.removes.filter((object) => object.scope === "source")).toEqual([
      { kind: "trigger", name: "facetdb_listings", of: "dbo.listings", scope: "source" },
      { kind: "grant", name: "facetdb_worker", of: "dbo.listings", scope: "source" },
      { kind: "view", name: "listings_with_answers", of: "dbo.listings", scope: "source" },
      { kind: "side-table", name: "facetdb_listings_answers", of: "dbo.listings", scope: "source" },
      {
        kind: "jobs-table",
        name: "dbo.facetdb_jobs",
        of: "dbo.listings",
        scope: "source",
        count: 0,
      },
      { kind: "marker", name: "dbo.facetdb_table_owners", of: "dbo.listings", scope: "source" },
    ]);
    expect(plan.confirm).toEqual({ kind: "project", name: "Listings" });
  });

  it("uninstall leaves an unmarked view or table of those names alone", async () => {
    const installed = installedWorld(SIDE);
    const world: World = {
      ...installed,
      objects: installed.objects.map((object) => ({ ...object, marked: false })),
    };
    const client = recordingClient({ answer: answer(world) });
    const plan = planOf(
      await createInstaller({ connect: client.connect }).planUninstall(
        SIDE,
        ADMIN,
        uninstallOptions,
      ),
    );
    expect(plan.statements.some((statement) => /^drop (view|table) /.test(statement.text))).toBe(
      false,
    );
  });

  it("prune makes the view again without a removed question's columns, then drops them from the side table", async () => {
    const before: EngineTarget = { ...SIDE, questionSet: everyType };
    const client = recordingClient({ answer: answer(installedWorld(before)) });
    const plan = planOf(
      await createInstaller({ connect: client.connect }).planPrune(
        { ...before, questionSet: { ...everyType, questions: everyType.questions.slice(0, 2) } },
        ADMIN,
        deps,
      ),
    );
    expect(plan.statements.map((statement) => statement.text.split("\n")[0])).toEqual([
      "set lock_timeout 10000",
      `create or alter view ${VIEW}`,
      `alter table ${SIDE_TABLE} drop column if exists [quality]`,
      `alter table ${SIDE_TABLE} drop column if exists [quality_confidence]`,
      `alter table ${SIDE_TABLE} drop column if exists [quality_expected]`,
    ]);
    const view = textOf(plan, "create or alter view");
    expect(view).not.toContain("quality");
    expect(view).toContain("a.[category_probabilities],");
    expect(plan.removes.map((object) => [object.name, object.of])).toEqual([
      ["quality", "dbo.facetdb_listings_answers"],
      ["quality_confidence", "dbo.facetdb_listings_answers"],
      ["quality_expected", "dbo.facetdb_listings_answers"],
    ]);
  });
});

describe("the connector in side-table mode", () => {
  const URL = "mssql://facetdb_worker:secret@127.0.0.1:1433/listings";
  const decided: RecordDecision = {
    decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
    status: "done",
  };

  async function opened(rows: (text: string) => readonly Record<string, unknown>[] | undefined) {
    const catalog = answer(installedWorld(SIDE));
    const client = recordingClient({
      answer: (text, params) => rows(text) ?? catalog(text, params),
    });
    const connector = await createMssqlConnector(SIDE, URL, {
      clock: new FakeClock(Date.parse("2026-11-04T09:00:00.000Z")),
      workerId: "w1",
      connect: (url) => client.connect(url),
    });
    return { client, connector };
  }

  it("declares the side table", async () => {
    const { connector } = await opened(() => undefined);
    expect(connector.capabilities).toBe(MSSQL_CAPABILITIES);
    expect(connector.capabilities.sideTable).toBe(true);
  });

  it("reads the state from the table, and writes the side row under an update lock on the table's row, in one batch", async () => {
    const { client, connector } = await opened((text) =>
      text.startsWith("select convert(nvarchar(322), t.[id]) as k")
        ? [{ k: "7", s0: "Bike", s1: null, x: false }]
        : text.startsWith("declare @written")
          ? [{ written: 1 }]
          : undefined,
    );
    const { rows } = await connector.read(["7"]);
    expect(client.statements.at(-1)?.text).toContain("from [dbo].[listings] t where t.[id] in");
    const hash = rows[0]?.hash ?? "";
    expect(await connector.write("7", decided, hash)).toEqual({ written: true });
    const write = client.statements.at(-1);
    expect(write?.text).toBe(`declare @written table ([n] int);
begin transaction;
if exists (select 1 from [dbo].[listings] t with (readcommittedlock, updlock, rowlock) where t.[id] = try_convert(int, @p5) and convert(nvarchar(322), t.[id]) = @p5 and convert(varbinary(max), convert(nvarchar(max), t.[title])) = convert(varbinary(max), @p6) and convert(nvarchar(max), t.[description]) is null)
begin
  update a set [is_scam] = @p1, [is_scam_probability] = @p2, [facetdb_status] = @p3, [facetdb_updated_at] = convert(datetime2(3), @p4, 121) output 1 into @written ([n]) from ${SIDE_TABLE} a where a.[id] = try_convert(int, @p5);
  if @@rowcount = 0
    insert into ${SIDE_TABLE} ([id], [is_scam], [is_scam_probability], [facetdb_status], [facetdb_updated_at]) output 1 into @written ([n]) values (try_convert(int, @p5), @p1, @p2, @p3, convert(datetime2(3), @p4, 121));
end
commit transaction;
select count(*) as written from @written;`);
    expect(write?.params).toEqual([false, 0.97, "done", "2026-11-04 09:00:00.000", "7", "Bike"]);
  });

  it("reads a decision from the side table, a record without a side row absent", async () => {
    const { client, connector } = await opened((text) =>
      text.startsWith("select convert(nvarchar(322), a.[id]) as k")
        ? [{ k: "7", q0v: "0", q0p: "0.97", cs: "done", cu: "2026-11-04 09:00:00.000", cr: null }]
        : undefined,
    );
    const found = await connector.current(["7", "8"]);
    expect(client.statements.at(-1)?.text).toBe(
      `select convert(nvarchar(322), a.[id]) as k, convert(nvarchar(max), a.[is_scam]) as q0v, convert(nvarchar(max), a.[is_scam_probability]) as q0p, coalesce(a.[facetdb_status], N'pending') as cs, convert(nvarchar(30), a.[facetdb_updated_at], 121) as cu, a.[facetdb_reviewed] as cr from ${SIDE_TABLE} a where a.[id] in (try_convert(int, @p1), try_convert(int, @p2))`,
    );
    expect([...found.keys()]).toEqual(["7"]);
    expect(found.get("7")).toMatchObject({ status: "done", reviewed: false });
  });
});
