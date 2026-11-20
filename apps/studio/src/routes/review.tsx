import { createRoute } from "@tanstack/react-router";
import { ReviewPage } from "../features/review/index.ts";
import { shellRoute } from "./root.tsx";

// Review, the review screen.
export const reviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/review",
  component: ReviewPage,
});
