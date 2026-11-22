import { defineConfig } from "vitest/config";

// Live-API tests only (`pnpm --filter @facetdb/packs run test:live`): the marketplace pack asked of
// the real model on its 50 labelled listings, with TYPESAFE_API_KEY from the shell. Never part of
// `pnpm test`; it is run by hand. Without the key the suite skips loudly.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
