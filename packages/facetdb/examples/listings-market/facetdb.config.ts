// An example project: marketplace listings with two questions, run against a real Supabase
// Postgres on jev-1.14.0. It lives inside the facetdb package so `import ... from "facetdb"`
// resolves from source; the directory's name is the project's name and id (what `uninstall` asks
// to have typed back). DATABASE_URL is the worker login's URL
// (`postgres://facetdb_worker:<password>@<host>:5432/postgres?sslmode=require`); the admin URL is
// passed to migrate and uninstall on the command line and never stored.
import { choice, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  // Billable input tokens for the month; the backfill of 2,000 rows costs about 900k at ~450 a row,
  // so this leaves room for the hour of inserts, edits and re-asks. At the cap the project pauses.
  spendingCap: 3_000_000,
  onCapReached: "pause",
  sources: [
    {
      name: "listings",
      database: process.env["DATABASE_URL"],
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
