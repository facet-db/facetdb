import { defineConfig } from "vitest/config";

// Live-API tests only (`pnpm --filter @facetdb/model run test:live`): one real call to TypeSafe
// with TYPESAFE_API_KEY from the shell. Never part of `pnpm test`, `test:db` or `test:e2e`; it is
// run by hand. Without the key the suite skips loudly.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
