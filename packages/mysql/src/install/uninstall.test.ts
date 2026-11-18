import type {
  EnginePlan,
  EngineTarget,
  PlanResult,
  Refusal,
  UninstallOptions,
} from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  ENGINE_DEPS,
  freshListings,
  installedListings,
  LISTINGS_JOBS,
  LISTINGS_TABLE,
  listingsTarget,
  type RecordingDriver,
  recordingDriver,
  type ScriptedDatabase,
  scriptedDatabase,
} from "../testing/index.ts";
import {
  createMysqlInstaller,
  REFUSED_FIX,
  SCRIPT_HEADER,
  SETTINGS,
  UNINSTALL_RERUN_NOTE,
  WORKER_ACCOUNT,
} from "./index.ts";

/**
 * The MySQL and MariaDB uninstall plan on the recording driver: it removes what install added in an
 * order a rerun can finish, drops the queue only once no FacetDB trigger of the schema writes to it
 * and no table is marked, and the marker table once it is empty (both checked as the script runs),
 * keeps the worker login with why, and asks for the project's name back.
 */

const UNINSTALL: UninstallOptions = { ...ENGINE_DEPS, purge: false, alsoUninstalling: [] };

type Planned = { readonly result: PlanResult; readonly driver: RecordingDriver };

async function planned(
  database: ScriptedDatabase,
  target: EngineTarget = listingsTarget(),
  options: UninstallOptions = UNINSTALL,
  url = ADMIN_URL,
): Promise<Planned> {
  const driver = recordingDriver(scriptedDatabase(database));
  const result = await createMysqlInstaller({ connect: driver.connect }).planUninstall(
    target,
    url,
    options,
  );
  return { result, driver };
}

function planOf({ result }: Planned): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf({ result }: Planned): Refusal {
  if (result.ok) {
    throw new Error("planned instead of refusing");
  }
  return result.refusal;
}

const texts = (plan: EnginePlan) => plan.statements.map((statement) => statement.text);

const LOGIN_KEPT = {
  kind: "login",
  name: WORKER_ACCOUNT,
  scope: "run",
  reason: "uninstall never drops it: every project on the server may share it",
} as const;

/**
 * The two run-time checks that drop the shared tables, as every table's plan ends. The queue also
 * waits for the marker to be empty: the triggers listed are only those the admin may see.
 */
const CLEANUP = [
  "set @facetdb_cleanup = if((select count(*) from information_schema.triggers\n       where trigger_schema = 'app' and left(trigger_name, 8) = 'facetdb_'\n         and locate('facetdb_jobs', action_statement) > 0) = 0\n    and (select count(*) from `app`.`facetdb_table_owners`) = 0,\n  'drop table if exists `app`.`facetdb_jobs`', 'do 0')",
  "prepare facetdb_cleanup from @facetdb_cleanup",
  "execute facetdb_cleanup",
  "set @facetdb_cleanup = if((select count(*) from `app`.`facetdb_table_owners`) = 0,\n  'drop table if exists `app`.`facetdb_table_owners`', 'do 0')",
  "prepare facetdb_cleanup from @facetdb_cleanup",
  "execute facetdb_cleanup",
  "deallocate prepare facetdb_cleanup",
];

