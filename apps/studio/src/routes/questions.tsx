import { createRoute } from "@tanstack/react-router";
import { QuestionsPage, questionsSearch } from "../features/questions/index.ts";
import { shellRoute } from "./root.tsx";

// Questions. The address holds the source whose tab is open, validated here; the source name
// reaches the validator as written (routes/search.ts).
export const questionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/questions",
  validateSearch: questionsSearch,
  component: QuestionsRoute,
});

function QuestionsRoute() {
  const { source } = questionsRoute.useSearch();
  const navigate = questionsRoute.useNavigate();
  return (
    <QuestionsPage
      source={source}
      onSource={(name) => {
        void navigate({ search: { source: name }, replace: true });
      }}
    />
  );
}
