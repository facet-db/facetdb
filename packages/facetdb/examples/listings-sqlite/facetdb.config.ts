// The listings example on SQLite (facetdb init --example listings --engine sqlite): the marketplace
// listings with its two questions. seed.sql makes the `listings` table with 2,000 rows
// (seed-quick.sql: 100) in listings.db; run it before `facetdb migrate`, which puts the file in WAL
// mode. LISTINGS_URL is the file (sqlite:./listings.db; a relative path is read from the directory
// the worker runs in, and one worker runs per file); DATABASE_URL is the store's Postgres, which
// keeps the decision log, usage and alerts.
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
