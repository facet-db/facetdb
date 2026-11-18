import { readFile, writeFile } from "node:fs/promises";
import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  PlanStatement,
  Refusal,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  AZURE_SQL,
  answer,
  CONTAINED_SQL_SERVER,
  everyType,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  listings,
  type RecordingScript,
  recordingClient,
  SQL_SERVER,
  serverError,
  typed,
  type World,
  type WorldColumn,
} from "../testing/index.ts";
import { SERVER_QUERY } from "./catalog.ts";
import { LOGIN_NOTE, REMAP_NOTE } from "./install.ts";
import { createInstaller } from "./installer.ts";
import { ownedColumns } from "./objects.ts";
import { ONE_TRANSACTION, render } from "./render.ts";

/**
 * The SQL Server install on a recording client, no server: the listings example (dbo.listings keyed
 * by id, the state columns title and description, one noul question is_scam) renders the committed
 * fixture install.listings.sql byte for byte, on Azure SQL, whose worker is a contained database
 * user. The fixture is read, never written by the test (`UPDATE_FIXTURES=1` rewrites it on purpose,
 * and the diff is reviewed). The other variant, a server without containment, is asserted against
 * the same plan: every statement equal but the worker's, which becomes a login and a user for it.
 * One fixture rather than two because the variants differ in those statements alone, and a second
 * file would have every generator change reviewed twice; the assertion pins the difference exactly.
 */

const FIXTURE = new URL("./install.listings.sql", import.meta.url);

const ADMIN = "mssql://admin:an-admin-password@db.example.com:1433/listings";
const PASSWORD = "a-long-random-pass'word";

const deps: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: false };
const withPassword: InstallOptions = { ...deps, workerPassword: PASSWORD };

/** The worker as a server login, where the database is not contained. */
const LOGIN_TEXT = `-- @p1 is the worker password from the source's connection string: facetdb migrate binds it
-- here and never prints it.
if not exists (select 1 from sys.server_principals where name = N'facetdb_worker')
begin
  declare @create nvarchar(max) = N'create login [facetdb_worker] with password = N''' + replace(@p1 collate Latin1_General_100_BIN2, N'''', N'''''') + N'''';
  exec (@create);
end`;

/** The worker's user in this database, for its login. */
const USER_FOR_LOGIN_TEXT = `if database_principal_id(N'facetdb_worker') is null
  create user [facetdb_worker] for login [facetdb_worker]`;

/** What the fixture's plan tells the operator besides the script. */
const FIXTURE_NOTES = [
  `dbo.listings now has a trigger, facetdb_listings: an application statement on the table with an OUTPUT clause and no INTO fails (error 334), as Entity Framework Core 7 and later write by default; declare the trigger to EF Core (HasTrigger("facetdb_listings") on the table's entity), or watch the table with Change Tracking instead of a trigger`,
  "dbo.listings gains 5 columns: an application insert that lists no columns (insert into dbo.listings values (…)) fails (error 213) until it names them",
  "facetdb_status starts out NULL on dbo.listings's rows (a default would rewrite every row on SQL Server Standard, so there is none, where other databases have 'pending'), and FacetDB reads NULL as pending: a query for pending rows asks for facetdb_status = 'pending' or facetdb_status is null",
];

