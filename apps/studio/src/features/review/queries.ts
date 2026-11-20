import { queryOptions } from "@tanstack/react-query";
import type { ApiClient, ReviewFilter, ReviewQueue } from "../../api/index.ts";

/**
 * The Review page's own queries. The count beside Review in the rail is the shell's
 * (`reviewCountQuery`); a decision invalidates it and these together.
 */

/** The prefix of every queue query of this page: one invalidation covers the filtered counts. */
export const REVIEW_QUEUE_KEY = ["review", "queue"] as const;

/** How many cards the facets read: the endpoint's most. */
const FACETS_LIMIT = 200;

/** The top bar's figures under the filter: how many wait and how long the oldest has. */
export function reviewQueueQuery(api: ApiClient, filter: ReviewFilter) {
  return queryOptions({
    queryKey: [...REVIEW_QUEUE_KEY, filter],
    queryFn: () => api.reviewQueue({ ...filter, limit: 1 }),
    // Asked again every SHELL_REFRESH_MS by the top bar, on the injected scheduler.
    // Changing a filter keeps the old figures on the bar until the new ones arrive.
    placeholderData: (previous) => previous,
  });
}

/**
 * What the filters can offer: the sources and questions of the cards waiting, unfiltered. The
 * endpoints list no sources or questions of their own, so a source or question with no card
 * waiting is not offered (and past 200 waiting cards, one that is rare may be missing).
 */
export function reviewFacetsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["review", "facets"],
    queryFn: () => api.reviewQueue({ limit: FACETS_LIMIT }),
  });
}

export type Facets = {
  readonly sources: readonly string[];
  readonly questions: readonly string[];
};

/** The filter options a queue offers: every source, and the questions open on the chosen source's cards. */
export function facetsOf(queue: ReviewQueue | undefined, source: string | undefined): Facets {
  const sources = new Set<string>();
  const questions = new Set<string>();
  for (const card of queue?.cards ?? []) {
    sources.add(card.source);
    if (source === undefined || card.source === source) {
      for (const open of card.open) {
        questions.add(open.name);
      }
    }
  }
  return {
    sources: [...sources].sort((a, b) => a.localeCompare(b)),
    questions: [...questions].sort((a, b) => a.localeCompare(b)),
  };
}
