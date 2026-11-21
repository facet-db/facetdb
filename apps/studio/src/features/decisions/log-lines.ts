import type { DecisionOutcome, DecisionRow, LoggedAnswer } from "../../api/index.ts";

/**
 * The log as the table reads it: one line per question. A model call answers several questions at
 * once and is one row of the log; a person decides one. The words are `facetdb explain`'s
 * (packages/core, log/explain.ts): "58% likely yes", "billing, 82% sure".
 */

/** What the model said about one question: the figure behind the strip, and it in words. */
export type Said = {
  /** The yes probability of a yes-or-no question, the confidence of the others: the strip's density. */
  readonly figure: number;
  /** "likely yes", the option, the level. */
  readonly words: string;
  /** For a screen reader: "58% likely yes", "electronics, 93% sure". */
  readonly label: string;
};

export type LogLine = {
  /** Stable while pages are appended: the row's place in the log and the question. */
  readonly id: string;
  /** ISO 8601. */
  readonly at: string;
  readonly record: string;
  readonly question: string;
  /** Absent for a person's decision: no model answered it. */
  readonly said?: Said;
  /** What the thresholds made of it, in explain's words: "yes", an option, "needs review", "unknown", "withdrawn". */
  readonly decided: string;
  /**
   * What `decided` is, by the tag the worker sends beside the words: an option may be named
   * "needs review", "unknown" or "withdrawn", so the page reads this and never the words. A
   * person's line is decided, or withdrawn when it takes back their own decision.
   */
  readonly outcome: DecisionOutcome | "withdrawn";
  readonly by: { readonly kind: "model" } | { readonly kind: "person"; readonly reviewer: string };
};

function percent(figure: number): string {
  return `${String(Math.round(figure * 100))}%`;
}

/**
 * A pick-one question's confidence: how far its top option stands above an even split (the same
 * formula as packages/core, thresholds/confidence.ts, so the number is the one explain prints).
 */
function choiceConfidence(probabilities: readonly number[]): number {
  const options = probabilities.length;
  const top = Math.max(...probabilities);
  return options < 2 ? top : (top - 1 / options) / (1 - 1 / options);
}

/**
 * Words for a level the row does not name (the worker no longer keeps the question-set version it
 * ran under, so there are no levels to name it by): only its place among the levels.
 */
function leaning(probabilities: readonly number[]): string {
  const place = probabilities.indexOf(Math.max(...probabilities)) + 1;
  return `leans to level ${String(place)} of ${String(probabilities.length)}`;
}

export function saidOf(answer: LoggedAnswer): Said {
  switch (answer.type) {
    case "noul":
      return {
        figure: answer.probability,
        words: "likely yes",
        label: `${percent(answer.probability)} likely yes`,
      };
    case "choice": {
      const figure = choiceConfidence(answer.probabilities);
      return {
        figure,
        words: answer.top,
        label: `${answer.top}, ${percent(figure)} sure`,
      };
    }
    case "score": {
      // The most likely level's name, as the export prints it; empty when its version is gone.
      const words = answer.value === "" ? leaning(answer.probabilities) : answer.value;
      return {
        figure: answer.confidence,
        words,
        label: `${words}, ${percent(answer.confidence)} sure`,
      };
    }
  }
}

/**
 * The table's lines for the rows of the log, newest first. A line's id is its row's place in the
 * log and its question, so it stays the same when a later page is appended. With a question named,
 * the lines of the other questions a model call answered at the same time are left out.
 */
export function logLines(rows: readonly DecisionRow[], question: string | undefined): LogLine[] {
  return rows.flatMap((row, index): LogLine[] => {
    const place = String(index);
    if (row.kind === "human") {
      return question !== undefined && row.question !== question
        ? []
        : [
            {
              id: `${place}:${row.question}`,
              at: row.time,
              record: row.record_key,
              question: row.question,
              decided: row.decision,
              outcome: row.withdrawn ? "withdrawn" : "decided",
              by: { kind: "person", reviewer: row.decided_by },
            },
          ];
    }
    return Object.entries(row.answers)
      .filter(([name]) => question === undefined || name === question)
      .map(([name, answer]) => ({
        id: `${place}:${name}`,
        at: row.time,
        record: row.record_key,
        question: name,
        said: saidOf(answer),
        decided: answer.decision,
        outcome: answer.outcome,
        by: { kind: "model" as const },
      }));
  });
}
