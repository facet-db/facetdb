import type { RegisteredCommand } from "../program.ts";
import { backfillCommand } from "./backfill.ts";
import { doctorCommand } from "./doctor.ts";
import { initCommand } from "./init.ts";
import { migrateCommand } from "./migrate.ts";
import { previewCommand } from "./preview.ts";
import { uninstallCommand } from "./uninstall.ts";

/**
 * Every command the `facetdb` program registers. worker, dev, types and explain join later.
 */
export const COMMANDS: readonly RegisteredCommand[] = [
  initCommand,
  doctorCommand,
  migrateCommand,
  uninstallCommand,
  previewCommand,
  backfillCommand,
];

export { backfillCommand } from "./backfill.ts";
export { doctorCommand } from "./doctor.ts";
export { initCommand } from "./init.ts";
export { migrateCommand } from "./migrate.ts";
export { previewCommand } from "./preview.ts";
export { uninstallCommand } from "./uninstall.ts";
