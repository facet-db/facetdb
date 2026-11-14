import { describe, expect, it } from "vitest";
import { runKept, runRemoved, tableKept, tableRemoved } from "./uninstall-words.ts";

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
