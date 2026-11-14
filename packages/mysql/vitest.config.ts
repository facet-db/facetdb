import { defineConfig } from "vitest/config";

// Unit tests only. The tests on a real server (*.db.test.ts) run through `pnpm test:db` with
// MYSQL_URL or MARIADB_URL set, and live-API tests (*.live.test.ts) only by hand with
// TYPESAFE_API_KEY; neither runs silently alongside unit tests.
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "mysql",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
