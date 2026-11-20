import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Plugins. Its content is not built yet.
export const pluginsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/plugins",
  component: PluginsPage,
});

function PluginsPage() {
  return (
    <PageHead title="Plugins" lede="Installed plugins with their settings, and the gallery." />
  );
}
