import { noul } from "facetdb";
import { pack } from "facetdb/plugin";

/**
 * The marketplace trust and safety pack: four yes-or-no questions on a listing's `title` and
 * `description`. A project copies them as ordinary questions ("Start from a pack"), so nothing here
 * is referenced after that; the wording is written for a System One model (the `typesafe-ai`
 * skill): one observable judgment per question, its criteria in its wording as concrete situations
 * for yes and for no, the borderline left to fall between them, no counting, no dates, at most one
 * negation per sentence. The criteria name kinds of situations, never a listing of the committed
 * sample.
 *
 * Stakes: an answer that hides a listing is high stakes, so `scam`, `banned_item` and `counterfeit`
 * (a marketplace hides a self-declared counterfeit) are high and keep the high-stakes defaults: yes
 * at 0.90 or above, no at 0.10 or below, the band between goes to review. `off_platform` is low
 * (0.70 and 0.30): its usual use is a warning to the buyer; a project that hides a listing on it
 * sets its stakes to high, as the description says. No question carries its own thresholds: they
 * follow from the stakes, so the defaults are the ones a project sees.
 *
 * The pack was run on `jev-1.14.0` against its sample and reworded where the answers showed the
 * model reading wrongly: a real sale of a rule-breaking item is not a scam, a transfer before any
 * viewing is a scam sign only beside another, being a branded fake does not by itself make an item
 * a banned kind (a fake of a banned kind still is), and the marketplace's own website or app is its
 * checkout.
 */
export const marketplace = pack({
  description:
    "Marketplace trust and safety: four yes-or-no questions on a listing's text, read from `title` and `description` (no images). They ask whether the listing is a scam, written to take a buyer's money or details without a real sale, whether it offers something of a kind general marketplaces commonly ban, whether it asks buyers to contact or pay the seller outside the marketplace, and whether the seller calls the item a counterfeit or replica of a branded product. The banned list is written into the banned_item question's criteria, and it is the first thing a project edits to match its own rules. Each question's thresholds follow from its stakes and the pack sets none of its own: high stakes decide yes at 0.90 or above and no at 0.10 or below, low stakes at 0.70 and 0.30, and everything between goes to review. An answer that hides a listing is high stakes: the scam, banned_item and counterfeit questions keep the high-stakes review band, a fixed rule (a blocked-word list, a price floor) belongs beside the model, and a project that hides listings on the off_platform answer sets its stakes to high.",
  questions: {
    scam: noul(
      "Is the listing in `title` and `description` written to take a buyer's money or personal details without a real sale behind it?",
      {
        stakes: "high",
        criteria: {
          true: "The listing asks for money or personal details in a way that leaves the buyer unable to check the item first: payment in gift cards or crypto, an item held by an agent or a courier, or a place to rent that nobody can visit, while the seller is far away, pressure to pay a deposit at once, a request for the buyer's bank or identity details, or a price far below the item's worth explained by a story. A money transfer ahead of any viewing is a sign of a scam only together with one of these.",
          false:
            "The listing describes a real sale of an item the seller has: the buyer can view or collect the item and pay at that moment, or pays through the marketplace's checkout for an item described plainly at a believable price. A listing that breaks the marketplace's rules in another way, with an item that may be fake, banned or of unclear origin, is still a real sale when the buyer can check the item before paying.",
        },
      },
    ),
    banned_item: noul(
      "Does the listing in `title` and `description` offer an item or a service of a kind that general marketplaces commonly ban?",
      {
        stakes: "high",
        criteria: {
          true: "The listing offers something of these kinds: weapons made to injure, including firearms, air guns, crossbows, their parts and ammunition, and self-defence weapons such as stun guns and irritant sprays; explosives and fireworks; illegal drugs and the equipment for taking them; prescription medicines; alcohol; tobacco and vaping products; live animals; human remains or body parts; stolen goods; counterfeit money; passports, identity documents and official badges; hazardous chemicals; recalled products; sexual services or adult content.",
          false:
            "The listing offers an ordinary product or service of another kind, such as tools, kitchen knives, ordinary sports gear like a bat, a ball, a racket or a bow for target archery, toys, furniture, containers or pet supplies sold on their own, including one whose name uses a word from these kinds in an everyday sense. Being a copy or a fake of a branded product does not by itself make an item one of these kinds, and a copy of an item of these kinds, such as a fake branded vape or medicine, is still that kind.",
        },
      },
    ),
    off_platform: noul(
      "Does the listing in `title` and `description` ask buyers to take the deal off this marketplace, to contact the seller elsewhere or to pay outside the marketplace?",
      {
        stakes: "low",
        criteria: {
          true: "The listing gives buyers a way to reach the seller outside the marketplace, such as a phone number, an email address, a messaging app or a website, or asks for money sent to the seller by a route other than the marketplace's checkout, such as a bank transfer, a payment app, gift cards or crypto, or offers better terms, such as a lower price, for settling the deal outside the marketplace.",
          false:
            "The listing keeps the conversation in the marketplace's messages, and the money goes through the marketplace's checkout, on its website or in its own app, or changes hands in person at collection.",
        },
      },
    ),
    counterfeit: noul(
      "Does the listing in `title` and `description` say, in the seller's own words, that the item is a counterfeit, a replica or a copy of a branded product?",
      {
        stakes: "high",
        criteria: {
          true: "The seller says the item imitates a brand's product: it is called a fake, a replica, a copy or an imitation of that brand's goods, or it carries a brand's name or logo that the brand did not put there. A copy of a brand's product that the brand did not make or license is a counterfeit whatever it is sold as, including decoration or display.",
          false:
            "The seller presents the item as the brand's own product or as goods the brand licensed: an official replica kit, the licensed fan version of a team's shirt, and a licensed model, toy or piece of merchandise of a branded product are genuine. The item can also be a generic product with no brand at all, or a reproduction of a historical object, an unbranded film prop or a scale model of a building.",
        },
      },
    ),
  },
});
