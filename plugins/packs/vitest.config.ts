import { defineConfig } from "vitest/config";

// Unit tests only. Tests on a real server (*.db.test.ts) and live-API tests (*.live.test.ts) run
// only by hand, never silently alongside the unit tests.
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "packs",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
