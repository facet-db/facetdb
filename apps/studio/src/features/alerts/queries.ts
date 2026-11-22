import { queryOptions } from "@tanstack/react-query";
import {
  type ApiClient,
  type Gallery,
  type InstalledPlugin,
  type InstalledPlugins,
  SHELL_REFRESH_MS,
} from "../../api/index.ts";
import { addCommand, galleryQuery, installedPluginsQuery } from "../plugins/index.ts";

/** The channels the config names and the alert history; asked again while the page is open. */
export function alertsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["alerts"],
    queryFn: () => api.alerts(),
    refetchInterval: SHELL_REFRESH_MS,
  });
}

/**
 * The channels as the config in force writes them (`GET /v1/config`: the file as the worker last
 * loaded it), which a draft is built over. While the file names other channels, a hand edit not yet
 * loaded, no draft is built: the dialog asks for Check again first. Under the config's key, so a
 * write elsewhere (Settings, Questions) that reads the config again reads it too.
 */
export function channelsInFileQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["config", "alerts"],
    queryFn: () => api.alertChannelsInFile(),
  });
}

/** The plugins the worker hosts that provide an alert channel: an address's kind is a short name. */
function channelPluginsOf(installed: InstalledPlugins): readonly InstalledPlugin[] {
  return installed.plugins.filter((plugin) => plugin.provides.channel.length > 0);
}

/**
 * The channel plugins a channel can be added with: the Plugins page's own read (one cache entry
 * for both pages), narrowed to the channel kinds.
 */
export function channelPluginsQuery(api: ApiClient) {
  return queryOptions({ ...installedPluginsQuery(api), select: channelPluginsOf });
}

/** A channel plugin of the registry this worker does not host: its kind and its `facetdb add` line. */
export type ChannelToAdd = { readonly kind: string; readonly command: string };

/**
 * The registry's channel plugins this worker does not host and could install (their core range
 * holds), each with the command the Plugins page builds: from a short name alone, never from the
 * answer; an entry whose name is not one is not offered. Null when the registry cannot be read.
 */
function channelsToAddOf(gallery: Gallery): readonly ChannelToAdd[] | null {
  if (!gallery.reachable) {
    return null;
  }
  return gallery.plugins.flatMap((entry) => {
    const command = addCommand(entry.name);
    return entry.kinds.includes("channel") && !entry.installed && entry.holds && command !== null
      ? [{ kind: entry.name, command }]
      : [];
  });
}

/** The registry's channel plugins this worker does not host, offered with their `facetdb add`. */
export function channelsToAddQuery(api: ApiClient) {
  return queryOptions({
    ...galleryQuery(api, ""),
    select: channelsToAddOf,
    // The registry is outside: one that cannot be reached is said once, not asked three times.
    retry: false,
  });
}
