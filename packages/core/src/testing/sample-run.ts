import { PRICE_PER_MILLION_INPUT_TOKENS } from "../backfill/index.ts";
import type { ModelProvider } from "../contracts/index.ts";
import { contentHash, type Question } from "../questions/index.ts";
import type { StateValue } from "../records/index.ts";
import {
  type Answer,
  choiceConfidence,
  type Decision,
  decide,
  resolveThresholds,
  type ThresholdOverride,
  type Thresholds,
} from "../thresholds/index.ts";

/**
 * A question pack's labelled sample run on a model: one request per record with every question of
 * the pack, each answer turned into a decision by the pack's thresholds exactly as the worker turns
 * it (`decide`), and each decision compared with the answer a person gave the record. The packs'
 * `*.live.test.ts` run it on the real model; nothing here calls one itself.
 *
 * A label is a decision's value: `yes` or `no` for a noul, an option's name for a choice, a level's
 * name for a score, or `unsure`, which means the person would send the record to review, so it
 * agrees with an answer in the question's review band (the samples' `about`).
 */

/** A pack's committed sample: the state fields the pack reads, and the labelled records. */
export type LabelledSample = {
  readonly fields: readonly string[];
  readonly records: readonly LabelledRecord[];
};

/** One record: its id, its state fields at the top level, and the label per question. */
export type LabelledRecord = {
  readonly id: string;
  readonly expected: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
};

/**
 * How one decision compares with its label: `agrees` when it is the labelled answer or, on an
 * unsure label, when it went to review; `wrong` when it is an automatic answer other than the
 * labelled one; `review` when a labelled answer went to review instead; `automatic` when an unsure
 * label was decided automatically. The last two are reported apart from the wrong answers.
 */
export type Outcome = "agrees" | "wrong" | "review" | "automatic";

export type QuestionResult = {
  readonly record: string;
  readonly question: string;
  readonly expected: string;
  readonly answer: Answer;
  readonly decision: Decision;
  readonly outcome: Outcome;
};

export type SampleRun = {
  /**
   * The content hash of the question set the run asked (core's `contentHash`: the model, the fields
   * read and every question's wording, criteria and option order), so a report names the wording it
   * measured by its content rather than by a commit.
   */
  readonly questionSet: string;
  /** Every model version the responses named, in the order first seen: one for a pinned run. */
  readonly models: readonly string[];
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** One per record and question, in the sample's record order and the pack's question order. */
  readonly results: readonly QuestionResult[];
};

export type SampleRunOptions = {
  /** The caller's provider, wrapped in its backoff and in-flight limit: every record is asked at once. */
  readonly provider: ModelProvider;
  readonly model: string;
  readonly questions: readonly Question[];
  readonly thresholds: Readonly<Record<string, ThresholdOverride>>;
  readonly sample: LabelledSample;
};

const UNSURE = "unsure";

/** The labels a question takes: its decision values, and unsure. */
function labelsOf(question: Question): readonly string[] {
  switch (question.type) {
    case "noul":
      return ["yes", "no", UNSURE];
    case "choice":
      return [...question.options.map((option) => option.name), UNSURE];
    case "score":
      return [...question.levels.map((level) => level.name), UNSURE];
  }
}

/** A decision written as a label. */
function labelOf(decision: Decision): string {
  if (decision.kind === "needs_review") {
    return UNSURE;
  }
  if (typeof decision.value === "boolean") {
    return decision.value ? "yes" : "no";
  }
  return decision.value;
}

function outcomeOf(expected: string, decision: Decision): Outcome {
  const decided = labelOf(decision);
  if (decided === expected) {
    return "agrees";
  }
  if (expected === UNSURE) {
    return "automatic";
  }
  return decided === UNSURE ? "review" : "wrong";
}

/** The record's state over the sample's fields; a field that is neither text nor null is refused. */
function stateOf(record: LabelledRecord, fields: readonly string[]): Record<string, StateValue> {
  const state: Record<string, StateValue> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" && value !== null) {
      throw new Error(`record ${record.id}: the field "${field}" is neither text nor null`);
    }
    state[field] = value;
  }
  return state;
}

