/**
 * The data module: the read endpoints behind the studio's pages (the runs, the Decisions page, the
 * why page, Home and Sources). Each endpoint group lives in its own file and is mounted by
 * `dataRoutes` (routes.ts) under `/v1` behind the API key until reviewer sessions, so adding one
 * does not touch another's.
 */
export type { AccessDeps, AccessService, StudioAccessView } from "./access.ts";
export { createAccessService } from "./access.ts";
export type {
  AlertChannelView,
  AlertEventView,
  AlertStanding,
  AlertsDeps,
  AlertsOutcome,
  AlertsService,
  AlertsView,
  ChannelDeliveryView,
  ChannelQuietHours,
  ChannelSends,
  ConfiguredChannel,
  HeldChannelView,
  RunningChannel,
} from "./alerts.ts";
export { ALERT_HISTORY_LINES, channelOf, createAlertsService, eventsOf } from "./alerts.ts";
export type { AlertTestDoor, AlertTestOutcome } from "./alerts-test.ts";
export { NO_ALERT_TEST } from "./alerts-test.ts";
export { decisionsRoutes } from "./decisions.ts";
export type {
  DecisionRow,
  DecisionsOutcome,
  DecisionsPage,
  DecisionsQuery,
  DecisionsService,
  DecisionsServiceDeps,
  DecisionsStore,
  WhyOutcome,
} from "./decisions-service.ts";
export {
  createDecisionsService,
  DECISIONS_DEFAULT_LIMIT,
  DECISIONS_MAX_LIMIT,
} from "./decisions-service.ts";
export {
  createDoctors,
  DOCTOR_FRESH_MS,
  type Doctors,
  doctorVerdict,
  losesAccess,
  type SourceVerdict,
  type Verdict,
} from "./doctor.ts";
export type { Capture, DashboardDoor, SourceFacts, TableFacts, WorkerLogin } from "./door.ts";
export {
  createHomeService,
  type Home,
  type HomeService,
  homeRoutes,
  RECENT_ALERTS,
  SPENDING_WARNING_PERCENT,
} from "./home.ts";
export { createDashboardReads, type DashboardDatabase, type DashboardReads } from "./reads.ts";
export {
  createSourcesService,
  type SourceRow,
  type SourcesService,
  sourcesRoutes,
} from "./sources.ts";
