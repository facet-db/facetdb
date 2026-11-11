import type { Clock, ProviderRequest, Question } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { createTypeSafeProvider } from "./client.ts";

/**
 * The one test that reaches the real API: the marketplace listings questions against the pinned
 * `jev-1.14.0`, through the same client the worker uses. It runs only through `test:live`, by
 * hand, with `TYPESAFE_API_KEY` in the shell; without the key it skips and says so on stderr,
 * never silently. The key is read here, at this file's boundary, and never printed.
 */

const MODEL = "jev-1.14.0";
const KEY_VARIABLE = "TYPESAFE_API_KEY";

const apiKey = process.env[KEY_VARIABLE];
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

if (!hasKey) {
  process.stderr.write(
    `\n${KEY_VARIABLE} is not set: the live TypeSafe test is SKIPPED, nothing was proven.\n` +
      `Export ${KEY_VARIABLE} and run: pnpm --filter @facetdb/model run test:live typesafe\n\n`,
  );
}

const listingsQuestions: readonly Question[] = [
  {
    type: "noul",
    name: "is_scam",
    instructions: "Is this listing likely a scam?",
    stakes: "high",
  },
  {
    type: "choice",
    name: "category",
    instructions: "Which category is this listing?",
    options: [
      { name: "car", description: "A car, van or motorbike" },
      { name: "flat", description: "A flat, house or room to rent or buy" },
      { name: "bike", description: "A bicycle or its parts" },
    ],
    stakes: "low",
    storeProbabilities: false,
  },
];

const listing: ProviderRequest = {
  model: MODEL,
  state: {
    title: "2019 Toyota Corolla, low mileage, must go this week",
    description:
      "Selling my Corolla, 48,000 km, full service history. I am abroad so I cannot show the " +
      "car; send a deposit by gift card and a courier will deliver it to your door.",
  },
  questions: listingsQuestions,
};

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

describe.skipIf(!hasKey)(`typesafe live: ${MODEL}`, () => {
  it("answers the listings questions in the documented shape and echoes the model", async () => {
    const provider = createTypeSafeProvider({
      apiKey: apiKey ?? "",
      fetch: globalThis.fetch,
      clock: systemClock,
    });

    const response = await provider.ask(listing);

    // The log records the version that answered; a run on jev-1.14.0 must see exactly that.
    expect(response.model).toBe(MODEL);
    // The spending cap counts billable input tokens; a real call never costs nothing.
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(Number.isInteger(response.usage.outputTokens)).toBe(true);
    expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);

    // The shape the thresholds consume, one answer per question, already validated at the
    // boundary by parseAnswers: a mismatch would have thrown instead of reaching these lines.
    expect(Object.keys(response.answers).sort()).toEqual(["category", "is_scam"]);

    const isScam = response.answers["is_scam"];
    expect(isScam?.type).toBe("noul");
    if (isScam?.type !== "noul") {
      throw new Error("is_scam is not a noul answer");
    }
    expect(isScam.probability).toBeGreaterThanOrEqual(0);
    expect(isScam.probability).toBeLessThanOrEqual(1);

    const category = response.answers["category"];
    expect(category?.type).toBe("choice");
    if (category?.type !== "choice") {
      throw new Error("category is not a choice answer");
    }
    expect(["car", "flat", "bike"]).toContain(category.top);
    expect(category.probabilities).toHaveLength(3);
    for (const probability of category.probabilities) {
      expect(probability).toBeGreaterThanOrEqual(0);
      expect(probability).toBeLessThanOrEqual(1);
    }
    const total = category.probabilities.reduce((sum, probability) => sum + probability, 0);
    expect(total).toBeCloseTo(1, 2);

    // What a run prints: the echoed version, the tokens and the answers. Never the key.
    process.stderr.write(
      `typesafe live: model=${response.model} input_tokens=${response.usage.inputTokens} ` +
        `output_tokens=${response.usage.outputTokens} is_scam=${isScam.probability.toFixed(3)} ` +
        `category=${category.top} [${category.probabilities.map((p) => p.toFixed(3)).join(", ")}]\n`,
    );
  });
});
