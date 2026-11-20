import { createRoute } from "@tanstack/react-router";
import { SettingsPage } from "../features/settings/index.ts";
import { shellRoute } from "./root.tsx";

// Settings. The page is features/settings.
export const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});
