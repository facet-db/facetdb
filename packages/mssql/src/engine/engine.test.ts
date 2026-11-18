import { type DoctorCheck, type EngineDeps, EngineRefusal, type EngineTarget } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { MSSQL_CAPABILITIES } from "../connector/index.ts";
import { tableNames } from "../install/index.ts";
import type { MssqlRow } from "../sql/index.ts";
import {
  AZURE_SQL,
  answer,
  freshWorld,
  installedWorld,
  LISTINGS,
  recordingClient,
  SQL_SERVER,
  serverError,
  type World,
} from "../testing/index.ts";
import { checksOf, createMssqlEngine, DOCTOR_CHECKS, ENGINE_NAME, serverName } from "./index.ts";

/**
 * The SQL Server engine: the installer spread as its plans, the worker URL refused before anything
 * connects, `open` as the connector with the worker's pool width, and doctor's checks on the
 * recording client over the scripted catalog, with their words. The real server runs doctor in
 * connector.db.test.ts.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const WORKER_URL = "mssql://facetdb_worker:secret@127.0.0.1:1433/listings";
const REMOTE_URL = "mssql://facetdb_worker:secret@db.example.com:1433/listings";

/** What a doctor session on the worker login sees besides the catalog. */
type Session = {
  readonly user?: string;
  /** The round trip each `select 1` takes on the fake clock. */
  readonly roundTripMs?: number;
  /** The trigger's text as the worker reads it: hidden (NULL) without VIEW DEFINITION. */
  readonly definition?: "hidden" | "shown";
  readonly jobs?: { readonly total: number; readonly claimed: number };
  /** A statement starting so fails. */
  readonly failing?: string;
};

function deps(clock = new FakeClock(START)): EngineDeps {
  return { clock, allowInsecure: false, storeShared: false };
}

/** The recording client over `world`'s catalog, answering doctor's own session reads too. */
function doctorClient(world: World, session: Session = {}, clock?: FakeClock) {
  const catalog = answer(world);
  return recordingClient({
    fail: (text) =>
      session.failing !== undefined && text.startsWith(session.failing)
        ? serverError(`The SELECT permission was denied on the object '${session.failing}'.`, 229)
        : undefined,
    answer: (text, params): readonly MssqlRow[] | undefined => {
      if (text.startsWith("select user_name() as user_name")) {
        const user = session.user ?? "facetdb_worker";
        return [{ user_name: user, login_name: user, database_name: "listings" }];
      }
      if (text === "select 1 as one") {
        clock?.advance(session.roundTripMs ?? 0);
        return [{ one: 1 }];
      }
      if (text.includes("from sys.triggers t\n where t.parent_id")) {
        const [table] = params.map(String);
        return world.objects
          .filter(
            (object) =>
              object.type === "TR" &&
              `[${object.schema}].[${object.parent}]` === table &&
              object.name.startsWith("facetdb_"),
          )
          .map((object) => ({ name: object.name }));
      }
      if (text.startsWith("select count(*) as total")) {
        return [session.jobs ?? { total: 3, claimed: 1 }];
      }
      const rows = catalog(text, params);
      // The worker login may not read a trigger's text (VIEW DEFINITION), unless the test says so.
      return session.definition === "shown" || rows === undefined
        ? rows
        : rows.map((row) => ("definition" in row ? { ...row, definition: null } : row));
    },
  });
}

async function doctor(
  world: World,
  session: Session = {},
  target: EngineTarget = LISTINGS,
  url = WORKER_URL,
): Promise<{ readonly checks: readonly DoctorCheck[]; readonly opened: number }> {
  const clock = new FakeClock(START);
  const client = doctorClient(world, session, clock);
  const engine = createMssqlEngine({ connect: client.connect });
  const checks = await engine.doctor(target, url, deps(clock));
  expect(client.openConnections()).toBe(0);
  return { checks, opened: client.connected.length };
}

const statuses = (checks: readonly DoctorCheck[]) =>
  checks.map((check) => [check.name, check.status]);

const installed = (world: World = freshWorld(SQL_SERVER)) => installedWorld(LISTINGS, world);

