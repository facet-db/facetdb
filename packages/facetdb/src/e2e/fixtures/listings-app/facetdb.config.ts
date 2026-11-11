// The local end-to-end's project: marketplace listings with two questions, written as a user
// writes facetdb.config.ts (the DSL, loaded by its loader). The directory's name is the project's
// name.
import { choice, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
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
