/**
 * @facetdb/model: model providers. Every provider speaks the TypeSafe System One shape; the HTTP
 * client, its backoff and the scripted fake are here, base-URL providers are not in yet.
 */

export type { InFlightLimiter, LimiterOptions } from "./backoff/limiter.ts";
export {
  createInFlightLimiter,
  DEFAULT_IN_FLIGHT,
  MIN_IN_FLIGHT,
  RECOVER_AFTER_MS,
} from "./backoff/limiter.ts";
export type {
  OnOutage,
  OutageEvent,
  OutageOptions,
  OutagePolicyHandle,
} from "./backoff/outage.ts";
export {
  createOutagePolicy,
  DEFAULT_RETRY_EVERY_MS,
  DEFAULT_RETRY_WINDOW_MS,
  OUTAGE_WINDOW_MS,
} from "./backoff/outage.ts";
export type { Backoff, BackoffOptions } from "./backoff/policy.ts";
export {
  createBackoff,
  DEFAULT_BASE_MS,
  DEFAULT_FACTOR,
  DEFAULT_JITTER,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_MS,
} from "./backoff/policy.ts";
export type { ResilientOptions } from "./backoff/resilient.ts";
export { createResilientProvider } from "./backoff/resilient.ts";
export {
  ModelUnreachableError,
  RequestRejectedError,
  RetryableError,
  UnexpectedStatusError,
} from "./errors.ts";
export type { FakeFailure, FakeProvider, FakeScript } from "./fake/fake-provider.ts";
export { createFakeProvider } from "./fake/fake-provider.ts";
export { PINNED_MODEL_RE, SYSTEMONE_PATH } from "./paths.ts";
export type { TypeSafeProviderOptions } from "./typesafe/client.ts";
export { createTypeSafeProvider, TYPESAFE_BASE_URL } from "./typesafe/client.ts";
