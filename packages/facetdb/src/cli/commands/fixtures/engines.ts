// One source per database FacetDB connects to, for `facetdb types`: the support-messages questions,
// with the choice's probabilities stored so that its json column shows, on each engine's connection
// string. The strings carry no password: types reads the scheme only.
import { choice, facetdb, noul, type ProjectConfig, score } from "../../../config/index.ts";

/** A connection string per engine, by the name its fixture files carry. */
export const ENGINE_URLS = {
  postgres: "postgres://app@db.example.com:5432/shop",
  cockroachdb: "cockroachdb://app@db.example.com:26257/shop",
  mysql: "mysql://app@db.example.com:3306/shop",
  mariadb: "mariadb://app@db.example.com:3306/shop",
  mssql: "sqlserver://app@db.example.com:1433/shop",
  sqlite: "sqlite:///var/data/shop.db",
  libsql: "libsql://shop-acme.turso.io",
  mongodb: "mongodb://app@db.example.com:27017/shop?replicaSet=rs0",
  oracle: "oracle://app@db.example.com:2484/shop?protocol=tcps",
} as const;

export type EngineName = keyof typeof ENGINE_URLS;

export const ENGINE_NAMES = Object.keys(ENGINE_URLS) as EngineName[];

/** The source's questions: a score, a choice with its probabilities stored, a yes-or-no. */
function questions() {
  return {
    urgency: score("How urgent is this message?", ["low", "medium", "high"]),
    team: choice(
      "Which team should handle it?",
      {
        billing: "Charges, payments, invoices",
        shipping: "Delivery times, tracking, countries",
        returns: "Damaged items, exchanges, refunds",
      },
      { storeProbabilities: true },
    ),
    wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
  };
}

/** A project with the one source `support_messages` on the engine's database. */
export function onEngine(engine: EngineName): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "support_messages",
        database: ENGINE_URLS[engine],
        table: "support_messages",
        read: ["subject", "body"],
        questions: questions(),
      },
    ],
  });
}

/** A project with a source on every engine, each on its own table (`<engine>_messages`). */
export function onEveryEngine(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: ENGINE_NAMES.map((engine) => ({
      name: `${engine}_messages`,
      database: ENGINE_URLS[engine],
      table: `${engine}_messages`,
      read: ["subject", "body"],
      questions: questions(),
    })),
  });
}
