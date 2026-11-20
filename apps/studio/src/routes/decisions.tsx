import { createRoute } from "@tanstack/react-router";
import {
  DecisionsPage,
  type DecisionsPatch,
  decisionsSearch,
  patched,
} from "../features/decisions/index.ts";
import { shellRoute } from "./root.tsx";

// Decisions. The view (the tab, the source, the filters, the time, the run log's page) is the
// address's search, validated here: a reload and a shared link show the same view, and a value that
// is not one falls back to the default. The text values (source, key, question, reviewer) reach the
// validator as written (routes/search.ts).
export const decisionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions",
  validateSearch: decisionsSearch,
  component: DecisionsRoute,
});

function DecisionsRoute() {
  const search = decisionsRoute.useSearch();
  const navigate = decisionsRoute.useNavigate();
  return (
    <DecisionsPage
      search={search}
      onChange={(patch: DecisionsPatch) => {
        void navigate({ search: patched(search, patch) });
      }}
    />
  );
}
