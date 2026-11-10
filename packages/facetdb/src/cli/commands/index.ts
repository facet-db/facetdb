import type { RegisteredCommand } from "../program.ts";
import { migrateCommand } from "./migrate.ts";
import { uninstallCommand } from "./uninstall.ts";

/**
 * Every command the `facetdb` program registers. init, doctor, preview, backfill, worker, dev, types
 * and explain join later.
 */
export const COMMANDS: readonly RegisteredCommand[] = [migrateCommand, uninstallCommand];

export { migrateCommand } from "./migrate.ts";
export { uninstallCommand } from "./uninstall.ts";
