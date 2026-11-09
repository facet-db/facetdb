/**
 * @facetdb/model: model providers. Every provider speaks the TypeSafe System One shape; the HTTP
 * client, its backoff, the scripted fake and the compatible base-URL providers live here.
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
export { MODELS_PATH, PINNED_MODEL_RE, SYSTEMONE_PATH } from "./paths.ts";
export type { CompatibleProvider, CompatibleProviderOptions } from "./providers/compatible.ts";
export { createCompatibleProvider } from "./providers/compatible.ts";
export type { ModelList } from "./providers/models.ts";
export { assertPinned, listModels, ModelNotPinnedError } from "./providers/models.ts";
export type { PresetName, PresetOptions, ProviderPreset } from "./providers/presets.ts";
export { createPresetProvider, PROVIDER_PRESETS } from "./providers/presets.ts";
export type { SelectProviderOptions } from "./providers/select.ts";
export { selectProvider } from "./providers/select.ts";
export type { SystemOneOptions, TypeSafeProviderOptions } from "./typesafe/client.ts";
export {
  createSystemOneProvider,
  createTypeSafeProvider,
  TYPESAFE_BASE_URL,
} from "./typesafe/client.ts";
