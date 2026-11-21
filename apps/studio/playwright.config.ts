import { defineConfig, devices } from "@playwright/test";
import { SMOKE_URL } from "./smoke/address.ts";

/**
 * The Playwright smoke: `pnpm --filter @facetdb/studio smoke`. The server is `facetdb dev` on a
 * fresh copy of the listings example (smoke/dev.ts), offline on PGlite and the fake provider,
 * serving the studio this install built (`pnpm build` first); Chromium walks the pages and writes a
 * screenshot of each in both themes into smoke/screenshots/. One test, one worker, no retries: a
 * run that fails is a finding, not a flake to run again.
 */
export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.smoke.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // The whole walk, the seed's 2,000 rows answered while it runs.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  use: {
    // A click on a control that never enables fails in half a minute with the page's state, not
    // at the end of the whole walk.
    actionTimeout: 30_000,
    ...devices["Desktop Chrome"],
    baseURL: SMOKE_URL,
    // The screenshots' size: one window, never a full-page capture of a long list.
    viewport: { width: 1280, height: 800 },
    // The system preference the studio follows by default: the brief's navy canvas first, then the
    // rail's switch turns the light theme on for the second shot of each page.
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --disable-warning=ExperimentalWarning smoke/dev.ts",
    cwd: import.meta.dirname,
    url: SMOKE_URL,
    // A fresh, seeded database every run: never a server left from an earlier one.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    // Ctrl+C, as dev reads it: the database closes before the process ends.
    gracefulShutdown: { signal: "SIGINT", timeout: 15_000 },
  },
});
