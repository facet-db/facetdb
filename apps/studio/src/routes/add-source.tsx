import { createRoute } from "@tanstack/react-router";
import { AddSourcePage } from "../features/setup/index.ts";
import { shellRoute } from "./root.tsx";

// "Add a source" on the Sources page opens this setup flow (the mockups' add-source.html). Under
// /sources, so the rail marks Sources. The page keeps the admin connection string in its memory
// alone: nothing of the flow is in the address.
export const addSourceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sources/new",
  component: AddSourcePage,
});
