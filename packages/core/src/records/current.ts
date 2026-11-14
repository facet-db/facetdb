import type { CurrentDecision } from "../contracts/index.ts";
import type { Question } from "../questions/index.ts";
import { RECORD_STATUSES, type RecordStatus, STATUS_COLUMN, UPDATED_AT_COLUMN } from "./status.ts";

/**
 * A record's decision read back from FacetDB's own columns (`Connector.current`, for `explain` and
 * the review screens), the one reading every engine that keeps answers in the record's columns
 * shares (the Postgres capture connector, the polling connector of every dialect). Each engine's
 * select names its columns with fixed aliases and reads every answer as the database's own text,
 * so every driver hands back the same strings: `q<i>v`, `q<i>p` and `q<i>e` for question `i`'s
 * value, probability or confidence and expected value (a choice's probability list is not read),
 * `cs` the status, `cu` the time of the decision in milliseconds since the epoch, `cr` the
 * reviewed flag.
 */

type Decided = CurrentDecision["decisions"][string];

/**
 * The database boundary: such a row becomes the record's decision, or an error that names the
 * column. Undefined when FacetDB never set the row's status (a polling install leaves it NULL until
 * it sees the record): FacetDB holds nothing for it yet.
 */
export function parseCurrent(
  row: Readonly<Record<string, unknown>>,
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
    status: storedStatus(row["cs"]),
    reviewed: row["cr"] === true,
    updatedAt: updatedAt === null ? null : new Date(finite(updatedAt, UPDATED_AT_COLUMN)),
  };
}

/** A stored status, or an error naming the column: no seventh status exists. */
function storedStatus(value: unknown): RecordStatus {
  const status = RECORD_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(
      `column "${STATUS_COLUMN}" holds ${JSON.stringify(value)}, not a record status`,
    );
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
