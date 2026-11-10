// The example project config, except that `slack` comes from ./slack.ts because the real
// @facetdb/slack package does not exist yet, and the environment is read as process.env["..."]
// because this repository's tsconfig forbids dot access on an index signature.
import { choice, facetdb, noul, score } from "facetdb";
import { slack } from "./slack.ts";

export default facetdb({
  model: "jev-1.14.0", // project default; pinned, never an alias such as jev-latest
  alerts: { channels: ["slack:#ops", "email:ops@example.com"] },
  sources: [
    {
      name: "support_messages",
      database: process.env["DATABASE_URL"], // any supported database
      table: "support_messages",
      where: "channel <> 'internal'", // optional filter on state fields; the rest are skipped
      read: ["subject", "body", "channel"], // the state: only what the questions need
      storage: "inline", // or "side-table"
      onChange: "reset", // or "keep": leave the old decision until the new one lands
      onOutage: "hold", // or "release": mark records unchecked instead of waiting
      questions: {
        urgency: score("How urgent is this message?", ["low", "medium", "high"]),
        team: choice("Which team should handle it?", {
          billing: "Charges, payments, invoices",
          shipping: "Delivery times, tracking, countries",
          returns: "Damaged items, exchanges, refunds",
        }),
        wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
      },
      thresholds: { urgency: { confidenceAtLeast: 0.6 } }, // wants_refund keeps the high-stakes defaults
      actions: [slack.notify({ channel: "#support-urgent", when: { urgency: "high" } })],
    },
    {
      name: "support_tickets", // an API source: your code sends records, see below
      api: true,
      read: ["subject", "body"],
      questions: { urgency: score("How urgent is this ticket?", ["low", "medium", "high"]) },
    },
  ],
});
