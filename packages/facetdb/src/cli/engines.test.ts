import type { DatabaseEngine } from "@facetdb/core";
import { FakeEngine } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  configFileSource,
  facetdb,
  noul,
  parseProjectConfig,
  toProjectJson,
} from "../config/index.ts";
import { engineFor, isPostgresUrl, lazyEngine, readsUrl, schemeOf } from "./engines.ts";
import { processDeps } from "./main.ts";
import { CliError, type EngineEntry } from "./program.ts";

/**
 * Which engine serves a source, with the fake engine: the scheme table, the `connector: "polling"`
 * override, the refusal of a scheme no engine reads, and an engine loaded only when a source of its
 * scheme asks for it; and the composition root's own registration, whose polling engine `connector:
 * "polling"` resolves to.
 */

/** An entry over a fake engine, counting its loads: the loader shape main.ts registers. */
function entry(key: string, schemes: readonly string[] = [key]) {
  const engine = new FakeEngine({ name: key, schemes });
  const loads = { count: 0 };
  return {
    engine,
    loads,
    entry: lazyEngine(key, () => {
      loads.count += 1;
      return Promise.resolve<DatabaseEngine>(engine);
    }),
  };
}

const postgres = entry("postgres", ["postgres", "postgresql"]);
const mysql = entry("mysql", ["mysql", "mariadb"]);
const sqlite = entry("sqlite", ["sqlite", "file"]);
const libsql = entry("libsql");
const mssql = entry("mssql", ["mssql", "sqlserver"]);
const mongodb = entry("mongodb", ["mongodb", "mongodb+srv"]);
const cockroachdb = entry("cockroachdb");
const oracle = entry("oracle");
const everyEngine: readonly EngineEntry[] = [
  postgres,
  mysql,
  sqlite,
  libsql,
  mssql,
  mongodb,
  cockroachdb,
  oracle,
].map((one) => one.entry);

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CliError)) {
    throw new Error(`expected a CliError, got ${String(error)}`);
  }
  return error;
}

