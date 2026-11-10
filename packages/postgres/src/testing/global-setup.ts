import { warmPgliteTemplate } from "./pglite.ts";

/**
 * vitest `globalSetup` for every package whose tests boot PGlite (postgres, server): the cluster
 * template is built once here, in the main process, so no test file's first test pays for it.
 */
export default async function setup(): Promise<void> {
  await warmPgliteTemplate();
}
