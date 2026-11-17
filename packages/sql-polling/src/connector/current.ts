import {
  type AnswerColumnRole,
  answerColumns,
  type Question,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import type { PollingRow, SqlDialect } from "../dialect/index.ts";

/**
 * The select of a record's decision from FacetDB's own columns (`Connector.current`, for `explain`
 * and the review screens), in the dialect's SQL: each question's answer columns (`answerColumns`),
 * `facetdb_status`, `facetdb_updated_at` and `facetdb_reviewed`, under the aliases core's
 * `parseCurrent` reads. Every answer is selected as the database's own text, so every driver hands
 * back the same strings, and a `real` reads as the shortest text that round-trips where the
 * database writes it so (Postgres: `0.93`, never float4's 0.9300000071525574). Where the dialect
 * keeps booleans as numbers (`SqlDialect.booleans`, Oracle's `number(1)`), a noul's answer and the
 * reviewed flag are selected as they are and read back through the dialect into what
 * `parseCurrent` reads: the text `true` or `false`, and a boolean.
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
      if (alias === undefined) {
        return [];
      }
      // A number standing for a boolean is read back by `currentRow`, not as its text ("1").
      const read =
        column.kind === "boolean" && dialect.booleans !== undefined
          ? dialect.quoteIdent(column.name)
          : dialect.keyAsText(column.name);
      return [`${read} as q${index}${alias}`];
    }),
  );
  return [
    ...answers,
    `${dialect.quoteIdent(STATUS_COLUMN)} as cs`,
    `${dialect.msOfTime(UPDATED_AT_COLUMN)} as cu`,
    `${dialect.quoteIdent(REVIEWED_COLUMN)} as cr`,
  ].join(", ");
}

/**
 * A row of `currentColumns` as `parseCurrent` reads it: unchanged where the driver hands over
 * booleans; where the dialect keeps them as numbers, a noul's answer becomes the text `true` or
 * `false` (NULL stays NULL: no decision) and `cr` a boolean (NULL, a flag the application cleared,
 * reads as not reviewed, as `parseCurrent` reads it).
 */
export function currentRow(
  dialect: SqlDialect,
  row: PollingRow,
  questions: readonly Question[],
): PollingRow {
  const { booleans } = dialect;
  if (booleans === undefined) {
    return row;
  }
  const read: Record<string, unknown> = { ...row };
  questions.forEach((question, index) => {
    const value = row[`q${index}v`];
    if (question.type === "noul" && value !== null) {
      read[`q${index}v`] = String(booleans.read(value));
    }
  });
  read["cr"] = row["cr"] !== null && booleans.read(row["cr"]);
  return read;
}

/** A value the connector binds, a boolean as the dialect stores one (Oracle: 1 or 0). */
export function booleanBind(dialect: SqlDialect, value: unknown): unknown {
  return typeof value === "boolean" && dialect.booleans !== undefined
    ? dialect.booleans.bind(value)
    : value;
}

/** A boolean the driver returned (a column or the `excluded` expression), read back. */
export function booleanRead(dialect: SqlDialect, value: unknown): boolean {
  return dialect.booleans === undefined ? value === true : dialect.booleans.read(value);
}
