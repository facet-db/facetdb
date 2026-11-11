import { defineConfig } from "vitest/config";

// The local end-to-end (`pnpm test:e2e`): PGlite in-process and the scripted fake provider, so it
// needs no service, no network and nothing set in the shell. The fixture's config file reads
// `process.env["DATABASE_URL"]` as a user's does; the suite supplies the worker login's connection
// string here (PGlite ignores the host), so the loader sees a variable holding it.
export default defineConfig({
  test: {
    include: ["src/e2e/*.e2e.test.ts"],
    env: {
      DATABASE_URL: "postgres://facetdb_worker:e2e-worker-password@localhost:5432/listings_app",
    },
    // The whole run is budgeted at 60 s; one test never needs more than that.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
