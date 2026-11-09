import type { StateValue } from "./state-hash.ts";

/**
 * A record is blank in one state field when it is NULL or its text is empty after trimming: a
 * whitespace-only text carries nothing for the model to read. A number's text ("0") is never blank.
 */
export function isBlank(value: StateValue): boolean {
  return value === null || value.trim() === "";
}

export type SkipDecision =
  | { readonly skip: false }
  | { readonly skip: true; readonly reason: SkipReason };

/**
 * `filtered-out`: the source's `where` filter excluded the record (checked first). `empty-state`:
 * every state field was NULL or blank.
 */
export type SkipReason = "filtered-out" | "empty-state";

/**
 * Whether a record is skipped without a model call. The connector evaluates the `where` filter
 * in SQL and passes only the boolean `filterExcluded`; this function never sees SQL.
 */
export function shouldSkip(
  fields: readonly string[],
  values: Readonly<Record<string, StateValue>>,
  filter: { readonly filterExcluded: boolean },
): SkipDecision {
  if (filter.filterExcluded) return { skip: true, reason: "filtered-out" };
  const allBlank = fields.every((name) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`state field "${name}" is missing from the row`);
    }
    return isBlank(value);
  });
  return allBlank ? { skip: true, reason: "empty-state" } : { skip: false };
}
