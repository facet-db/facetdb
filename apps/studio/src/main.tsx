import { createBrowserHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { createApiClient } from "./api/client.ts";
import type { StudioDeps } from "./deps.tsx";
import { browserMedia } from "./shell/media.ts";
import { Studio } from "./studio.tsx";
import "./app.css";

/**
 * The composition root of the studio: the only file that touches the browser's `fetch`,
 * `localStorage`, `matchMedia` and history. Everything else receives them through `StudioDeps`.
 */
// The page's policy forbids eval (packages/server, studio/routes.ts): zod parses without compiling,
// and never probes `new Function` to find out, which the browser would report as a violation.
z.config({ jitless: true });

const deps: StudioDeps = {
  // Same-origin: the worker serves the app and the API at one address (Vite proxies /v1 in dev).
  api: createApiClient((input, init) => window.fetch(input, init)),
  // Reached on each use: in a private window even reading `window.localStorage` throws.
  storage: () => window.localStorage,
  media: browserMedia((query) => window.matchMedia(query)),
  origin: window.location.origin,
};

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}
createRoot(root).render(
  <StrictMode>
    <Studio deps={deps} history={createBrowserHistory()} />
  </StrictMode>,
);
