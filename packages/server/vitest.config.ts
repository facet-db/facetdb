import { defineConfig } from "vitest/config";

// Unit tests only (they may use PGlite in-process). Real-Postgres tests (*.db.test.ts) run through
// `pnpm test:db` with DATABASE_URL set, and live-API tests (*.live.test.ts) only by hand with
// TYPESAFE_API_KEY; neither runs silently alongside unit tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
    // The check tests run on the real store over PGlite: the cluster template is built once before
    // the workers start (postgres' testing/pglite.ts), and a cold checkout gets 15 s a test.
    globalSetup: ["../postgres/src/testing/global-setup.ts"],
    testTimeout: 15_000,
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
