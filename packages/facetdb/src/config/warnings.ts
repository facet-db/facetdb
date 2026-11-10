import { checkStateSize, type Question, type QuestionSet, STATE_WARN_TOKENS } from "@facetdb/core";

/**
 * Wording warnings: the model reads a question literally, does not count, reads dates as text and
 * loses accuracy as unrelated text grows. A warning never refuses a config, because the wording is
 * the author's; it says what the model tends to get wrong and what to do instead. Plain words only:
 * no warning names a question type or shows a probability.
 */

export type WordingWarningCode = "double-negative" | "counting" | "date-comparison" | "state-size";

export type WordingWarning = {
  /** The question the warning is about; null when it is about the whole state. */
  readonly question: string | null;
  readonly code: WordingWarningCode;
  readonly message: string;
  /** What to do instead, as one sentence. */
  readonly fix: string;
};

const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "none",
  "nobody",
  "nothing",
  "nowhere",
  "neither",
  "nor",
  "cannot",
  "without",
]);

const NUMBER_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "twenty",
  "thirty",
  "fifty",
  "hundred",
  "thousand",
  "million",
  "once",
  "twice",
]);

const DATE_WORDS = new Set([
  "date",
  "dates",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "today",
  "yesterday",
  "tomorrow",
  "deadline",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

/** Words that put two moments or two amounts in order; they matter only beside a date word. */
const DATE_COMPARISONS = new Set([
  "before",
  "after",
  "since",
  "until",
  "within",
  "older",
  "newer",
  "earlier",
  "later",
  "prior",
]);

/** Tokens of a state field's name that say it holds a date or a time. */
const DATE_FIELD_TOKENS = new Set([
  "date",
  "datetime",
  "time",
  "timestamp",
  "deadline",
  "due",
  "expires",
  "expiry",
  "created",
  "updated",
  "dob",
  "birthday",
]);
const DATE_FIELD_SUFFIXES = new Set(["at", "on"]);

/** How many words either side of a comparison word still count as "next to" it. */
const NEARBY_WORDS = 5;

function textsOf(question: Question): string[] {
  switch (question.type) {
    case "noul":
      return [question.instructions, question.criteria?.true ?? "", question.criteria?.false ?? ""];
    case "choice":
      return [question.instructions, ...question.options.map((option) => option.description)];
    case "score":
      return [question.instructions, ...question.levels.map((level) => level.description ?? "")];
  }
}

function sentencesOf(text: string): string[] {
  return text.split(/[.!?]+(?:\s+|$)|[;:\n]+/).filter((sentence) => sentence.trim() !== "");
}

/** Lowercase words; an apostrophe or a dot inside a word stays (can't, order.created_at), and an ISO date is one word. */
function wordsOf(sentence: string): string[] {
  return (
    sentence.toLowerCase().match(/\d{4}-\d{2}-\d{2}|[\p{L}\p{N}_]+(?:['’.][\p{L}\p{N}_]+)*/gu) ?? []
  );
}

function isNegation(word: string): boolean {
  return NEGATIONS.has(word) || /n['’]t$/.test(word);
}

/** Two negations in one sentence; "neither … nor" is one negation, "not only" is none. */
function hasDoubleNegative(text: string): boolean {
  return sentencesOf(text).some((sentence) => {
    const words = wordsOf(sentence);
    let count = 0;
    let neither = false;
    words.forEach((word, index) => {
      if (!isNegation(word)) {
        return;
      }
      if (word === "not" && words[index + 1] === "only") {
        return;
      }
      if (word === "neither") {
        neither = true;
      }
      if (word === "nor" && neither) {
        return;
      }
      count += 1;
    });
    return count >= 2;
  });
}

function isNumber(word: string): boolean {
  return /^\d[\d,.]*$/.test(word) || NUMBER_WORDS.has(word);
}

/** "how many", "total" and "count" always; "more than" and "at least" only before a number. */
function hasCounting(text: string): boolean {
  return sentencesOf(text).some((sentence) => {
    const words = wordsOf(sentence);
    return words.some((word, index) => {
      const next = words[index + 1];
      if (word === "how" && next === "many") {
        return true;
      }
      if (word === "total" || word === "totals") {
        return true;
      }
      if (/^count(s|ing|ed)?$/.test(word)) {
        return next !== "as";
      }
      const quantity =
        (word === "more" && next === "than") ||
        (word === "less" && next === "than") ||
        (word === "fewer" && next === "than") ||
        (word === "at" && (next === "least" || next === "most"));
      if (!quantity) {
        return false;
      }
      const after = words.slice(index + 2, index + 4);
      return after.some(isNumber);
    });
  });
}

function fieldTokens(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[._\-\s]+/)
    .filter((token) => token !== "");
}

/** Whether a state field's name says it holds a date or a time (created_at, dueDate, deadline). */
function isDateField(field: string): boolean {
  const tokens = fieldTokens(field);
  const last = tokens[tokens.length - 1];
  return (
    tokens.some((token) => DATE_FIELD_TOKENS.has(token)) ||
    (last !== undefined && tokens.length > 1 && DATE_FIELD_SUFFIXES.has(last))
  );
}

/** Beside a date word, an ISO date or the name of a date-typed state field. */
function hasDateComparison(text: string, dateFields: ReadonlySet<string>): boolean {
  const isDateTerm = (word: string): boolean =>
    DATE_WORDS.has(word) ||
    /^\d{4}-\d{2}-\d{2}$/.test(word) ||
    dateFields.has(word) ||
    dateFields.has(word.slice(word.lastIndexOf(".") + 1));
  return sentencesOf(text).some((sentence) => {
    const words = wordsOf(sentence);
    return words.some((word, index) => {
      if (!DATE_COMPARISONS.has(word)) {
        return false;
      }
      const near = [
        ...words.slice(Math.max(0, index - NEARBY_WORDS), index),
        ...words.slice(index + 1, index + 1 + NEARBY_WORDS),
      ];
      return near.some(isDateTerm);
    });
  });
}

function quoted(name: string): string {
  return `"${name}"`;
}

const COUNT_FIX =
  "Compute the number in SQL and pass it as a state field, then compare it in a view or an action condition instead of asking the model to count.";
const DATE_FIX =
  "Compute the difference in SQL (the days since the date, for example) and pass it as a state field, then compare that number in a view or an action condition.";
const NEGATIVE_FIX =
  'Rewrite it so a true answer means yes and it holds at most one negation: ask "Does the message ask for a refund?" rather than "Is it untrue that the message does not ask for a refund?".';
const SIZE_FIX =
  "Drop the fields the questions do not need from read, or pass a shorter field (a summary or the first lines) computed in SQL.";

/**
 * Warns on wording the model reads literally: a double negative, counting, a date comparison, and a
 * state estimate above 8,000 tokens. `stateEstimateTokens` is core's estimate for a typical record
 * (0 when nothing was measured, which warns about nothing). The question set is only read.
 */
export function wordingWarnings(
  questionSet: QuestionSet,
  stateEstimateTokens: number,
): WordingWarning[] {
  const dateFields = new Set(
    questionSet.read.filter(isDateField).flatMap((field) => {
      const lower = field.toLowerCase();
      return [lower, lower.slice(lower.lastIndexOf(".") + 1)];
    }),
  );
  const warnings: WordingWarning[] = [];
  for (const question of questionSet.questions) {
    const text = textsOf(question).join("\n");
    const name = quoted(question.name);
    if (hasDoubleNegative(text)) {
      warnings.push({
        question: question.name,
        code: "double-negative",
        message: `The question ${name} has two negations in one sentence. The model reads words literally, so "not … no" can flip the meaning of its answer.`,
        fix: NEGATIVE_FIX,
      });
    }
    if (hasCounting(text)) {
      warnings.push({
        question: question.name,
        code: "counting",
        message: `The question ${name} asks the model to count or compare an amount. The model does not count reliably and is weak on numbers.`,
        fix: COUNT_FIX,
      });
    }
    if (hasDateComparison(text, dateFields)) {
      warnings.push({
        question: question.name,
        code: "date-comparison",
        message: `The question ${name} compares dates. The model reads a date as text, not as a point in time, so "before" and "older than" are unreliable.`,
        fix: DATE_FIX,
      });
    }
  }
  if (checkStateSize(stateEstimateTokens).kind !== "ok") {
    warnings.push({
      question: null,
      code: "state-size",
      message: `The state of a record is about ${stateEstimateTokens.toLocaleString("en-US")} tokens, above ${STATE_WARN_TOKENS.toLocaleString("en-US")}. Answers get less accurate as unrelated text grows, and a large state costs more on every record.`,
      fix: SIZE_FIX,
    });
  }
  return warnings;
}

/** A warning found while loading a config, with the source it belongs to. */
export type ConfigWarning = WordingWarning & { readonly source: string };

/** The text printed to stderr: the source and question named, then what to do. One block per warning. */
export function formatWarnings(warnings: readonly ConfigWarning[]): string {
  return warnings
    .map((warning) => {
      const where =
        warning.question === null
          ? `source ${quoted(warning.source)}`
          : `source ${quoted(warning.source)}, question ${quoted(warning.question)}`;
      return `warning: ${where}\n  ${warning.message}\n  Fix: ${warning.fix}\n`;
    })
    .join("");
}
