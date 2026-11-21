import type { ReviewQueue } from "../../api/index.ts";

/**
 * The Review page's own queries. The queue's figures are the api module's (`reviewQueueQuery`):
 * the rail's count is the same read under an empty filter, and a decision invalidates the prefix
 * (`REVIEW_QUEUE_KEY`) for both. The same answer lists every source the worker runs with its
 * questions, whatever the filter, so the filters are built from it too (`facetsOf`).
 */
export { REVIEW_QUEUE_KEY, reviewQueueQuery } from "../../api/index.ts";

export type Facets = {
  readonly sources: readonly string[];
  readonly questions: readonly string[];
};

/**
 * The filter options a queue offers: every source the worker runs, and the questions of the chosen
 * source (of every source when none is chosen), whether or not a card of theirs is waiting.
 */
export function facetsOf(queue: ReviewQueue | undefined, source: string | undefined): Facets {
  const fleet = queue?.sources ?? [];
  const questions = new Set<string>();
  for (const one of fleet) {
    if (source === undefined || one.name === source) {
      for (const question of one.questions) {
        questions.add(question);
      }
    }
  }
  return {
    sources: fleet.map((one) => one.name).sort((a, b) => a.localeCompare(b)),
    questions: [...questions].sort((a, b) => a.localeCompare(b)),
  };
}
