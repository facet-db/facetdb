// The listings example on Oracle Database 19c and later (facetdb init --example listings --engine
// oracle): the marketplace listings with its two questions. seed.sql makes the LISTINGS table with
// 2,000 rows (seed-quick.sql: 100) in the schema of the user who runs it; run it before `facetdb
// migrate`, and write that user in place of APP below. FacetDB uses every name exactly as written,
// so the table and the read columns are in capitals, as Oracle stores a name created without
// quotes, and polls the table every 10 seconds by UPDATED_AT. LISTINGS_URL is the worker login's
// connection string (oracle://facetdb_worker:<password>@<host>:2484/<service>?protocol=tcps);
// DATABASE_URL is the store's Postgres, which keeps the decision log, usage and alerts.
import { choice, env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  // Billable input tokens for the month: the backfill of 2,000 rows costs about 900k at ~450 a row.
  // At the cap the project pauses.
  spendingCap: 3_000_000,
  onCapReached: "pause",
  sources: [
    {
      name: "listings",
      database: env("LISTINGS_URL"),
      table: "APP.LISTINGS", // the worker owns no schema, so the source names the table's owner
      read: ["TITLE", "DESCRIPTION"],
      questions: {
        is_scam: noul("Is this listing a scam?", { stakes: "high" }),
        category: choice("Which category is this listing?", {
          car: "A car, van or motorbike",
          flat: "A flat, house or room to rent or buy",
          bike: "A bicycle or its parts",
        }),
      },
    },
  ],
});