async function planned(
  world: World,
  target: EngineTarget = LISTINGS,
  options: InstallOptions = withPassword,
  url: string = ADMIN,
) {
  const client = recordingClient({ answer: answer(world) });
  const result = await createInstaller({ connect: client.connect }).planInstall(
    target,
    url,
    options,
  );
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

/** The plan of the fixture: the listings example on Azure SQL. */
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

/** What the plan grants, statement by statement. */
function grantsOf(plan: EnginePlan): readonly string[] {
  return plan.statements
    .filter((statement) => statement.purpose === "grants")
    .map((statement) => statement.text);
}

/** The listings database with the table's columns replaced. */
function withColumns(columns: readonly WorldColumn[], key: readonly string[] = ["id"]): World {
  return { ...freshWorld(AZURE_SQL), tables: { "dbo.listings": { columns, key } } };
}

/** The listings database with a key of `column` in place of its int id. */
function keyed(column: WorldColumn): World {
  return withColumns([column, ...LISTINGS_COLUMNS.slice(1)], [column.name]);
}

describe("the listings example", () => {
  it("renders byte for byte as the committed fixture, on Azure SQL with a contained worker user", async () => {
    const sql = render(await fixturePlan());
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("says in its first line that a failed statement rolls the whole install back", async () => {
    const [first, second] = (await readFile(FIXTURE, "utf8")).split("\n");
    expect(first).toBe(ONE_TRANSACTION);
    expect(first).toContain("one transaction: if a statement fails, all of it rolls back");
    expect(second).toBe(
      "-- Run by hand (sqlcmd, SSMS), a check before each statement skips the rest once one failed; then run set noexec off.",
    );
  });

  it("guards every statement and the commit for a hand run: after a failure rolled back, nothing more runs", async () => {
    const plan = await fixturePlan();
    const sql = render(plan);
    const guard = "if @@trancount = 0 set noexec on;\ngo\n\n";
    // Each statement's batch is right after a guard batch of its own; so is the commit.
    for (const statement of plan.statements) {
      expect(sql).toContain(`${guard}${statement.text};\ngo\n`);
    }
    expect(sql.endsWith(`${guard}commit transaction;\ngo\n`)).toBe(true);
    expect(sql.split(guard).length - 1).toBe(plan.statements.length + 1);
    // `create trigger` still begins its own batch, the guard before it a batch apart.
    expect(sql).toContain("set noexec on;\ngo\n\ncreate trigger [dbo].[facetdb_listings]");
  });

  it("runs as one transaction, every statement for the source's database, in install order", async () => {
    const plan = await fixturePlan();
    expect(plan).toMatchObject({
      transactional: true,
      removes: [],
      keeps: [],
      notes: FIXTURE_NOTES,
    });
    expect(plan.confirm).toBeUndefined();
    expect(new Set(plan.statements.map((statement) => statement.database))).toEqual(
      new Set(["source"]),
    );
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      ...["columns", "columns", "columns", "columns", "columns"],
      "queue",
      ...["capture", "capture"],
      "login",
      ...["grants", "grants", "grants", "grants"],
    ]);
  });

  it("guards every statement, so the printed script run again changes nothing", async () => {
    const plan = await fixturePlan();
    for (const { text } of plan.statements) {
      const guarded =
        /^(if |-- @p1 )/.test(text) ||
        /^drop trigger if exists /.test(text) ||
        /^create trigger /.test(text) ||
        /^declare @owner /.test(text) ||
        /^(grant|set lock_timeout) /.test(text);
      expect(guarded, text).toBe(true);
    }
    expect(plan.statements.filter((s) => s.text.startsWith("if col_length(")).length).toBe(5);
  });

  it("acts on an update that sets a state column, or an insert, so the worker's own update never queues a row", async () => {
    const plan = await fixturePlan();
    const trigger = textOf(plan, "create trigger");
    expect(
      trigger,
    ).toContain(`  -- An update that sets a state column, or an insert (which sets every column): the worker's own
  -- update sets none of them.
  if update([title])
     or update([description])
  begin
`);
    // update() is tested on the state columns and on nothing else: true for every column of an
    // insert, true for a column an update's set names. No test reads deleted.
    const tested = [...trigger.matchAll(/update\(\[([^\]]+)\]\)/g)].map((match) => match[1]);
    expect(tested).toEqual(listings.read);
    expect(trigger).not.toContain("deleted");
    // The worker can update FacetDB's columns only, and none of them is a tested one.
    const writable = ownedColumns(listings).map((column) => column.name);
    expect(grantsOf(plan)).toContain(
      `grant update (${writable.map((name) => `[${name}]`).join(", ")})\n  on [dbo].[listings] to [facetdb_worker]`,
    );
    expect(tested.filter((column) => column !== undefined && writable.includes(column))).toEqual(
      [],
    );
    // Nothing is written outside that test: the body's three writes all come after it.
    const test = trigger.indexOf("if update(");
    for (const write of ["update t set", "update j set", "insert into"]) {
      expect(trigger.indexOf(write)).toBeGreaterThan(test);
    }
  });

  it("returns at once from a statement that changed no row, before any write, so an empty firing never fires it again", async () => {
    const trigger = textOf(await fixturePlan(), "create trigger");
    const body = trigger.slice(trigger.indexOf("\nbegin\n") + "\nbegin\n".length).split("\n");
    // The first statement after the two settings (set nocount on, the trigger's own read committed)
    // and their comments is the early return.
    expect(body.slice(0, 6)).toEqual([
      "  set nocount on;",
      "  -- FacetDB's reads here run at read committed whatever the application's level; SQL Server gives",
      "  -- the application its own level back when the trigger returns.",
      "  set transaction isolation level read committed;",
      "  -- A statement that changed no row has nothing to queue: its firing ends here, before any write.",
      "  if not exists (select 1 from inserted) return;",
    ]);
    // It comes before the update() test and before every write of the body.
    const early = trigger.indexOf("if not exists (select 1 from inserted) return;");
    for (const later of ["if update(", "update t set", "update j set", "insert into"]) {
      expect(trigger.indexOf(later)).toBeGreaterThan(early);
    }
  });

  it("is set-based over inserted: the rows back to pending, a queued key's claim cleared, a new key queued under the table's name", async () => {
    const trigger = textOf(await fixturePlan(), "create trigger");
    expect(trigger).toBe(`create trigger [dbo].[facetdb_listings] on [dbo].[listings]
with execute as owner
after insert, update
as
begin
  set nocount on;
  -- FacetDB's reads here run at read committed whatever the application's level; SQL Server gives
  -- the application its own level back when the trigger returns.
  set transaction isolation level read committed;
  -- A statement that changed no row has nothing to queue: its firing ends here, before any write.
  if not exists (select 1 from inserted) return;
  -- An update that sets a state column, or an insert (which sets every column): the worker's own
  -- update sets none of them.
  if update([title])
     or update([description])
  begin
    update t set [facetdb_status] = 'pending'
      from [dbo].[listings] t
      join inserted i on i.[id] = t.[id]
     where t.[facetdb_status] is null or t.[facetdb_status] <> 'pending';
    -- A key already queued keeps its job, its claim cleared, so the new state is asked too.
    update j set [claimed_by] = null, [claimed_at] = null, [claim_token] = null
      from [dbo].[facetdb_jobs] j
      join inserted i on j.[table_name] = N'[dbo].[listings]' and j.[record_key] = convert(nvarchar(322), i.[id]);
    -- A key not queued yet is queued.
    insert into [dbo].[facetdb_jobs] ([table_name], [record_key])
    select N'[dbo].[listings]', convert(nvarchar(322), i.[id])
      from inserted i
     where not exists (select 1 from [dbo].[facetdb_jobs] j
                        where j.[table_name] = N'[dbo].[listings]' and j.[record_key] = convert(nvarchar(322), i.[id]));
  end
end`);
    // The claim is cleared before the insert, as the Postgres trigger's `on conflict … do update`.
    expect(trigger.indexOf("update j set")).toBeLessThan(trigger.indexOf("insert into"));
  });

  it("makes the database's one queue, keyed by the table and the key as text, a queued key a no-op", async () => {
    expect(textOf(await fixturePlan(), "if object_id(N'[dbo].[facetdb_jobs]'")).toBe(
      `if object_id(N'[dbo].[facetdb_jobs]', N'U') is null
begin
  create table [dbo].[facetdb_jobs] (
    [table_name] nvarchar(128) not null,
    [record_key] nvarchar(322) collate Latin1_General_100_BIN2 not null,
    [enqueued_at] datetime2(3) not null default sysutcdatetime(),
    [claimed_by] nvarchar(128) null,
    [claimed_at] datetime2(3) null,
    [claim_token] char(32) null,
    primary key ([table_name], [record_key]) with (ignore_dup_key = on)
  );
  create index [facetdb_jobs_claimed] on [dbo].[facetdb_jobs] ([table_name], [claimed_at]);
end`,
    );
  });

  it("grants the worker the least permission that works, as every engine, and no right to create anything", async () => {
    const plan = await fixturePlan();
    expect(grantsOf(plan)).toEqual([
      "grant select ([id], [title], [description], [is_scam], [is_scam_probability], [facetdb_status], [facetdb_updated_at], [facetdb_reviewed])\n  on [dbo].[listings] to [facetdb_worker]",
      "grant update ([is_scam], [is_scam_probability], [facetdb_status], [facetdb_updated_at], [facetdb_reviewed])\n  on [dbo].[listings] to [facetdb_worker]",
      "grant select, insert, update, delete on [dbo].[facetdb_jobs] to [facetdb_worker]",
      "grant select on [dbo].[facetdb_table_owners] to [facetdb_worker]",
    ]);
    const sql = render(plan);
    expect(sql).not.toMatch(/\bgrant\b[^;]*\b(create|alter|control|execute|references)\b/i);
    expect(sql).not.toMatch(/with grant option|alter role|sp_addrolemember|db_owner/i);
    // No grant names any principal but the worker: the application's login needs nothing.
    const grantees = [...sql.matchAll(/\bto (\[[^\]]+\])/g)].map((match) => match[1]);
    expect(new Set(grantees)).toEqual(new Set(["[facetdb_worker]"]));
    // The trigger writes the queue with the table owner's rights.
    expect(textOf(plan, "create trigger")).toMatch(
      /^create trigger \[dbo\]\.\[facetdb_listings\] on \[dbo\]\.\[listings\]\nwith execute as owner\nafter insert, update\nas\n/,
    );
  });

  it("holds no password: its one secret statement reads it from @p1 to create the contained user", async () => {
    const plan = await fixturePlan();
    const secrets = plan.statements.filter((statement) => statement.secret === true);
    expect(secrets).toEqual([
      {
        database: "source",
        purpose: "login",
        secret: true,
        text: `-- @p1 is the worker password from the source's connection string: facetdb migrate binds it
-- here and never prints it.
if database_principal_id(N'facetdb_worker') is null
begin
  declare @create nvarchar(max) = N'create user [facetdb_worker] with password = N''' + replace(@p1 collate Latin1_General_100_BIN2, N'''', N'''''') + N'''';
  exec (@create);
end`,
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("pass'word");
    expect(render(plan)).not.toContain("pass'word");
  });

  it("marks each column FacetDB adds as FacetDB's, in the statement that adds it", async () => {
    expect(textOf(await fixturePlan(), "if col_length(N'[dbo].[listings]', N'is_scam')")).toBe(
      `if col_length(N'[dbo].[listings]', N'is_scam') is null
begin
  alter table [dbo].[listings] add [is_scam] bit null;
  exec sys.sp_addextendedproperty @name = N'facetdb', @value = N'facetdb',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'listings',
    @level2type = N'COLUMN', @level2name = N'is_scam';
end`,
    );
  });

  it("only reads the catalog while it plans, and lets go of the admin connection", async () => {
    const { client } = await planned(freshWorld(AZURE_SQL));
    expect(client.connected).toEqual([ADMIN]);
    expect(client.openConnections()).toBe(0);
    expect(client.transactions.size).toBe(0);
    for (const statement of client.statements) {
      expect(statement.text.startsWith("select ")).toBe(true);
    }
  });
});

describe("a second plan", () => {
  it("has no statement on the installed database, and needs no password", async () => {
    for (const server of [AZURE_SQL, SQL_SERVER]) {
      const world = installedWorld(LISTINGS, freshWorld(server));
      const plan = planOf((await planned(world, LISTINGS, deps)).result);
      expect(plan.statements).toEqual([]);
      expect(plan.notes).toEqual([]);
      expect(render(plan)).toBe("");
    }
  });

  it("restores the table's marker row deleted by hand, and nothing else", async () => {
    const world = installedWorld(LISTINGS, freshWorld(AZURE_SQL));
    const plan = planOf((await planned({ ...world, marker: [] }, LISTINGS, deps)).result);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
    ]);
    expect(textOf(plan, "if not exists (select 1 from [dbo].[facetdb_table_owners]")).toContain(
      "values (N'dbo', N'listings', N'proj_listings', N'Listings')",
    );
    expect(plan.notes).toEqual([]);
  });

  it("adds only what a question added later needs: its columns and the worker's rights on them", async () => {
    const world = installedWorld(LISTINGS, freshWorld(AZURE_SQL));
    const target: EngineTarget = {
      ...LISTINGS,
      questionSet: {
        ...listings,
        questions: [
          ...listings.questions,
          { type: "noul", name: "is_spam", instructions: "Spam?", stakes: "low" },
        ],
      },
    };
    const plan = planOf((await planned(world, target, deps)).result);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      ...["columns", "columns"],
      ...["grants", "grants"],
    ]);
    expect(grantsOf(plan)).toEqual([
      "grant select ([is_spam], [is_spam_probability])\n  on [dbo].[listings] to [facetdb_worker]",
      "grant update ([is_spam], [is_spam_probability])\n  on [dbo].[listings] to [facetdb_worker]",
    ]);
    // The trigger was there already; only the new columns are worth a word.
    expect(plan.notes).toEqual([
      "dbo.listings gains 2 columns: an application insert that lists no columns (insert into dbo.listings values (…)) fails (error 213) until it names them",
    ]);
  });

  it("makes the trigger again for a changed read list, and lets the worker read the new state column", async () => {
    const before = withColumns([...LISTINGS_COLUMNS, typed("price", "decimal(10, 2)")]);
    const world = installedWorld(LISTINGS, before);
    const target: EngineTarget = {
      ...LISTINGS,
      questionSet: { ...listings, read: ["title", "description", "price"] },
    };
    const plan = planOf((await planned(world, target, deps)).result);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      ...["capture", "capture"],
      "grants",
    ]);
    expect(textOf(plan, "drop trigger")).toBe("drop trigger if exists [dbo].[facetdb_listings]");
    expect(textOf(plan, "create trigger")).toContain(
      "if update([title])\n     or update([description])\n     or update([price])\n",
    );
    expect(grantsOf(plan)).toEqual([
      "grant select ([price])\n  on [dbo].[listings] to [facetdb_worker]",
    ]);
  });

  it("makes a disabled trigger again", async () => {
    const world = installedWorld(LISTINGS, freshWorld(AZURE_SQL));
    const disabled: World = {
      ...world,
      objects: world.objects.map((object) =>
        object.type === "TR" ? { ...object, disabled: true } : object,
      ),
    };
    const plan = planOf((await planned(disabled, LISTINGS, deps)).result);
    expect(plan.statements.filter((statement) => statement.purpose === "capture")).toHaveLength(2);
  });

  it("installs a second table beside the first: its own columns, trigger and grants, the queue and marker shared", async () => {
    const both: World = {
      ...installedWorld(LISTINGS, freshWorld(AZURE_SQL)),
    };
    const world: World = {
      ...both,
      tables: { ...both.tables, "sales.orders": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    };
    const orders: EngineTarget = {
      ...LISTINGS,
      source: "orders",
      schema: "sales",
      table: "orders",
    };
    const plan = planOf((await planned(world, orders, deps)).result);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      ...["marker", "marker", "marker"],
      ...["columns", "columns", "columns", "columns", "columns"],
      ...["capture", "capture"],
      ...["grants", "grants"],
    ]);
    const trigger = textOf(plan, "create trigger");
    expect(trigger).toContain("create trigger [sales].[facetdb_orders] on [sales].[orders]");
    expect(trigger).toContain("j.[table_name] = N'[sales].[orders]'");
    expect(trigger).toContain("insert into [dbo].[facetdb_jobs] ([table_name], [record_key])");
    expect(textOf(plan, "if not exists (select 1 from [dbo].[facetdb_table_owners]")).toContain(
      "values (N'sales', N'orders', N'proj_listings', N'Listings')",
    );
  });
});