/** Every record holds an allowed label for every question, so a typo is refused, never counted. */
function checkLabels(questions: readonly Question[], records: readonly LabelledRecord[]): void {
  for (const record of records) {
    for (const question of questions) {
      const label = record.expected[question.name];
      const allowed = labelsOf(question);
      if (label === undefined || !allowed.includes(label)) {
        throw new Error(
          `record ${record.id}: the label for ${question.name} is ${label === undefined ? "missing" : `"${label}"`}, not one of ${allowed.join(", ")}`,
        );
      }
    }
  }
}

/**
 * Asks the model every record of the sample, once each, and compares each decision with its label.
 * A failed call rejects the run: it is an error, never an answer.
 */
export async function runSample(options: SampleRunOptions): Promise<SampleRun> {
  const { provider, model, questions, thresholds, sample } = options;
  checkLabels(questions, sample.records);
  const responses = await Promise.all(
    sample.records.map((record) =>
      provider.ask({ model, state: stateOf(record, sample.fields), questions }),
    ),
  );
  const models: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const results: QuestionResult[] = [];
  sample.records.forEach((record, at) => {
    const response = responses[at];
    if (response === undefined) {
      throw new Error(`record ${record.id} has no response`);
    }
    if (!models.includes(response.model)) {
      models.push(response.model);
    }
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    for (const question of questions) {
      const answer = response.answers[question.name];
      if (answer === undefined) {
        throw new Error(`record ${record.id}: the response has no answer to ${question.name}`);
      }
      const decision = decide(
        question,
        resolveThresholds(question, thresholds[question.name]),
        answer,
      );
      const expected = record.expected[question.name];
      if (expected === undefined) {
        throw new Error(`record ${record.id} has no label for ${question.name}`);
      }
      results.push({
        record: record.id,
        question: question.name,
        expected,
        answer,
        decision,
        outcome: outcomeOf(expected, decision),
      });
    }
  });
  const questionSet = contentHash({ questions, read: sample.fields, model, thresholds });
  return { questionSet, models, calls: responses.length, inputTokens, outputTokens, results };
}

export type Tally = {
  readonly total: number;
  readonly agrees: number;
  readonly wrong: number;
  readonly review: number;
  readonly automatic: number;
  /** Answers sent to review, whatever their label: the share a person would see. */
  readonly sentToReview: number;
};

export function tally(results: readonly QuestionResult[]): Tally {
  const count = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
  return {
    total: results.length,
    agrees: count("agrees"),
    wrong: count("wrong"),
    review: count("review"),
    automatic: count("automatic"),
    sentToReview: results.filter((result) => result.decision.kind === "needs_review").length,
  };
}

/** A part of the sample reported apart for one question, such as the bug reports alone. */
export type SampleSubset = {
  readonly name: string;
  readonly question: string;
  readonly records: ReadonlySet<string>;
};

export type ReportOptions = {
  readonly pack: string;
  readonly questions: readonly Question[];
  readonly thresholds: Readonly<Record<string, ThresholdOverride>>;
  /** The fewest agreeing answers a question is held to; a question under it is marked. */
  readonly bar: number;
  readonly subsets?: readonly SampleSubset[];
};

function thresholdWords(thresholds: Thresholds): string {
  return thresholds.kind === "yes-no"
    ? `yes at ${thresholds.yesAbove.toFixed(2)} or above, no at ${thresholds.noBelow.toFixed(2)} or below`
    : `decides at confidence ${thresholds.confidenceAtLeast.toFixed(2)} or above`;
}

function tallyWords(counts: Tally): string {
  return (
    `${counts.agrees} of ${counts.total} agree; ${counts.wrong} wrong, ` +
    `${counts.review} sent to review on a labelled record, ` +
    `${counts.automatic} decided on an unsure record; ` +
    `${counts.sentToReview} of ${counts.total} sent to review`
  );
}

/** An answer in a few characters: a noul's yes probability, a choice's or score's top and confidence. */
function answerWords(question: Question, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return answer.probability.toFixed(3);
    case "choice": {
      const options = question.type === "choice" ? question.options : [];
      const spread = answer.probabilities
        .map((probability, at) => `${options[at]?.name ?? at} ${probability.toFixed(2)}`)
        .join(", ");
      const confidence = choiceConfidence(answer.probabilities).toFixed(2);
      return `${answer.top} at confidence ${confidence} [${spread}]`;
    }
    case "score":
      return `expected ${answer.expected.toFixed(2)} at confidence ${answer.confidence.toFixed(2)} [${answer.probabilities.map((p) => p.toFixed(2)).join(", ")}]`;
  }
}

