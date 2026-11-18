// The listings example on CockroachDB (facetdb init --example listings --engine cockroachdb): the
// marketplace listings with its two questions. seed.sql makes the `listings` table with 2,000 rows
// (seed-quick.sql: 100); run it with the admin login before `facetdb migrate`. FacetDB polls the
// table every 10 seconds by updated_at, with no trigger. LISTINGS_URL is the worker login's
// connection string
// (cockroachdb://facetdb_worker:<password>@<host>:26257/<database>?sslmode=verify-full);
// DATABASE_URL is the store's Postgres, which keeps the decision log, usage and alerts.
import { choice, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  // Billable input tokens for the month: the backfill of 2,000 rows costs about 900k at ~450 a row.
  // At the cap the project pauses.
  spendingCap: 3_000_000,
  onCapReached: "pause",
  sources: [
    {
      name: "listings",
      database: process.env.LISTINGS_URL,
      table: "listings",
      read: ["title", "description"],
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
