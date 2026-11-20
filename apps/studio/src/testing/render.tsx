import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ApiClient } from "../api/index.ts";
import { type KeyValueStorage, LIGHT_QUERY, type Media, PHONE_QUERY } from "../shell/index.ts";
import { Studio } from "../studio.tsx";
import { fakeApi } from "./fake-client.ts";

/**
 * How a studio test renders the whole app (the shell's test and every page's): the real router at a
 * path in a memory history, the fake API client, a storage that is a map and media queries whose
 * answers the test sets. No real fetch, storage, viewport or timer.
 */

/** The origin a test's studio is served from, as `facetdb studio` serves it. */
export const STUDIO_ORIGIN = "http://127.0.0.1:4040";

/** `localStorage` as a map: two renders over one of these are a reload of the page. */
export function memoryStorage(): KeyValueStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** Media queries answered from a map the test sets; `set` tells the subscribers, as a resize does. */
export function fakeMedia(answers: Readonly<Record<string, boolean>>) {
  const now = new Map(Object.entries(answers));
  const listeners = new Map<string, Set<() => void>>();
  const media: Media = (query) => ({
    matches: () => now.get(query) ?? false,
    subscribe: (onChange) => {
      const set = listeners.get(query) ?? new Set();
      set.add(onChange);
      listeners.set(query, set);
      return () => {
        set.delete(onChange);
      };
    },
  });
  return {
    media,
    set(query: string, matches: boolean): void {
      now.set(query, matches);
      for (const onChange of listeners.get(query) ?? []) {
        onChange();
      }
    },
  };
}

export type RenderStudioOptions = {
  /** Where the app opens: `/` unless given. */
  readonly path?: string;
  readonly api?: ApiClient;
  readonly storage?: () => KeyValueStorage;
  /** A phone's width (the top bar and the drawer) instead of the rail. */
  readonly phone?: boolean;
  /** The system prefers the light theme. */
  readonly light?: boolean;
};

export function renderStudio(options: RenderStudioOptions = {}) {
  const api = options.api ?? fakeApi();
  const page = memoryStorage();
  const storage = options.storage ?? (() => page);
  const screenMedia = fakeMedia({
    [PHONE_QUERY]: options.phone ?? false,
    [LIGHT_QUERY]: options.light ?? false,
  });
  const history = createMemoryHistory({ initialEntries: [options.path ?? "/"] });
  const user = userEvent.setup();
  const rendered = render(
    <Studio
      deps={{ api, storage, media: screenMedia.media, origin: STUDIO_ORIGIN }}
      history={history}
    />,
  );
  return { ...rendered, api, history, media: screenMedia, user };
}