describe("planUninstall: the listings example", () => {
  it("removes the triggers first, then the worker's rights, the marked columns and the table's row", async () => {
    const plan = planOf(await planned(installedListings()));
    expect(texts(plan)).toEqual([
      SETTINGS.text,
      "drop trigger if exists `app`.`facetdb_listings_new`",
      "drop trigger if exists `app`.`facetdb_listings_ins`",
      "drop trigger if exists `app`.`facetdb_listings_upd`",
      "revoke select (`id`, `title`, `description`, `is_scam`, `is_scam_probability`, `facetdb_status`, `facetdb_updated_at`, `facetdb_reviewed`), update (`is_scam`, `is_scam_probability`, `facetdb_status`, `facetdb_updated_at`, `facetdb_reviewed`)\n  on `app`.`listings` from 'facetdb_worker'@'%'",
      "alter table `app`.`listings`\n  drop column `is_scam`,\n  drop column `is_scam_probability`,\n  drop column `facetdb_status`,\n  drop column `facetdb_updated_at`,\n  drop column `facetdb_reviewed`",
      "delete from `app`.`facetdb_jobs` where `table_name` = 'listings'",
      "delete from `app`.`facetdb_table_owners` where `table_name` = 'listings'",
      ...CLEANUP,
    ]);
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "capture",
      "capture",
      "capture",
      "grants",
      "columns",
      "data",
      "marker",
      ...CLEANUP.map(() => "cleanup"),
    ]);
    expect(plan.statements.some((statement) => statement.secret === true)).toBe(false);
  });

  it("asks for the project's name back, says a rerun finishes it, and runs statement by statement", async () => {
    const plan = planOf(await planned(installedListings()));
    expect(plan.confirm).toEqual({ kind: "project", name: "Listings" });
    expect(plan.transactional).toBe(false);
    expect(plan.notes).toEqual([UNINSTALL_RERUN_NOTE]);
    // On a MariaDB server the note says MariaDB, as the version read says.
    const mariadb = planOf(
      await planned({
        ...installedListings(),
        version: "10.6.20-MariaDB-ubu2204",
        views: "unlisted",
      }),
    );
    expect(mariadb.notes).toEqual([
      "MariaDB runs these statements one by one, with no transaction around them: if one fails, the ones before it stay done, and running facetdb uninstall again completes it.",
      "MySQL and MariaDB drop a column that a view reads, and the view then fails with error 1356; MariaDB cannot list the views that read app.listings, so check them before this runs.",
    ]);
    const script = createMysqlInstaller({ connect: recordingDriver().connect }).render(plan);
    expect(script.startsWith(`${SCRIPT_HEADER}\n\n${SETTINGS.text};\n`)).toBe(true);
  });

  it("names what goes and what stays, the worker login with why", async () => {
    const plan = planOf(await planned(installedListings()));
    const own = (kind: string, name: string) => ({
      kind,
      name,
      of: "app.listings",
      scope: "source",
    });
    expect(plan.removes).toEqual([
      own("trigger", "facetdb_listings_new"),
      own("trigger", "facetdb_listings_ins"),
      own("trigger", "facetdb_listings_upd"),
      own("grant", WORKER_ACCOUNT),
      ...[
        "is_scam",
        "is_scam_probability",
        "facetdb_status",
        "facetdb_updated_at",
        "facetdb_reviewed",
      ].map((name) => own("column", name)),
      // Its queued jobs: the table's part of the shared queue.
      own("jobs-table", "app.facetdb_jobs"),
      own("marker", "app.facetdb_table_owners"),
      {
        kind: "jobs-table",
        name: "app.facetdb_jobs",
        scope: "run",
        reason: "no table uses it any more",
      },
      { kind: "marker", name: "app.facetdb_table_owners", scope: "run", reason: "now empty" },
    ]);
    expect(plan.keeps).toEqual([
      ...["app.facetdb_jobs", "app.facetdb_table_owners"].map((of) => ({
        kind: "grant",
        name: WORKER_ACCOUNT,
        of,
        scope: "run",
        reason:
          "MySQL keeps a dropped table's grants, and whether this table goes is decided as the script runs: they go with the login",
      })),
      LOGIN_KEPT,
    ]);
  });

  it("drops FacetDB's marked columns only, never the application's", async () => {
    const installed = installedListings();
    const withNotes: ScriptedDatabase = {
      ...installed,
      tables: installed.tables.map((table) =>
        table.name === "listings"
          ? { ...table, columns: [...table.columns, { name: "notes", type: "text" }] }
          : table,
      ),
    };
    const alter = texts(planOf(await planned(withNotes))).find((text) =>
      text.startsWith("alter table"),
    );
    expect(alter).not.toContain("notes");
  });

  it("says a view that reads a dropped column breaks, naming it where the server lists views", async () => {
    // MySQL 8 lists the views that read the table.
    const viewed = planOf(
      await planned({
        ...installedListings(),
        views: [{ view: "listing_cards", table: "listings" }],
      }),
    );
    expect(viewed.notes).toEqual([
      UNINSTALL_RERUN_NOTE,
      "MySQL drops a column that a view reads, and the view then fails with error 1356: app.listing_cards reads app.listings, so check it before this runs.",
    ]);
    // MariaDB cannot: the note says so, as the catalog cannot refuse it.
    const mariadb = planOf(await planned({ ...installedListings(), views: "unlisted" }));
    expect(mariadb.notes).toEqual([
      UNINSTALL_RERUN_NOTE,
      "MySQL and MariaDB drop a column that a view reads, and the view then fails with error 1356; MariaDB cannot list the views that read app.listings, so check them before this runs.",
    ]);
    // With no FacetDB column left to drop there is nothing to say.
    const dropped = planOf(
      await planned({
        ...installedListings(),
        tables: [LISTINGS_JOBS],
        triggers: [],
        views: "unlisted",
      }),
    );
    expect(dropped.notes).toEqual([UNINSTALL_RERUN_NOTE]);
  });

  it("plans the same statements with --purge: the decision log is the store's", async () => {
    const plain = planOf(await planned(installedListings()));
    const purged = planOf(
      await planned(installedListings(), listingsTarget(), { ...UNINSTALL, purge: true }),
    );
    expect(purged).toEqual(plain);
  });

  it("reads the catalog only, on one connection it closes", async () => {
    const { driver } = await planned(installedListings());
    expect(driver.sent.every((sent) => sent.text.trimStart().startsWith("select"))).toBe(true);
    expect(driver.opened).toBe(1);
    expect(driver.closed).toBe(1);
  });
});