describe("the mssql engine", () => {
  it("is named mssql, reads mssql: and sqlserver:, and declares what the connector can do", () => {
    const engine = createMssqlEngine();
    expect(engine.name).toBe(ENGINE_NAME);
    expect(engine.name).toBe("mssql");
    expect(engine.schemes).toEqual(["mssql", "sqlserver"]);
    // A bare name is in dbo, as every plan reads it.
    expect(engine.label(LISTINGS)).toBe("dbo.listings");
    expect(engine.label({ ...LISTINGS, schema: "sales" })).toBe("sales.listings");
    expect(engine.capabilities).toBe(MSSQL_CAPABILITIES);
    expect(engine.checks).toBe(DOCTOR_CHECKS);
    expect(engine.checks.map((check) => check.name)).toEqual([
      "database",
      "version",
      "containment",
      "install",
      "trigger",
      // In the trigger check's place for capture: "change-tracking".
      "change-tracking",
      "grants",
      "queue",
    ]);
  });

  it("refuses a worker URL that would carry the password to another machine without TLS or past any certificate, in the variable's words", () => {
    const engine = createMssqlEngine();
    expect(engine.checkUrl(LISTINGS, WORKER_URL, { allowInsecure: false })).toBeUndefined();
    expect(
      engine.checkUrl(LISTINGS, `${WORKER_URL}?trustServerCertificate=true`, {
        allowInsecure: false,
      }),
    ).toBeUndefined();
    expect(engine.checkUrl(LISTINGS, REMOTE_URL, { allowInsecure: false })).toBeUndefined();
    expect(
      engine.checkUrl(LISTINGS, `${REMOTE_URL}?encrypt=false`, { allowInsecure: false }),
    ).toEqual({
      code: "database-url-tls",
      message:
        "LISTINGS_URL reaches db.example.com without TLS (encrypt=false), so the worker password would travel in the clear; no connection was made",
      fix: "remove encrypt=false from LISTINGS_URL, or pass --allow-insecure if that network is trusted",
    });
    expect(
      engine.checkUrl(LISTINGS, `${REMOTE_URL}?trustServerCertificate=true`, {
        allowInsecure: false,
      })?.message,
    ).toBe(
      "LISTINGS_URL takes any certificate db.example.com shows (trustServerCertificate=true), so a machine in between could read the worker password; no connection was made",
    );
    expect(
      engine.checkUrl(LISTINGS, `${REMOTE_URL}?encrypt=false`, { allowInsecure: true }),
    ).toBeUndefined();
    const { urlVariable: _, ...unnamed } = LISTINGS;
    expect(engine.checkUrl(unnamed, "Server=db;Database=x", { allowInsecure: false })).toEqual({
      code: "database-url",
      message:
        "the source's connection string is not a SQL Server URL (mssql://user:password@host:1433/database); no connection was made",
      fix: "set the source's connection string to mssql://facetdb_worker:<the worker password>@<host>:1433/<database>; a named instance (host\\instance) and an ADO.NET, ODBC, JDBC or Prisma key=value string are not read: give the instance's TCP port, and write the string as that URL",
    });
  });

  it("open refuses such a URL before any pool opens, and otherwise opens the connector as wide as the worker asks", async () => {
    const pools: number[] = [];
    const client = recordingClient({ answer: answer(installed()) });
    const engine = createMssqlEngine({
      pool: (url, options) => {
        pools.push(options.maxConnections);
        return client.connect(url);
      },
    });
    const refused = await engine
      .open(LISTINGS, `${REMOTE_URL}?encrypt=false`, { ...deps(), maxConnections: 3 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(EngineRefusal);
    expect(pools).toEqual([]);
    const connector = await engine.open(LISTINGS, WORKER_URL, {
      ...deps(),
      maxConnections: 3,
      workerId: "w9",
    });
    expect(pools).toEqual([3]);
    expect(connector.capabilities).toBe(MSSQL_CAPABILITIES);
    await connector.close();
    expect(client.openConnections()).toBe(0);
  });

  it("plans through the installer: nothing on an installed table", async () => {
    const client = recordingClient({ answer: answer(installed()) });
    const engine = createMssqlEngine({ connect: client.connect });
    const planned = await engine.planInstall(
      LISTINGS,
      "mssql://sa:pw@127.0.0.1:1433/listings",
      deps(),
    );
    expect(planned).toMatchObject({ ok: true, plan: { statements: [] } });
    expect(
      engine.render({ statements: [], transactional: true, removes: [], keeps: [], notes: [] }),
    ).toBe("");
  });

  it("names the server as its release", () => {
    expect(serverName({ edition: 3, majorVersion: 16 })).toBe("SQL Server 2022 (16)");
    expect(serverName({ edition: 2, majorVersion: 13 })).toBe("SQL Server 2016 (13)");
    expect(serverName({ edition: 3, majorVersion: 18 })).toBe("SQL Server version 18");
    expect(serverName({ edition: 5, majorVersion: 12 })).toBe("Azure SQL Database");
    expect(serverName({ edition: 8, majorVersion: 16 })).toBe("Azure SQL Managed Instance");
  });
});

describe("doctor", () => {
  it("passes every check on an installed table, in plain words, on one connection it lets go of", async () => {
    const { checks, opened } = await doctor(installed());
    expect(opened).toBe(1);
    expect(checks).toEqual([
      {
        name: "database",
        status: "ok",
        detail:
          '"listings": connected to 127.0.0.1:1433/listings as facetdb_worker over TLS, the server\'s certificate checked, 0 ms per round trip',
      },
      { name: "version", status: "ok", detail: "SQL Server 2022 (16)" },
      {
        name: "containment",
        status: "ok",
        detail:
          "listings is not contained: facetdb_worker is a server login with a user in this database; the database's owner is the login sa",
      },
      {
        name: "install",
        status: "ok",
        detail:
          "5 FacetDB columns on dbo.listings, the jobs table and the marker row of project proj_listings are there",
      },
      {
        name: "trigger",
        status: "ok",
        detail:
          "facetdb_listings is on dbo.listings and enabled; its text is checked by facetdb migrate --dry-run with the admin connection string, which plans nothing when it is as installed (the worker login may not read a trigger's text)",
      },
      {
        name: "app-writes",
        status: "warn",
        detail:
          'dbo.listings has a trigger, so an application statement on it with an OUTPUT clause and no INTO fails (error 334), as Entity Framework Core 7 and later write by default: declare the trigger to EF Core (HasTrigger("facetdb_listings") on the table\'s entity), or watch the table with Change Tracking instead of a trigger; and an insert that lists no columns (insert into dbo.listings values (…)) fails (error 213) until it names them',
      },
      {
        name: "grants",
        status: "ok",
        detail:
          "facetdb_worker selects the key, the 2 state columns and FacetDB's columns of dbo.listings, updates FacetDB's columns only, and has its rights on facetdb_jobs and facetdb_table_owners",
      },
      { name: "queue", status: "ok", detail: "2 jobs wait for dbo.listings, 1 is claimed" },
    ]);
  });

  it("says the worker is a user of the database on Azure SQL, and the TLS the URL asks for", async () => {
    const { checks } = await doctor(
      installed(freshWorld(AZURE_SQL)),
      {},
      LISTINGS,
      `${WORKER_URL}?trustServerCertificate=true`,
    );
    expect(checks.find((check) => check.name === "database")?.detail).toContain(
      "over TLS, taking any certificate the server shows (trustServerCertificate=true)",
    );
    expect(checks.find((check) => check.name === "version")?.detail).toBe("Azure SQL Database");
    expect(checks.find((check) => check.name === "containment")?.detail).toBe(
      "listings keeps its users itself (Azure SQL Database): facetdb_worker is a user of this database alone",
    );
  });

  it("compares the trigger's text where the worker may read it", async () => {
    const shown = await doctor(installed(), { definition: "shown" });
    expect(shown.checks.find((check) => check.name === "trigger")?.detail).toBe(
      "facetdb_listings is on dbo.listings, enabled, and its text is the one this config installs",
    );
    // The same table under onChange: keep wants another trigger text.
    const kept = await doctor(
      installed(),
      { definition: "shown" },
      { ...LISTINGS, onChange: "keep" },
    );
    expect(kept.checks.find((check) => check.name === "trigger")).toEqual({
      name: "trigger",
      status: "fail",
      detail:
        "the trigger facetdb_listings on dbo.listings is not the one this config installs (its state columns or its onChange differ, or it was changed by hand)",
      fix: "run facetdb migrate: it makes the trigger again as the config says",
    });
  });

  it("fails a missing or disabled trigger: no change reaches the queue", async () => {
    const world = installed();
    const names = tableNames(LISTINGS);
    const without: World = {
      ...world,
      objects: world.objects.filter((object) => object.name !== names.trigger),
    };
    const missing = await doctor(without);
    expect(missing.checks.find((check) => check.name === "trigger")).toMatchObject({
      status: "fail",
      detail:
        "dbo.listings has no trigger facetdb_listings, so no change of the table reaches the queue",
    });
    expect(missing.checks.some((check) => check.name === "app-writes")).toBe(false);
    const disabled: World = {
      ...world,
      objects: world.objects.map((object) =>
        object.name === names.trigger ? { ...object, disabled: true } : object,
      ),
    };
    expect((await doctor(disabled)).checks.find((check) => check.name === "trigger")?.detail).toBe(
      "the trigger facetdb_listings on dbo.listings is disabled, so no change of the table reaches the queue",
    );
  });

  it("fails a login that is not the worker's, and checks nothing more", async () => {
    const { checks } = await doctor(installed(), { user: "dbo" });
    expect(checks[0]).toEqual({
      name: "database",
      status: "fail",
      detail:
        '"listings": LISTINGS_URL logs in to 127.0.0.1:1433/listings as dbo (the user dbo of listings), not facetdb_worker',
      fix: "set LISTINGS_URL to the worker login: mssql://facetdb_worker:<the worker password>@<host>:1433/<database>",
    });
    // A trigger source's checks: the Change Tracking check is another capture's.
    expect(statuses(checks.slice(1))).toEqual(
      checksOf(LISTINGS)
        .slice(1)
        .map((check) => [check.name, "skip"]),
    );
  });

  it("refuses an insecure URL before it connects, and says an unreachable server without the password", async () => {
    const refused = await doctor(installed(), {}, LISTINGS, `${REMOTE_URL}?encrypt=false`);
    expect(refused.opened).toBe(0);
    expect(refused.checks[0]?.detail).toBe(
      '"listings": LISTINGS_URL reaches db.example.com without TLS (encrypt=false), so the worker password would travel in the clear; no connection was made',
    );
    const unreachable = await doctor(installed(), { failing: "select user_name()" });
    expect(unreachable.checks[0]).toEqual({
      name: "database",
      status: "fail",
      detail:
        "\"listings\": 127.0.0.1:1433/listings could not be reached as the worker login: The SELECT permission was denied on the object 'select user_name()'.",
      fix: "check the host, port, database and worker password in LISTINGS_URL, and that the server lets this machine connect",
    });
    expect(unreachable.checks[0]?.detail).not.toContain("secret");
  });

  it("fails the check a catalog read stopped in, and skips the rest", async () => {
    const { checks } = await doctor(installed(), { failing: "select s.name as schema_name" });
    expect(statuses(checks)).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["containment", "ok"],
      ["install", "ok"],
      ["trigger", "ok"],
      ["app-writes", "warn"],
      ["grants", "fail"],
      ["queue", "skip"],
    ]);
    expect(checks.find((check) => check.name === "grants")?.detail).toBe(
      "reading dbo.listings as the worker login failed: The SELECT permission was denied on the object 'select s.name as schema_name'.",
    );
  });

  it("fails a server older than SQL Server 2016, and a database whose owner has no login here", async () => {
    const old = installed({
      ...freshWorld(SQL_SERVER),
      server: { ...SQL_SERVER, majorVersion: 12 },
    });
    expect((await doctor(old)).checks.find((check) => check.name === "version")).toEqual({
      name: "version",
      status: "fail",
      detail: "SQL Server 2014 (12) is older than SQL Server 2016 (13), the oldest FacetDB runs on",
      fix: "upgrade the server to SQL Server 2016 or later, or move the database to Azure SQL",
    });
    const orphan = installed({
      ...freshWorld(SQL_SERVER),
      server: { ...SQL_SERVER, ownerLogin: null },
    });
    expect((await doctor(orphan)).checks.find((check) => check.name === "containment")).toEqual({
      name: "containment",
      status: "fail",
      detail:
        "the database listings is owned by a login this server does not have (a database restored from another server keeps its owner), so FacetDB's trigger, which runs as the table's owner, fails every application insert and update of the table (error 15517)",
      fix: "give the database an owner this server has: alter authorization on database::[listings] to [sa] (or another login), as an admin",
    });
    // Azure SQL Database maps dbo to its server admin, whose login lives in master.
    const azure = installed({
      ...freshWorld(AZURE_SQL),
      server: { ...AZURE_SQL, ownerLogin: null },
    });
    expect((await doctor(azure)).checks.find((check) => check.name === "containment")?.status).toBe(
      "ok",
    );
  });

  it("says a table renamed under its trigger fails every application write, from either side", async () => {
    const world = installed();
    const moved: World = {
      ...world,
      tables: Object.fromEntries(
        Object.entries(world.tables).map(([label, table]) => [
          label === "dbo.listings" ? "dbo.listings_old" : label,
          table,
        ]),
      ),
      objects: world.objects.map((object) =>
        object.type === "TR" ? { ...object, parent: "listings_old" } : object,
      ),
    };
    const { checks } = await doctor(moved);
    expect(checks.find((check) => check.name === "install")).toEqual({
      name: "install",
      status: "fail",
      detail:
        "dbo.listings was renamed to dbo.listings_old: FacetDB's trigger facetdb_listings moved with it and still writes to [dbo].[listings], so every insert and update of dbo.listings_old fails (error 208)",
      fix: "rename dbo.listings_old back to listings (exec sp_rename N'dbo.listings_old', N'listings'), then run facetdb doctor again",
    });
    expect(statuses(checks.slice(-3))).toEqual([
      ["trigger", "skip"],
      ["grants", "skip"],
      ["queue", "skip"],
    ]);
    // The config names the table by its new name, which carries the old name's trigger.
    const renamedTarget: EngineTarget = { ...LISTINGS, table: "listings_old" };
    const fromNew = await doctor(moved, {}, renamedTarget);
    expect(fromNew.checks.find((check) => check.name === "install")?.detail).toBe(
      "dbo.listings_old carries the trigger facetdb_listings, made for a table named listings: the table was renamed, and the trigger still writes to that name, so every insert and update of dbo.listings_old fails (error 208)",
    );
  });

  it("fails a table FacetDB is not installed on, or another project's, and skips what follows", async () => {
    const fresh = await doctor(freshWorld(SQL_SERVER));
    expect(fresh.checks.find((check) => check.name === "install")).toEqual({
      name: "install",
      status: "fail",
      detail:
        "FacetDB is not installed on dbo.listings: dbo.listings lacks is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed; dbo.facetdb_jobs is missing; dbo.facetdb_table_owners is missing",
      fix: "run facetdb migrate",
    });
    expect(statuses(fresh.checks.slice(-3))).toEqual([
      ["trigger", "skip"],
      ["grants", "skip"],
      ["queue", "skip"],
    ]);
    const world = installed();
    const theirs: World = {
      ...world,
      marker: (world.marker ?? []).map((row) => ({ ...row, projectId: "proj_other" })),
    };
    expect((await doctor(theirs)).checks.find((check) => check.name === "install")).toEqual({
      name: "install",
      status: "fail",
      detail: "dbo.listings belongs to another project (proj_other)",
      fix: "run doctor from that project's directory, or point the source at another table",
    });
  });

  it("fails grants the worker lacks, naming each", async () => {
    const world = installed();
    const fewer: World = {
      ...world,
      grants: world.grants.filter(
        (grant) =>
          !(grant.column === "facetdb_status" && grant.permission === "UPDATE") &&
          !(grant.object === "facetdb_jobs" && grant.permission === "DELETE"),
      ),
    };
    expect((await doctor(fewer)).checks.find((check) => check.name === "grants")).toEqual({
      name: "grants",
      status: "fail",
      detail: "facetdb_worker lacks update on facetdb_status, delete on facetdb_jobs",
      fix: "run facetdb migrate: it grants what is missing and nothing more",
    });
  });

  it("warns of a database more than 100 ms away, and counts the queue in plain words", async () => {
    const { checks } = await doctor(installed(), {
      roundTripMs: 140,
      jobs: { total: 1, claimed: 0 },
    });
    expect(checks.find((check) => check.name === "distance")).toEqual({
      name: "distance",
      status: "warn",
      detail:
        "127.0.0.1:1433/listings is 140 ms away; the 1 second target assumes a database within 100 ms",
    });
    expect(checks.find((check) => check.name === "queue")?.detail).toBe(
      "1 job waits for dbo.listings, 0 are claimed",
    );
  });
});
