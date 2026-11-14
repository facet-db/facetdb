import {
  type AnswerColumnRole,
  answerColumns,
  type Question,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import type { SqlDialect } from "../dialect/index.ts";

/**
 * The select of a record's decision from FacetDB's own columns (`Connector.current`, for `explain`
 * and the review screens), in the dialect's SQL: each question's answer columns (`answerColumns`),
 * `facetdb_status`, `facetdb_updated_at` and `facetdb_reviewed`, under the aliases core's
 * `parseCurrent` reads. Every answer is selected as the database's own text, so every driver hands
 * back the same strings, and a `real` reads as the shortest text that round-trips where the
 * database writes it so (Postgres: `0.93`, never float4's 0.9300000071525574).
 */

/** The alias letter of each column `current` reads; a choice's probability list is not read. */
function aliasOf(role: AnswerColumnRole): "v" | "p" | "e" | undefined {
  switch (role) {
    case "value":
      return "v";
    case "probability":
    case "confidence":
      return "p";
    case "expected":
      return "e";
    case "probabilities":
      return undefined;
  }
}

/** The select list, each column under a fixed alias: `q<i>v`, `q<i>p`, `q<i>e`, `cs`, `cu`, `cr`. */
export function currentColumns(dialect: SqlDialect, questions: readonly Question[]): string {
  const answers = questions.flatMap((question, index) =>
    answerColumns(question).flatMap((column) => {
      const alias = aliasOf(column.role);
      return alias === undefined ? [] : [`${dialect.keyAsText(column.name)} as q${index}${alias}`];
    }),
  );
  return [
    ...answers,
    `${dialect.quoteIdent(STATUS_COLUMN)} as cs`,
    `${dialect.msOfTime(UPDATED_AT_COLUMN)} as cu`,
    `${dialect.quoteIdent(REVIEWED_COLUMN)} as cr`,
  ].join(", ");
}
