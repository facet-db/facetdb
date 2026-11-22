import { readFile } from "node:fs/promises";
import type { Clock } from "@facetdb/core";
import { type LabelledSample, runSample, sampleReport } from "@facetdb/core/testing";
import {
  createBackoff,
  createInFlightLimiter,
  createResilientProvider,
  createTypeSafeProvider,
} from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { marketplace } from "./index.ts";

/**
 * The marketplace pack on the real model: its four questions asked of the pinned `jev-1.14.0` once
 * on each of the 50 labelled listings of `marketplace.sample.json`, through the client the worker
 * uses, each answer decided by the thresholds its stakes give, and per question the agreement with
 * the labels printed, with the unsure listings per stakes level, as the sample's `about` asks. A
 * question under 45 of 50 is reworded in `marketplace.ts` and the run repeated.
 *
 * It runs only through `test:live`, by hand, with `TYPESAFE_API_KEY` in the shell; without the key
 * it skips and says so on stderr, never silently (`facetdb-testing`). The key is read here and
 * never printed.
 */

const MODEL = "jev-1.14.0";
const KEY_VARIABLE = "TYPESAFE_API_KEY";
/** The bar: a question agreeing on fewer than 45 of the 50 listings is reworded. */
const BAR = 45;

const apiKey = process.env[KEY_VARIABLE];
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

if (!hasKey) {
  process.stderr.write(
    `\n${KEY_VARIABLE} is not set: the marketplace pack's live run is SKIPPED, nothing was measured.\n` +
      `Export ${KEY_VARIABLE} and run: pnpm --filter @facetdb/packs run test:live\n\n`,
  );
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

describe.skipIf(!hasKey)(`the marketplace pack live on ${MODEL}`, () => {
  it("answers each of its 50 labelled listings once, and prints the agreement per question", async () => {
    const sample = JSON.parse(
      await readFile(new URL("./marketplace.sample.json", import.meta.url), "utf8"),
    ) as LabelledSample;
    // The worker's own wrapping: 429 and 529 retried with backoff, at most four calls in flight.
    const provider = createResilientProvider(
      createTypeSafeProvider({ apiKey: apiKey ?? "", fetch: globalThis.fetch, clock: systemClock }),
      {
        backoff: createBackoff({ clock: systemClock, random: Math.random }),
        limiter: createInFlightLimiter({ clock: systemClock, max: 4 }),
      },
    );

    const run = await runSample({
      provider,
      model: MODEL,
      questions: marketplace.questions,
      thresholds: marketplace.thresholds,
      sample,
    });

    const lines = sampleReport(run, {
      pack: "marketplace",
      questions: marketplace.questions,
      thresholds: marketplace.thresholds,
      bar: BAR,
    });
    process.stderr.write(`\n${lines.join("\n")}\n\n`);

    // The run is the pinned model's, every listing answered once and paid for; the agreement is a
    // person's to judge against the bar, printed above, not an assertion here.
    expect(run.models).toEqual([MODEL]);
    expect(run.calls).toBe(50);
    expect(run.results).toHaveLength(50 * marketplace.questions.length);
    expect(run.inputTokens).toBeGreaterThan(0);
  });
});
