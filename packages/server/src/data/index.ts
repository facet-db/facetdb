/**
 * The data module: the read endpoints behind the studio's pages (the Decisions page, the why page,
 * the runs and the home). Each endpoint group lives in its own file and is mounted from here, so
 * adding one does not touch another's.
 */
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
