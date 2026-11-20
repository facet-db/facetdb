import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { STUDIO_ROUTES } from "./src/routes/paths.ts";

/**
 * The studio's build and dev server. `vite build` writes dist/, which the worker serves with no
 * Vite at runtime (`facetdb studio`, `facetdb worker`); `vite` serves the app with hot reload and
 * proxies /v1 to a worker running beside it (`pnpm facetdb dev` or `worker`), so the API is
 * same-origin in both. The worker's port is FACETDB_PORT, 4040 unless set.
 */

/** routes.json beside index.html: the paths the worker answers with the page (and no others). */
function routesFile(): Plugin {
  return {
    name: "facetdb-studio-routes",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "routes.json",
        source: `${JSON.stringify({ routes: STUDIO_ROUTES }, null, 2)}\n`,
      });
    },
  };
}

const workerPort = process.env["FACETDB_PORT"] ?? "4040";

export default defineConfig({
  plugins: [react(), tailwindcss(), routesFile()],
  server: {
    // No x-forwarded-* headers (xfwd stays off) and the Host kept: the worker sees this machine's
    // loopback, so the OS user needs no sign-in in development as in `facetdb studio`.
    proxy: { "/v1": { target: `http://127.0.0.1:${workerPort}` } },
  },
});
