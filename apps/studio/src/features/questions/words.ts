import type { DraftIssue } from "../../api/index.ts";
import type { QuestionType, Stakes } from "./draft.ts";

/** The question types as the page names them. */
export const TYPE_WORDS: Record<QuestionType, string> = {
  noul: "Yes or no",
  choice: "Pick one",
  score: "Rate on a scale",
};

/**
 * "What happens when this answer is wrong?": each stakes in words, with no figure: the cut in
 * force, which a hand-set threshold can change, is said once, under the slider.
 */
export function stakesWords(stakes: Stakes): string {
  return stakes === "high"
    ? "High stakes: a wrong answer hides, rejects or charges something, or accuses someone"
    : "Low stakes: a wrong answer gets a second look";
}

/** Dollars as a person reads a price this small: "$0.0002", "$0.04", "$1.20". */
export function dollarWords(dollars: number): string {
  if (dollars === 0) {
    return "$0";
  }
  if (dollars < 0.01) {
    return `$${dollars.toPrecision(1)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

export function countWords(count: number): string {
  return count.toLocaleString("en-US");
}

/** "1 row", "6 rows". */
export function plural(count: number, one: string, many: string): string {
  return `${countWords(count)} ${count === 1 ? one : many}`;
}

/** The part of a question a problem is about, so it stands under that field. */
export type IssueField =
  | "question"
  | "instructions"
  | "criteria"
  | "options"
  | "levels"
  | "thresholds";

const QUESTION_PATH = /^sources\[\d+\]\.questions\.([^.[]+)(?:\.([A-Za-z]+))?/;
const THRESHOLD_PATH = /^sources\[\d+\]\.thresholds\.([^.[]+)/;

function fieldOf(part: string | undefined): IssueField {
  switch (part) {
    case "instructions":
    case "criteria":
    case "options":
    case "levels":
      return part;
    default:
      return "question";
  }
}

/**
 * Where a problem the loader named by its path (`sources[0].questions.is_scam.instructions`)
 * stands on the page: under a question's field, or, for anything else, in the Wording section.
 */
export function issuePlace(
  issue: DraftIssue,
): { readonly question: string; readonly field: IssueField } | undefined {
  const threshold = THRESHOLD_PATH.exec(issue.path);
  if (threshold?.[1] !== undefined) {
    return { question: threshold[1], field: "thresholds" };
  }
  const question = QUESTION_PATH.exec(issue.path);
  if (question?.[1] === undefined) {
    return undefined;
  }
  return { question: question[1], field: fieldOf(question[2]) };
}

/** A problem in a sentence, its path as the config file writes it when it is not under a field. */
export function issueWords(issue: DraftIssue): string {
  return issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`;
}
