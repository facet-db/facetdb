import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Settings. Its content is not built yet.
export const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <PageHead
      title="Settings"
      lede="Members and roles, environments, billing, the spending cap and data retention."
    />
  );
}
