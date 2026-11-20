import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "./client.ts";

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

/** How many cards wait for this reviewer: the count beside Review in the rail. */
export function reviewCountQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["review", "count"],
    queryFn: async () => (await api.reviewQueue({ limit: 1 })).count,
    refetchInterval: SHELL_REFRESH_MS,
  });
}

/** Home's figures: the rail's instrument reads the heartbeat and the spending from them. */
export function homeQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["home"],
    queryFn: () => api.home(),
    refetchInterval: SHELL_REFRESH_MS,
  });
}
