import type { DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import { EngineRefusal } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { MYSQL_CAPABILITIES } from "../connector/index.ts";
import { createMysqlInstaller } from "../install/index.ts";
import type { MysqlRow } from "../sql/index.ts";
import {
  ADMIN_URL,
  type Answer,
  DEFAULT_SQL_MODE,
  ENGINE_DEPS,
  fakeServer,
  freshListings,
  installedListings,
  installedSideListings,
  listingsTarget,
  recordingDriver,
  type ScriptedDatabase,
  scriptedDatabase,
} from "../testing/index.ts";
import {
  atLeast,
  createMysqlEngine,
  DOCTOR_CHECKS,
  ENGINE_NAME,
  MINIMUM_MARIADB,
  MINIMUM_MYSQL,
  serverName,
} from "./index.ts";

/**
 * The MySQL engine: the installer spread as its plans, the worker URL refused before anything
 * connects, `open` as the connector with the worker's pool width, and doctor's checks on the
 * recording driver over a scripted database, with their words.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const WORKER_URL = "mysql://facetdb_worker:secret@127.0.0.1:3306/app";
const REMOTE_URL = "mysql://facetdb_worker:secret@db.example.com:3306/app";

function target(changes: Partial<EngineTarget> = {}): EngineTarget {
  return listingsTarget({ urlVariable: "LISTINGS_URL", ...changes });
}

/** What a doctor session on the worker login sees besides the catalog. */
type Server = {
  readonly login?: string;
  readonly version?: string;
  readonly tls?: string;
  readonly jobs?: { readonly total: number; readonly claimed: number };
  /** The round trip each `select 1` takes on the fake clock. */
  readonly roundTripMs?: number;
  /** `@@global.log_bin` and `@@global.log_bin_trust_function_creators`; both off when absent. */
  readonly binaryLogging?: boolean;
  readonly trustCreators?: boolean;
  /** `@@global.binlog_format`; `ROW` when absent. */
  readonly binlogFormat?: string;
};

/** The scripted database answering the plans' reads, and the session reads doctor adds. */
function doctorDriver(database: ScriptedDatabase, server: Server = {}, clock?: FakeClock) {
  const catalog = scriptedDatabase(database);
  const answer: Answer = (text, params) => {
    if (text.includes("current_user() as login")) {
      return [
        {
          login: server.login ?? "facetdb_worker@%",
          server_version: server.version ?? database.version ?? "8.4.3",
          current_database: database.database,
          sql_mode: database.sqlMode ?? DEFAULT_SQL_MODE,
          log_bin: server.binaryLogging === true ? 1 : 0,
          trust_creators: server.trustCreators === true ? 1 : 0,
          binlog_format: server.binlogFormat ?? "ROW",
        },
      ];
    }
    if (text.startsWith("show session status like 'Ssl_cipher'")) {
      return [{ Variable_name: "Ssl_cipher", Value: server.tls ?? "" }];
    }
    if (text === "select 1") {
      clock?.advance(server.roundTripMs ?? 1);
      return [{ "1": 1 }];
    }
    if (text.includes("count(*) as total")) {
      const jobs = server.jobs ?? { total: 0, claimed: 0 };
      return [{ total: jobs.total, claimed: jobs.claimed } satisfies MysqlRow];
    }
    return catalog(text, params);
  };
  return recordingDriver(answer);
}

function deps(clock = new FakeClock(START)): EngineDeps {
  return { ...ENGINE_DEPS, clock };
}

const brief = (checks: readonly DoctorCheck[]) => checks.map((check) => [check.name, check.status]);

describe("the engine", () => {
  it("is the engine of mysql: and mariadb:, with the install plans, several workers and doctor's six checks", async () => {
    const driver = recordingDriver(scriptedDatabase(freshListings()));
    const engine = createMysqlEngine({ connect: driver.connect });
    expect(engine.name).toBe(ENGINE_NAME);
    expect(engine.schemes).toEqual(["mysql", "mariadb"]);
    // A bare name is in the connection string's database, as the plans name it; the config's
    // database wins; a string whose path names none leaves the name bare.
    expect(engine.label(listingsTarget(), WORKER_URL)).toBe("app.listings");
    expect(engine.label(listingsTarget(), "mysql://admin:pw@127.0.0.1:3306/my%20shop")).toBe(
      "my shop.listings",
    );
    expect(engine.label(listingsTarget({ schema: "shop" }), WORKER_URL)).toBe("shop.listings");
    expect(engine.label(listingsTarget(), "mysql://admin:pw@127.0.0.1:3306/")).toBe("listings");
    expect(engine.label(listingsTarget(), "mysql://admin:pw@127.0.0.1:3306")).toBe("listings");
    expect(engine.capabilities).toBe(MYSQL_CAPABILITIES);
    expect(engine.checks).toBe(DOCTOR_CHECKS);
    expect(engine.checks.map((check) => check.name)).toEqual([
      "database",
      "version",
      "capture",
      "install",
      "grants",
      "queue",
    ]);
    // Said once, where doctor --dry-run says what each check reads.
    expect(engine.checks.find((check) => check.name === "capture")?.looksAt).toBe(
      "reads that changes are still queued as far as the worker login sees: the jobs table. The worker login cannot see triggers, so a dropped trigger is not noticed by the worker: facetdb migrate --dry-run with the admin connection string checks them",
    );
    const options = { ...ENGINE_DEPS, workerPassword: "a-long-random-password" };
    const planned = await engine.planInstall(target(), ADMIN_URL, options);
    const direct = await createMysqlInstaller({
      connect: recordingDriver(scriptedDatabase(freshListings())).connect,
    }).planInstall(target(), ADMIN_URL, options);
    expect(planned).toEqual(direct);
    expect(planned.ok && engine.render(planned.plan)).toContain("create table if not exists");
  });

  it("refuses a worker URL that would carry the password in the clear, before anything connects", async () => {
    const driver = recordingDriver(scriptedDatabase(installedListings()));
    const engine = createMysqlEngine({ connect: driver.connect });
    const refusal = engine.checkUrl(target(), REMOTE_URL, { allowInsecure: false });
    expect(refusal).toEqual({
      code: "database-url-tls",
      message:
        "LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      fix: 'add ?ssl={"rejectUnauthorized":true} to LISTINGS_URL (mysql2 reads ssl as a JSON object, so ssl=true does not turn TLS on), or pass --allow-insecure if that network is trusted',
    });
    expect(engine.checkUrl(target(), REMOTE_URL, { allowInsecure: true })).toBeUndefined();
    expect(engine.checkUrl(target(), WORKER_URL, { allowInsecure: false })).toBeUndefined();
    expect(engine.checkUrl(listingsTarget(), "not a url", { allowInsecure: false })?.message).toBe(
      "the source's connection string is not a connection string (mysql://user:password@host:3306/database); no connection was made",
    );

    const opened = await engine.open(target(), REMOTE_URL, { ...deps(), workerId: "w1" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(opened).toBeInstanceOf(EngineRefusal);
    expect((opened as EngineRefusal).refusal.code).toBe("database-url-tls");
    const checks = await engine.doctor(target(), REMOTE_URL, deps());
    expect(brief(checks)).toEqual([
      ["database", "fail"],
      ["version", "skip"],
      ["capture", "skip"],
      ["install", "skip"],
      ["grants", "skip"],
      ["queue", "skip"],
    ]);
    expect(checks[0]?.detail).toContain(
      '"listings": LISTINGS_URL reaches db.example.com without TLS',
    );
    expect(driver.opened).toBe(0);
  });

  it("opens the connector over the pool, as wide as the worker asks, with its id", async () => {
    const server = fakeServer({
      database: "app",
      table: "listings",
      state: ["title", "description"],
    });
    const engine = createMysqlEngine({
      connect: recordingDriver(scriptedDatabase(installedListings())).connect,
      pool: server.connect,
    });
    const connector = await engine.open(target(), WORKER_URL, {
      ...deps(),
      workerId: "w1",
      maxConnections: 10,
    });
    expect(server.pools).toEqual([{ maxConnections: 10 }]);
    expect(connector.capabilities).toBe(MYSQL_CAPABILITIES);
    server.edit("1", { title: "A red car", description: "Runs well" });
    expect(await connector.claim(5)).toEqual(["1"]);
    expect(server.jobs[0]?.claimedBy).toBe("w1");
    await connector.close();
    expect(server.closed).toBe(1);
  });

  it("refuses to open side-table mode on a table no longer InnoDB, in install's words, and closes its pool", async () => {
    const server = fakeServer({
      database: "app",
      table: "listings",
      state: ["title", "description"],
      sideTable: true,
      engine: "MyISAM",
    });
    const engine = createMysqlEngine({ connect: recordingDriver().connect, pool: server.connect });
    const opening = engine.open(target({ storage: "side-table" }), WORKER_URL, deps());
    await expect(opening).rejects.toBeInstanceOf(EngineRefusal);
    await expect(opening).rejects.toMatchObject({
      refusal: {
        code: "table-engine",
        message: expect.stringContaining("app.listings is a MyISAM table"),
        fix: expect.stringContaining("alter table app.listings engine = InnoDB"),
      },
    });
    expect(server.closed).toBe(1);
    // Inline mode opens on it: the worker takes no side-row lock there.
    const inline = fakeServer({
      database: "app",
      table: "listings",
      state: ["title", "description"],
      engine: "MyISAM",
    });
    const opened = await createMysqlEngine({
      connect: recordingDriver().connect,
      pool: inline.connect,
    }).open(target(), WORKER_URL, deps());
    await opened.close();
  });
});

describe("versions", () => {
  it("names the server and compares its version part by part", () => {
    expect(serverName("8.4.3")).toEqual({ engine: "MySQL", number: "8.4.3" });
    expect(serverName("10.6.20-MariaDB-ubu2204")).toEqual({ engine: "MariaDB", number: "10.6.20" });
    expect(serverName("8.0.40-0ubuntu0.22.04.1")).toEqual({ engine: "MySQL", number: "8.0.40" });
    expect(atLeast("8.0.0", MINIMUM_MYSQL)).toBe(true);
    expect(atLeast("8.4", MINIMUM_MYSQL)).toBe(true);
    expect(atLeast("5.7.44", MINIMUM_MYSQL)).toBe(false);
    expect(atLeast("10.5.27", MINIMUM_MARIADB)).toBe(true);
    expect(atLeast("10.11.9", MINIMUM_MARIADB)).toBe(true);
    expect(atLeast("10.4.33", MINIMUM_MARIADB)).toBe(false);
  });
});

describe("doctor", () => {
  it("passes every check on an installed table under the worker login, saying what it found", async () => {
    const clock = new FakeClock(START);
    const driver = doctorDriver(
      installedListings(),
      { tls: "TLS_AES_256_GCM_SHA384", jobs: { total: 3, claimed: 1 } },
      clock,
    );
    const engine = createMysqlEngine({ connect: driver.connect });
    const checks = await engine.doctor(target(), WORKER_URL, deps(clock));
    expect(checks).toEqual([
      {
        name: "database",
        status: "ok",
        detail:
          '"listings": connected to 127.0.0.1:3306/app as facetdb_worker@% over TLS (TLS_AES_256_GCM_SHA384), 1 ms per round trip',
      },
      { name: "version", status: "ok", detail: "MySQL 8.4.3" },
      {
        name: "capture",
        status: "ok",
        detail:
          "app.facetdb_jobs is there; the triggers are checked by facetdb migrate --dry-run with the admin connection string, which plans nothing when they are as installed",
      },
      {
        name: "install",
        status: "ok",
        detail:
          "5 marked columns on app.listings and the marker row of project proj_listings are there",
      },
      {
        name: "grants",
        status: "ok",
        detail:
          "'facetdb_worker'@'%' selects the key, the 2 state columns and FacetDB's columns of app.listings, updates FacetDB's columns only, and has its rights on facetdb_jobs and facetdb_table_owners",
      },
      { name: "queue", status: "ok", detail: "2 jobs wait for listings, 1 is claimed" },
    ]);
    // One connection, closed; nothing written.
    expect(driver.opened).toBe(1);
    expect(driver.closed).toBe(1);
    expect(driver.sent.every((sent) => /^(select|show)/.test(sent.text))).toBe(true);
  });

  it("checks the side table, the view and the worker's side-table rights in side-table mode", async () => {
    const clock = new FakeClock(START);
    const side = target({ storage: "side-table" });
    const driver = doctorDriver(
      installedSideListings(side),
      { tls: "TLS_AES_256_GCM_SHA384" },
      clock,
    );
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      side,
      WORKER_URL,
      deps(clock),
    );
    expect(checks.find((check) => check.name === "install")).toEqual({
      name: "install",
      status: "ok",
      detail:
        "5 marked columns on app.facetdb_listings_answers, the view app.listings_with_answers and the marker row of project proj_listings are there",
    });
    expect(checks.find((check) => check.name === "grants")).toEqual({
      name: "grants",
      status: "ok",
      detail:
        "'facetdb_worker'@'%' selects the key and the 2 state columns of app.listings and writes none of it, writes the rows of facetdb_listings_answers, selects listings_with_answers, and has its rights on facetdb_jobs and facetdb_table_owners",
    });

    // Without the view, and without the worker's delete on the side table, both say so.
    const installed = installedSideListings(side);
    const broken = doctorDriver(
      {
        ...installed,
        tables: installed.tables.filter((table) => table.name !== "listings_with_answers"),
        worker: {
          ...installed.worker,
          tables: (installed.worker?.tables ?? []).filter(
            (held) =>
              !(held.table === "facetdb_listings_answers" && held.privilege === "DELETE") &&
              held.table !== "listings_with_answers",
          ),
        },
      },
      {},
      clock,
    );
    const failed = await createMysqlEngine({ connect: broken.connect }).doctor(
      side,
      WORKER_URL,
      deps(clock),
    );
    expect(failed.find((check) => check.name === "install")).toMatchObject({
      status: "fail",
      detail: "FacetDB is not installed on app.listings: app.listings_with_answers is missing",
      fix: "run facetdb migrate",
    });
    expect(failed.find((check) => check.name === "grants")).toMatchObject({
      status: "fail",
      detail:
        "'facetdb_worker'@'%' lacks delete on facetdb_listings_answers, select on listings_with_answers",
    });
  });

  it("warns of a far database and of plain TCP, and reads a MariaDB's version", async () => {
    const clock = new FakeClock(START);
    const driver = doctorDriver(
      { ...installedListings(), version: "10.6.20-MariaDB-ubu2204" },
      { roundTripMs: 190 },
      clock,
    );
    const engine = createMysqlEngine({ connect: driver.connect });
    const checks = await engine.doctor(target(), WORKER_URL, deps(clock));
    expect(brief(checks)).toEqual([
      ["database", "ok"],
      ["distance", "warn"],
      ["version", "ok"],
      ["capture", "ok"],
      ["install", "ok"],
      ["grants", "ok"],
      ["queue", "ok"],
    ]);
    expect(checks[0]?.detail).toContain("without TLS, 190 ms per round trip");
    expect(checks[1]?.detail).toBe(
      "127.0.0.1:3306/app is 190 ms away; the 1 second target assumes a database within 100 ms",
    );
    expect(checks[2]?.detail).toBe("MariaDB 10.6.20");
  });

  it("warns of binary logging without trusted creators, and of NO_BACKSLASH_ESCAPES, never failing", async () => {
    const driver = doctorDriver(
      { ...installedListings(), sqlMode: "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES" },
      { binaryLogging: true, trustCreators: false },
    );
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(brief(checks)).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["binlog", "warn"],
      ["sql-mode", "warn"],
      ["capture", "ok"],
      ["install", "ok"],
      ["grants", "ok"],
      ["queue", "ok"],
    ]);
    expect(checks[2]?.detail).toContain("needs an admin with SUPER (error 1419 otherwise)");
    expect(checks[3]?.detail).toBe(
      "the server's sql_mode has NO_BACKSLASH_ESCAPES; the worker drops it in its own sessions, and facetdb migrate refuses to run until it is removed from the server's",
    );
    // Statement-based binary logging refuses InnoDB writes under read committed: a failure.
    const statement = doctorDriver(installedListings(), {
      binaryLogging: true,
      trustCreators: true,
      binlogFormat: "STATEMENT",
    });
    const refused = await createMysqlEngine({ connect: statement.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(refused[2]).toEqual({
      name: "binlog",
      status: "fail",
      detail:
        "binary logging is on with binlog_format = STATEMENT, under which InnoDB refuses the worker's writes in its read committed sessions (error 1665), so every claim, write and ack would fail",
      fix: "set binlog_format to ROW or MIXED (MySQL 8's default is ROW), then run doctor again",
    });
    // Trusted creators, or no binary log: no warning.
    const trusted = doctorDriver(installedListings(), { binaryLogging: true, trustCreators: true });
    const quiet = await createMysqlEngine({ connect: trusted.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(brief(quiet).map(([name]) => name)).toEqual([
      "database",
      "version",
      "capture",
      "install",
      "grants",
      "queue",
    ]);
  });

  it("fails the version on a server older than FacetDB runs on", async () => {
    const driver = doctorDriver({ ...installedListings(), version: "5.7.44" });
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(checks[1]).toEqual({
      name: "version",
      status: "fail",
      detail: "MySQL 5.7.44 is older than 8.0, the oldest FacetDB runs on",
      fix: "upgrade the server to MySQL 8.0 or later",
    });
  });

  it("fails the database check when the login is not the worker's, and skips the rest", async () => {
    const driver = doctorDriver(installedListings(), { login: "root@%" });
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      "mysql://root:secret@127.0.0.1:3306/app",
      deps(),
    );
    expect(brief(checks)).toEqual([
      ["database", "fail"],
      ["version", "skip"],
      ["capture", "skip"],
      ["install", "skip"],
      ["grants", "skip"],
      ["queue", "skip"],
    ]);
    expect(checks[0]).toMatchObject({
      detail:
        '"listings": LISTINGS_URL logs in to 127.0.0.1:3306/app as root@%, not facetdb_worker',
      fix: "set LISTINGS_URL to the worker login: mysql://facetdb_worker:<the worker password>@<host>:3306/<database>",
    });
  });

  it("fails install, grants and skips queue on a table FacetDB is not installed on", async () => {
    const driver = doctorDriver(freshListings());
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(brief(checks)).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["capture", "fail"],
      ["install", "fail"],
      ["grants", "fail"],
      ["queue", "skip"],
    ]);
    // The jobs table is the capture's, in the words it had under install.
    expect(checks[2]).toMatchObject({
      detail: "FacetDB is not installed on app.listings: app.facetdb_jobs is missing",
      fix: "run facetdb migrate",
    });
    expect(checks[3]).toMatchObject({
      detail:
        "FacetDB is not installed on app.listings: app.listings lacks is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed; app.facetdb_table_owners is missing",
      fix: "run facetdb migrate",
    });
    expect(checks[4]?.detail).toBe(
      "'facetdb_worker'@'%' lacks select on id, select on title, select on description, select on is_scam, select on is_scam_probability, select on facetdb_status, select on facetdb_updated_at, select on facetdb_reviewed, update on is_scam, update on is_scam_probability, update on facetdb_status, update on facetdb_updated_at, update on facetdb_reviewed, select on facetdb_jobs, insert on facetdb_jobs, update on facetdb_jobs, delete on facetdb_jobs, select on facetdb_table_owners",
    );
  });

  it("fails capture, not install, on a jobs table that is gone, and skips the queue", async () => {
    const installed = installedListings();
    const driver = doctorDriver({
      ...installed,
      tables: installed.tables.filter((table) => table.name !== "facetdb_jobs"),
    });
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(checks.find((check) => check.name === "capture")).toEqual({
      name: "capture",
      status: "fail",
      detail: "FacetDB is not installed on app.listings: app.facetdb_jobs is missing",
      fix: "run facetdb migrate",
    });
    expect(checks.find((check) => check.name === "install")?.status).toBe("ok");
    expect(checks.find((check) => check.name === "queue")).toEqual({
      name: "queue",
      status: "skip",
      detail: "nothing is installed to queue for",
    });
    // The first failure is what the worker's verdict reads: the capture, which raises.
    expect(checks.find((check) => check.status === "fail")?.name).toBe("capture");
  });

  it("fails install on another project's table, and names a missing grant", async () => {
    const theirs = installedListings();
    const driver = doctorDriver({
      ...theirs,
      owners: [{ table: "listings", projectId: "proj_other", source: "listings" }],
      worker: {
        ...theirs.worker,
        tables: (theirs.worker?.tables ?? []).filter((held) => held.privilege !== "DELETE"),
      },
    });
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(checks[2]).toMatchObject({ name: "capture", status: "ok" });
    expect(checks[3]).toMatchObject({
      status: "fail",
      detail: "app.listings belongs to another project (proj_other)",
    });
    expect(checks[4]).toMatchObject({
      status: "fail",
      detail: "'facetdb_worker'@'%' lacks delete on facetdb_jobs",
      fix: "run facetdb migrate: it grants what is missing and nothing more",
    });
    expect(checks[5]).toEqual({
      name: "queue",
      status: "skip",
      detail: "the table is another project's",
    });
  });

  it("fails install in side-table mode on a table converted from InnoDB since install, in install's words", async () => {
    const side = target({ storage: "side-table" });
    const installed = installedSideListings(side);
    const converted: ScriptedDatabase = {
      ...installed,
      tables: installed.tables.map((table) =>
        table.name === "listings" ? { ...table, engine: "MyISAM" } : table,
      ),
    };
    const checks = await createMysqlEngine({ connect: doctorDriver(converted).connect }).doctor(
      side,
      WORKER_URL,
      deps(),
    );
    expect(brief(checks)).toEqual([
      ["database", "ok"],
      ["version", "ok"],
      ["capture", "ok"],
      ["install", "fail"],
      ["grants", "ok"],
      ["queue", "ok"],
    ]);
    expect(checks[3]).toEqual({
      name: "install",
      status: "fail",
      detail:
        "app.listings is a MyISAM table; side-table mode keeps the answers in an InnoDB table beside it and serializes the worker's write with the application's on InnoDB's row locks, which a MyISAM table does not take, so the two could wait on each other until a lock timeout",
      fix: 'convert the table to InnoDB (alter table app.listings engine = InnoDB), or set storage "inline" for this source, then run facetdb migrate again',
    });
    // Inline mode takes no side-row lock: a MyISAM table is no failure of its.
    const inline = installedListings();
    const myisam: ScriptedDatabase = {
      ...inline,
      tables: inline.tables.map((table) =>
        table.name === "listings" ? { ...table, engine: "MyISAM" } : table,
      ),
    };
    const inlineChecks = await createMysqlEngine({
      connect: doctorDriver(myisam).connect,
    }).doctor(target(), WORKER_URL, deps());
    expect(inlineChecks.find((check) => check.name === "install")?.status).toBe("ok");
  });

  it("reports a server that cannot be reached, without the password, and skips the rest", async () => {
    const driver = recordingDriver(() => {
      throw new Error(
        "connect ECONNREFUSED 127.0.0.1:3306 (mysql://facetdb_worker:secret@127.0.0.1:3306/app)",
      );
    });
    const checks = await createMysqlEngine({ connect: driver.connect }).doctor(
      target(),
      WORKER_URL,
      deps(),
    );
    expect(checks[0]).toEqual({
      name: "database",
      status: "fail",
      detail:
        '"listings": 127.0.0.1:3306/app could not be reached as the worker login: connect ECONNREFUSED 127.0.0.1:3306 (***)',
      fix: "check the host, port, database and worker password in LISTINGS_URL, and that the server lets this machine connect",
      unreachable: true,
    });
    expect(
      brief(checks)
        .slice(1)
        .every(([, status]) => status === "skip"),
    ).toBe(true);
  });
});
