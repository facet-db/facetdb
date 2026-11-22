import { keepPreviousData, queryOptions, skipToken } from "@tanstack/react-query";
import type { ApiClient, SourceDraft } from "../../api/index.ts";

/**
 * The Questions page's reads. The config is the worker's (its memory, not the file): a refetch
 * never touches the draft, which is the page's. The judgement of a draft is free (the loader, no
 * model), asked once the typing settles, under the draft's own key, so an answer for an older draft
 * never stands for a newer one. The preview, Test and Apply spend or write, so they are mutations
 * the page sends itself, never queries a remount or a refocus could send again.
 */

export const CONFIG_KEY = ["config", "project"] as const;

export function projectConfigQuery(api: ApiClient) {
  return queryOptions({ queryKey: CONFIG_KEY, queryFn: () => api.projectConfig() });
}

/**
 * The packs of the plugins the worker hosts: read when "Start from a pack" opens, and again at each
 * opening, the last list shown meanwhile. Reading them is free and writes nothing.
 */
export function packsQuery(api: ApiClient) {
  return queryOptions({ queryKey: ["packs"], queryFn: () => api.packs() });
}

/** `draft` is undefined while a name or a pair of cut lines cannot be sent: nothing is asked then. */
export function validationQuery(api: ApiClient, key: string, draft: SourceDraft | undefined) {
  return queryOptions({
    queryKey: ["questions", "validate", key],
    queryFn: draft === undefined ? skipToken : () => api.validateDraft(draft),
    // A judgement of one draft does not change: the same text is judged once.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    // While the next draft is judged, the last judgement stays on screen, marked as such.
    placeholderData: keepPreviousData,
  });
}
