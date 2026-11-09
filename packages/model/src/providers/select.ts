import type { Clock, ModelProvider } from "@facetdb/core";
import { createTypeSafeProvider } from "../typesafe/client.ts";
import { createCompatibleProvider } from "./compatible.ts";

export type SelectProviderOptions = {
  /** `modelUrl` from the config: a compatible server's base URL. Absent means TypeSafe direct. */
  readonly modelUrl?: string | undefined;
  /** `TYPESAFE_API_KEY` for TypeSafe direct; optional for a compatible server that needs none. */
  readonly apiKey?: string | undefined;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
};

/**
 * The selection rule for the composition roots: `modelUrl` picks a compatible provider at that
 * base URL, otherwise the request goes to TypeSafe direct with its key. One provider serves one
 * question set; the response's `model` is what the log records.
 */
export function selectProvider(options: SelectProviderOptions): ModelProvider {
  if (options.modelUrl !== undefined) {
    return createCompatibleProvider({
      baseUrl: options.modelUrl,
      apiKey: options.apiKey,
      fetch: options.fetch,
      clock: options.clock,
    });
  }
  if (options.apiKey === undefined) {
    throw new Error(
      "no model is configured: set TYPESAFE_API_KEY for TypeSafe, or modelUrl for a compatible server",
    );
  }
  return createTypeSafeProvider({
    apiKey: options.apiKey,
    fetch: options.fetch,
    clock: options.clock,
  });
}
