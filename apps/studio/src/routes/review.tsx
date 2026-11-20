import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Review, the review screen. Its content is not built yet.
export const reviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/review",
  component: ReviewPage,
});

function ReviewPage() {
  return (
    <PageHead
      title="Review"
      lede="The records the model was unsure about, one card at a time, with a key for every action."
    />
  );
}
