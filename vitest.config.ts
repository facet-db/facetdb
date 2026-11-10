import { defineConfig } from "vitest/config";

// The whole workspace in one vitest run: each package's own vitest.config.ts is a project, so its
// include and exclude rules hold (no *.db.test.ts, no *.live.test.ts), and the files of every
// package run in parallel across the cores instead of package after package. `pnpm test`
// runs this; `pnpm --filter <pkg> test <pattern>` still runs one package.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
