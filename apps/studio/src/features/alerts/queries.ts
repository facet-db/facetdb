import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, SHELL_REFRESH_MS } from "../../api/index.ts";

/** The channels the config names and the alert history; asked again while the page is open. */
export function alertsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["alerts"],
    queryFn: () => api.alerts(),
    refetchInterval: SHELL_REFRESH_MS,
  });
}
