import type { RegisteredCommand } from "../program.ts";
import { backfillCommand } from "./backfill.ts";
import { doctorCommand } from "./doctor.ts";
import { explainCommand } from "./explain.ts";
import { initCommand } from "./init.ts";
import { migrateCommand } from "./migrate.ts";
import { previewCommand } from "./preview.ts";
import { uninstallCommand } from "./uninstall.ts";

/**
 * Every command the `facetdb` program registers. worker, dev and types join later.
 */
export const COMMANDS: readonly RegisteredCommand[] = [
  initCommand,
  doctorCommand,
  migrateCommand,
  uninstallCommand,
  previewCommand,
  backfillCommand,
  explainCommand,
];

export { backfillCommand } from "./backfill.ts";
export { doctorCommand } from "./doctor.ts";
export { explainCommand } from "./explain.ts";
export { initCommand } from "./init.ts";
export { migrateCommand } from "./migrate.ts";
export { previewCommand } from "./preview.ts";
export { uninstallCommand } from "./uninstall.ts";
