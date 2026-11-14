import { readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests on a real server only (`pnpm test:db`, on the server MSSQL_URL names; see serverUrl in
// src/testing). Files run one at a time: they share that server and its logins, with no scratch
// database and role suffix per file as the Postgres suites have. It runs only with MSSQL_URL set;
// vitest fails a run that finds no file.
//
// An empty run passes only while this package has no *.db.test.ts at all; once one exists, a
// pattern that matches nothing exits 1.
const hasDbTest = readdirSync(new URL("src", import.meta.url), { recursive: true }).some((file) =>
  file.endsWith(".db.test.ts"),
);

export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: !hasDbTest,
  },
});
