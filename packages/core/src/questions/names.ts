import type { Question } from "./types.ts";

/**
 * Names become column names, so they follow the strictest database: at most 40 characters so
 * that the longest suffix (`_probabilities`, 14) still fits in Postgres's 63.
 */
export const QUESTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const QUESTION_NAME_RULE =
  "lowercase letters, digits and underscores, starting with a letter, at most 40 characters";

/**
 * Everything FacetDB adds to a database carries the `facetdb_` prefix. A question named `facetdb`
 * or `facetdb_…` would put its answer columns (`facetdb_probability`) there.
 */
export const RESERVED_QUESTION_NAME = /^facetdb(_|$)/;

// The only place the answer-column suffixes are spelled; the install generator and
// `facetdb types` both read them through `answerColumns`.
const PROBABILITY_SUFFIX = "_probability";
const CONFIDENCE_SUFFIX = "_confidence";
const EXPECTED_SUFFIX = "_expected";
const PROBABILITIES_SUFFIX = "_probabilities";

/** What a column holds; the connector maps each kind onto its database's type. */
export type AnswerColumnKind = "boolean" | "text" | "real" | "json";

/** The part of the answer a column stores, so writers never match on a suffix. */
export type AnswerColumnRole =
  | "value"
  | "probability"
  | "confidence"
  | "expected"
  | "probabilities";

export type AnswerColumn = {
  readonly role: AnswerColumnRole;
  readonly name: string;
  readonly kind: AnswerColumnKind;
};

/** The columns a question adds to its record, in install order. */
export function answerColumns(question: Question): readonly AnswerColumn[] {
  const { name } = question;
  switch (question.type) {
    case "noul":
      return [
        { role: "value", name, kind: "boolean" },
        { role: "probability", name: `${name}${PROBABILITY_SUFFIX}`, kind: "real" },
      ];
    case "choice":
      return [
        { role: "value", name, kind: "text" },
        { role: "confidence", name: `${name}${CONFIDENCE_SUFFIX}`, kind: "real" },
        ...(question.storeProbabilities
          ? [
              {
                role: "probabilities",
                name: `${name}${PROBABILITIES_SUFFIX}`,
                kind: "json",
              } as const,
            ]
          : []),
      ];
    case "score":
      return [
        { role: "value", name, kind: "text" },
        { role: "confidence", name: `${name}${CONFIDENCE_SUFFIX}`, kind: "real" },
        { role: "expected", name: `${name}${EXPECTED_SUFFIX}`, kind: "real" },
      ];
  }
}
