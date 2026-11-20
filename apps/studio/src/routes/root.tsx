import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, Link, Outlet } from "@tanstack/react-router";
import type { ApiClient } from "../api/index.ts";
import { PageHead, Shell } from "../shell/index.ts";

/**
 * The routes' two roots: the root, which holds the sign-in page alone, and the shell, a layout
 * with no path of its own that puts the rail around every page. A page is a route whose parent is
 * `shellRoute`, in its own file under src/routes/, added to the tree in tree.ts and its path to
 * paths.ts.
 */

/** What a route's loader may use: the API and the query cache (pages prefetch through them). */
export type RouterContext = { readonly api: ApiClient; readonly queryClient: QueryClient };

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

export const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: Shell,
});

/** A link inside the app to a path it does not route (the server answers none of those). */
function NotFound() {
  return (
    <main className="mx-auto max-w-[64ch] px-4 py-12">
      <PageHead title="No such page" lede="This studio has no page at this address." />
      <Link to="/">Go to Home</Link>
    </main>
  );
}
