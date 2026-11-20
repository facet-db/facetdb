import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode } from "react";
import type { ApiClient } from "../api/index.ts";
import type { StudioDeps } from "../deps.tsx";
import { type KeyValueStorage, LIGHT_QUERY, type Media, PHONE_QUERY } from "../shell/index.ts";
import { createStudio, Studio } from "../studio.tsx";
import { fakeApi } from "./fake-client.ts";
import { FAKE_START, fakeScheduler } from "./fake-scheduler.ts";

/**
 * How a studio test renders the whole app (the shell's test and every page's): the real router at a
 * path in a memory history, the fake API client, a storage that is a map and media queries whose
 * answers the test sets. No real fetch, storage, viewport or timer.
 */

/** The origin a test's studio is served from, as `facetdb studio` serves it. */
export const STUDIO_ORIGIN = "http://127.0.0.1:4040";

/** The moment a test's studio calls now unless it is given another: the fake scheduler's start. */
export const STUDIO_NOW = new Date(FAKE_START);

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
  /** Mount under React's StrictMode, as main.tsx does. */
  readonly strict?: boolean;
  /** The moment the fake scheduler starts at (STUDIO_NOW unless given); `schedule.advance` moves it on. */
  readonly now?: Date;
  /** The clipboard; by default it takes the text into `copied` of the result. */
  readonly clipboard?: (text: string) => Promise<void>;
};

export function renderStudio(options: RenderStudioOptions = {}) {
  const api = options.api ?? fakeApi();
  const page = memoryStorage();
  const storage = options.storage ?? (() => page);
  const screenMedia = fakeMedia({
    [PHONE_QUERY]: options.phone ?? false,
    [LIGHT_QUERY]: options.light ?? false,
  });
  const schedule = fakeScheduler(options.now?.getTime());
  const history = createMemoryHistory({ initialEntries: [options.path ?? "/"] });
  const user = userEvent.setup();
  const copied: string[] = [];
  const deps: StudioDeps = {
    api,
    storage,
    media: screenMedia.media,
    schedule,
    origin: STUDIO_ORIGIN,
    clipboard:
      options.clipboard ??
      ((text) => {
        copied.push(text);
        return Promise.resolve();
      }),
  };
  // Made here, not inside <Studio>, so a test can look into the query cache the pages fill.
  const made = createStudio(deps, history);
  const studio = <Studio deps={deps} history={history} studio={made} />;
  // main.tsx mounts under StrictMode, which runs every effect twice in development.
  const rendered = render(options.strict === true ? <StrictMode>{studio}</StrictMode> : studio);
  return {
    ...rendered,
    api,
    history,
    media: screenMedia,
    schedule,
    user,
    copied,
    queryClient: made.queryClient,
  };
}
