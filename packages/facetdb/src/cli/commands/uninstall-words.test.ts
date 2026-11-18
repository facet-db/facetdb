import type { EngineObject } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  accountLines,
  once,
  runKept,
  runRemoved,
  tableKept,
  tableRemoved,
} from "./uninstall-words.ts";

/**
 * Every object a plan holds is said: the kinds the phrases word come out as uninstall's tests read
 * them, and a kind no Postgres plan holds (a MongoDB field, an index, a collection) is said plainly
 * by its kind and name, never left out of "This removes" or "This keeps".
 */

const TABLE = "public.orders";

describe("the words for a kind the phrases do not cover", () => {
  it("says it in the table's words, after the phrases it has", () => {
    expect(
      tableRemoved([
        { kind: "column", name: "is_scam", of: TABLE, scope: "source" },
        { kind: "field", name: "facetdb.is_scam", of: TABLE, scope: "source" },
        { kind: "index", name: "facetdb_orders_due", of: TABLE, scope: "source" },
        { kind: "jobs-table", name: "facetdb.jobs", of: TABLE, scope: "source" },
      ]),
    ).toEqual([
      "from public.orders: 1 FacetDB column (is_scam), 1 FacetDB field (facetdb.is_scam), the index facetdb_orders_due and its queued jobs",
    ]);
    expect(
      tableKept([
        {
          kind: "index",
          name: "facetdb_orders_due",
          of: TABLE,
          scope: "source",
          reason: "another table's queue uses it",
        },
      ]),
    ).toEqual([
      "the index facetdb_orders_due on public.orders, left in place (another table's queue uses it)",
    ]);
  });

  it("says it in the run's words, before the schema and before the logins", () => {
    expect(
      runRemoved([
        { kind: "collection", name: "facetdb_jobs", scope: "run" },
        { kind: "schema", name: "facetdb", scope: "run", reason: "now empty" },
      ]),
    ).toEqual(["the collection facetdb_jobs", "the facetdb schema, now empty"]);
    const logins = "uninstall never drops them";
    expect(
      runKept([
        { kind: "login", name: "facetdb_worker", scope: "run", reason: logins },
        {
          kind: "collection",
          name: "facetdb_jobs",
          scope: "run",
          reason: "it holds 3 queued jobs of other collections",
        },
        { kind: "login", name: "facetdb_enqueue", scope: "run", reason: logins },
      ]),
    ).toEqual([
      "the collection facetdb_jobs, because it holds 3 queued jobs of other collections",
      "the facetdb_worker and facetdb_enqueue logins (uninstall never drops them)",
    ]);
  });
});

/**
 * Every name in "This removes" is the plan's own, each object said once, whatever the engine: the
 * queue and the marks as the engine spells them, the trigger or the Change Tracking turned off, the
 * side table and view, MongoDB's role and user; nothing kept, no keeps line.
 */
