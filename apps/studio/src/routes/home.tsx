import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Home. Its content is not built yet.
export const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: HomePage,
});

function HomePage() {
  return (
    <PageHead
      title="Home"
      lede="Health, records answered today, the review queue, spending against the cap and recent alerts."
    />
  );
}
