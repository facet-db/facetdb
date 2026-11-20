// The setup flow's door: the CLI's door it calls, the service and its routes, how an install's
// failure says whether anything ran, and how the admin string is hidden.
export type {
  InspectOutcome,
  SetupDoor,
  SetupInstallOutcome,
  SetupPlan,
  SetupPlanOutcome,
  SetupPreviewOutcome,
  SetupRefused,
  ShownPlan,
  StopReason,
} from "./door.ts";
export { INSTALL_NOTHING_RAN, INSTALL_OUTCOME_UNKNOWN, INSTALL_STOPPED } from "./install-codes.ts";
export type { SecretPart } from "./redact.ts";
export { HIDDEN, hideSecrets, secretParts } from "./redact.ts";
export { setupRoutes } from "./routes.ts";
export type { SetupAccess, SetupService } from "./service.ts";
export {
  createSetupService,
  NO_SETUP,
  PLAN_TOKEN_TTL_MS,
  SETUP_PREVIEW_ROWS,
} from "./service.ts";
