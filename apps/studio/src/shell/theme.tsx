import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { LIGHT_QUERY, type Media, useMedia } from "./media.ts";

/**
 * Both themes: the system's preference by default, the rail's switch on top of it, remembered per
 * browser. The tokens do the painting (packages/ui tokens.css reads `data-theme` on the root); this
 * module only decides the attribute.
 */

export type Theme = "light" | "dark";

/** The part of `localStorage` the switch uses; a test passes a map behind the same two methods. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export const THEME_KEY = "facetdb-theme";

/**
 * The theme this browser chose, or undefined: none chosen, or no storage to ask (a private window,
 * blocked site data, where even reaching `localStorage` throws).
 */
export function rememberedTheme(storage: () => KeyValueStorage): Theme | undefined {
  try {
    const chosen = storage().getItem(THEME_KEY);
    return chosen === "light" || chosen === "dark" ? chosen : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the choice for the next visit when the browser lets us; the switch works either way. */
export function rememberTheme(storage: () => KeyValueStorage, theme: Theme): void {
  try {
    storage().setItem(THEME_KEY, theme);
  } catch {
    // A private window or a full quota: this page still switches, the next one starts afresh.
  }
}

type ThemeState = { readonly theme: Theme; readonly toggle: () => void };

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({
  storage,
  media,
  children,
}: {
  readonly storage: () => KeyValueStorage;
  readonly media: Media;
  readonly children: ReactNode;
}) {
  const [chosen, setChosen] = useState(() => rememberedTheme(storage));
  const prefersLight = useMedia(media, LIGHT_QUERY);
  const theme: Theme = chosen ?? (prefersLight ? "light" : "dark");

  // Before the first paint, so a remembered theme never flashes the other one.
  useLayoutEffect(() => {
    if (chosen !== undefined) {
      document.documentElement.setAttribute("data-theme", chosen);
    }
  }, [chosen]);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    rememberTheme(storage, next);
    setChosen(next);
  }, [theme, storage]);

  const state = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (state === null) {
    throw new Error("useTheme is called outside <Studio>, which provides the theme");
  }
  return state;
}