describe("planUninstall: the shared tables", () => {
  /** Another table of the project installed in the same database, on the queue they share. */
  function withOrders(): ScriptedDatabase {
    const installed = installedListings();
    return {
      ...installed,
      tables: [...installed.tables, { ...LISTINGS_TABLE, name: "orders" }],
      owners: [
        ...(installed.owners ?? []),
        { table: "orders", projectId: "proj_listings", source: "orders" },
      ],
      triggers: [
        ...(installed.triggers ?? []),
        {
          name: "facetdb_orders_ins",
          table: "orders",
          timing: "AFTER",
          event: "INSERT",
          body: "insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('orders', cast(new.`id` as char character set utf8mb4))",
        },
      ],
    };
  }

  it("keeps the queue and the marker table while another table uses them, and still checks at run time", async () => {
    const plan = planOf(await planned(withOrders()));
    expect(texts(plan).slice(-CLEANUP.length)).toEqual(CLEANUP);
    // The table's own jobs go; the other table's stay in the queue they share.
    expect(texts(plan)).toContain(
      "delete from `app`.`facetdb_jobs` where `table_name` = 'listings'",
    );
    expect(plan.removes.filter((object) => object.scope === "run")).toEqual([]);
    expect(plan.keeps).toEqual([
      {
        kind: "jobs-table",
        name: "app.facetdb_jobs",
        scope: "run",
        reason: "app.orders still uses it",
      },
      {
        kind: "marker",
        name: "app.facetdb_table_owners",
        scope: "run",
        reason: "app.orders still uses it",
      },
      LOGIN_KEPT,
    ]);
  });

  it("says the run's other tables go with it: its words change, never its statements", async () => {
    const alone = planOf(await planned(withOrders()));
    const together = planOf(
      await planned(withOrders(), listingsTarget(), {
        ...UNINSTALL,
        alsoUninstalling: [listingsTarget({ table: "orders", source: "orders" })],
      }),
    );
    expect(together.statements).toEqual(alone.statements);
    expect(together.removes.filter((object) => object.scope === "run")).toEqual([
      {
        kind: "jobs-table",
        name: "app.facetdb_jobs",
        scope: "run",
        reason: "no table uses it any more",
      },
      { kind: "marker", name: "app.facetdb_table_owners", scope: "run", reason: "now empty" },
    ]);
  });

  it("uninstalls a table the application dropped: its row and the shared tables, its grants kept with why", async () => {
    const installed = installedListings();
    const dropped: ScriptedDatabase = {
      ...installed,
      tables: [LISTINGS_JOBS],
      triggers: [],
    };
    const plan = planOf(await planned(dropped));
    expect(texts(plan)).toEqual([
      SETTINGS.text,
      "delete from `app`.`facetdb_jobs` where `table_name` = 'listings'",
      "delete from `app`.`facetdb_table_owners` where `table_name` = 'listings'",
      ...CLEANUP,
    ]);
    expect(plan.keeps[0]).toEqual({
      kind: "grant",
      name: WORKER_ACCOUNT,
      of: "app.listings",
      scope: "source",
      reason:
        "the table is gone, and MySQL keeps the grants of a dropped table: they go with the login",
    });
  });

  it("finishes a run stopped after the table's row went: only the shared tables are left", async () => {
    const stopped: ScriptedDatabase = {
      ...freshListings(),
      tables: [LISTINGS_TABLE, LISTINGS_JOBS],
      owners: [],
    };
    const plan = planOf(await planned(stopped));
    expect(texts(plan)).toEqual([SETTINGS.text, ...CLEANUP]);
    expect(plan.confirm).toEqual({ kind: "project", name: "Listings" });
  });
});

