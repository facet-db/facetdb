/**
 * @facetdb/server: the HTTP surface of a FacetDB installation: the check API for API sources,
 * signed webhooks and the review endpoints. Routes parse,
 * authenticate, call one service and map the result; they never touch the database.
 */
export { API_VERSION } from "./api-version.ts";
export { REQUEST_ID_HEADER, type StudioAccess } from "./app.ts";
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
  ApplyOptions,
  ConfigDraft,
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
  ProjectDraft,
  ReloadSummary,
  SourceDraft,
  SourceReload,
  UncommittedWords,
  Words,
} from "./config/service.ts";
export { createConfigService } from "./config/service.ts";
export type {
  HistoryDoor,
  SourceHistory,
  StoredVersion,
  VersionHistory,
} from "./config/versions.ts";
export { VERSION_HISTORY_SHOWN, versionChanges } from "./config/versions.ts";
export type {
  AlertTestDoor,
  AlertTestOutcome,
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
  SourceVerdict,
  TableFacts,
  WorkerLogin,
} from "./data/index.ts";
export {
  createDecisionsService,
  DECISIONS_DEFAULT_LIMIT,
  DECISIONS_MAX_LIMIT,
  DOCTOR_FRESH_MS,
  doctorVerdict,
  losesAccess,
} from "./data/index.ts";
export type { DataServices } from "./data/routes.ts";
export type { RunsPage, RunsService, RunView } from "./data/runs.ts";
export { createRunsService, RUNS_PER_PAGE } from "./data/runs.ts";
export type { ErrorBody } from "./errors.ts";
export { ApiError } from "./errors.ts";
export type {
  HookAdmission,
  HookDelivery,
  HookLimiter,
  HookOutcome,
  HookRequest,
  HooksDoor,
} from "./hooks/index.ts";
export {
  createHookLimiter,
  HOOK_ADDRESS_BURST,
  HOOK_ADDRESS_PER_SECOND,
  HOOK_BODIES_AT_ONCE,
  HOOK_BODY_DEADLINE_MS,
  HOOK_BODY_MAX_BYTES,
  HOOK_BUSY_RETRY_AFTER_SECONDS,
  HOOK_READING_PER_ADDRESS,
  HOOK_RETRY_AFTER_SECONDS,
  HOOK_SOURCE_BURST,
  HOOK_SOURCE_PER_SECOND,
  HOOK_TIMEOUT_MS,
  HOOK_TRACKED_ADDRESSES,
  HOOK_TRACKED_SOURCES,
  HOOKS_PATH,
  hookBodyTooLarge,
  hookBodyTooSlow,
  isHookUrl,
  NO_HOOKS,
} from "./hooks/index.ts";
export type { ServerDeps } from "./main.ts";
export { createServer } from "./main.ts";
export type {
  Gallery,
  GalleryEntry,
  InstalledPlugin,
  JsonObject,
  PackView,
  PluginsDoor,
  PluginVariableView,
} from "./plugins/index.ts";
export { NO_PLUGINS } from "./plugins/index.ts";
export { BODY_MAX_BYTES, requestTooLarge } from "./request.ts";
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
  MigrateDoor,
  MigratePlan,
  MigratePlanOutcome,
  MigrateRunOutcome,
  SetupDoor,
  SetupInstallOutcome,
  SetupPlan,
  SetupPlanOutcome,
  SetupPreviewOutcome,
  SetupRefused,
  ShownMigration,
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
export type { CredentialLink } from "./webhooks/credential-refused.ts";
export {
  CREDENTIAL_REFUSED_DID,
  CREDENTIAL_WORDS_WITHHELD,
  credentialRefusedAlert,
  credentialRefusedKey,
  credentialSubject,
} from "./webhooks/credential-refused.ts";
export type { GaveUpLink } from "./webhooks/gave-up.ts";
export {
  GAVE_UP_DID,
  GAVE_UP_REFUSED_DID,
  gaveUpAlert,
  gaveUpHow,
  gaveUpSubject,
} from "./webhooks/gave-up.ts";
export type {
  ActionClose,
  ActionCredentialRefused,
  ActionDefer,
  ActionDelivered,
  ActionDelivery,
  ActionFailedHints,
  ActionGaveUp,
  AlertFailure,
  CredentialAlertFailure,
  DeliveryReport,
  DigestDelivery,
  DigestRow,
  DigestWindow,
  EndpointGaveUp,
  NewAction,
  NewWebhook,
  Outbox,
  OutboxDatabase,
  OutboxDeps,
  TimeSpan,
  WebhookFetch,
  WebhookGaveUp,
  WebhookOrigin,
} from "./webhooks/outbox.ts";
export {
  ACTION_DEFER_MS,
  ACTION_ERROR_NOT_KEPT,
  ActionFailed,
  createOutbox,
  DEFAULT_FETCH_TIMEOUT_MS,
  DELIVERY_PASS_FAILED,
  DeliveryPassFailed,
  DIGEST_AFTER,
  DIGEST_MINUTE_MS,
  GIVE_UP_AFTER_MS,
  HELD_FOR_DIGEST,
  HELD_FOR_QUIET,
  outboxQueue,
  queueAction,
  queueWebhook,
  REFUSED_FOR_GOOD,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryAfterDelayMs,
  retryDelayMs,
} from "./webhooks/outbox.ts";
export type { Verification } from "./webhooks/sign.ts";
export { SIGNATURE_TOLERANCE_MS, sign, verify, WEBHOOK_SIGNATURE_HEADER } from "./webhooks/sign.ts";
