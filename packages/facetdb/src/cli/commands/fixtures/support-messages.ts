// The support-messages example, reduced to what `facetdb types` reads: the sources, their
// questions and thresholds. The connection, alerts and actions do not change a type.
import { choice, facetdb, noul, score } from "../../../config/index.ts";

export const supportMessages = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "support_messages",
      table: "support_messages",
      where: "channel <> 'internal'",
      read: ["subject", "body", "channel"],
      questions: {
        urgency: score("How urgent is this message?", ["low", "medium", "high"]),
        team: choice("Which team should handle it?", {
          billing: "Charges, payments, invoices",
          shipping: "Delivery times, tracking, countries",
          returns: "Damaged items, exchanges, refunds",
        }),
        wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
      },
      thresholds: { urgency: { confidenceAtLeast: 0.6 } },
    },
    {
      name: "support_tickets",
      api: true,
      read: ["subject", "body"],
      questions: { urgency: score("How urgent is this ticket?", ["low", "medium", "high"]) },
    },
  ],
});
