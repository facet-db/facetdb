import type { RegisteredCommand } from "../program.ts";
import { doctorCommand } from "./doctor.ts";
import { initCommand } from "./init.ts";
import { migrateCommand } from "./migrate.ts";
import { uninstallCommand } from "./uninstall.ts";

/**
 * Every command the `facetdb` program registers. preview, backfill, worker, dev, types and explain
 * join later.
 */
export const COMMANDS: readonly RegisteredCommand[] = [
  initCommand,
  doctorCommand,
  migrateCommand,
  uninstallCommand,
];

export { doctorCommand } from "./doctor.ts";
export { initCommand } from "./init.ts";
export { migrateCommand } from "./migrate.ts";
export { uninstallCommand } from "./uninstall.ts";
