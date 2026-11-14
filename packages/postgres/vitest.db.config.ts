import { defineConfig } from "vitest/config";

// Real-Postgres tests only (`pnpm test:db`, with DATABASE_URL set). Files run in parallel: each makes
// its own scratch database with its own role names (testing/postgres.ts), so no two share a schema
// or a login, here or in another run on the same server.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    exclude: ["**/node_modules/**"],
    // Same cap as the unit config (an uncapped run spawns one worker per core).
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