describe("the scheme table", () => {
  it.each([
    ["postgres://u:p@db.example.com/app", postgres],
    ["postgresql://u:p@db.example.com/app", postgres],
    ["mysql://u:p@db.example.com/app", mysql],
    ["mariadb://u:p@db.example.com/app", mysql],
    ["mssql://u:p@db.example.com/app", mssql],
    ["sqlserver://u:p@db.example.com/app", mssql],
    ["sqlite:///var/lib/app.db", sqlite],
    ["file:./app.db", sqlite],
    ["./data/app.db", sqlite],
    ["/var/lib/app.sqlite", sqlite],
    ["app.sqlite3", sqlite],
    ["libsql://app-org.turso.io", libsql],
    ["https://app.libsql.example.com", libsql],
    ["mongodb://u:p@db.example.com/app", mongodb],
    ["mongodb+srv://u:p@cluster.example.com/app", mongodb],
    ["cockroachdb://u:p@db.example.com:26257/app", cockroachdb],
    ["oracle://u:p@db.example.com:1521/FREEPDB1", oracle],
  ])("%s is read by its engine", async (url, expected) => {
    expect(await engineFor(everyEngine, url)).toBe(expected.engine);
  });

  it("reads a scheme in any case, and an http(s) URL whose host is neither Turso's nor libsql's as itself", () => {
    expect(schemeOf("POSTGRES://db.example.com/app")).toBe("postgres");
    expect(schemeOf("https://api.example.com/app")).toBe("https");
    expect(schemeOf("http://127.0.0.1:8080")).toBe("http");
    expect(schemeOf("https://notturso.io.example.com")).toBe("https");
    expect(schemeOf("https://app-org.turso.io")).toBe("libsql");
    expect(schemeOf("http://sqld.libsql.internal:8080")).toBe("libsql");
    expect(schemeOf("data/app.csv")).toBeUndefined();
    expect(isPostgresUrl("postgresql://db.example.com/app")).toBe(true);
    expect(isPostgresUrl("mysql://db.example.com/app")).toBe(false);
  });

  it.each(["sqlite:///var/lib/app.db", "file:./app.db", "./data/app.db", "/var/lib/app.db"])(
    "%s is read by the SQLite engine main.ts registers",
    async (url) => {
      const { engines } = processDeps();
      expect(readsUrl(engines, url)).toBe(true);
      const engine = await engineFor(engines, url);
      expect(engine.name).toBe("sqlite");
      expect(engine.schemes).toEqual(["sqlite", "file"]);
      expect(engine.capabilities).toMatchObject({ multipleWorkers: false, pushWakeup: false });
    },
  );

  it.each(["mysql://u:p@127.0.0.1:3306/app", "mariadb://u:p@127.0.0.1:3307/app"])(
    "%s is read by the MySQL engine main.ts registers",
    async (url) => {
      const { engines } = processDeps();
      expect(readsUrl(engines, url)).toBe(true);
      const engine = await engineFor(engines, url);
      expect(engine.name).toBe("mysql");
      expect(engine.schemes).toEqual(["mysql", "mariadb"]);
      expect(engine.capabilities).toMatchObject({
        multipleWorkers: true,
        pushWakeup: false,
        sideTable: true,
      });
    },
  );

  it.each(["mssql://u:p@127.0.0.1:1433/app", "sqlserver://u:p@127.0.0.1:1433/app"])(
    "%s is read by the SQL Server engine main.ts registers",
    async (url) => {
      const { engines } = processDeps();
      expect(readsUrl(engines, url)).toBe(true);
      const engine = await engineFor(engines, url);
      expect(engine.name).toBe("mssql");
      expect(engine.schemes).toEqual(["mssql", "sqlserver"]);
      expect(engine.capabilities).toMatchObject({
        multipleWorkers: true,
        pushWakeup: false,
        sideTable: true,
      });
    },
  );

  it.each([
    "mongodb://u:p@127.0.0.1:27017/app",
    "mongodb+srv://u:p@cluster0.example.net/app",
    "mongodb://u:p@a.example.com:27017,b.example.com:27017/app?replicaSet=rs0",
  ])("%s is read by the MongoDB engine main.ts registers", async (url) => {
    const { engines } = processDeps();
    expect(readsUrl(engines, url)).toBe(true);
    const engine = await engineFor(engines, url);
    expect(engine.name).toBe("mongodb");
    expect(engine.schemes).toEqual(["mongodb", "mongodb+srv"]);
    expect(engine.capabilities).toMatchObject({
      multipleWorkers: true,
      pushWakeup: true,
      sideTable: false,
    });
  });

  it.each([
    "libsql://listings-acme.turso.io",
    "https://listings-acme.aws-us-east-1.turso.io",
    "http://libsql:8080",
    "libsql://127.0.0.1:8080?tls=0",
  ])("%s is read by the libSQL engine main.ts registers", async (url) => {
    const { engines } = processDeps();
    expect(readsUrl(engines, url)).toBe(true);
    const engine = await engineFor(engines, url);
    expect(engine.name).toBe("libsql");
    expect(engine.schemes).toEqual(["libsql", "https", "http"]);
    expect(engine.capabilities).toMatchObject({
      multipleWorkers: false,
      pushWakeup: false,
      sideTable: false,
    });
  });

  it("a libSQL source's JSON export and config file name its variable, never its URL or token", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "libsql://listings-acme.turso.io",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const [source] = config.sources;
    if (source === undefined) throw new Error("fixture has a source");
    const parsed = parseProjectConfig({
      ...config,
      sources: [{ ...source, databaseEnv: "LISTINGS_URL" }],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    // The engine reads the token from LISTINGS_URL_AUTH_TOKEN when it connects; the config holds
    // no token to export.
    const json = JSON.stringify(toProjectJson(parsed.config));
    expect(json).toContain('"database":{"env":"LISTINGS_URL"}');
    const file = configFileSource(parsed.config);
    expect(file).toContain("database: process.env.LISTINGS_URL");
    for (const text of [json, file]) {
      expect(text).not.toContain("turso.io");
      expect(text).not.toContain("AUTH_TOKEN");
    }
  });

  it("says which schemes an engine is registered for without loading any", () => {
    const counted = entry("postgres", ["postgres", "postgresql"]);
    expect(readsUrl([counted.entry], "postgres://db.example.com/app")).toBe(true);
    expect(readsUrl([counted.entry], "mysql://db.example.com/app")).toBe(false);
    expect(counted.loads.count).toBe(0);
  });

  it.each([
    "oracle://facetdb_worker:pw@127.0.0.1:1521/FREEPDB1",
    "oracle://facetdb_worker:pw@db.example.com:2484/ORCLPDB1?protocol=tcps",
  ])("%s is read by the Oracle polling engine main.ts registers", async (url) => {
    const oracleTarget: Parameters<DatabaseEngine["checkUrl"]>[0] = {
      project: { id: "proj_listings", name: "Listings" },
      source: "listings",
      table: "LISTINGS",
      schema: "APP",
      storage: "inline",
      onChange: "reset",
      questionSet: { questions: [], read: ["TITLE"], model: "jev-1.14.0", thresholds: {} },
      urlVariable: "LISTINGS_URL",
    };
    const { engines } = processDeps();
    expect(readsUrl(engines, url)).toBe(true);
    const engine = await engineFor(engines, url);
    expect(engine.name).toBe("polling");
    expect(engine.schemes).toEqual(["oracle"]);
    expect(engine.capabilities).toMatchObject({
      multipleWorkers: false,
      pushWakeup: false,
      sideTable: false,
    });
    expect(engine.checkUrl(oracleTarget, url, { allowInsecure: false })).toBeUndefined();
    expect(
      engine.checkUrl(oracleTarget, "oracle://u:p@db.example.com:1521/ORCLPDB1", {
        allowInsecure: false,
      }),
    ).toMatchObject({ code: "database-url-tls" });
  });

  describe("cockroachdb:// is read by the CockroachDB polling dialect main.ts registers", () => {
    const listingsTarget = {
      project: { id: "p", name: "p" },
      source: "listings",
      table: "listings",
      storage: "inline",
      onChange: "reset",
      questionSet: { questions: [], read: [], model: "jev-1.14.0", thresholds: {} },
      urlVariable: "LISTINGS_URL",
    } as const;

    it.each([
      "cockroachdb://root@127.0.0.1:26257/defaultdb",
      "cockroachdb://u:p@db.example.com:26257/app?sslmode=verify-full",
    ])("%s", async (url) => {
      const { engines } = processDeps();
      expect(readsUrl(engines, url)).toBe(true);
      const engine = await engineFor(engines, url);
      expect(engine.name).toBe("polling");
      expect(engine.schemes).toEqual(["cockroachdb"]);
      expect(engine.capabilities).toMatchObject({
        multipleWorkers: false,
        pushWakeup: false,
        sideTable: false,
      });
      expect(engine.checkUrl(listingsTarget, url, { allowInsecure: false })).toBeUndefined();
    });

    it("refuses a plaintext URL to another machine before connecting, unless --allow-insecure says the network is trusted", async () => {
      const { engines } = processDeps();
      const url = "cockroachdb://facetdb_worker:pw@db.example.com:26257/app";
      const engine = await engineFor(engines, url);
      expect(engine.checkUrl(listingsTarget, url, { allowInsecure: false })).toEqual({
        code: "database-url-tls",
        message:
          "LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
        fix: "add ?sslmode=verify-full to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
      });
      expect(engine.checkUrl(listingsTarget, url, { allowInsecure: true })).toBeUndefined();
    });

    it('dispatches a postgres:// source with connector: "polling" by version(), and doctor lists the line that says which it found', async () => {
      const { engines } = processDeps();
      const engine = await engineFor(engines, "postgres://u:p@db.example.com/app", "polling");
      expect(engine.checks[0]?.name).toBe("dialect");
      expect(engine.checks.map((check) => check.name)).toEqual([
        "dialect",
        "database",
        "pooler",
        "install",
        "worker",
      ]);
    });
  });
});

describe("an engine is loaded on first use, for a source of its scheme only", () => {
  it("loads the matching engine once, and never the others", async () => {
    const pg = entry("postgres", ["postgres", "postgresql"]);
    const sqlServer = entry("mssql", ["mssql", "sqlserver"]);
    const entries = [pg.entry, sqlServer.entry];
    expect([pg.loads.count, sqlServer.loads.count]).toEqual([0, 0]);
    await engineFor(entries, "postgres://db.example.com/app");
    await engineFor(entries, "postgresql://db.example.com/other");
    expect([pg.loads.count, sqlServer.loads.count]).toEqual([1, 0]);
  });
});

describe("the connector: override", () => {
  it('refuses "polling" where no polling engine is registered, naming the engines that are', async () => {
    const error = await refusal(
      engineFor([postgres.entry], "postgres://db.example.com/app", "polling"),
    );
    expect(error.code).toBe("connector-polling");
    expect(error.message).toBe(
      'the source asks for connector: "polling", and no polling engine is registered here; the engines registered here read postgres (postgres://, postgresql://)',
    );
    expect(error.fix).toContain('remove connector: "polling"');
  });

  it('resolves "polling" on a postgres:// source to the polling engine over the Postgres dialect, as main.ts registers it', async () => {
    const { engines } = processDeps();
    const engine = await engineFor(
      engines,
      "postgres://facetdb_worker:pw@db.example.com/app",
      "polling",
    );
    expect(engine.name).toBe("polling");
    expect(engine.schemes).toEqual(["postgres", "postgresql"]);
    expect(engine.capabilities).toMatchObject({ multipleWorkers: false, pushWakeup: false });
    // Without the override the scheme's own engine reads the same URL: the trigger.
    const trigger = await engineFor(engines, "postgres://facetdb_worker:pw@db.example.com/app");
    expect(trigger.name).toBe("postgres");
    // The polling engine judges the URL as the Postgres engine does, before anything connects.
    const target = {
      project: { id: "p", name: "p" },
      source: "listings",
      table: "listings",
      storage: "inline",
      onChange: "reset",
      questionSet: { questions: [], read: [], model: "jev-1.14.0", thresholds: {} },
      urlVariable: "LISTINGS_URL",
    } as const;
    const clear = "postgres://facetdb_worker:pw@db.example.com/app";
    expect(engine.checkUrl(target, clear, { allowInsecure: false })).toEqual(
      trigger.checkUrl(target, clear, { allowInsecure: false }),
    );
  });

  it("picks the polling engine for a SQL scheme once one is registered", async () => {
    const polling = entry("polling");
    const entries = [...everyEngine, polling.entry];
    for (const url of ["postgres://db.example.com/app", "mysql://db.example.com/app"]) {
      expect(await engineFor(entries, url, "polling")).toBe(polling.engine);
    }
    const error = await refusal(engineFor(entries, "mongodb://db.example.com/app", "polling"));
    expect(error.code).toBe("connector-polling");
    expect(error.message).toContain("MongoDB's (mongodb:)");
  });

  it('resolves "polling" on a scheme whose engine polls already to that engine, with or without a polling engine registered', async () => {
    const polling = entry("polling");
    for (const entries of [everyEngine, [...everyEngine, polling.entry]]) {
      expect(await engineFor(entries, "oracle://u:p@db.example.com:2484/ORCLPDB1", "polling")).toBe(
        oracle.engine,
      );
      expect(
        await engineFor(entries, "cockroachdb://u:p@db.example.com:26257/app", "polling"),
      ).toBe(cockroachdb.engine);
    }
    expect(polling.loads.count).toBe(0);
    // A scheme with no polling engine of its own still needs one registered.
    const error = await refusal(engineFor(everyEngine, "mysql://db.example.com/app", "polling"));
    expect(error.code).toBe("connector-polling");
    // The scheme's engine unregistered: refused as without the override.
    const missing = await refusal(
      engineFor([postgres.entry], "oracle://u:p@db.example.com:2484/ORCLPDB1", "polling"),
    );
    expect(missing.code).toBe("unknown-scheme");
    expect(missing.message).toContain("no Oracle engine is registered here");
  });

  it('plans an oracle:// source with connector: "polling" with the Oracle engine main.ts registers', async () => {
    const { engines } = processDeps();
    const url = "oracle://facetdb_worker:pw@db.example.com:2484/ORCLPDB1?protocol=tcps";
    const engine = await engineFor(engines, url, "polling");
    expect(engine).toBe(await engineFor(engines, url));
    expect(engine.schemes).toEqual(["oracle"]);
    const cockroach = "cockroachdb://u:p@db.example.com:26257/app?sslmode=verify-full";
    expect((await engineFor(engines, cockroach, "polling")).schemes).toEqual(["cockroachdb"]);
  });
});

describe("a scheme no engine here reads is refused before any connection", () => {
  it("names the scheme, the engines registered and the page, never the connection string", async () => {
    const unknown = await refusal(
      engineFor([postgres.entry], "redis://user:s3cret-password@cache.example.com/0"),
    );
    expect(unknown.code).toBe("unknown-scheme");
    expect(unknown.message).toBe(
      "the connection string names no database FacetDB connects to (its scheme is redis:); the engines registered here read postgres (postgres://, postgresql://)",
    );
    expect(unknown.fix).toContain("https://docs.facetdb.dev/databases");
    expect(`${unknown.message} ${unknown.fix}`).not.toContain("s3cret-password");

    const notHere = await refusal(engineFor([postgres.entry], "mysql://root:hunter2@db/app"));
    expect(notHere.message).toBe(
      "the connection string is MySQL or MariaDB's (mysql:), and no MySQL or MariaDB engine is registered here; the engines registered here read postgres (postgres://, postgresql://)",
    );
    expect(notHere.message).not.toContain("hunter2");

    const none = await refusal(engineFor([], "no scheme at all"));
    expect(none.message).toContain("(it has no scheme, such as postgres://)");
    expect(none.message).toContain("the engines registered here read none");
  });
});

describe("every engine main.ts registers names a bare table as its plans do", () => {
  const bare = {
    project: { id: "p", name: "p" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: { questions: [], read: [], model: "jev-1.14.0", thresholds: {} },
    urlVariable: "LISTINGS_URL",
  } as const;

  it.each([
    ["postgres://facetdb_worker:pw@db.example.com/app?sslmode=require", "public.listings"],
    ["mysql://facetdb_worker:pw@db.example.com:3306/app", "app.listings"],
    ["mariadb://facetdb_worker:pw@db.example.com:3306/app", "app.listings"],
    ["mssql://facetdb_worker:pw@db.example.com:1433/app", "dbo.listings"],
    ["sqlite:///var/lib/app.db", "listings"],
    ["libsql://app-org.turso.io", "listings"],
    ["mongodb://facetdb_worker:pw@a.example.com:27017,b.example.com:27017/app", "app.listings"],
    ["cockroachdb://facetdb_worker:pw@db.example.com:26257/app", "public.listings"],
    ["oracle://facetdb_worker:pw@db.example.com:2484/ORCLPDB1", "listings"],
  ])("%s names listings %s", async (url, label) => {
    const { engines } = processDeps();
    const engine = await engineFor(engines, url);
    expect(engine.label(bare, url)).toBe(label);
  });
});
