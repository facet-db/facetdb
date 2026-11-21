// The listings example on MongoDB 4.4 and later or Atlas (facetdb init --example listings --engine
// mongodb): the marketplace listings with its two questions. seed.js makes the `listings`
// collection with 2,000 documents (seed-quick.js: 100); run it with mongosh and the admin login
// before `facetdb migrate`. The server must be a replica set (Atlas is one; a self-hosted mongod
// runs with --replSet rs0 and rs.initiate() once), because FacetDB follows a change stream.
// LISTINGS_URL is the worker login's connection string
// (mongodb://facetdb_worker:<password>@<host>:27017/<database>?replicaSet=rs0, or on Atlas
// mongodb+srv://facetdb_worker:<password>@<cluster host>/<database>?authSource=admin); DATABASE_URL
// is the store's Postgres, which keeps the decision log, usage, alerts and the stream's place.
import { choice, env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  // Billable input tokens for the month: the backfill of 2,000 documents costs about 900k at ~450
  // a document. At the cap the project pauses.
  spendingCap: 3_000_000,
  onCapReached: "pause",
  sources: [
    {
      name: "listings",
      database: env("LISTINGS_URL"),
      table: "listings", // the collection whose documents get answers
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
