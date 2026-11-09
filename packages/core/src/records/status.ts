/**
 * The record statuses and the transitions between them. The worker applies these transitions;
 * the connector stores the result in `facetdb_status`. No seventh status exists.
 */

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

/** The FacetDB-owned columns on every record. They are never state fields. */
export const STATUS_COLUMN = "facetdb_status";
export const UPDATED_AT_COLUMN = "facetdb_updated_at";
export const REVIEWED_COLUMN = "facetdb_reviewed";

/** What a source does with a decided record whose state changed: reset it to pending, or keep it. */
export type OnChange = "reset" | "keep";

/** The events that move a record between statuses. */
export type StatusEvent =
  | "queued"
  | "answered-all-decided"
  | "answered-some-review"
  | "model-error"
  | "released-unchecked"
  | "skipped"
  | "human-decided-last"
  | { readonly event: "state-changed"; readonly onChange: OnChange };

/**
 * The status after one event. `human-decided-last` is only valid on a needs_review record (the
 * review screen shows nothing else); any other status there is a caller bug and throws.
 */
export function transition(current: RecordStatus, event: StatusEvent): RecordStatus {
  if (typeof event === "object") {
    return event.onChange === "keep" ? current : "pending";
  }
  switch (event) {
    case "queued":
      return "pending";
    case "answered-all-decided":
      return "done";
    case "answered-some-review":
      return "needs_review";
    case "model-error":
      return "error";
    case "released-unchecked":
      return "unchecked";
    case "skipped":
      return "skipped";
    case "human-decided-last":
      if (current !== "needs_review") {
        throw new Error(
          `a human decision can only close a needs_review record, not one that is ${current}`,
        );
      }
      return "done";
  }
}
