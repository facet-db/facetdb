// The shell's door: the layout around every page, a page's head, the rail's parts the sign-in page
// reuses, and the theme and media queries the composition root wires.
export type { Media, MediaWatch } from "./media.ts";
export { browserMedia, LIGHT_QUERY, PHONE_QUERY, useMedia } from "./media.ts";
export { PageHead } from "./Page.tsx";
export { Brand, PAGES, PROJECT_HINT } from "./Rail.tsx";
export { Shell } from "./Shell.tsx";
export type { KeyValueStorage, Theme } from "./theme.tsx";
export { rememberedTheme, rememberTheme, THEME_KEY, ThemeProvider, useTheme } from "./theme.tsx";
