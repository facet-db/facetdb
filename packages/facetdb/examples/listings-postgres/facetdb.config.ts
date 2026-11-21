// The listings example on Postgres (facetdb init --example listings --engine postgres): the
// marketplace listings with its two questions. seed.sql makes the `listings` table with 2,000 rows
// (seed-quick.sql: 100); run it with the admin login before `facetdb migrate`. The store lives in
// the same database. DATABASE_URL is the worker login's connection string
// (postgres://facetdb_worker:<password>@<host>:5432/<database>?sslmode=require); the admin URL is
// passed to migrate and uninstall on the command line and never stored.
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
      database: env("DATABASE_URL"),
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
