import type { Question, QuestionSet } from "../questions/index.ts";
import {
  type Answer,
  choiceConfidence,
  type Decision,
  decide,
  resolveThresholds,
} from "../thresholds/index.ts";
import { type AnswerEntry, type HumanEntry, isHumanDecision, type LogEntry } from "./model.ts";

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

/**
 * What an answer came to, as a tag beside the words. An option or a level may be named any one-line
 * text, "needs review" and "unknown" included, so no reader tells a decided value from the other
 * two by the words: it reads this. `unknown` is a version the store no longer keeps, or a question
 * that version does not name, so there are no thresholds to read the answer by.
 */
export type DecisionOutcome = "decided" | "needs_review" | "unknown";

export type TaggedDecision = {
  /** "yes", "no", an option or level name, "needs review" or "unknown": what a person reads. */
  readonly words: string;
  readonly outcome: DecisionOutcome;
};

const UNKNOWN_DECISION: TaggedDecision = { words: "unknown", outcome: "unknown" };

/** A decision with its tag. */
function tagDecision(decision: Decision): TaggedDecision {
  return { words: decisionWords(decision), outcome: decision.kind };
}

/** The most likely level of a score answer, by the question's levels; undefined without a score question. */
function topLevelName(question: Question | undefined, answer: Answer): string | undefined {
  if (question?.type !== "score" || answer.type !== "score") {
    return undefined;
  }
  return question.levels[answer.probabilities.indexOf(Math.max(...answer.probabilities))]?.name;
}

/**
 * The option or level the model named, as `facetdb export` prints it in `value`: a choice's top
 * option, a score's most likely level by the levels of the question set in force (empty when the
 * store no longer keeps that version), and nothing for a noul, whose answer is its probability.
 */
export function namedValue(question: Question | undefined, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return "";
    case "choice":
      return answer.top;
    case "score":
      return topLevelName(question, answer) ?? "";
  }
}

/** What the model said, in words: "58% likely yes", "billing, 82% sure". */
export function saidWords(question: Question | undefined, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return likelyYes(answer.probability);
    case "choice":
      return `${answer.top}, ${percent(choiceConfidence(answer.probabilities))} sure`;
    case "score":
      return `${topLevelName(question, answer) ?? "unknown"}, ${percent(answer.confidence)} sure`;
  }
}

/**
 * What each question of a logged answer led to, tagged, by question name, under the thresholds of
 * the question-set version the call ran under. `set` is undefined when the store no longer keeps
 * that version, and a question the set does not name has no thresholds to read: both are unknown.
 */
export function answerOutcomes(
  entry: AnswerEntry,
  set: QuestionSet | undefined,
): Readonly<Record<string, TaggedDecision>> {
  return Object.fromEntries(
    Object.entries(entry.answers).map(([name, answer]) => {
      const question = set?.questions.find((candidate) => candidate.name === name);
      return [
        name,
        question === undefined || set === undefined
          ? UNKNOWN_DECISION
          : tagDecision(
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
  /** The tag the words cannot carry: whether `decision` is a value, needs review or unknown. */
  readonly outcome: DecisionOutcome;
};

export type ExplainedEntry =
  | {
      readonly kind: "answer";
      /** ISO 8601, UTC. */
      readonly at: string;
      readonly model: string;
      readonly version: number;
      /** The hash of the state the model was shown: two answers at different hashes saw a changed record. */
      readonly stateHash: string;
      readonly answers: readonly ExplainedAnswer[];
    }
  | {
      readonly kind: "human";
      readonly at: string;
      readonly version: number;
      /** The state the reviewer saw; the decision stands while the record still has it. */
      readonly stateHash: string;
      readonly question: string;
      /** The wording of that version, or the question's name when the version is not kept. */
      readonly wording: string;
      readonly decided: string;
      readonly reviewer: string;
      readonly note?: string;
    }
  | {
      /** A reviewer took back their own decision (undo); both stay in the log. */
      readonly kind: "withdrawal";
      readonly at: string;
      readonly version: number;
      readonly stateHash: string;
      readonly question: string;
      readonly wording: string;
      readonly reviewer: string;
    };

function explainAnswer(entry: AnswerEntry, set: QuestionSet | undefined): ExplainedEntry {
  const outcomes = answerOutcomes(entry, set);
  const answers = Object.entries(entry.answers).map(([name, answer]): ExplainedAnswer => {
    const question = set?.questions.find((candidate) => candidate.name === name);
    const { words, outcome } = outcomes[name] ?? UNKNOWN_DECISION;
    return {
      question: name,
      wording: question?.instructions ?? name,
      said: saidWords(question, answer),
      decision: words,
      outcome,
    };
  });
  return {
    kind: "answer",
    at: entry.at.toISOString(),
    model: entry.model,
    version: entry.version,
    stateHash: entry.stateHash,
    answers,
  };
}

function explainHuman(entry: HumanEntry, set: QuestionSet | undefined): ExplainedEntry {
  const question = set?.questions.find((candidate) => candidate.name === entry.question);
  const common = {
    at: entry.at.toISOString(),
    version: entry.version,
    stateHash: entry.stateHash,
    question: entry.question,
    wording: question?.instructions ?? entry.question,
    reviewer: entry.reviewer,
  };
  if (!isHumanDecision(entry)) {
    return { kind: "withdrawal", ...common };
  }
  return {
    kind: "human",
    ...common,
    decided: chosenWords(entry.value),
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
