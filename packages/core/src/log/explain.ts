import type { Question, QuestionSet } from "../questions/index.ts";
import {
  type Answer,
  choiceConfidence,
  type Decision,
  decide,
  resolveThresholds,
} from "../thresholds/index.ts";
import type { AnswerEntry, HumanEntry, LogEntry } from "./model.ts";

/**
 * One record's history in words. Each model answer and each human decision is read with the wording
 * and thresholds of the question-set version it ran under, never today's: the history says what was
 * asked then. `facetdb explain` prints it and `GET /v1/decisions/:source/:key` returns it, both
 * through `explainHistory`, so the terminal and the page can never tell two stories.
 */

/** "58%": a probability or a confidence as a whole percent, never a decimal. */
export function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** "58% likely yes": how a probability reads anywhere a user sees one. */
export function likelyYes(probability: number): string {
  return `${percent(probability)} likely yes`;
}

/** A value a person chose, in words: "yes", "no", or the option or level name. */
export function chosenWords(value: boolean | string): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return value;
}

/** What the thresholds made of an answer: "yes", "no", an option or level name, or "needs review". */
export function decisionWords(decision: Decision): string {
  return decision.kind === "needs_review" ? "needs review" : chosenWords(decision.value);
}

/** What the model said, in words: "58% likely yes", "billing, 82% sure". */
export function saidWords(question: Question | undefined, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return likelyYes(answer.probability);
    case "choice":
      return `${answer.top}, ${percent(choiceConfidence(answer.probabilities))} sure`;
    case "score": {
      const level =
        question?.type === "score"
          ? question.levels[answer.probabilities.indexOf(Math.max(...answer.probabilities))]
          : undefined;
      return `${level?.name ?? "unknown"}, ${percent(answer.confidence)} sure`;
    }
  }
}

/**
 * What each question of a logged answer led to, in words, by question name, under the thresholds
 * of the question-set version the call ran under. `set` is undefined when the store no longer
 * keeps that version, and a question the set does not name has no thresholds to read: both are
 * "unknown".
 */
export function answerDecisions(
  entry: AnswerEntry,
  set: QuestionSet | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(entry.answers).map(([name, answer]) => {
      const question = set?.questions.find((candidate) => candidate.name === name);
      return [
        name,
        question === undefined || set === undefined
          ? "unknown"
          : decisionWords(
              decide(question, resolveThresholds(question, set.thresholds[name]), answer),
            ),
      ];
    }),
  );
}

/** One question as it was worded in the version in force, with the answer in words. */
export type ExplainedAnswer = {
  readonly question: string;
  /** The wording the model was given in that version. */
  readonly wording: string;
  /** "58% likely yes", "billing, 82% sure". */
  readonly said: string;
  /** What that version's thresholds made of it: "yes", "no", a name, or "needs review". */
  readonly decision: string;
};

export type ExplainedEntry =
  | {
      readonly kind: "answer";
      /** ISO 8601, UTC. */
      readonly at: string;
      readonly model: string;
      readonly version: number;
      readonly answers: readonly ExplainedAnswer[];
    }
  | {
      readonly kind: "human";
      readonly at: string;
      readonly version: number;
      readonly question: string;
      /** The wording of that version, or the question's name when the version is not kept. */
      readonly wording: string;
      readonly decided: string;
      readonly reviewer: string;
      readonly note?: string;
    };

function explainAnswer(entry: AnswerEntry, set: QuestionSet | undefined): ExplainedEntry {
  const decisions = answerDecisions(entry, set);
  const answers = Object.entries(entry.answers).map(([name, answer]): ExplainedAnswer => {
    const question = set?.questions.find((candidate) => candidate.name === name);
    return {
      question: name,
      wording: question?.instructions ?? name,
      said: saidWords(question, answer),
      decision: decisions[name] ?? "unknown",
    };
  });
  return {
    kind: "answer",
    at: entry.at.toISOString(),
    model: entry.model,
    version: entry.version,
    answers,
  };
}

function explainHuman(entry: HumanEntry, set: QuestionSet | undefined): ExplainedEntry {
  const question = set?.questions.find((candidate) => candidate.name === entry.question);
  return {
    kind: "human",
    at: entry.at.toISOString(),
    version: entry.version,
    question: entry.question,
    wording: question?.instructions ?? entry.question,
    decided: chosenWords(entry.value),
    reviewer: entry.reviewer,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

/**
 * A record's log entries (oldest first, as `DecisionLog.history` returns them) in words, each read
 * with the question set of its own version; a version the store does not keep is absent from
 * `versions`, and its entries fall back to the question's name.
 */
export function explainHistory(
  history: readonly LogEntry[],
  versions: ReadonlyMap<number, QuestionSet>,
): ExplainedEntry[] {
  return history.map((entry) =>
    entry.kind === "answer"
      ? explainAnswer(entry, versions.get(entry.version))
      : explainHuman(entry, versions.get(entry.version)),
  );
}
