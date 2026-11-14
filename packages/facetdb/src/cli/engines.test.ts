import type { DatabaseEngine } from "@facetdb/core";
import { FakeEngine } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { engineFor, isPostgresUrl, lazyEngine, readsUrl, schemeOf } from "./engines.ts";
import { CliError, type EngineEntry } from "./program.ts";

/**
 * Which engine serves a source, with the fake engine: the scheme table, the `connector: "polling"`
 * override, the refusal of a scheme no engine reads, and an engine loaded only when a source of its
 * scheme asks for it.
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

  it("reads a scheme in any case, and an https URL without libsql in its host as https", () => {
    expect(schemeOf("POSTGRES://db.example.com/app")).toBe("postgres");
    expect(schemeOf("https://api.example.com/app")).toBe("https");
    expect(schemeOf("data/app.csv")).toBeUndefined();
    expect(isPostgresUrl("postgresql://db.example.com/app")).toBe(true);
    expect(isPostgresUrl("mysql://db.example.com/app")).toBe(false);
  });

  it("says which schemes an engine is registered for without loading any", () => {
    const counted = entry("postgres", ["postgres", "postgresql"]);
    expect(readsUrl([counted.entry], "postgres://db.example.com/app")).toBe(true);
    expect(readsUrl([counted.entry], "mysql://db.example.com/app")).toBe(false);
    expect(counted.loads.count).toBe(0);
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
  it('refuses "polling" until its engine is registered', async () => {
    const error = await refusal(engineFor(everyEngine, "postgres://db.example.com/app", "polling"));
    expect(error.code).toBe("connector-polling");
    expect(error.message).toContain("polling is not in this build yet");
    expect(error.fix).toContain('remove connector: "polling"');
  });

  it("picks the polling engine for a SQL scheme once one is registered", async () => {
    const polling = entry("polling");
    const entries = [...everyEngine, polling.entry];
    for (const url of [
      "postgres://db.example.com/app",
      "mysql://db.example.com/app",
      "cockroachdb://db.example.com/app",
    ]) {
      expect(await engineFor(entries, url, "polling")).toBe(polling.engine);
    }
    const error = await refusal(engineFor(entries, "mongodb://db.example.com/app", "polling"));
    expect(error.code).toBe("connector-polling");
    expect(error.message).toContain("MongoDB's (mongodb:)");
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
