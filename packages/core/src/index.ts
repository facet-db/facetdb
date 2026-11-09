/**
 * @facetdb/core: question sets, thresholds, decisions, record statuses, the worker loop and the
 * contracts every connector, action and model provider implements. Each feature module is reached
 * through its barrel.
 */

export * from "./questions/index.ts";
export * from "./thresholds/index.ts";

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
