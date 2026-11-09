import { MODEL_VERSION_PATTERN } from "@facetdb/core";

/** The one endpoint every compatible provider serves. */
export const SYSTEMONE_PATH = "/v1/systemone";

/** The model list, offered by a compatible server in the OpenAI-style `{ data: [{ id }] }` shape. */
export const MODELS_PATH = "/v1/models";

/**
 * A pinned model version looks like `jev-1.14.0`; aliases such as `jev-latest` are refused. This is
 * core's version rule (`MODEL_VERSION_PATTERN`), so config and providers agree on one definition.
 */
export const PINNED_MODEL_RE = MODEL_VERSION_PATTERN;
