import type { SqlRow } from "../sql/index.ts";

/**
 * Database rows are a boundary: these read a column and name it when the shape is wrong. Queries cast
 * numbers, timestamps and jsonb to text, so both drivers (postgres.js and PGlite) hand back the same
 * JavaScript types, and `json` parses the text itself.
 */

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}

export function textOrNull(row: SqlRow, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

export function integer(row: SqlRow, column: string): number {
  const parsed = Number(text(row, column));
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`column "${column}" is not a safe integer`);
  }
  return parsed;
}

export function flag(row: SqlRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected boolean`);
  }
  return value;
}

/** A jsonb column selected as `col::text`. */
export function json(row: SqlRow, column: string): unknown {
  return JSON.parse(text(row, column));
}

export function jsonOrNull(row: SqlRow, column: string): unknown {
  return row[column] === null ? null : json(row, column);
}

/** A jsonb value that must be an object (a map of answers, a state, a decision). */
export function jsonObject(row: SqlRow, column: string): Record<string, unknown> {
  const value = json(row, column);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`column "${column}" holds ${JSON.stringify(value)}, expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** SQL for a millisecond count from the caller's clock as a timestamp: `$n` is a number of ms. */
export function fromMs(placeholder: string): string {
  return `to_timestamp(${placeholder}::double precision / 1000)`;
}

/** SQL that reads a timestamp column back as whole milliseconds, as text. */
export function toMs(column: string, alias: string): string {
  return `round(extract(epoch from ${column}) * 1000)::bigint::text as ${alias}`;
}
