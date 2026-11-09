/**
 * @facetdb/model: model providers. Every provider speaks the TypeSafe System One shape; the HTTP
 * client, its backoff and the scripted fake come later.
 */

/** The one endpoint every compatible provider serves. */
export const SYSTEMONE_PATH = "/v1/systemone";

/** A pinned model version looks like `jev-1.14.0`; aliases such as `jev-latest` are refused in config. */
export const PINNED_MODEL_RE = /^[a-z][a-z0-9]*-\d+\.\d+\.\d+$/;
