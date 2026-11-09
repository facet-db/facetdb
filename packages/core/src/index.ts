/**
 * @facetdb/core: question sets, thresholds, decisions, record statuses, the worker loop and the
 * contracts every connector, action and model provider implements. This first cut ships only the
 * vocabulary everything later builds on.
 */

/** The three question types, mapped one-to-one onto the TypeSafe primitives FacetDB exposes. */
export const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** The six record statuses a row's `facetdb_status` can hold. */
export const RECORD_STATUSES = [
  "pending",
  "done",
  "needs_review",
  "error",
  "unchecked",
  "skipped",
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
