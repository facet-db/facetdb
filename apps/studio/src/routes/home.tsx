import { createRoute } from "@tanstack/react-router";
import { HomePage } from "../features/home/index.ts";
import { shellRoute } from "./root.tsx";

// Home. The page is features/home.
export const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: HomePage,
});
