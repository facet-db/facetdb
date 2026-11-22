import { readFile } from "node:fs/promises";
import { type Clock, choiceConfidence, type Question } from "@facetdb/core";
import {
  type LabelledSample,
  type QuestionResult,
  runSample,
  type SampleRun,
  sampleReport,
} from "@facetdb/core/testing";
import {
  createBackoff,
  createInFlightLimiter,
  createResilientProvider,
  createTypeSafeProvider,
} from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { triage } from "../index.ts";

/**
 * The triage pack on the real model: its three questions asked of the pinned `jev-1.14.0` once on
 * each of the 50 labelled records of `triage.sample.json`, through the client the worker uses, each
 * answer decided by the pack's thresholds, and per question the agreement with the labels printed,
 * with missing_reproduction on the records labelled bug_report apart, as the sample's `about` asks.
 * A question under 45 of 50 is reworded in `triage.ts` and the run repeated.
 *
 * The same records are then asked again with kind's options in reverse order, the check for a lean
 * to the first option, and the report says which kind decisions the order changed and where the
 * records labelled unsure went in each order.
 *
 * It runs only through `test:live`, by hand, with `TYPESAFE_API_KEY` in the shell; without the key
 * it skips and says so on stderr, never silently (`facetdb-testing`). The key is read here and
 * never printed.
 */

const MODEL = "jev-1.14.0";
const KEY_VARIABLE = "TYPESAFE_API_KEY";
/** The bar: a question agreeing on fewer than 45 of the 50 records is reworded. */
const BAR = 45;
/** The pack's first option, the one a lean to the first option would favour. */
const FIRST = "bug_report";

const apiKey = process.env[KEY_VARIABLE];
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

if (!hasKey) {
  process.stderr.write(
    `\n${KEY_VARIABLE} is not set: the triage pack's live run is SKIPPED, nothing was measured.\n` +
      `Export ${KEY_VARIABLE} and run: pnpm --filter @facetdb/github run test:live\n\n`,
  );
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The pack's questions with kind's options last to first; every other question as it is. */
function kindReversed(questions: readonly Question[]): Question[] {
  return questions.map((question) =>
    question.type === "choice" && question.name === "kind"
      ? { ...question, options: [...question.options].reverse() }
      : question,
  );
}

/** kind's results of a run, by record. */
function kindOf(run: SampleRun): Map<string, QuestionResult> {
  return new Map(
    run.results
      .filter((result) => result.question === "kind")
      .map((result) => [result.record, result]),
  );
}

/** A kind answer in a few words: the top option, its confidence and the decision. */
function kindWords(result: QuestionResult): string {
  if (result.answer.type !== "choice") {
    throw new Error(`kind of ${result.record} is a ${result.answer.type} answer, not a choice`);
  }
  const decided = result.decision.kind === "decided" ? String(result.decision.value) : "review";
  return `${result.answer.top} at confidence ${choiceConfidence(result.answer.probabilities).toFixed(2)} -> ${decided}`;
}

/** What the reversed order changed: kind's decisions record by record, and the first option's share. */
function orderLines(forward: SampleRun, reversed: SampleRun): string[] {
  const before = kindOf(forward);
  const after = kindOf(reversed);
  const decision = (result: QuestionResult | undefined) =>
    result === undefined || result.decision.kind === "needs_review"
      ? "review"
      : String(result.decision.value);
  const records = [...before.keys()];
  const changed = records.filter(
    (record) => decision(before.get(record)) !== decision(after.get(record)),
  );
  const unsure = records.filter((record) => before.get(record)?.expected === "unsure");
  const toFirst = (run: Map<string, QuestionResult>, among: readonly string[]) =>
    among.filter((record) => decision(run.get(record)) === FIRST).length;
  const line = (record: string) => {
    const first = before.get(record);
    const second = after.get(record);
    if (first === undefined || second === undefined) {
      throw new Error(`record ${record} is missing from one of the two runs`);
    }
    return `  ${record} labelled ${first.expected}: in order ${kindWords(first)}; reversed ${kindWords(second)}`;
  };
  return [
    "reversed-order check (kind's options last to first):",
    `kind decisions that differ between the two orders: ${changed.length} of ${records.length}`,
    ...changed.map(line),
    `the ${unsure.length} records labelled unsure, in both orders:`,
    ...unsure.map(line),
    `decided ${FIRST}: ${toFirst(before, records)} of ${records.length} in the pack's order, ${toFirst(after, records)} reversed; ` +
      `of the ${unsure.length} labelled unsure: ${toFirst(before, unsure)} in order, ${toFirst(after, unsure)} reversed`,
  ];
}

describe.skipIf(!hasKey)(`the triage pack live on ${MODEL}`, () => {
  it("answers each of its 50 labelled records once in the pack's order and once with kind reversed, and prints the agreement and what the order changed", async () => {
    const sample = JSON.parse(
      await readFile(new URL("./triage.sample.json", import.meta.url), "utf8"),
    ) as LabelledSample;
    // The worker's own wrapping: 429 and 529 retried with backoff, at most four calls in flight.
    const provider = createResilientProvider(
      createTypeSafeProvider({ apiKey: apiKey ?? "", fetch: globalThis.fetch, clock: systemClock }),
      {
        backoff: createBackoff({ clock: systemClock, random: Math.random }),
        limiter: createInFlightLimiter({ clock: systemClock, max: 4 }),
      },
    );
    const bugReports = new Set(
      sample.records
        .filter((record) => record.expected["kind"] === "bug_report")
        .map((record) => record.id),
    );
    const report = (pack: string, questions: readonly Question[], run: SampleRun) =>
      sampleReport(run, {
        pack,
        questions,
        thresholds: triage.thresholds,
        bar: BAR,
        subsets: [
          {
            name: `the ${bugReports.size} records labelled bug_report`,
            question: "missing_reproduction",
            records: bugReports,
          },
        ],
      });

    const forward = await runSample({
      provider,
      model: MODEL,
      questions: triage.questions,
      thresholds: triage.thresholds,
      sample,
    });
    process.stderr.write(`\n${report("triage", triage.questions, forward).join("\n")}\n\n`);

    const reversedQuestions = kindReversed(triage.questions);
    const reversed = await runSample({
      provider,
      model: MODEL,
      questions: reversedQuestions,
      thresholds: triage.thresholds,
      sample,
    });
    process.stderr.write(
      `${report("triage, kind reversed", reversedQuestions, reversed).join("\n")}\n\n` +
        `${orderLines(forward, reversed).join("\n")}\n\n`,
    );

    // Both runs are the pinned model's, every record answered once each and paid for; the agreement
    // is a person's to judge against the bar, printed above, not an assertion here.
    for (const run of [forward, reversed]) {
      expect(run.models).toEqual([MODEL]);
      expect(run.calls).toBe(50);
      expect(run.results).toHaveLength(50 * triage.questions.length);
      expect(run.inputTokens).toBeGreaterThan(0);
    }
    expect(reversed.questionSet).not.toBe(forward.questionSet);
  });
});
