import { defineConfig } from "vitest/config";

// Unit tests only (they may use PGlite in-process). Real-Postgres tests (*.db.test.ts) run through
// `pnpm test:db` with DATABASE_URL set, and live-API tests (*.live.test.ts) only by hand with
// TYPESAFE_API_KEY; neither runs silently alongside unit tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
    // The PGlite cluster template is built once before the workers start (testing/pglite.ts), and a
    // cold checkout still boots slower than a warm one: 15 s leaves a hang failing.
    globalSetup: ["./src/testing/global-setup.ts"],
    testTimeout: 15_000,
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