describe("the worker", () => {
  it("on a server without containment is a login and its user here; every other statement is the fixture's", async () => {
    const contained = await fixturePlan();
    const server = planOf((await planned(freshWorld(SQL_SERVER))).result);
    const at = contained.statements.findIndex((statement) => statement.secret === true);
    const expected: readonly PlanStatement[] = [
      ...contained.statements.slice(0, at),
      { database: "source", purpose: "login", secret: true, text: LOGIN_TEXT },
      { database: "source", purpose: "login", text: USER_FOR_LOGIN_TEXT },
      ...contained.statements.slice(at + 1),
    ];
    expect(server.statements).toEqual(expected);
    expect(server.notes).toEqual([...FIXTURE_NOTES, LOGIN_NOTE]);
  });

  it("is a contained user on a partially contained SQL Server database, as on Azure SQL", async () => {
    const plan = planOf((await planned(freshWorld(CONTAINED_SQL_SERVER))).result);
    expect(plan.statements).toEqual((await fixturePlan()).statements);
    expect(plan.notes).toEqual(FIXTURE_NOTES);
  });

  it("reads no server login on Azure SQL Database, whose logins are master's", async () => {
    const { client } = await planned(freshWorld(AZURE_SQL));
    expect(client.statements.some((s) => s.text.includes("sys.server_principals"))).toBe(false);
    const server = await planned(freshWorld(SQL_SERVER));
    expect(server.client.statements.some((s) => s.text.includes("sys.server_principals"))).toBe(
      true,
    );
    // A containment Azure SQL Database leaves NULL reads as none, before the edition is weighed.
    expect(SERVER_QUERY).toContain("cast(coalesce(d.containment, 0) as int) as containment");
  });

  it("keeps an existing login's password: only its user here is made, and none is needed", async () => {
    const world: World = {
      ...freshWorld(SQL_SERVER),
      worker: { user: false, login: true, roles: [] },
    };
    const plan = planOf((await planned(world, LISTINGS, deps)).result);
    expect(plan.statements.filter((statement) => statement.secret === true)).toEqual([]);
    expect(
      plan.statements
        .filter((statement) => statement.purpose === "login")
        .map((statement) => statement.text),
    ).toEqual([USER_FOR_LOGIN_TEXT]);
    expect(plan.notes).toEqual(FIXTURE_NOTES);
  });

  it("keeps an existing contained user's password, even when one is given", async () => {
    const world: World = {
      ...freshWorld(AZURE_SQL),
      worker: { user: true, login: false, roles: [] },
    };
    const plan = planOf((await planned(world)).result);
    expect(plan.statements.filter((statement) => statement.purpose === "login")).toEqual([]);
    expect(grantsOf(plan)).toHaveLength(4);
  });

  it("maps a user whose login is gone (a restore from another server) to FacetDB's login, and says so", async () => {
    const remap = {
      text: "if database_principal_id(N'facetdb_worker') is not null\n  alter user [facetdb_worker] with login = [facetdb_worker]",
      secret: undefined,
    };
    const logins = (plan: EnginePlan) =>
      plan.statements
        .filter((statement) => statement.purpose === "login")
        .map(({ text, secret }) => ({ text, secret }));
    // No login of that name yet: it is made, with the password, and the user mapped to it.
    const orphan: World = {
      ...freshWorld(SQL_SERVER),
      worker: { user: true, login: false, userLogin: null, roles: [] },
    };
    const made = planOf((await planned(orphan)).result);
    expect(logins(made)).toEqual([{ text: LOGIN_TEXT, secret: true }, remap]);
    expect(made.notes).toEqual([...FIXTURE_NOTES, LOGIN_NOTE, REMAP_NOTE]);
    // The login is there and the user is not its: mapped to it, no password needed.
    const loose: World = {
      ...freshWorld(SQL_SERVER),
      worker: { user: true, login: true, userLogin: null, roles: [] },
    };
    const mapped = planOf((await planned(loose, LISTINGS, deps)).result);
    expect(logins(mapped)).toEqual([remap]);
    expect(mapped.notes).toEqual([...FIXTURE_NOTES, REMAP_NOTE]);
    expect(REMAP_NOTE).toBe(
      "the user facetdb_worker of this database has no login on this server (a database restored from another server keeps its users so): the install maps it to the login facetdb_worker and changes nothing else of it",
    );
  });

  it("reads the key, the state, FacetDB's own columns and created_at when the table has it", async () => {
    const world = withColumns([...LISTINGS_COLUMNS, typed("created_at", "datetime2(7)")]);
    const [select] = grantsOf(planOf((await planned(world)).result));
    expect(select).toBe(
      "grant select ([id], [title], [description], [is_scam], [is_scam_probability], [facetdb_status], [facetdb_updated_at], [facetdb_reviewed], [created_at])\n  on [dbo].[listings] to [facetdb_worker]",
    );
  });
});

