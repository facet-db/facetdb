import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { addSourceRoute } from "./add-source.tsx";
import { alertsRoute } from "./alerts.tsx";
import { decisionsRoute } from "./decisions.tsx";
import { homeRoute } from "./home.tsx";
import { pluginsRoute } from "./plugins.tsx";
import { questionsRoute } from "./questions.tsx";
import { reviewRoute } from "./review.tsx";
import { type RouterContext, rootRoute, shellRoute } from "./root.tsx";
import { settingsRoute } from "./settings.tsx";
import { signInRoute } from "./sign-in.tsx";
import { sourcesRoute } from "./sources.tsx";
import { whyRoute } from "./why.tsx";

/**
 * The studio's routes, written in code (there is no router plugin in the build): the eight pages,
 * the setup flow and the why page inside the shell, and the sign-in page outside it. A route added
 * here adds its path to paths.ts, which the server reads.
 */
export const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    homeRoute,
    sourcesRoute,
    addSourceRoute,
    questionsRoute,
    reviewRoute,
    decisionsRoute,
    whyRoute,
    pluginsRoute,
    alertsRoute,
    settingsRoute,
  ]),
  signInRoute,
]);

/** The router over a history: the browser's in the app, a memory history in a test. */
export function createStudioRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history === undefined ? {} : { history }),
  });
}

declare module "@tanstack/react-router" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: the router's types are registered by declaration merging, which needs an interface
  interface Register {
    router: ReturnType<typeof createStudioRouter>;
  }
}
