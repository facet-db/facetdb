import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// "Why was this decided" for one record (the mockups' why.html): under /decisions, so the rail
// marks Decisions. The key is the record's as its source writes it, URL-encoded in the path. Its
// content is not built yet.
export const whyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions/$source/$key",
  component: WhyPage,
});

function WhyPage() {
  const { source, key } = whyRoute.useParams();
  return (
    <PageHead
      title="Why was this decided"
      lede={`The history of ${key} in ${source}: every answer and decision, with the wording and thresholds in force at each.`}
    />
  );
}
