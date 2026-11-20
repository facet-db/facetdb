import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, needsSignIn } from "./api/client.ts";
import { DepsProvider, type StudioDeps } from "./deps.tsx";
import { createStudioRouter } from "./routes/tree.ts";
import { ThemeProvider } from "./shell/theme.tsx";

/**
 * The studio as one component over its dependencies: the query client, the router and the
 * providers. main.tsx renders it with the browser's dependencies, a test with fakes and a memory
 * history (src/testing/render.tsx).
 */

/** Network trouble is retried twice; a refusal with the surface's words is an answer, not trouble. */
function retry(failures: number, error: Error): boolean {
  return !(error instanceof ApiError) && failures < 2;
}

/**
 * The query cache, the router, and the one rule between them: any answer `sign-in` sends this
 * browser to the sign-in page, which brings it back to where it was.
 */
export function createStudio(deps: StudioDeps, history?: RouterHistory) {
  const toSignIn = (error: Error) => {
    if (!needsSignIn(error)) {
      return;
    }
    const { pathname, href } = router.state.location;
    if (pathname !== "/sign-in") {
      void router.navigate({ to: "/sign-in", search: { next: href } });
    }
  };
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: toSignIn }),
    mutationCache: new MutationCache({ onError: toSignIn }),
    defaultOptions: { queries: { retry }, mutations: { retry: false } },
  });
  const router = createStudioRouter({ api: deps.api, queryClient }, history);
  return { queryClient, router };
}

export function Studio({
  deps,
  history,
}: {
  readonly deps: StudioDeps;
  readonly history?: RouterHistory;
}) {
  const [{ queryClient, router }] = useState(() => createStudio(deps, history));
  return (
    <DepsProvider deps={deps}>
      <ThemeProvider storage={deps.storage} media={deps.media}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </DepsProvider>
  );
}
