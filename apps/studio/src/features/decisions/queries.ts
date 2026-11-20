import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { ApiClient, DecisionFilters } from "../../api/index.ts";

/**
 * The Decisions page's queries. The log pages through an infinite query: its cursor is the
 * worker's, passed back unchanged, so a page never repeats or skips a row and "Show more" appends.
 */

/** The project's sources, for the source choice; the config does not change while the page is open. */
export function sourceNamesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["sources", "names"],
    queryFn: () => api.sourceNames(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** One source's log under the filters, newest first, a cursor at a time. */
export function logQuery(api: ApiClient, filters: DecisionFilters) {
  return infiniteQueryOptions({
    queryKey: ["decisions", "log", filters],
    queryFn: ({ pageParam }) => api.decisions(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    // The pages are fetched again together, from the first; a window coming back to the front
    // should not do that to a long list the reader is part way down.
    refetchOnWindowFocus: false,
  });
}

/** One page of the run log; the page before stays on screen while the next one is read. */
export function runsQuery(api: ApiClient, source: string | undefined, page: number) {
  return queryOptions({
    queryKey: ["decisions", "runs", source ?? null, page],
    queryFn: () => api.runs(source === undefined ? { page } : { source, page }),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}
