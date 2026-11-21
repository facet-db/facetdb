import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../api/index.ts";

/**
 * The Settings page's queries, one key each so a mutation can name what it changed: an account
 * made refreshes the list and the count in studio access.
 */

/** The reviewer accounts (`facetdb users add` makes them, and so does the form on the page). */
export function reviewersQuery(api: ApiClient) {
  return queryOptions({ queryKey: ["reviewers"], queryFn: () => api.reviewers() });
}

/** The host the studio listens on, whether only this machine can reach it, and the accounts' count. */
export function studioAccessQuery(api: ApiClient) {
  return queryOptions({ queryKey: ["studio", "access"], queryFn: () => api.studioAccess() });
}

// The spending cap's query is the api module's (`spendingConfigQuery`): Home and the rail read it too.
