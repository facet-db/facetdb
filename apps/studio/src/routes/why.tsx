import { createRoute } from "@tanstack/react-router";
import { WhyPage } from "../features/why/index.ts";
import { shellRoute } from "./root.tsx";

// "Why was this decided" for one record (the mockups' why.html): under /decisions, so the rail marks
// Decisions. The key is the record's as the log shows it, which may hold a slash, a space or a
// percent sign: the router decodes it from the path once and the API client encodes it once.
export const whyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/decisions/$source/$key",
  component: WhyRoute,
});

function WhyRoute() {
  const { source, key } = whyRoute.useParams();
  return <WhyPage source={source} recordKey={key} />;
}
