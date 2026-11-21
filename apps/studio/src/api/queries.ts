import { queryOptions } from "@tanstack/react-query";
import type { ApiClient, ReviewFilter } from "./client.ts";

/**
 * The queries more than one part of the studio reads, each under one key so they share a cache:
 * the rail and the Home page read the same `home`, the rail and the Review page the same queue
 * count. A page's own queries live with the page.
 */

/** How often the rail asks again while the studio is open: the heartbeat's age and the queue move. */
export const SHELL_REFRESH_MS = 15_000;

/** The one project and the reviewer on record; neither changes while the page is open. */
export function projectQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["project"],
    queryFn: () => api.project(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The prefix of every queue query: one invalidation after a decision covers the rail and the page. */
export const REVIEW_QUEUE_KEY = ["review", "queue"] as const;

/**
 * The queue's figures under a filter: how many wait, how long the oldest has, and every source the
 * worker runs with its questions (the Review page's top bar; the rail reads the unfiltered one).
 * One card is asked for, so the worker counts and reads no more; the rail and the top bar under an
 * empty filter share one key, so one request serves both (it was two full listings).
 */
export function reviewQueueQuery(api: ApiClient, filter: ReviewFilter) {
  return queryOptions({
    queryKey: [...REVIEW_QUEUE_KEY, filter],
    queryFn: () => api.reviewQueue({ ...filter, limit: 1 }),
    // Asked again every SHELL_REFRESH_MS, on the injected scheduler. Changing a filter keeps the
    // old figures on the bar until the new ones arrive.
    placeholderData: (previous) => previous,
    refetchInterval: SHELL_REFRESH_MS,
  });
}

/** How many cards wait for this reviewer: the count beside Review in the rail, off the same read. */
export function reviewCountQuery(api: ApiClient) {
  return queryOptions({
    ...reviewQueueQuery(api, {}),
    select: (queue) => queue.count,
  });
}

/**
 * The project's spending cap and what happens at 100%, as facetdb.config.ts says now: Settings
 * edits it, and Settings, Home and the rail compare it with the cap the worker started with.
 */
export function spendingConfigQuery(api: ApiClient) {
  return queryOptions({ queryKey: SPENDING_CONFIG_KEY, queryFn: () => api.spendingConfig() });
}

/** The key Settings' save invalidates once the file is written. */
export const SPENDING_CONFIG_KEY = ["config", "spending"] as const;

/** Home's figures: the rail's instrument reads the heartbeat and the spending from them. */
export function homeQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["home"],
    queryFn: () => api.home(),
    refetchInterval: SHELL_REFRESH_MS,
  });
}
