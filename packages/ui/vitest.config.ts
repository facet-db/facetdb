import { defineConfig } from "vitest/config";

// The design system's tests run on happy-dom: the tokens' values and contrast, the dither's canvas
// at the device pixel ratio, later the components. No database, no model.
export default defineConfig({
  test: {
    // The project name, for `vitest --project <name>`.
    name: "ui",
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**"],
    // Same cap as the root config (an uncapped run spawns one worker per core; see vitest.config.ts).
    maxWorkers: 4,
  },
});