const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = {
  agrees: "agrees",
  wrong: "WRONG",
  review: "REVIEW (labelled)",
  automatic: "AUTOMATIC (labelled unsure)",
};

/**
 * The run in plain lines, for a person and for a file: the question set's content hash, the model
 * and the cost, the records sent to review, per question its thresholds and its agreement, per
 * label, the subsets, the unsure labels per stakes level, every answer that does not agree, and
 * every answer of every record.
 */
export function sampleReport(run: SampleRun, options: ReportOptions): string[] {
  const { pack, questions, thresholds, bar } = options;
  const records = new Set(run.results.map((result) => result.record)).size;
  // One undecided answer puts the whole record in review.
  const inReview = new Set(
    run.results
      .filter((result) => result.decision.kind === "needs_review")
      .map((result) => result.record),
  ).size;
  const dollars = (run.inputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS;
  const lines = [
    `${pack}: question set ${run.questionSet}`,
    `${pack}: ${records} records, ${run.calls} calls, answered by ${run.models.join(", ")}; ` +
      `${run.inputTokens} input tokens ($${dollars.toFixed(4)} at $${PRICE_PER_MILLION_INPUT_TOKENS} per million), ` +
      `${run.outputTokens} output tokens`,
    `records sent to review (any answer in review): ${inReview} of ${records}`,
  ];
  for (const question of questions) {
    const own = run.results.filter((result) => result.question === question.name);
    const counts = tally(own);
    const under = counts.agrees < bar ? `  BELOW ${bar} of ${counts.total}` : "";
    lines.push(
      `${question.name} (${question.type}, ${question.stakes} stakes, ${thresholdWords(resolveThresholds(question, thresholds[question.name]))}): ${tallyWords(counts)}${under}`,
    );
    const perLabel = labelsOf(question)
      .map((label) => {
        const labelled = own.filter((result) => result.expected === label);
        return labelled.length === 0
          ? undefined
          : `${label} ${tally(labelled).agrees}/${labelled.length}`;
      })
      .filter((words) => words !== undefined);
    lines.push(`  per label: ${perLabel.join(" · ")}`);
    for (const subset of options.subsets ?? []) {
      if (subset.question === question.name) {
        const part = own.filter((result) => subset.records.has(result.record));
        lines.push(`  on ${subset.name}: ${tallyWords(tally(part))}`);
      }
    }
  }
  for (const stakes of ["high", "low"] as const) {
    const names = new Set(questions.filter((q) => q.stakes === stakes).map((q) => q.name));
    const unsure = run.results.filter(
      (result) => names.has(result.question) && result.expected === UNSURE,
    );
    if (unsure.length > 0) {
      lines.push(
        `unsure labels at ${stakes} stakes (${[...names].join(", ")}): ${tally(unsure).agrees} of ${unsure.length} sent to review`,
      );
    }
  }
  const byName = new Map(questions.map((question) => [question.name, question]));
  const answerLine = (result: QuestionResult): string => {
    const question = byName.get(result.question);
    const words = question === undefined ? "" : answerWords(question, result.answer);
    return `${result.question} ${words} -> ${labelOf(result.decision)}`;
  };
  lines.push("answers that do not agree with their label:");
  for (const result of run.results.filter((result) => result.outcome !== "agrees")) {
    lines.push(
      `  ${result.record} ${OUTCOME_WORDS[result.outcome]}: labelled ${result.expected}, ${answerLine(result)}`,
    );
  }
  lines.push("every answer:");
  for (const record of new Set(run.results.map((result) => result.record))) {
    const own = run.results.filter((result) => result.record === record);
    lines.push(
      `  ${record} ${own.map((result) => `${answerLine(result)} (${result.expected}${result.outcome === "agrees" ? "" : ` ${OUTCOME_WORDS[result.outcome]}`})`).join(" | ")}`,
    );
  }
  return lines;
}
