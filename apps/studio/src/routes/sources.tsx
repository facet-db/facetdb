import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Sources. Its content is not built yet.
export const sourcesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sources",
  component: SourcesPage,
});

function SourcesPage() {
  return (
    <PageHead
      title="Sources"
      lede="Each source, its connector, the last change seen, backfill progress and the worker login's permissions."
    />
  );
}
