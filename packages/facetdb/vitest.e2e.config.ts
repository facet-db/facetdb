import { defineConfig } from "vitest/config";

// The local end-to-ends (`pnpm test:e2e`), no service and no network:
// - listings.e2e.test.ts: PGlite in-process and the scripted fake provider, nothing set in
//   the shell. The fixture's config file names `env("DATABASE_URL")` as a user's does; the suite
//   supplies the worker login's connection string here (PGlite ignores the host), so the loader
//   reads it from that variable. Its run was budgeted at 60 s.
// - fresh-install.e2e.test.ts: builds and packs every publishable package and installs
//   the tarballs into a project under $TMPDIR with `pnpm install --offline`. It needs a warm pnpm
//   store and metadata cache (a `pnpm install` in the workspace), the pinned pnpm in corepack's
//   cache, and a shell that may write to the store; one to two minutes.
export default defineConfig({
  test: {
    include: ["src/e2e/*.e2e.test.ts"],
    env: {
      DATABASE_URL: "postgres://facetdb_worker:e2e-worker-password@localhost:5432/listings_app",
    },
    // One file at a time: the fresh install's clean build takes every core for half a minute, and
    // listings.e2e.test.ts measures the pipeline's overhead against its budget.
    fileParallelism: false,
    // One test of listings.e2e never needs more than 60 s; the fresh install's slow steps carry
    // their own timeouts.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
