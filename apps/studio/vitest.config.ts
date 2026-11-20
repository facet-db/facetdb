import { defineConfig } from "vitest/config";

// The studio's tests run on happy-dom with Testing Library: the shell, then each page against the
// fake API client. No database, no model, no real server.
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "studio",
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**"],
    // Testing Library's matchers, cleanup, and the parts of the DOM happy-dom lacks for Radix.
    setupFiles: ["src/testing/setup.ts"],
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