describe("the words of every engine's plan", () => {
  const MSSQL = "dbo.listings";
  const own = (kind: EngineObject["kind"], name: string): EngineObject => ({
    kind,
    name,
    of: MSSQL,
    scope: "source",
  });
  const run = (
    kind: EngineObject["kind"],
    name: string,
    more: Partial<EngineObject> = {},
  ): EngineObject => ({ kind, name, scope: "run", ...more });

  it("says every kind of a table's removes, each once, by the names the plan gives", () => {
    expect(
      tableRemoved([
        own("column", "is_scam"),
        own("field", "facetdb.is_scam"),
        own("side-table", "dbo.facetdb_listings_answers"),
        own("view", "dbo.listings_with_answers"),
        own("trigger", "facetdb_listings"),
        { ...own("change-tracking", MSSQL), reason: "FacetDB's install turned it on" },
        own("function", "facetdb.enqueue"),
        own("jobs-table", "dbo.facetdb_jobs"),
        own("marker", "dbo.facetdb_table_owners"),
        own("schema", "facetdb"),
        { ...own("login", "facetdb_worker_listings"), noun: "role" },
        own("grant", "facetdb_worker"),
        own("policy", "facetdb_reads"),
        own("index", "facetdb_listings_due"),
        own("collection", "facetdb_jobs"),
        own("store-table", "facetdb.usage"),
        { kind: "log", name: "facetdb.decisions", of: "listings", scope: "source", count: 2 },
      ]),
    ).toEqual([
      "from dbo.listings: 1 FacetDB column (is_scam), 1 FacetDB field (facetdb.is_scam), the side table dbo.facetdb_listings_answers, the view dbo.listings_with_answers, the trigger facetdb_listings, its Change Tracking (turned off: FacetDB's install turned it on), the policy facetdb_reads, the function facetdb.enqueue, the schema facetdb, the role facetdb_worker_listings, the index facetdb_listings_due, the collection facetdb_jobs, the FacetDB store table facetdb.usage, its queued jobs, its table-ownership mark and the facetdb_worker login's rights on it",
      "the decision log of source listings (2 decisions)",
    ]);
  });

  it("says every kind of the run's removes, the queue and the marks by the engine's names", () => {
    expect(
      runRemoved([
        run("grant", "facetdb_worker", { of: "public" }),
        run("marker", "facetdb.projects", { of: "listings-app", reason: "nothing of it remains" }),
        run("function", "facetdb.enqueue", { reason: "no trigger uses them any more" }),
        run("jobs-table", "facetdb_jobs"),
        run("marker", "facetdb_table_owners"),
        run("store-table", "facetdb.usage", { reason: "no project remains" }),
        run("marker", "facetdb.projects", { reason: "no project is left in it" }),
        run("column", "is_spam", { of: "orders" }),
        run("field", "facetdb", { of: "orders" }),
        run("side-table", "facetdb_orders_answers"),
        run("view", "orders_with_answers"),
        run("trigger", "facetdb_orders"),
        run("login", "facetdb_worker_orders", { noun: "role" }),
        run("policy", "facetdb_reads", { of: "orders" }),
        run("index", "facetdb_jobs_due"),
        run("collection", "facetdb_meta"),
        run("change-tracking", "dbo.orders", { of: "dbo.orders" }),
        run("log", "facetdb.decisions", { reason: "now empty" }),
        run("schema", "facetdb", { reason: "now empty" }),
      ]),
    ).toEqual([
      "the facetdb_worker login's usage of schema public",
      "project listings-app's entry in the FacetDB store (nothing of it remains)",
      "the enqueue trigger functions (no trigger uses them any more)",
      "the jobs table and the table-ownership marks (facetdb_jobs, facetdb_table_owners)",
      "the shared FacetDB tables and the alert history in them (no project remains)",
      "the project register facetdb.projects (no project is left in it)",
      "the column is_spam on orders",
      "the field facetdb on orders",
      "the side table facetdb_orders_answers",
      "the view orders_with_answers",
      "the trigger facetdb_orders",
      "the role facetdb_worker_orders",
      "the policy facetdb_reads on orders",
      "the index facetdb_jobs_due",
      "the collection facetdb_meta",
      "Change Tracking on dbo.orders",
      "the decision log tables, now empty",
      "the facetdb schema, now empty",
    ]);
  });

  it("names only the shared tables the plan drops, and Postgres's as before", () => {
    expect(runRemoved([run("jobs-table", "app.facetdb_jobs")])).toEqual([
      "the jobs table (app.facetdb_jobs)",
    ]);
    expect(runRemoved([run("marker", "facetdb_table_owners")])).toEqual([
      "the table-ownership marks (facetdb_table_owners)",
    ]);
    expect(
      runRemoved([run("jobs-table", "facetdb.jobs"), run("marker", "facetdb.table_owners")]),
    ).toEqual([
      "the jobs table and the table-ownership marks (facetdb.jobs, facetdb.table_owners)",
    ]);
  });

  it("says SQL Server's Change Tracking turned off, beside its queue and marks, once each", () => {
    const removes: readonly EngineObject[] = [
      own("column", "is_scam"),
      own("column", "facetdb_status"),
      { ...own("change-tracking", MSSQL), reason: "FacetDB's install turned it on" },
      { ...own("jobs-table", "dbo.facetdb_jobs"), count: 0 },
      own("marker", "dbo.facetdb_table_owners"),
      own("grant", "facetdb_worker"),
      run("jobs-table", "dbo.facetdb_jobs", { reason: "no trigger uses it any more" }),
      run("marker", "dbo.facetdb_table_owners", { reason: "now empty" }),
    ];
    expect(once([...tableRemoved(removes), ...runRemoved(removes)])).toEqual([
      "from dbo.listings: 2 FacetDB columns (is_scam, facetdb_status), its Change Tracking (turned off: FacetDB's install turned it on), its queued jobs, its table-ownership mark and the facetdb_worker login's rights on it",
      "the jobs table and the table-ownership marks (dbo.facetdb_jobs, dbo.facetdb_table_owners)",
    ]);
  });

  it("says MongoDB's role and user in the database's words", () => {
    const reason =
      "uninstall never drops it: other collections and projects of the database may share it";
    expect(
      tableRemoved([
        { kind: "field", name: "facetdb", of: "app.listings", scope: "source" },
        { kind: "jobs-table", name: "facetdb_jobs", of: "app.listings", scope: "source" },
        {
          kind: "login",
          name: "facetdb_worker_listings",
          of: "app.listings",
          scope: "source",
          noun: "role",
        },
      ]),
    ).toEqual([
      "from app.listings: 1 FacetDB field (facetdb), the role facetdb_worker_listings and its queued jobs",
    ]);
    expect(
      runKept([{ kind: "login", name: "facetdb_worker", scope: "run", noun: "user", reason }]),
    ).toEqual([`the facetdb_worker user (${reason})`]);
    expect(
      tableKept([
        {
          kind: "login",
          name: "facetdb_worker_listings",
          of: "admin",
          scope: "source",
          noun: "role",
          reason: "made by hand in admin",
        },
      ]),
    ).toEqual(["the role facetdb_worker_listings on admin, left in place (made by hand in admin)"]);
  });

  it("says the marks a run keeps by the engine's name", () => {
    expect(
      runKept([
        {
          kind: "marker",
          name: "app.facetdb_table_owners",
          scope: "run",
          reason: "app.orders is still installed",
        },
      ]),
    ).toEqual([
      "the table-ownership marks (app.facetdb_table_owners), because app.orders is still installed",
    ]);
  });

  it("says Change Tracking left on where it was on before the install", () => {
    expect(
      tableKept([
        {
          ...own("change-tracking", MSSQL),
          reason: "it was on before FacetDB's install",
        },
      ]),
    ).toEqual(["Change Tracking on dbo.listings, left on (it was on before FacetDB's install)"]);
  });

  it("names every queue and marks table a run drops, each once", () => {
    expect(
      runRemoved([
        run("jobs-table", "app.facetdb_jobs"),
        run("marker", "app.facetdb_table_owners"),
        run("marker", "shop.facetdb_table_owners"),
        run("marker", "app.facetdb_table_owners"),
      ]),
    ).toEqual([
      "the jobs table and the table-ownership marks (app.facetdb_jobs, app.facetdb_table_owners, shop.facetdb_table_owners)",
    ]);
    expect(
      runRemoved([run("jobs-table", "app.facetdb_jobs"), run("jobs-table", "shop.facetdb_jobs")]),
    ).toEqual(["the jobs tables (app.facetdb_jobs, shop.facetdb_jobs)"]);
  });

  it("prints no keeps line when nothing is kept, and the keeps when anything is", () => {
    expect(tableKept([])).toEqual([]);
    expect(runKept([])).toEqual([]);
    expect(accountLines({ removes: ["the jobs table (facetdb_jobs)"], keeps: [] })).toEqual([
      "This removes: the jobs table (facetdb_jobs).",
    ]);
    expect(
      accountLines({
        removes: ["from listings: 1 FacetDB column (is_scam)", "the jobs table (facetdb_jobs)"],
        keeps: ["the facetdb_worker login (uninstall never drops it)"],
      }),
    ).toEqual([
      "This removes: from listings: 1 FacetDB column (is_scam); the jobs table (facetdb_jobs).",
      "This keeps: the facetdb_worker login (uninstall never drops it).",
    ]);
    expect(accountLines({ removes: [], keeps: [] })).toEqual([
      "This removes nothing of FacetDB's from the database.",
    ]);
  });
});
