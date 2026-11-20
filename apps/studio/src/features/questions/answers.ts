import type { StatusKind, Thresholds } from "@facetdb/ui";
import type { PreviewAnswer, PreviewRow } from "../../api/index.ts";
import { crossed } from "./cuts.ts";
import { type QuestionForm, type SourceForm, thresholdsOf } from "./draft.ts";

/**
 * The preview's answers under the thresholds on the page now: a cut line moved is re-applied here
 * to the probabilities the preview returned, and the model is not asked again. The rule is core's
 * (packages/core, thresholds/decide.ts), inclusive on every side: yes at or above `yesAbove`, no at
 * or below `noBelow`, a pick-one or a rating decided at or above `confidenceAtLeast`.
 */

const percent = (figure: number): string => `${String(Math.round(figure * 100))}%`;

/**
 * A pick-one's confidence: how far its top option stands above an even split, `(p_top - 1/n) / (1
 * - 1/n)` (packages/core, thresholds/confidence.ts).
 */
function choiceConfidence(probabilities: readonly number[]): number {
  const options = probabilities.length;
  const top = Math.max(...probabilities);
  return (top - 1 / options) / (1 - 1 / options);
}

/** The yes probability of a yes or no answer; the confidence of a pick-one or a rating. */
export function figureOf(answer: PreviewAnswer): number {
  switch (answer.type) {
    case "noul":
      return answer.probability;
    case "choice":
      return choiceConfidence(answer.probabilities);
    case "score":
      return answer.confidence;
  }
}

/** The answer the model leans to: an option, a level, or yes for a yes or no question. */
function leaning(question: QuestionForm, answer: PreviewAnswer): string {
  switch (answer.type) {
    case "noul":
      return "likely yes";
    case "choice":
      return answer.top;
    case "score": {
      const top = answer.probabilities.indexOf(Math.max(...answer.probabilities));
      return question.levels[top]?.name ?? `level ${String(top + 1)}`;
    }
  }
}

/** What the model said, in words with the number: "58% likely yes", "electronics, 95% sure". */
export function saidWords(question: QuestionForm, answer: PreviewAnswer): string {
  const figure = percent(figureOf(answer));
  return answer.type === "noul"
    ? `${figure} likely yes`
    : `${leaning(question, answer)}, ${figure} sure`;
}

/** What the thresholds make of an answer: the value in words, or null when it falls between. */
export function decidedWords(
  question: QuestionForm,
  thresholds: Thresholds,
  answer: PreviewAnswer,
): string | null {
  const figure = figureOf(answer);
  if (thresholds.kind === "cuts") {
    if (figure >= thresholds.yesAbove) {
      return "yes";
    }
    return figure <= thresholds.noBelow ? "no" : null;
  }
  return figure >= thresholds.confidenceAtLeast ? leaning(question, answer) : null;
}

/**
 * A question of the preview's table: as it was when the rows were answered, with the thresholds in
 * force for it now (the draft's, when the draft still has that question as the same kind); null
 * when those cut lines cross (cuts.ts), and nothing is decided under them.
 */
export type PreviewColumn = {
  readonly question: QuestionForm;
  readonly thresholds: Thresholds | null;
};

export function previewColumns(previewed: SourceForm, current: SourceForm): PreviewColumn[] {
  return previewed.questions.map((question) => {
    const now = current.questions.find(
      (candidate) => candidate.name === question.name && candidate.type === question.type,
    );
    const thresholds = thresholdsOf(now ?? question);
    return { question, thresholds: crossed(thresholds) ? null : thresholds };
  });
}

export type PreviewCell = {
  /**
   * The decided value, or null when the answer falls between the cut lines; undefined when the cut
   * lines cross and nothing is decided.
   */
  readonly decided: string | null | undefined;
  readonly figure: number;
  /** For a screen reader and the strip's tooltip: "is_scam: 58% likely yes". */
  readonly label: string;
};

export type PreviewLine = {
  readonly key: string;
  /** What the model was shown; empty for a row it was not asked about. */
  readonly state: Readonly<Record<string, string | null>>;
  readonly cells: ReadonlyMap<string, PreviewCell>;
  readonly status: StatusKind;
};

export function previewLines(
  rows: readonly PreviewRow[],
  columns: readonly PreviewColumn[],
): PreviewLine[] {
  return rows.map((row) => {
    if (row.kind === "skipped") {
      return { key: row.key, state: {}, cells: new Map(), status: "skipped" };
    }
    const cells = new Map<string, PreviewCell>();
    for (const { question, thresholds } of columns) {
      const answer = row.answers[question.name];
      if (answer !== undefined) {
        cells.set(question.name, {
          decided: thresholds === null ? undefined : decidedWords(question, thresholds, answer),
          figure: figureOf(answer),
          label: `${question.name}: ${saidWords(question, answer)}`,
        });
      }
    }
    const values = [...cells.values()];
    // A row with a question its crossed cut lines cannot decide has no status yet: pending.
    if (values.some((cell) => cell.decided === undefined)) {
      return { key: row.key, state: row.state, cells, status: "pending" };
    }
    const unsure = values.some((cell) => cell.decided === null);
    return { key: row.key, state: row.state, cells, status: unsure ? "needs_review" : "done" };
  });
}

/**
 * The figures behind a question's slider counts: the preview's answers to it, when the preview
 * asked it as the same kind; none when the draft added it or changed its kind since.
 */
export function figuresFor(
  question: QuestionForm,
  previewed: SourceForm,
  rows: readonly PreviewRow[],
): number[] {
  const asked = previewed.questions.some(
    (candidate) => candidate.name === question.name && candidate.type === question.type,
  );
  if (!asked) {
    return [];
  }
  return rows.flatMap((row) => {
    if (row.kind === "skipped") {
      return [];
    }
    const answer = row.answers[question.name];
    return answer === undefined ? [] : [figureOf(answer)];
  });
}

/** Why a row was shown but not asked, in words. */
export function skipWords(reason: string): string {
  switch (reason) {
    case "filtered-out":
      return "left out by the source's where filter";
    case "empty-state":
      return "nothing to read: every field is empty";
    case "too-large":
      return "too large to send to the model";
    case "spending-cap":
      return "not asked: the spending cap was reached";
    default:
      return `not asked (${reason})`;
  }
}
