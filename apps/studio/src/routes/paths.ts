/**
 * Every path the studio routes, as its router writes them. The build writes this list to
 * `routes.json` beside index.html (vite.config.ts), and the worker answers index.html for these
 * paths and for nothing else (packages/server, studio/routes.ts); shell.test.tsx holds the router
 * to this list both ways. Plain data: Vite's config imports it, so it imports nothing.
 */
export const STUDIO_ROUTES = [
  "/",
  "/sources",
  "/sources/new",
  "/questions",
  "/review",
  "/decisions",
  "/decisions/$source/$key",
  "/decisions/history",
  "/plugins",
  "/alerts",
  "/settings",
  "/sign-in",
] as const;
