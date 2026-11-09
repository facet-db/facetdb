/**
 * @facetdb/model: model providers. Every provider speaks the TypeSafe System One shape; the HTTP
 * client and the scripted fake are here, backoff and base-URL providers are not in yet.
 */

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
