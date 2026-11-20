import { createContext, type ReactNode, useContext } from "react";
import type { ApiClient } from "./api/client.ts";
import type { Media } from "./shell/media.ts";
import type { KeyValueStorage } from "./shell/theme.tsx";

/**
 * What the studio touches outside itself, wired once by the composition root (main.tsx) and
 * passed by a test as fakes through the same object: the worker's API, the browser's storage for
 * the theme, and its media queries. Nothing in the app reaches for `fetch`, `localStorage` or
 * `matchMedia` on its own.
 */
export type StudioDeps = {
  readonly api: ApiClient;
  /** The browser's `localStorage`, reached through a function: in a private window reaching it throws. */
  readonly storage: () => KeyValueStorage;
  readonly media: Media;
  /** The page's own origin (`http://127.0.0.1:4040`): the sign-in page goes back to it alone. */
  readonly origin: string;
};

const DepsContext = createContext<StudioDeps | null>(null);

export function DepsProvider({
  deps,
  children,
}: {
  readonly deps: StudioDeps;
  readonly children: ReactNode;
}) {
  return <DepsContext.Provider value={deps}>{children}</DepsContext.Provider>;
}

export function useDeps(): StudioDeps {
  const deps = useContext(DepsContext);
  if (deps === null) {
    throw new Error("useDeps is called outside <Studio>, which provides the dependencies");
  }
  return deps;
}

/** The API client, for a page's queries: `const api = useApi(); useQuery({ queryKey, queryFn: () => api.x() })`. */
export function useApi(): ApiClient {
  return useDeps().api;
}
