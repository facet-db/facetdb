import type { DoctorCheck } from "@facetdb/core";
import { FakeClock, FakeEngine } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type SourceConfig } from "../../config/index.ts";
import { tableFacts } from "./dashboard-door.ts";
import { engineTarget, projectRef, splitTable } from "./database.ts";

/**
 * A table source as the worker hands it to the Home and Sources endpoints: the database and its
 * change capture from the connection string and the config, the worker login and the reach of its
 * grants, and the engine's doctor as the worker can run it. A fake engine stands for each database;
 * the words come from the scheme's row of the static table, so nothing connects.
 */

const config = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:worker-password@db.example.com/app?sslmode=require",
      table: "listings",
      read: ["title", "price"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

const [base] = config.sources;
const project = projectRef("/work/marketplace");
const deps = { clock: new FakeClock(0), allowInsecure: false, storeShared: false };

function factsOf(url: string, source: Partial<SourceConfig> = {}, engine = new FakeEngine()) {
  if (base === undefined) {
    throw new Error("the test config has a source");
  }
  const configured: SourceConfig = {
    ...base,
    database: url,
    databaseEnv: "LISTINGS_URL",
    ...source,
  };
  const target = engineTarget(
    { ...config, sources: [configured] },
    { source: configured, ...splitTable(configured.table ?? "") },
    project,
  );
  return tableFacts({ engine, target, url, source: configured, deps });
}

describe("a table source's facts for the dashboard", () => {
  it("names the database, the trigger, the login from the URL and its column grants", () => {
    const facts = factsOf(
      "postgres://facetdb_worker:worker-password@db.example.com/app?sslmode=require",
    );
    expect(facts).toMatchObject({
      database: "Postgres",
      capture: "trigger",
      pushWakeup: true,
      label: "listings",
      storage: "inline",
      answersIn: "columns",
      login: { kind: "user", user: "facetdb_worker", reach: "columns" },
    });
    // Words only: the connection string and its password stay out.
    expect(JSON.stringify(facts)).not.toContain("worker-password");
  });

  it("tells MySQL from MariaDB by the scheme, and SQL Server's Change Tracking by the config", () => {
    expect(factsOf("mysql://facetdb_worker:pw@db/app").database).toBe("MySQL");
    expect(factsOf("mariadb://facetdb_worker:pw@db/app").database).toBe("MariaDB");
    expect(
      factsOf("mssql://facetdb_worker:pw@db:1433/app", { capture: "change-tracking" }),
    ).toMatchObject({ database: "SQL Server", capture: "change-tracking" });
    expect(factsOf("mssql://facetdb_worker:pw@db:1433/app").capture).toBe("trigger");
  });

  it("says polling for a polled source and engine, and how far each engine's grants reach", () => {
    expect(factsOf("postgres://facetdb_worker:pw@db/app", { connector: "polling" })).toMatchObject({
      capture: "polling",
      login: { reach: "columns" },
    });
    expect(factsOf("cockroachdb://facetdb_worker:pw@db:26257/app")).toMatchObject({
      database: "CockroachDB",
      capture: "polling",
      login: { reach: "table" },
    });
    expect(factsOf("oracle://facetdb_worker:pw@db:1521/APP")).toMatchObject({
      capture: "polling",
      login: { reach: "reads-table" },
    });
    expect(factsOf("mongodb://facetdb_worker:pw@db:27017/app")).toMatchObject({
      database: "MongoDB",
      capture: "change-stream",
      answersIn: "fields",
      login: { reach: "table" },
    });
  });

  it("gives SQLite the file and libSQL its auth token's variable, never a login", () => {
    expect(factsOf("sqlite:///srv/app.db").login).toEqual({ kind: "file" });
    expect(factsOf("libsql://app-team.turso.io").login).toEqual({
      kind: "token",
      variable: "LISTINGS_URL_AUTH_TOKEN",
    });
  });

  it("leaves the pooler check to facetdb doctor: the worker's own pool is open on the database", async () => {
    const checks: readonly DoctorCheck[] = [
      { name: "database", status: "ok", detail: "logged in as facetdb_worker" },
      {
        name: "pooler",
        status: "fail",
        detail: "one prepared statement ran in two server sessions on one connection",
        fix: "use the session pooler",
      },
      { name: "install", status: "ok", detail: "in place" },
    ];
    const facts = factsOf(
      "postgres://facetdb_worker:pw@db.example.com/app?sslmode=require",
      {},
      new FakeEngine({ doctor: () => checks }),
    );
    expect(await facts.doctor()).toEqual([
      checks[0],
      {
        name: "pooler",
        status: "skip",
        detail:
          "not checked from the worker, whose own pool is open on this database; facetdb doctor checks it",
      },
      checks[2],
    ]);
  });

  it("asks the engine for the table's estimated rows, and reads none where it has no estimate or cannot read", async () => {
    const asked: string[] = [];
    const estimating = new FakeEngine({
      estimateRows: (target) => {
        asked.push(target.table);
        return 4_137;
      },
    });
    const secure = "postgres://facetdb_worker:pw@db.example.com/app?sslmode=require";
    expect(await factsOf(secure, {}, estimating).estimateRows()).toBe(4_137);
    expect(asked).toEqual(["listings"]);
    // An engine with no estimate (every engine but Postgres's): none, and nothing is asked.
    expect(await factsOf(secure).estimateRows()).toBeNull();
    // A read the engine refuses is no estimate; the doctor in the same row says why.
    expect(
      await factsOf(
        "postgres://facetdb_worker:pw@db.example.com/app",
        {},
        estimating,
      ).estimateRows(),
    ).toBeNull();
    expect(asked).toEqual(["listings"]);
  });
});
