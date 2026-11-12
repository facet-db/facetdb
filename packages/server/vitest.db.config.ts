import { defineConfig } from "vitest/config";

// Real-Postgres tests only (`pnpm test:db`, with DATABASE_URL set). They share the `facetdb` schema
// of one database, so files run one after another.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
