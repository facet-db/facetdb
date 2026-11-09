import type { Clock, ModelProvider, ProviderRequest, ProviderResponse } from "@facetdb/core";
import { SYSTEMONE_PATH } from "../paths.ts";
import { createSystemOneProvider } from "../typesafe/client.ts";
import { assertPinned } from "./models.ts";

/** A System One provider at a base URL, plus what `listModels` needs to ask the same server. */
export type CompatibleProvider = ModelProvider & {
  /** The base URL without a trailing slash; `/v1/systemone` and `/v1/models` hang off it. */
  readonly baseUrl: string;
  /** The headers every call carries, the key's header included. */
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
};

export type CompatibleProviderOptions = {
  readonly baseUrl: string;
  /** Sent as `Bearer <key>` in `keyHeader`; a local server needs none and gets no header. */
  readonly apiKey?: string | undefined;
  /** The header that carries the key; `authorization` unless a gateway names another. */
  readonly keyHeader?: string | undefined;
  /** Extra gateway headers, such as routing or metadata headers. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
  /** Measures an HTTP-date `retry-after` against now. */
  readonly clock: Clock;
};

/**
 * The System One client behind a base URL (`modelUrl`): the same request and response shape as
 * TypeSafe direct, with another host and optional gateway headers (`facetdb-model`). It refuses a
 * model name that is not an exact version before any call is made.
 */
export function createCompatibleProvider(options: CompatibleProviderOptions): CompatibleProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey !== undefined) {
    headers[options.keyHeader ?? "authorization"] = `Bearer ${options.apiKey}`;
  }
  const system = createSystemOneProvider({
    url: `${baseUrl}${SYSTEMONE_PATH}`,
    headers,
    fetch: options.fetch,
    clock: options.clock,
  });
  return {
    baseUrl,
    headers,
    fetch: options.fetch,
    async ask(request: ProviderRequest): Promise<ProviderResponse> {
      assertPinned(request.model);
      return system.ask(request);
    },
  };
}
