import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_PORT } from "./address.ts";

/**
 * The smoke's server: `facetdb dev` on a fresh copy of the listings example, started by
 * Playwright's webServer (playwright.config.ts) and stopped with it. The copy lives under
 * packages/facetdb/build/ (gitignored), never in the examples folder, which a dev run would leave a
 * `.facetdb/` in; and under the facetdb package, so the example's `import ... from "facetdb"`
 * resolves to the package's own sources through its exports (a package may name itself) with no
 * install step. `facetdb init --example` writes the copy as a user would get it; the smoke's second
 * table (sellers.sql, for Add a source to install on) is seeded after the example's seed in the one
 * transaction dev runs. Everything is offline: PGlite under `.facetdb/dev/` and the fake provider,
 * with the rows that hold URGENT left for review.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..");
const project = join(repository, "packages", "facetdb", "build", "listings-smoke");

/** The seed dev runs: the example's 2,000 listings, then the smoke's sellers. */
const SEED = "seed-smoke.sql";

/** `pnpm -w facetdb …` from the copy: the CLI takes the folder it is called from as the project. */
function facetdb(args: readonly string[], options: { readonly wait: true }): number;
function facetdb(args: readonly string[]): ReturnType<typeof spawn>;
function facetdb(args: readonly string[], options?: { readonly wait: true }) {
  const argv = ["-w", "facetdb", ...args];
  if (options?.wait === true) {
    const ran = spawnSync("pnpm", argv, { cwd: project, stdio: "inherit" });
    if (ran.error !== undefined) {
      throw ran.error;
    }
    return ran.status ?? 1;
  }
  return spawn("pnpm", argv, { cwd: project, stdio: "inherit" });
}

async function main(): Promise<void> {
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  const initialized = facetdb(
    ["init", "--example", "listings", "--engine", "postgres", "--force"],
    {
      wait: true,
    },
  );
  if (initialized !== 0) {
    throw new Error(`facetdb init exited with ${String(initialized)}`);
  }
  const [listings, sellers] = await Promise.all([
    readFile(join(project, "seed.sql"), "utf8"),
    readFile(join(here, "sellers.sql"), "utf8"),
  ]);
  await writeFile(join(project, SEED), `${listings}\n${sellers}`);

  const dev = facetdb(["dev", "--seed", SEED, "--reset", "--port", String(SMOKE_PORT)]);
  // Playwright stops the server with SIGINT (gracefulShutdown): passed on so dev closes its
  // database as it does on Ctrl+C, then this process ends with dev's own code.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      dev.kill(signal);
    });
  }
  dev.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 0));
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
