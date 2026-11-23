import { describe, expect, it } from "vitest";
import { facetdb, noul, type SourceConfig } from "../config/index.ts";
import { CliError } from "./program.ts";
import {
  ownVariable,
  requireStoreSecret,
  runStoreMigration,
  sameDatabase,
  showStoreMigration,
  storeSecretWarning,
  storeSharedFor,
  storeUrlProblem,
} from "./store-door.ts";
import {
  CURRENT_STORE,
  type SqlConnect,
  storeAtVersions,
  storeScript,
  storeStepStatements,
} from "./testing.ts";

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
      'write database: env("ORDERS_URL") for the source in facetdb.config.ts, set ORDERS_URL to its connection string, and point DATABASE_URL at the store\'s Postgres',
    );
  });

  it("names a source's own variable after it, never DATABASE_URL", () => {
    expect(ownVariable("orders")).toBe("ORDERS_URL");
    expect(ownVariable("database")).toBe("DATABASE_SOURCE_URL");
  });
});

/**
 * The first `facetdb worker` of a new project meets an unset FACETDB_SECRET; the words name the
 * variable, what it is for and the fix, where the store's own refusal would reach the user as an
 * unexpected error ending in "open an issue".
 */
describe("the store's secret", () => {
  it("is refused unset or empty, before anything connects, naming what it is for and the fix", () => {
    for (const env of [{}, { FACETDB_SECRET: "" }]) {
      const refused = refusalOf(() => requireStoreSecret(env));
      expect(refused.code).toBe("store-secret");
      expect(refused.message).toBe(
        "FACETDB_SECRET is not set, and the FacetDB store encrypts the credentials it keeps for the worker with it; nothing was connected",
      );
      expect(refused.fix).toBe(
        "set FACETDB_SECRET to a long random value (openssl rand -hex 32) and keep it: credentials encrypted under it need the same value to be read later",
      );
      expect(refused.fix).not.toContain("open an issue");
    }
    expect(requireStoreSecret({ FACETDB_SECRET: "a-long-random-value" })).toBe(
      "a-long-random-value",
    );
  });

  it("is a warning at migrate, which needs none itself, and nothing once it is set", () => {
    expect(storeSecretWarning({})).toMatch(
      /^warning: FACETDB_SECRET is not set\. migrate does not need it, but facetdb worker does/,
    );
    expect(storeSecretWarning({ FACETDB_SECRET: "a-long-random-value" })).toBeUndefined();
  });
});

/**
 * The store's step at its run: every caller of `runStoreMigration` gets FacetDB's words for a login
 * that may not create the store's tables and for a store table held past the step's lock timeout,
 * never the server's bare error. A store at the version before this FacetDB's newest, as its
 * version table holds it; a transaction that only records what it was sent.
 */
describe("runStoreMigration", () => {
  const STORE_URL = "postgres://owner:s3cret-owner@localhost:5432/facetdb";
  const BEHIND = CURRENT_STORE.slice(0, -1);

  /** The store `storeAtVersions` reads, with `failAt` the statement its transaction stops at. */
  function storeWith(options: {
    readonly mayCreate: boolean;
    readonly failAt?: (text: string) => boolean;
  }) {
    const sent: string[] = [];
    const transactions: number[] = [];
    const connect: SqlConnect = (url, connectOptions) => {
      const reads = storeAtVersions(BEHIND, { mayCreate: options.mayCreate })(url, connectOptions);
      return {
        ...reads,
        transaction: (work) => {
          transactions.push(1);
          return work((text) => {
            sent.push(text);
            return options.failAt?.(text) === true
              ? Promise.reject(
                  Object.assign(new Error("canceling statement due to lock timeout"), {
                    code: "55P03",
                  }),
                )
              : Promise.resolve([]);
          });
        },
      };
    };
    return { connect, sent, transactions };
  }

  it("refuses a login that may not create the store's tables, in FacetDB's words, and opens no transaction", async () => {
    const store = storeWith({ mayCreate: false });
    const shown = await showStoreMigration(store.connect, STORE_URL);
    // The show (a dry run's) prints the step whatever the login may do.
    expect(shown.script).toBe(storeScript(storeStepStatements()));
    const refused = runStoreMigration(store.connect, STORE_URL, shown, "store");
    await expect(refused).rejects.toThrow(CliError);
    await expect(refused).rejects.toThrow(
      "the login in DATABASE_URL may not create the store's tables in localhost:5432/facetdb; nothing was run",
    );
    await expect(runStoreMigration(store.connect, STORE_URL, shown, "admin")).rejects.toThrow(
      "the login in the admin connection string may not create the store's tables in localhost:5432/facetdb; nothing was run",
    );
    expect(store.transactions).toEqual([]);
  });

  it("stops at the lock timeout naming the store table another transaction holds, and what to do", async () => {
    const store = storeWith({
      mayCreate: true,
      failAt: (text) => text.includes("create index webhook_outbox_batch on"),
    });
    const shown = await showStoreMigration(store.connect, STORE_URL);
    const stopped = runStoreMigration(store.connect, STORE_URL, shown, "store");
    await expect(stopped).rejects.toMatchObject({
      code: "store-busy",
      message:
        "another transaction holds facetdb.webhook_outbox on localhost:5432/facetdb, so the FacetDB store's migration stopped waiting for it after 10s; nothing was run",
      fix: "wait for that transaction to end, or end it (pg_stat_activity names it; pg_locks shows what it holds on facetdb.webhook_outbox), then run facetdb migrate again",
    });
    // The step pinned the install's lock timeout right after the store's lock, as printed.
    expect(store.sent.slice(0, 2)).toEqual(storeStepStatements().slice(0, 2));
    expect(store.sent[1]).toBe("set local lock_timeout = '10s'");
  });
});
