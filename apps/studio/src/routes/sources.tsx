import { createRoute } from "@tanstack/react-router";
import { SourcesPage } from "../features/sources/index.ts";
import { shellRoute } from "./root.tsx";

// Sources.
export const sourcesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sources",
  component: SourcesPage,
});