describe("the columns and the queue", () => {
  it("adds every question type's columns in SQL Server's types, each marked as FacetDB's", async () => {
    const plan = planOf(
      (await planned(freshWorld(AZURE_SQL), { ...LISTINGS, questionSet: everyType })).result,
    );
    const added = plan.statements
      .filter((statement) => statement.purpose === "columns")
      .map(
        (statement) => /alter table \[dbo\]\.\[listings\] add (.*) null;/.exec(statement.text)?.[1],
      );
    expect(added).toEqual([
      "[is_scam] bit",
      "[is_scam_probability] real",
      "[category] nvarchar(255)",
      "[category_confidence] real",
      "[category_probabilities] nvarchar(max)",
      "[quality] nvarchar(255)",
      "[quality_confidence] real",
      "[quality_expected] real",
      "[facetdb_status] varchar(16)",
      "[facetdb_updated_at] datetime2(3)",
      "[facetdb_reviewed] bit",
    ]);
    for (const statement of plan.statements.filter((s) => s.purpose === "columns")) {
      expect(statement.text).toContain("exec sys.sp_addextendedproperty @name = N'facetdb'");
    }
  });

  it("queues a text key under the queue's own collation, so its comparison never conflicts", async () => {
    const code = typed("code", "nvarchar(20)", { collation: "Latin1_General_100_CS_AS" });
    const trigger = textOf(planOf((await planned(keyed(code))).result), "create trigger");
    expect(trigger).toContain(
      "j.[record_key] = convert(nvarchar(322), i.[code]) collate Latin1_General_100_BIN2;",
    );
    expect(trigger).toContain("join inserted i on i.[code] = t.[code]");
  });

  it("takes whole number, decimal, uniqueidentifier and text keys up to 322 characters", async () => {
    for (const key of [
      typed("id", "bigint"),
      typed("id", "tinyint"),
      typed("id", "decimal(38, 0)"),
      typed("id", "uniqueidentifier"),
      typed("id", "varchar(322)"),
      typed("id", "nchar(322)"),
    ]) {
      expect((await planned(keyed(key))).result.ok, key.type).toBe(true);
    }
  });

  it("onChange keep leaves a decided row's status; only a row without one is set to pending", async () => {
    const plan = planOf(
      (await planned(freshWorld(AZURE_SQL), { ...LISTINGS, onChange: "keep" })).result,
    );
    const trigger = textOf(plan, "create trigger");
    expect(trigger).toContain("     where t.[facetdb_status] is null;\n");
    expect(trigger).not.toContain("<> 'pending'");
  });

  it("quotes every name, so a schema and a table holding ] and ' are escaped wherever they appear", async () => {
    const target: EngineTarget = { ...LISTINGS, schema: "sales]x", table: "o'brien]s" };
    const world: World = {
      ...freshWorld(AZURE_SQL),
      tables: { "sales]x.o'brien]s": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    };
    const sql = render(planOf((await planned(world, target)).result));
    expect(sql).toContain("[sales]]x].[o'brien]]s]");
    expect(sql).toContain("N'[sales]]x].[o''brien]]s]'");
    expect(sql).toContain("@level0name = N'sales]x'");
    expect(sql).toContain("@level1name = N'o''brien]s'");
    // With every quoted name and every literal taken out, no part of either name is left bare.
    const bare = sql
      .replaceAll(/N'(?:[^']|'')*'/g, "")
      .replaceAll(/\[(?:[^\]]|\]\])*\]/g, "")
      .replaceAll(/^--.*$/gm, "");
    expect(bare).not.toContain("brien");
    expect(bare).not.toContain("sales");
  });
});

