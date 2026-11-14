import {
  type AnswerColumnRole,
  answerColumns,
  type CurrentDecision,
  type Question,
  RECORD_STATUSES,
  REVIEWED_COLUMN,
  type RecordStatus,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import type { SqlRow } from "./client.ts";
import { quoteIdent } from "./identifier.ts";

/**
 * A record's decision read back from FacetDB's own columns (`Connector.current`), for the capture
 * and the polling connectors, which write the same ones: each question's answer columns
 * (`answerColumns`), `facetdb_status`, `facetdb_updated_at` and `facetdb_reviewed`. Every value is
 * selected as text, so both drivers hand back the same strings, and a `real` reads as the shortest
 * text that round-trips (`0.93`, never the float4's 0.9300000071525574).
 */

type Decided = CurrentDecision["decisions"][string];

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

/**
 * The database boundary: a row of `currentColumns` becomes the record's decision, or an error that
 * names the column. Undefined when FacetDB never set the row's status (a polling install leaves it
 * NULL until it sees the record): FacetDB holds nothing for it yet.
 */
export function parseCurrent(
  row: SqlRow,
  questions: readonly Question[],
): CurrentDecision | undefined {
  if (row["cs"] === null) {
    return undefined;
  }
  const decisions: Record<string, Decided> = {};
  questions.forEach((question, index) => {
    const value = textOrNull(row[`q${index}v`], question.name);
    const certainty = textOrNull(row[`q${index}p`], question.name);
    // A question's value is NULL until it has a decision (or while it waits for review); both the
    // value and its probability or confidence are written together.
    if (value === null || certainty === null) {
      return;
    }
    const expected =
      question.type === "score" ? textOrNull(row[`q${index}e`], question.name) : null;
    decisions[question.name] = {
      kind: "decided",
      value: question.type === "noul" ? yesNo(value, question.name) : value,
      probabilityOrConfidence: unitInterval(certainty, question.name),
      ...(expected === null ? {} : { expected: finite(expected, question.name) }),
    };
  });
  const updatedAt = textOrNull(row["cu"], UPDATED_AT_COLUMN);
  return {
    decisions,
    status: recordStatus(row["cs"], STATUS_COLUMN),
    reviewed: row["cr"] === true,
    updatedAt: updatedAt === null ? null : new Date(finite(updatedAt, UPDATED_AT_COLUMN)),
  };
}

/** A stored status, or an error naming the column: no seventh status exists. */
export function recordStatus(value: unknown, column: string): RecordStatus {
  const status = RECORD_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`column "${column}" holds ${JSON.stringify(value)}, not a record status`);
  }
  return status;
}

function textOrNull(value: unknown, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`a column of "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}

function yesNo(text: string, column: string): boolean {
  if (text !== "true" && text !== "false") {
    throw new Error(`the answer of "${column}" reads "${text}", expected true or false`);
  }
  return text === "true";
}

function finite(text: string, column: string): number {
  const parsed = Number(text);
  if (text.trim() === "" || !Number.isFinite(parsed)) {
    throw new Error(`a column of "${column}" reads "${text}", expected a number`);
  }
  return parsed;
}

function unitInterval(text: string, column: string): number {
  const parsed = finite(text, column);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`the probability of "${column}" reads ${parsed}, outside 0 to 1`);
  }
  return parsed;
}
