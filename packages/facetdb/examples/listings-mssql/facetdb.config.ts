// The listings example on SQL Server 2016 and later or Azure SQL (facetdb init --example listings
// --engine mssql): the marketplace listings with its two questions. seed.sql makes the
// `dbo.listings` table with 2,000 rows (seed-quick.sql: 100); run it with the admin login before
// `facetdb migrate`. LISTINGS_URL is the worker login's connection string
// (mssql://facetdb_worker:<password>@<host>:1433/<database>; on Azure SQL the worker is a contained
// user of that database); DATABASE_URL is the store's Postgres, which keeps the decision log, usage
// and alerts. On a host that forbids triggers, add capture: "change-tracking" to the source.
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
      table: "dbo.listings",
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
