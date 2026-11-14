import {
  type AnswerColumnRole,
  answerColumns,
  type Question,
  RECORD_STATUSES,
  REVIEWED_COLUMN,
  type RecordStatus,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { quoteIdent } from "./identifier.ts";

/**
 * The capture connector's select of a record's decision from FacetDB's own columns
 * (`Connector.current`): each question's answer columns (`answerColumns`), `facetdb_status`,
 * `facetdb_updated_at` and `facetdb_reviewed`, under the aliases core's `parseCurrent` reads (the
 * one reading every engine with answers in the record's columns shares, the polling connector's
 * included). Every value is selected as text, so every driver hands back the same strings, and a
 * `real` reads as the shortest text that round-trips (`0.93`, never float4's 0.9300000071525574).
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
export function currentColumns(questions: readonly Question[]): string {
  const answers = questions.flatMap((question, index) =>
    answerColumns(question).flatMap((column) => {
      const alias = aliasOf(column.role);
      return alias === undefined ? [] : [`${quoteIdent(column.name)}::text as q${index}${alias}`];
    }),
  );
  return [
    ...answers,
    `${quoteIdent(STATUS_COLUMN)} as cs`,
    `round(extract(epoch from ${quoteIdent(UPDATED_AT_COLUMN)}) * 1000)::bigint::text as cu`,
    `${quoteIdent(REVIEWED_COLUMN)} as cr`,
  ].join(", ");
}

/** A stored status, or an error naming the column: no seventh status exists. */
export function recordStatus(value: unknown, column: string): RecordStatus {
  const status = RECORD_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`column "${column}" holds ${JSON.stringify(value)}, not a record status`);
  }
  return status;
}
