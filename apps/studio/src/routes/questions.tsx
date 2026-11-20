import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Questions. Its content is not built yet.
export const questionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/questions",
  component: QuestionsPage,
});

function QuestionsPage() {
  return (
    <PageHead
      title="Questions"
      lede="The question editor with a live preview on 20 rows, thresholds with a slider, version history, Test and Apply."
    />
  );
}
