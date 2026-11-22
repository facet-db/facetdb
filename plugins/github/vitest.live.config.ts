import { defineConfig } from "vitest/config";

// Live-API tests only (`pnpm --filter @facetdb/github run test:live`): the triage pack asked of the
// real model on its 50 labelled records, then again with kind's options reversed (100 calls), with
// TYPESAFE_API_KEY from the shell. Never part of `pnpm test` or `test:e2e`; it is run by hand.
// Without the key the suite skips loudly.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
