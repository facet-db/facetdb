import { choice, noul, score } from "facetdb";
import { pack } from "facetdb/plugin";

/**
 * The support inbox triage pack: four questions on a customer's message, its `subject` and `body`.
 * A project copies them as ordinary questions ("Start from a pack"), so nothing here is referenced
 * after that. The wording is written for a System One model (the `typesafe-ai` skill): one judgment
 * per question with its criteria in its wording, each criterion a situation a person can see in the
 * message, the borderline left to fall between the sides, no counting, no dates, at most one
 * negation per sentence. The criteria describe kinds of situations. The committed sample was
 * written beside this wording by the same hand, so it is no blind test of it: the unit test only
 * keeps the two from sharing a quoted phrase or a run of four words, and a project's own `facetdb
 * test` is what measures the pack on its messages.
 * - `topic` is a choice whose option names are the content they describe, `something_else` last so
 *   the catch-all never takes the first place the model leans to. Each option is defined by what
 *   the message says, never by facts about the product the message does not hold. A message about
 *   two topics asks what it is mainly about, and a request for money back because something failed
 *   is about the fault; a project that needs both answers splits the topic into nouls.
 * - `urgency` is the documented score, its three levels each a situation that reads on its own,
 * asked
 *   of the customer's situation rather than of the message's tone, which is the usual confusion.
 *   Work done by hand for want of a feature is low; something that should work and slows them is
 *   medium; money counts as high only while the problem keeps costing it.
 * - `wants_refund` is the documented question at high stakes: a yes can start a refund. Its no side
 *   names the case that confuses, a question about the refund policy, and a charge the customer
 *   only wants explained.
 * - `cancel_intent` asks one thing, whether the customer says they want to stop using the product;
 *   cancelling a plan and closing an account are its yes side, and a message that says nothing
 *   about leaving is its no side, whatever else it asks.
 *
 * Stakes: only `wants_refund` is high (yes at 0.90 or above, no at 0.10 or below), as in the
 * documented example. The others route a message or raise a flag that a person reads, so they are
 * low: confidence 0.50 for `topic` and `urgency`, 0.70 and 0.30 for `cancel_intent`. No question
 * carries its own thresholds: they follow from the stakes, so the defaults are the ones a project
 * sees.
 */
export const support = pack({
  description:
    "Support inbox triage: four questions on a customer's message, read from `subject` and `body`. The topic question sorts the message as billing, account access, a product fault, a how-to question, a feature request or something else; its options are the first thing a project edits to match its own teams. The urgency question places the customer's situation at low, medium or high. The wants_refund question asks whether the customer asks for their money back, and the cancel_intent question whether they say they want to stop using the product. Each question's thresholds follow from its stakes and the pack sets none of its own. wants_refund is high stakes, since a yes can start a refund: it decides yes at 0.90 or above and no at 0.10 or below. The other three are low stakes: cancel_intent decides yes at 0.70 or above and no at 0.30 or below, and topic and urgency decide their top answer at confidence 0.50 or above. Everything between goes to review.",
  reads: ["subject", "body"],
  questions: {
    topic: choice(
      "What is the customer's message in `subject` and `body` mainly about?",
      {
        billing:
          "Billing: charges, invoices, receipts, payment methods, refunds, and moves between plans, such as an upgrade, a downgrade or a cancellation of the subscription.",
        account_access:
          "Account access: signing in, passwords, two-step codes, the email address used to log in, or an account that is locked or disabled.",
        product_fault:
          "A product fault: something in the product fails or gives a wrong result, such as an error message, a crash, a page that will not load, missing or wrong data, or a feature that stopped working. A request for money back because something failed is about the fault.",
        how_to:
          "A how-to question: the customer asks how to do something with the product, or where to find something in it.",
        feature_request:
          "A feature request: a wish for something the customer says the product lacks, or for a change to how it behaves.",
        something_else:
          "Something else: the sender writes about matters outside their own use of the product and their account, or the message needs no reply.",
      },
      { stakes: "low" },
    ),
    urgency: score(
      "How urgent is the customer's situation in `subject` and `body`, whatever the tone of the message?",
      [
        {
          name: "low",
          description:
            "The customer asks a question or makes a request with no deadline, and their work goes on as it does today while they wait, even if they do some of it by hand.",
        },
        {
          name: "medium",
          description:
            "Something that should work slows the customer's work or gets in their way, and they have a workaround or can carry on with the rest of their work for now.",
        },
        {
          name: "high",
          description:
            "The customer is blocked from using the product, is losing money as long as the problem lasts, or has data at risk of being lost, exposed or corrupted.",
        },
      ],
      { stakes: "low" },
    ),
    wants_refund: noul(
      "Is the customer asking for their money back in the message in `subject` and `body`?",
      {
        stakes: "high",
        criteria: {
          true: "The customer asks for a payment to be returned to them, in full or in part, such as a duplicate payment or the price of something they paid for and were unable to use.",
          false:
            "The customer asks about refunds in general, such as what the refund policy says or how a refund would work, and makes no request for one; a question about the refund policy is a question, not a request. The message can also be about something else: a charge they want explained, a fault, a question, a cancellation that leaves past payments as they are, or a refund they have already received.",
        },
      },
    ),
    cancel_intent: noul(
      "Does the customer say in `subject` and `body` that they want to stop using the product?",
      {
        stakes: "low",
        criteria: {
          true: "The customer says they want to cancel their subscription, close their account, end their plan at its next renewal or leave for another provider, or asks how to do one of these.",
          false:
            "The customer says nothing about leaving: the message is about a question, a fault, a payment, or a change to a plan or a team that keeps the account open.",
        },
      },
    ),
  },
});
