// The listings example's sample data on MongoDB 4.4 and later or Atlas: a marketplace `listings`
// collection with 2,000 documents, run with the admin login before `facetdb migrate`
// (mongosh "<admin connection string>" seed.js; the database is the one the string names). Three
// categories in rotation, about one document in twenty written like a scam (upfront payment,
// off-platform contact), so the backfill has both answers to give. A mongosh script: `db` is
// mongosh's own.
const titles = [
  [
    "2015 Toyota Corolla, 98k km",
    "Honda CB500 motorbike, serviced",
    "Ford Transit van, long wheelbase",
    "VW Golf 1.4, one owner",
  ],
  [
    "Two-bedroom flat near the station",
    "Room in a shared house, bills included",
    "Family house with garden, 3 beds",
    "Studio to rent, furnished",
  ],
  [
    "Trek mountain bike, 29 inch",
    "Road bike carbon frame, 56 cm",
    "Kids bike with stabilisers",
    "Shimano groupset and wheels",
  ],
];

const descriptions = [
  "Full service history, MOT until next year, two keys. Viewing welcome at my home address, cash or bank transfer on collection.",
  "Close to shops and schools, recently redecorated, deposit and first month on signing. Viewings by appointment through the agency.",
  "Good condition, a few scratches, recently serviced. Collection only, happy to show it running before you pay.",
];

const scam =
  "URGENT. Owner abroad, item is at a shipping agent. Pay the deposit by gift card or crypto today and we deliver tomorrow. No viewing possible, contact only on WhatsApp +00 000 000.";

const count = 2000;
const documents = [];
for (let n = 1; n <= count; n += 1) {
  const now = new Date();
  documents.push({
    title: `${titles[n % 3][Math.floor(n / 3) % 4]} #${n}`,
    description: n % 20 === 0 ? scam : descriptions[n % 3],
    created_at: now,
    updated_at: now,
  });
}
db.listings.insertMany(documents);
