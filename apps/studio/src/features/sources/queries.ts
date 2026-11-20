import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../api/index.ts";

/**
 * The Sources page's read: `GET /v1/sources`, asked again while the page is open (a change seen, a
 * backfill moving). Apply and the setup flow invalidate every `sources` key when they write.
 */

/** How often the page asks the worker again while it is open. */
export const SOURCES_REFRESH_MS = 15_000;

export const SOURCES_KEY = ["sources", "rows"] as const;

export function sourcesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: SOURCES_KEY,
    queryFn: () => api.sources(),
    refetchInterval: SOURCES_REFRESH_MS,
  });
}
