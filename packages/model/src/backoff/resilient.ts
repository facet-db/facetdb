import type { ModelProvider, ProviderRequest, ProviderResponse } from "@facetdb/core";
import type { InFlightLimiter } from "./limiter.ts";
import type { Backoff } from "./policy.ts";

export type ResilientOptions = {
  readonly backoff: Backoff;
  readonly limiter: InFlightLimiter;
};

/**
 * Wraps a provider (the HTTP client, or the scripted fake) so that 429 and 529 are retried with
 * backoff, every attempt takes a slot of the in-flight limiter, and a 429 halves that limit. A wait
 * between attempts holds no slot. What still fails after the attempts is thrown as it came: it is
 * the outage policy's to judge, never an answer.
 */
export function createResilientProvider(
  provider: ModelProvider,
  { backoff, limiter }: ResilientOptions,
): ModelProvider {
  return {
    ask(request: ProviderRequest): Promise<ProviderResponse> {
      return backoff.run(
        () => limiter.run(() => provider.ask(request)),
        (error) => {
          if (error.status === 429) {
            limiter.rateLimited();
          }
        },
      );
    },
  };
}
