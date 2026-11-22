import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../api/index.ts";

/**
 * The Plugins page's queries, beside the other pages' own: the installed plugins, read again after
 * Apply writes their settings, and the registry's gallery under a search. The worker keeps the
 * registry's index for ten minutes, so asking it at each keystroke reads no network.
 */

/** The key Apply's write refreshes: the plugins as the worker now runs them. */
export const INSTALLED_PLUGINS_KEY = ["plugins", "installed"] as const;

export function installedPluginsQuery(api: ApiClient) {
  return queryOptions({ queryKey: INSTALLED_PLUGINS_KEY, queryFn: () => api.plugins() });
}

/** The gallery under a search; the entries shown stay until the next search's arrive. */
export function galleryQuery(api: ApiClient, search: string) {
  const asked = search.trim();
  return queryOptions({
    queryKey: ["plugins", "gallery", asked],
    queryFn: () => api.gallery(asked === "" ? undefined : asked),
    placeholderData: keepPreviousData,
  });
}
