import { defineConfig } from "vitest/config";

// Unit tests only (they may use PGlite in-process). Real-Postgres tests (*.db.test.ts) run through
// `pnpm test:db` with DATABASE_URL set, and live-API tests (*.live.test.ts) only by hand with
// TYPESAFE_API_KEY; neither runs silently alongside unit tests. The local end-to-end
// (*.e2e.test.ts) runs through `pnpm test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "facetdb",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/*.e2e.test.ts", "**/node_modules/**"],
    // The `facetdb types` tests spawn tsc on the generated declaration: seconds alone, more on a
    // loaded machine (6 s at load 15, 2026-11-01). A hang still fails at 30 s.
    testTimeout: 30_000,
    // Each command test file installs on PGlite once in its beforeAll (doctor's runs two real
    // migrates and the store's migrations; the whole file takes 4.6 s on the laptop), and the CI
    // runner's unit stage runs about four times slower than the laptop (165 s against 39 s on
    // 2026-11-03, four workers on two vCPUs), so vitest's 10 s hook default timed doctor's out
    // there. The same margin as the tests; a hang still fails at 30 s.
    hookTimeout: 30_000,
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
