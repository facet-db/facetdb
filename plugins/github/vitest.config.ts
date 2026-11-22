import { defineConfig } from "vitest/config";

// Unit tests only. Tests on a real server (*.db.test.ts) and live-API tests (*.live.test.ts) run
// only by hand, never silently alongside the unit tests; the triage example's end to end
// (*.e2e.test.ts) runs through `pnpm test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "github",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/*.live.test.ts", "**/*.e2e.test.ts", "**/node_modules/**"],
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
