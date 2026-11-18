import type { RegisteredCommand } from "../program.ts";
import { backfillCommand } from "./backfill.ts";
import { devCommand } from "./dev.ts";
import { doctorCommand } from "./doctor.ts";
import { explainCommand } from "./explain.ts";
import { exportCommand } from "./export.ts";
import { initCommand } from "./init.ts";
import { migrateCommand } from "./migrate.ts";
import { previewCommand } from "./preview.ts";
import { testCommand } from "./test.ts";
import { typesCommand } from "./types.ts";
import { uninstallCommand } from "./uninstall.ts";
import { usersCommand } from "./users.ts";
import { workerCommand } from "./worker.ts";

/** Every command the `facetdb` program registers. */
export const COMMANDS: readonly RegisteredCommand[] = [
  initCommand,
  doctorCommand,
  migrateCommand,
  uninstallCommand,
  previewCommand,
  testCommand,
  backfillCommand,
  explainCommand,
  exportCommand,
  workerCommand,
  devCommand,
  typesCommand,
  usersCommand,
];

export { backfillCommand } from "./backfill.ts";
export { devCommand } from "./dev.ts";
export { doctorCommand } from "./doctor.ts";
export { explainCommand } from "./explain.ts";
export { exportCommand } from "./export.ts";
export { initCommand } from "./init.ts";
export { migrateCommand } from "./migrate.ts";
export { previewCommand } from "./preview.ts";
export { testCommand } from "./test.ts";
export { typesCommand } from "./types.ts";
export { uninstallCommand } from "./uninstall.ts";
export { usersCommand } from "./users.ts";
export { workerCommand } from "./worker.ts";
