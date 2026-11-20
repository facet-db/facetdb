import { createRoute } from "@tanstack/react-router";
import { AlertsPage } from "../features/alerts/index.ts";
import { shellRoute } from "./root.tsx";

// Alerts. The page is features/alerts.
export const alertsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/alerts",
  component: AlertsPage,
});