describe("refusals", () => {
  /** A refusal, after checking that the plan wrote nothing and let go of every connection. */
  async function refused(
    world: World,
    target: EngineTarget = LISTINGS,
    options: InstallOptions = withPassword,
    url: string = ADMIN,
  ): Promise<{ readonly refusal: Refusal; readonly connected: number }> {
    const { result, client } = await planned(world, target, options, url);
    expect(client.transactions.size).toBe(0);
    expect(client.openConnections()).toBe(0);
    return { refusal: refusalOf(result), connected: client.connected.length };
  }

  it("refuses an admin connection string that is not one, or whose host cannot be read, before connecting", async () => {
    for (const url of [
      "not a url",
      "postgres://admin@db.example.com/app",
      "mssql://a@b@db.example.com/app",
    ]) {
      const { refusal, connected } = await refused(freshWorld(), LISTINGS, withPassword, url);
      expect(refusal.code).toBe("admin-url");
      expect(connected).toBe(0);
    }
  });

  it("refuses a password sent to another machine without TLS or past any certificate, before connecting", async () => {
    const plaintext = await refused(
      freshWorld(),
      LISTINGS,
      withPassword,
      "mssql://admin:pw@db.example.com/app?encrypt=false",
    );
    expect(plaintext.refusal).toMatchObject({
      code: "admin-url-tls",
      message: expect.stringContaining("reaches db.example.com without TLS (encrypt=false)"),
      fix: expect.stringContaining("--allow-insecure"),
    });
    expect(plaintext.connected).toBe(0);
    const unverified = await refused(
      freshWorld(),
      LISTINGS,
      withPassword,
      "mssql://admin:pw@db.example.com/app?trustServerCertificate=true",
    );
    expect(unverified.refusal).toMatchObject({
      code: "admin-url-tls",
      message: expect.stringContaining("trustServerCertificate=true"),
    });
    expect(unverified.connected).toBe(0);
  });

  it("takes either on this machine, and anywhere with --allow-insecure", async () => {
    const local = await planned(
      freshWorld(),
      LISTINGS,
      withPassword,
      "mssql://sa:pw@127.0.0.1:1433/master?encrypt=false&trustServerCertificate=true",
    );
    expect(local.result.ok).toBe(true);
    const trusted = await planned(
      freshWorld(),
      LISTINGS,
      { ...withPassword, allowInsecure: true },
      "mssql://admin:pw@db.example.com/app?encrypt=false",
    );
    expect(trusted.result.ok).toBe(true);
  });

  it("refuses a table whose name leaves no room for FacetDB's names, before connecting", async () => {
    const fits = "t".repeat(120);
    const world = withColumns(LISTINGS_COLUMNS);
    const long: World = {
      ...world,
      tables: { [`dbo.${fits}`]: { columns: LISTINGS_COLUMNS, key: ["id"] } },
    };
    expect((await planned(long, { ...LISTINGS, table: fits })).result.ok).toBe(true);
    const { refusal, connected } = await refused(freshWorld(), { ...LISTINGS, table: `${fits}t` });
    expect(refusal).toMatchObject({ code: "name-length", fix: expect.stringContaining("128") });
    expect(connected).toBe(0);
  });

  it("refuses a dbo table whose trigger would take the name of FacetDB's queue or marker, before connecting", async () => {
    for (const table of ["jobs", "table_owners"]) {
      const { refusal, connected } = await refused(freshWorld(), { ...LISTINGS, table });
      expect(refusal.code).toBe("name-taken");
      expect(connected).toBe(0);
    }
    // In another schema the trigger sales.facetdb_jobs takes nothing of FacetDB's.
    const jobs: World = {
      ...freshWorld(),
      tables: { "sales.jobs": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    };
    expect((await planned(jobs, { ...LISTINGS, schema: "sales", table: "jobs" })).result.ok).toBe(
      true,
    );
  });

  it("refuses a server older than SQL Server 2016", async () => {
    const { refusal } = await refused(freshWorld({ ...SQL_SERVER, majorVersion: 12 }));
    expect(refusal).toMatchObject({
      code: "server-version",
      message: expect.stringContaining("version 12"),
    });
  });

  it("refuses a table that does not exist", async () => {
    const { refusal } = await refused({ ...freshWorld(), tables: {} });
    expect(refusal).toMatchObject({
      code: "no-table",
      message:
        "dbo.listings does not exist; FacetDB adds columns to a table, it does not create one",
    });
  });

  it("refuses a table without a primary key, with a composite one, or with another than the config's", async () => {
    expect((await refused(withColumns(LISTINGS_COLUMNS, []))).refusal).toMatchObject({
      code: "primary-key",
      message: expect.stringContaining("has no primary key"),
    });
    expect((await refused(withColumns(LISTINGS_COLUMNS, ["id", "title"]))).refusal).toMatchObject({
      code: "primary-key",
      message: expect.stringContaining("composite primary key (id, title)"),
    });
    expect(
      (await refused(withColumns(LISTINGS_COLUMNS), { ...LISTINGS, key: "uid" })).refusal,
    ).toMatchObject({
      code: "primary-key",
      message: expect.stringContaining("primary key is id, not uid"),
    });
  });

  it("refuses a key whose text would not read back as the same value, or would not fit the queue", async () => {
    for (const key of [
      typed("id", "datetime2(7)"),
      typed("id", "float"),
      typed("id", "binary(16)"),
      typed("id", "nvarchar(450)"),
    ]) {
      expect((await refused(keyed(key))).refusal).toMatchObject({
        code: "key-type",
        message: expect.stringContaining(`primary key id is ${key.type}`),
      });
    }
  });

  it("refuses a state field FacetDB writes, a missing one and a computed one", async () => {
    const reading = (read: readonly string[]): EngineTarget => ({
      ...LISTINGS,
      questionSet: { ...listings, read },
    });
    expect(
      (await refused(freshWorld(), reading(["title", "facetdb_status"]))).refusal,
    ).toMatchObject({
      code: "state-column",
      message: expect.stringContaining("facetdb_status is a column FacetDB writes"),
    });
    expect((await refused(freshWorld(), reading(["title", "is_scam"]))).refusal.code).toBe(
      "state-column",
    );
    expect((await refused(freshWorld(), reading(["title", "summary"]))).refusal).toMatchObject({
      code: "missing-column",
      message: expect.stringContaining("no column named summary"),
    });
    const computed = withColumns([
      ...LISTINGS_COLUMNS,
      typed("blurb", "nvarchar(400)", { computed: true }),
    ]);
    expect((await refused(computed, reading(["title", "blurb"]))).refusal).toMatchObject({
      code: "state-column",
      message: expect.stringContaining("blurb is a computed column"),
    });
  });

  it("refuses a column of the application's that a question would take", async () => {
    const world = withColumns([...LISTINGS_COLUMNS, typed("is_scam", "bit")]);
    expect((await refused(world)).refusal).toMatchObject({
      code: "column-collision",
      message: "dbo.listings already has a column named is_scam that is not FacetDB's",
    });
  });

  it("refuses a question whose type changed in place", async () => {
    const world = withColumns([
      ...LISTINGS_COLUMNS,
      typed("is_scam", "nvarchar(255)", { marked: true }),
    ]);
    expect((await refused(world)).refusal).toMatchObject({
      code: "column-type",
      message: expect.stringContaining("is_scam is nvarchar(255) and the question now needs bit"),
    });
  });

  it("refuses a table another project installed on, before it looks at that project's columns", async () => {
    const other: EngineTarget = { ...LISTINGS, project: { id: "proj_other", name: "Other" } };
    const message =
      "dbo.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.";
    expect((await refused(installedWorld(other, freshWorld()))).refusal).toMatchObject({
      code: "another-project",
      message,
    });
    // Its category is a choice: the project, not a question's changed type, is what is wrong.
    const asChoice = installedWorld(
      { ...other, questionSet: { ...listings, questions: everyType.questions.slice(1, 2) } },
      freshWorld(),
    );
    const renamed: EngineTarget = {
      ...LISTINGS,
      questionSet: {
        ...listings,
        questions: [{ type: "noul", name: "category", instructions: "A car?", stakes: "low" }],
      },
    };
    expect((await refused(asChoice, renamed)).refusal).toMatchObject({
      code: "another-project",
      message,
    });
  });

  it("refuses a name FacetDB gives its objects that something else already has", async () => {
    const taken = (object: {
      schema: string;
      name: string;
      type: string;
      parent?: string;
    }): World => ({ ...freshWorld(), objects: [object] });
    expect(
      (await refused(taken({ schema: "dbo", name: "facetdb_listings", type: "U" }))).refusal,
    ).toMatchObject({
      code: "name-taken",
      message: "dbo.facetdb_listings already exists and is not FacetDB's trigger on dbo.listings",
    });
    expect(
      (
        await refused(
          taken({ schema: "dbo", name: "facetdb_listings", type: "TR", parent: "orders" }),
        )
      ).refusal.code,
    ).toBe("name-taken");
    expect(
      (await refused(taken({ schema: "dbo", name: "facetdb_jobs", type: "V" }))).refusal,
    ).toMatchObject({
      code: "name-taken",
      message: "dbo.facetdb_jobs already exists and is not FacetDB's queue",
    });
    // A table of that name that is not shaped as the queue (no table_name, no record_key).
    const notQueue: World = {
      ...taken({ schema: "dbo", name: "facetdb_jobs", type: "U" }),
      tables: {
        ...freshWorld().tables,
        "dbo.facetdb_jobs": { columns: [typed("id", "int")], key: ["id"] },
      },
    };
    expect((await refused(notQueue)).refusal.code).toBe("name-taken");
    expect(
      (await refused(taken({ schema: "dbo", name: "facetdb_table_owners", type: "V" }))).refusal,
    ).toMatchObject({ code: "name-taken", message: expect.stringContaining("marker table") });
  });

  it("refuses a table whose owner the trigger could not run as, or that could not write the queue", async () => {
    const owned = (owner: { name: string; type: string; dbOwner: boolean }): World => ({
      ...freshWorld(),
      tables: { "dbo.listings": { columns: LISTINGS_COLUMNS, key: ["id"], owner } },
    });
    // A role is never impersonated (error 15517), in db_owner or not: the fix is a user owner.
    for (const role of [
      { name: "app_role", type: "R", dbOwner: true },
      { name: "app_role", type: "R", dbOwner: false },
    ]) {
      expect((await refused(owned(role))).refusal).toEqual({
        code: "table-owner",
        message:
          "dbo.listings belongs to app_role, a database role; its trigger runs as the table's owner, and SQL Server runs nothing as one (error 15517), so every write to the table would fail",
        fix: "make dbo, or a user, the owner of the table's schema (alter authorization on schema::[dbo] to dbo), then run facetdb migrate again",
      });
    }
    expect(
      (await refused(owned({ name: "sales_admin", type: "S", dbOwner: false }))).refusal,
    ).toMatchObject({
      code: "table-owner",
      message: expect.stringContaining(
        "dbo.listings belongs to sales_admin, which is not dbo and not in db_owner",
      ),
    });
    for (const user of [
      { name: "alice", type: "S", dbOwner: true },
      { name: "corp\\alice", type: "U", dbOwner: true },
      { name: "alice@corp.example", type: "E", dbOwner: true },
    ]) {
      expect((await planned(owned(user))).result.ok, user.type).toBe(true);
    }
  });

  it("refuses a database whose owner has no login, which every write through the trigger would fail on", async () => {
    const { refusal } = await refused(freshWorld({ ...SQL_SERVER, ownerLogin: null }));
    expect(refusal).toMatchObject({
      code: "database-owner",
      fix: "make a login the database's owner (alter authorization on database::[listings] to <a login>), then run facetdb migrate again",
    });
    // Azure SQL Database names no owner login from inside the database, and needs none.
    expect((await planned(freshWorld({ ...AZURE_SQL, ownerLogin: null }))).result.ok).toBe(true);
  });

  it("refuses a worker user that belongs to another login than FacetDB's", async () => {
    const world: World = {
      ...freshWorld(SQL_SERVER),
      worker: { user: true, login: true, userLogin: "app_login", roles: [] },
    };
    expect((await refused(world)).refusal).toEqual({
      code: "worker-user",
      message:
        "the user facetdb_worker in this database belongs to the login app_login, not to the login facetdb_worker FacetDB connects as",
      fix: "rename that user if the application uses it (alter user facetdb_worker with name = <another name>), or drop it, then run facetdb migrate again: FacetDB makes its own",
    });
  });

  it("refuses a worker user that is a member of a role", async () => {
    const world: World = {
      ...freshWorld(),
      worker: { user: true, login: false, roles: ["db_datareader", "db_owner"] },
    };
    expect((await refused(world)).refusal).toMatchObject({
      code: "worker-roles",
      message: expect.stringContaining("is a member of db_datareader, db_owner"),
    });
  });

  it("refuses to create the worker without a password, saying where to put one", async () => {
    const contained = await refused(freshWorld(AZURE_SQL), LISTINGS, deps);
    expect(contained.refusal).toEqual({
      code: "worker-login",
      message:
        "the worker user facetdb_worker does not exist in this database yet, and no password was given to create it with",
      fix: "put the worker user and a long random password in LISTINGS_URL: mssql://facetdb_worker:<a long random password>@<host>/<database>; the install creates the user with that password",
    });
    const server = await refused(freshWorld(SQL_SERVER), LISTINGS, deps);
    expect(server.refusal).toMatchObject({
      code: "worker-login",
      message: expect.stringContaining(
        "the worker login facetdb_worker does not exist on this server",
      ),
    });
  });
});

describe("run", () => {
  async function run(
    plan: EnginePlan,
    options: { readonly workerPassword?: string; readonly url?: string } = {},
    script: RecordingScript = {},
  ) {
    const client = recordingClient(script);
    const result = await createInstaller({ connect: client.connect }).run(
      LISTINGS,
      plan,
      options.url ?? ADMIN,
      {
        ...deps,
        ...(options.workerPassword === undefined ? {} : { workerPassword: options.workerPassword }),
      },
    );
    return { result, client };
  }

  it("runs every statement as printed, in one transaction, binding the password at the secret statement alone", async () => {
    const plan = await fixturePlan();
    const { result, client } = await run(plan, { workerPassword: PASSWORD });
    expect(result).toEqual({ ran: plan.statements, removed: [], notes: FIXTURE_NOTES });
    expect(client.transactions).toEqual(new Map([[1, "committed"]]));
    expect(client.inTransaction(1).map((statement) => statement.text)).toEqual(
      plan.statements.map((statement) => statement.text),
    );
    expect(client.inTransaction(1).map((statement) => statement.params)).toEqual(
      plan.statements.map((statement) => (statement.secret === true ? [PASSWORD] : [])),
    );
    expect(client.statements.every((statement) => statement.transaction === 1)).toBe(true);
    expect(client.openConnections()).toBe(0);
  });

  it("rolls the whole install back at a failed statement, and says where it stopped", async () => {
    const plan = await fixturePlan();
    const at = plan.statements.findIndex((statement) =>
      statement.text.startsWith("create trigger"),
    );
    const { result, client } = await run(
      plan,
      { workerPassword: PASSWORD },
      {
        fail: (text) =>
          text.startsWith("create trigger")
            ? serverError("Lock request time out period exceeded.", 1222)
            : undefined,
      },
    );
    expect(result).toEqual({
      ran: [],
      stopped: { at, error: "Lock request time out period exceeded." },
      removed: [],
      notes: [],
    });
    expect(client.transactions).toEqual(new Map([[1, "rolled back"]]));
    // Nothing after the failed statement was sent.
    expect(client.statements).toHaveLength(at + 1);
    expect(client.openConnections()).toBe(0);
  });

  it("never says the worker password or the admin's in a stopped run's words", async () => {
    const plan = await fixturePlan();
    const { result } = await run(
      plan,
      { workerPassword: PASSWORD },
      {
        fail: (_text, params) =>
          params.length > 0
            ? new Error(
                `Password validation failed for ${String(params[0])} on ${ADMIN} (an-admin-password)`,
              )
            : undefined,
      },
    );
    expect(result.stopped).toMatchObject({
      error: expect.stringContaining("Password validation failed"),
    });
    const words = JSON.stringify(result);
    expect(words).not.toContain("pass'word");
    expect(words).not.toContain("an-admin-password");
  });

  it("stops with another-project when the script's owner check finds the table claimed since the plan", async () => {
    const plan = await fixturePlan();
    const message =
      "FacetDB: dbo.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.";
    const at = plan.statements.findIndex((statement) =>
      statement.text.startsWith("declare @owner"),
    );
    const { result, client } = await run(
      plan,
      { workerPassword: PASSWORD },
      {
        fail: (text) =>
          text.startsWith("declare @owner") ? serverError(message, 51000) : undefined,
      },
    );
    expect(result.stopped).toEqual({
      at,
      refusal: {
        code: "another-project",
        message: message.slice("FacetDB: ".length),
        fix: "uninstall it from that project first, or point this source at another table",
      },
    });
    expect(result.ran).toEqual([]);
    expect(client.transactions.get(1)).toBe("rolled back");
  });

  it("stops at the secret statement without a password, and nothing stays", async () => {
    const plan = await fixturePlan();
    const at = plan.statements.findIndex((statement) => statement.secret === true);
    const { result, client } = await run(plan);
    expect(result).toEqual({
      ran: [],
      stopped: {
        at,
        refusal: {
          code: "worker-password",
          message: "this plan sets the worker login's password, and the run was given none",
          fix: "set the source's connection string to the worker login with its password",
        },
      },
      removed: [],
      notes: [],
    });
    expect(client.transactions.get(1)).toBe("rolled back");
  });

  it("refuses a plaintext admin connection string before connecting, and runs nothing for an empty plan", async () => {
    const plan = await fixturePlan();
    const refused = await run(plan, { url: "mssql://admin:pw@db.example.com/app?encrypt=false" });
    expect(refused.result.stopped).toMatchObject({ at: 0, refusal: { code: "admin-url-tls" } });
    expect(refused.client.connected).toEqual([]);
    const empty = await run({ ...plan, statements: [] });
    expect(empty.result).toEqual({ ran: [], removed: [], notes: FIXTURE_NOTES });
    expect(empty.client.connected).toEqual([]);
  });

  it("renders a plan that is not one transaction without the transaction's frame", async () => {
    const plan = await fixturePlan();
    const script = render({ ...plan, transactional: false });
    expect(script.split("\n")[0]).toBe(
      "-- FacetDB runs this script statement by statement: if one fails, what ran before it stays, and running the script again completes it.",
    );
    expect(script).not.toContain("begin transaction");
    expect(script).not.toContain("commit transaction");
  });
});
