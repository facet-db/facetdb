import { useMemo, useSyncExternalStore } from "react";

/**
 * Media queries as the shell reads them: whether the screen is a phone's (the rail becomes a top
 * bar and a drawer) and whether the system prefers the light theme. The composition root passes
 * the window's `matchMedia`; a test passes a handwritten fake whose answers it sets.
 */

/** Below this width the rail is a top bar with a menu (the mockups' 900 px). */
export const PHONE_QUERY = "(max-width: 900px)";

/** The system's theme, which the rail's switch overrides. */
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

export type MediaWatch = {
  readonly matches: () => boolean;
  /** Calls `onChange` whenever the answer may have changed; returns how to stop. */
  readonly subscribe: (onChange: () => void) => () => void;
};

export type Media = (query: string) => MediaWatch;

/** The window's media queries, one list per query. */
export function browserMedia(matchMedia: (query: string) => MediaQueryList): Media {
  const lists = new Map<string, MediaQueryList>();
  return (query) => {
    const list = lists.get(query) ?? matchMedia(query);
    lists.set(query, list);
    return {
      matches: () => list.matches,
      subscribe: (onChange) => {
        list.addEventListener("change", onChange);
        return () => {
          list.removeEventListener("change", onChange);
        };
      },
    };
  };
}

/** Whether `query` matches now, re-rendering when it changes. */
export function useMedia(media: Media, query: string): boolean {
  const watch = useMemo(() => media(query), [media, query]);
  return useSyncExternalStore(watch.subscribe, watch.matches);
}
