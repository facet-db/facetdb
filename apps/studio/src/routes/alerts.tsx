import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Alerts. Its content is not built yet.
export const alertsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/alerts",
  component: AlertsPage,
});

function AlertsPage() {
  return <PageHead title="Alerts" lede="Channels, events, quiet hours and a test button." />;
}
