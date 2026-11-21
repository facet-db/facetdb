/**
 * @facetdb/server: the HTTP surface of a FacetDB installation: the check API for API sources,
 * signed webhooks and the review endpoints. Routes parse,
 * authenticate, call one service and map the result; they never touch the database.
 */
export { API_VERSION, type StudioAccess } from "./app.ts";
export type { ApiKeys } from "./auth/api-keys.ts";
export { createApiKeys } from "./auth/api-keys.ts";
export { isLoopbackAddress, isLoopbackHost } from "./auth/loopback.ts";
export type { Peer } from "./auth/middleware.ts";
export { OpenSurfaceError, requireAccountToServe } from "./auth/open-surface.ts";
export type { AddOutcome, Reviewers } from "./auth/reviewers.ts";
export { createReviewers } from "./auth/reviewers.ts";
export type { ReviewerLookup, Sessions, SignIn } from "./auth/sessions.ts";
export {
  createSessions,
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  OS_REVIEWER_PREFIX,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./auth/sessions.ts";
export type {
  ApiSource,
  CheckedAnswer,
  CheckRequest,
  CheckResult,
  CheckService,
  CheckStore,
  CheckWorkers,
} from "./check/service.ts";
export { createCheckService } from "./check/service.ts";
export type { DeclaredApiSource } from "./check/store.ts";
export { createCheckStore } from "./check/store.ts";
export { onlyRecord } from "./check/target.ts";
export { PREVIEW_MAX_LIMIT } from "./config/routes.ts";
export type {
  ConfigFileDoor,
  ConfigService,
  DraftCheck,
  DraftIssue,
  DraftWarning,
  FileApply,
  FileDiff,
  PendingSource,
  PreviewSource,
  ProjectConfigDoor,
  ReloadSummary,
  SourceDraft,
  SourceReload,
  Words,
} from "./config/service.ts";
export { createConfigService } from "./config/service.ts";
export type {
  HistoryDoor,
  SourceHistory,
  StoredVersion,
  VersionHistory,
} from "./config/versions.ts";
export { VERSION_HISTORY_SHOWN } from "./config/versions.ts";
export type {
  Capture,
  DashboardDatabase,
  DashboardDoor,
  DecisionRow,
  DecisionsPage,
  DecisionsService,
  DecisionsServiceDeps,
  DecisionsStore,
  Home,
  SourceFacts,
  SourceRow,
  TableFacts,
  WorkerLogin,
} from "./data/index.ts";
export {
  createDecisionsService,
  DECISIONS_DEFAULT_LIMIT,
  DECISIONS_MAX_LIMIT,
  DOCTOR_FRESH_MS,
} from "./data/index.ts";
export type { DataServices } from "./data/routes.ts";
export type { RunsPage, RunsService, RunView } from "./data/runs.ts";
export { createRunsService, RUNS_PER_PAGE } from "./data/runs.ts";
export type { ErrorBody } from "./errors.ts";
export { ApiError } from "./errors.ts";
export type { ServerDeps } from "./main.ts";
export { createServer } from "./main.ts";
export { QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT } from "./review/routes.ts";
export type {
  CardView,
  QueuedCardView,
  QueueView,
  ReviewEndpointDeps,
  ReviewEndpointService,
} from "./review/service.ts";
export { createReviewEndpointService } from "./review/service.ts";
export type {
  BackfillEstimateOutcome,
  BackfillJobCounts,
  BackfillJobState,
  BackfillJobStatus,
  BackfillJobsDoor,
  BackfillStartOutcome,
  BackfillStatusOutcome,
  BackfillStopOutcome,
} from "./sources/backfill-door.ts";
export { NO_BACKFILL_JOBS } from "./sources/backfill-door.ts";
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
} from "./sources/door.ts";
export {
  INSTALL_NOTHING_RAN,
  INSTALL_OUTCOME_UNKNOWN,
  INSTALL_STOPPED,
} from "./sources/install-codes.ts";
export type { SecretPart } from "./sources/redact.ts";
export { HIDDEN, hideSecrets, secretParts } from "./sources/redact.ts";
export type { SetupAccess, SetupService } from "./sources/service.ts";
export { createSetupService, PLAN_TOKEN_TTL_MS, SETUP_PREVIEW_ROWS } from "./sources/service.ts";
export type { StudioBuild, StudioFiles } from "./studio/build.ts";
export { openStudioBuild, STUDIO_INDEX_FILE, STUDIO_ROUTES_FILE } from "./studio/build.ts";
export type { WebhookConfig, WebhookPayload } from "./webhooks/action.ts";
export { createWebhookAction } from "./webhooks/action.ts";
export type {
  AlertFailure,
  DeliveryReport,
  NewWebhook,
  Outbox,
  OutboxDatabase,
  OutboxDeps,
  WebhookFetch,
  WebhookGaveUp,
} from "./webhooks/outbox.ts";
export {
  createOutbox,
  DEFAULT_FETCH_TIMEOUT_MS,
  GIVE_UP_AFTER_MS,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryDelayMs,
} from "./webhooks/outbox.ts";
export type { Verification } from "./webhooks/sign.ts";
export { SIGNATURE_TOLERANCE_MS, sign, verify, WEBHOOK_SIGNATURE_HEADER } from "./webhooks/sign.ts";
