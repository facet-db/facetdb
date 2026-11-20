import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Decisions. Its content is not built yet.
export const decisionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions",
  component: DecisionsPage,
});

function DecisionsPage() {
  return (
    <PageHead
      title="Decisions"
      lede="Every decision, searchable, and the page that says why each record was decided."
    />
  );
}
