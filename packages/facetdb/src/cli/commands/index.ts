import type { RegisteredCommand } from "../program.ts";
import { backfillCommand } from "./backfill.ts";
import { devCommand } from "./dev.ts";
import { doctorCommand } from "./doctor.ts";
import { explainCommand } from "./explain.ts";
import { initCommand } from "./init.ts";
import { migrateCommand } from "./migrate.ts";
import { previewCommand } from "./preview.ts";
import { uninstallCommand } from "./uninstall.ts";
import { workerCommand } from "./worker.ts";

/** Every command the `facetdb` program registers. types joins later. */
export const COMMANDS: readonly RegisteredCommand[] = [
  initCommand,
  doctorCommand,
  migrateCommand,
  uninstallCommand,
  previewCommand,
  backfillCommand,
  explainCommand,
  workerCommand,
  devCommand,
];

export { backfillCommand } from "./backfill.ts";
export { devCommand } from "./dev.ts";
export { doctorCommand } from "./doctor.ts";
export { explainCommand } from "./explain.ts";
export { initCommand } from "./init.ts";
export { migrateCommand } from "./migrate.ts";
export { previewCommand } from "./preview.ts";
export { uninstallCommand } from "./uninstall.ts";
export { workerCommand } from "./worker.ts";