describe("planUninstall refuses, and changes nothing", () => {
  it("refuses a table another project installed on, in Postgres's code", async () => {
    const theirs = await planned(
      installedListings(listingsTarget({ project: { id: "proj_b", name: "Bee" } })),
    );
    expect(refusalOf(theirs)).toEqual({
      code: "uninstall-refused",
      message: "app.listings belongs to another project (proj_b); uninstall it from that project.",
      fix: REFUSED_FIX,
    });
  });

  it("refuses a table FacetDB is not installed on", async () => {
    const fresh = await planned(freshListings());
    expect(refusalOf(fresh)).toEqual({
      code: "uninstall-refused",
      message:
        "FacetDB is not installed on app.listings (app.facetdb_table_owners has no row for it); check the source's table and database.",
      fix: REFUSED_FIX,
    });
    // FacetDB's columns without the marker's row name no project to confirm.
    const installed = installedListings();
    const unowned = await planned({ ...installed, owners: [] });
    expect(refusalOf(unowned).code).toBe("uninstall-refused");
  });

  it("refuses when no database is named, and a plaintext admin URL before it connects", async () => {
    expect(refusalOf(await planned({ ...installedListings(), database: null })).code).toBe(
      "no-database",
    );
    const remote = await planned(
      installedListings(),
      listingsTarget(),
      UNINSTALL,
      "mysql://admin:s3cret@db.example.com/app",
    );
    expect(refusalOf(remote).code).toBe("admin-url-tls");
    expect(remote.driver.opened).toBe(0);
  });

  it("refuses an admin who may not read mysql.user in words, never the driver's error", async () => {
    const denied = await planned({ ...installedListings(), deniedGrantTables: ["user"] });
    expect(refusalOf(denied)).toEqual({
      code: "admin-rights",
      message:
        "the account of the admin connection string may not read mysql.user (error 1142); FacetDB reads it to find every account named facetdb_worker (and MariaDB's roles) before it creates or keeps the worker login, and plans nothing it cannot see; nothing was changed",
      fix: "grant the admin account select on mysql.user (grant select on mysql.user to <the admin account>, run by an account that may), or use an admin account that has it, then run the command again",
    });
    expect(denied.driver.closed).toBe(denied.driver.opened);
  });
});
