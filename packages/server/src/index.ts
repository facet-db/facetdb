/**
 * @facetdb/server: the HTTP surface of a FacetDB installation: the check API for API sources,
 * signed webhooks and the review endpoints. Routes parse,
 * authenticate, call one service and map the result; they never touch the database.
 */
export const WEBHOOK_SIGNATURE_HEADER = "facetdb-signature";

export { API_VERSION } from "./app.ts";
export type { ApiKeys } from "./auth/api-keys.ts";
export { createApiKeys } from "./auth/api-keys.ts";
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
export type { ErrorBody } from "./errors.ts";
export { ApiError } from "./errors.ts";
export type { ServerDeps } from "./main.ts";
export { createServer } from "./main.ts";
