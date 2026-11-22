import { defineConfig } from "vitest/config";

// The GitHub triage example end to end (`pnpm test:e2e`): `facetdb init
// --example github-triage` and `facetdb dev --model-url` in child processes on a copy under
// build/ (gitignored), against GitHub, a System One server and Slack's webhook receiver on
// loopback ports. No network, no key, nothing set in the shell.
export default defineConfig({
  test: {
    include: ["src/e2e/*.e2e.test.ts"],
    // The whole run takes seconds; each wait gives up after 30 s with what it saw, inside these.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
