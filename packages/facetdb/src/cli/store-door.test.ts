import { describe, expect, it } from "vitest";
import { facetdb, noul, type SourceConfig } from "../config/index.ts";
import { CliError } from "./program.ts";
import { ownVariable, sameDatabase, storeSharedFor, storeUrlProblem } from "./store-door.ts";

/**
 * The store door's rules that need no database: when two connection strings reach one database as
 * postgres.js resolves them, that the store is always a Postgres, which sources share it, and the
 * variable a source of another kind reads.
 */

const PG_SOURCE = "postgres://facetdb_worker:s3cret-worker@localhost:5432/app";
const PG_STORE = "postgres://owner:s3cret-owner@localhost/app";
const MYSQL = "mysql://facetdb_worker:s3cret-mysql@db.example.com/shop";

/** The `orders` source as the loader makes it: the string read, and the variable it came from. */
function sourceOf(database: string, databaseEnv?: string): SourceConfig {
  const [source] = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "orders",
        database,
        table: "orders",
        read: ["title"],
        questions: { is_scam: noul("Is this order a scam?") },
      },
    ],
  }).sources;
  if (source === undefined) {
    throw new Error("facetdb() keeps the source it is given");
  }
  return databaseEnv === undefined ? source : { ...source, databaseEnv };
}

/** The CLI's error a call throws, so its words can be read. */
function refusalOf(work: () => unknown): CliError {
  try {
    work();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("it did not throw");
}

describe("sameDatabase reads both URLs as postgres.js does, with the environment's defaults", () => {
  it("takes PGDATABASE for a URL with no path before the user's name, so two databases never compare equal", () => {
    const env = { PGDATABASE: "app" };
    const pathless = "postgres://alice:pw@db.example.com";
    expect(sameDatabase("postgres://alice:pw@db.example.com/alice", pathless, env)).toBe(false);
    expect(sameDatabase("postgres://alice:pw@db.example.com/app", pathless, env)).toBe(true);
    // Without PGDATABASE, the driver names the database after the user.
    expect(sameDatabase("postgres://alice:pw@db.example.com/alice", pathless, {})).toBe(true);
  });

  it("takes PGPORT for a URL with no port: an explicit :5432 is not PGPORT=6432, and :6432 is", () => {
    const env = { PGPORT: "6432" };
    const portless = "postgres://u:pw@db.example.com/app";
    expect(sameDatabase("postgres://u:pw@db.example.com:5432/app", portless, env)).toBe(false);
    expect(sameDatabase("postgres://u:pw@db.example.com:6432/app", portless, env)).toBe(true);
    expect(sameDatabase("postgres://u:pw@db.example.com:5432/app", portless, {})).toBe(true);
  });

  it("takes PGHOST for a URL with no host and PGUSER for one with no user, whatever the logins", () => {
    expect(
      sameDatabase("postgres:///app", "postgres://v:pw@store.internal/app", {
        PGHOST: "store.internal",
      }),
    ).toBe(true);
    expect(
      sameDatabase("postgres://db.example.com", "postgres://other:pw@db.example.com/bob", {
        PGUSER: "bob",
      }),
    ).toBe(true);
    expect(sameDatabase(PG_SOURCE, PG_STORE, {})).toBe(true);
    expect(sameDatabase("postgres://u@db.example.com/shop", MYSQL, {})).toBe(false);
  });
});

describe("the store is always a Postgres", () => {
  it("refuses a DATABASE_URL of another kind in words, as it refuses a PGlite one", () => {
    expect(storeUrlProblem(MYSQL, false, undefined)).toEqual({
      code: "store-not-postgres",
      problem: "DATABASE_URL names a mysql: database, and the FacetDB store is always a Postgres",
      fix: "point DATABASE_URL at a Postgres (postgres://user:password@host/database; a free Supabase or Neon project is enough), and read a source's own database from a variable of its own",
    });
    expect(storeUrlProblem("pglite://.facetdb/dev", false, undefined)?.code).toBe("store-pglite");
    expect(storeUrlProblem(PG_STORE, false, undefined)).toBeUndefined();
  });

  it("shares the store with a Postgres source that reads DATABASE_URL or reaches its database", () => {
    expect(storeSharedFor({}, sourceOf(PG_SOURCE, "DATABASE_URL"))).toBe(true);
    expect(storeSharedFor({ DATABASE_URL: PG_STORE }, sourceOf(PG_SOURCE, "ORDERS_URL"))).toBe(
      true,
    );
    // No variable recorded is no shortcut: the source is compared with DATABASE_URL, and with no
    // DATABASE_URL there is no store yet.
    expect(storeSharedFor({}, sourceOf(PG_SOURCE))).toBe(false);
    expect(storeSharedFor({ DATABASE_URL: PG_STORE }, sourceOf(PG_SOURCE))).toBe(true);
  });

  it("never shares it with a source of another kind, and refuses one that reads DATABASE_URL", () => {
    expect(storeSharedFor({ DATABASE_URL: PG_STORE }, sourceOf(MYSQL, "ORDERS_URL"))).toBe(false);
    const refused = refusalOf(() =>
      storeSharedFor({ DATABASE_URL: MYSQL }, sourceOf(MYSQL, "DATABASE_URL")),
    );
    expect(refused.code).toBe("store-not-postgres");
    expect(refused.message).toBe(
      `the source "orders" reads DATABASE_URL, the store's variable, and its database is not a Postgres (mysql); the FacetDB store is always a Postgres, so a source of another kind reads a variable of its own`,
    );
    expect(refused.fix).toBe(
      "write database: process.env.ORDERS_URL for the source in facetdb.config.ts, set ORDERS_URL to its connection string, and point DATABASE_URL at the store's Postgres",
    );
  });

  it("names a source's own variable after it, never DATABASE_URL", () => {
    expect(ownVariable("orders")).toBe("ORDERS_URL");
    expect(ownVariable("database")).toBe("DATABASE_SOURCE_URL");
  });
});
