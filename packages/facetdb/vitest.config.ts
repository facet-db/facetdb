import { defineConfig } from "vitest/config";

// Unit tests only (they may use PGlite in-process). Real-Postgres tests (*.db.test.ts) run through
// `pnpm test:db` with DATABASE_URL set, and live-API tests (*.live.test.ts) only by hand with
// TYPESAFE_API_KEY; neither runs silently alongside unit tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
    // The `facetdb types` tests spawn tsc on the generated declaration: seconds alone, more on
    // a loaded machine (6 s at load 15, 2026-11-01). A hang still fails at 30 s.
    testTimeout: 30_000,
  },
});
