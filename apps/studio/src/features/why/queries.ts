import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../api/index.ts";

/** One record's history. The key is as the log shows it; the client encodes it once into the path. */
export function historyQuery(api: ApiClient, source: string, key: string) {
  return queryOptions({
    queryKey: ["decisions", "history", source, key],
    queryFn: () => api.decisionHistory(source, key),
  });
}
