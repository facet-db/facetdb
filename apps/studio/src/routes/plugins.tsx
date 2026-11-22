import { createRoute } from "@tanstack/react-router";
import { PluginsPage } from "../features/plugins/index.ts";
import { shellRoute } from "./root.tsx";

// Plugins. The page is features/plugins.
export const pluginsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/plugins",
  component: PluginsPage,
});
