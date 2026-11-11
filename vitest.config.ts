import { defineConfig } from "vitest/config";

// The whole workspace in one vitest run: each package's own vitest.config.ts is a project, so its
// include and exclude rules hold (no *.db.test.ts, no *.live.test.ts), and the files of every
// package run in parallel across the cores instead of package after package. `pnpm test`
// runs this; `pnpm --filter <pkg> test <pattern>` still runs one package.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
    // Four workers, not one per core: an uncapped run on a 16-core laptop spawned 16 node workers
    // (7 to 13 GB a run) and two overlapping runs took the desktop session down with the OOM
    // killer (2026-11-01, twice). Each package config repeats the cap for single-package runs.
    maxWorkers: 4,
  },
});
