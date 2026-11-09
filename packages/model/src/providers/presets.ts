import type { Clock } from "@facetdb/core";
import { type CompatibleProvider, createCompatibleProvider } from "./compatible.ts";

/**
 * What a preset knows about a known provider: its base URL and the header that carries the key.
 * Never a key, never a default key. A preset whose base URL depends on the user's account (or
 * that this build does not know) has no `baseUrl`; the user passes `modelUrl` instead.
 */
export type ProviderPreset = {
  readonly baseUrl?: string;
  readonly keyHeader?: string;
};

export const PROVIDER_PRESETS = {
  openrouter: { baseUrl: "https://openrouter.ai/api", keyHeader: "authorization" },
  "vercel-ai-gateway": { baseUrl: "https://ai-gateway.vercel.sh", keyHeader: "authorization" },
  // The gateway URL carries the account and gateway ids, so the user supplies the full base URL.
  "cloudflare-ai-gateway": { keyHeader: "cf-aig-authorization" },
  ollama: { baseUrl: "http://localhost:11434" },
  // The hosts of these two are not in this build's references; the user supplies `modelUrl`.
  "strands-decider": { keyHeader: "authorization" },
  "solar-decide": { keyHeader: "authorization" },
} as const satisfies Record<string, ProviderPreset>;

export type PresetName = keyof typeof PROVIDER_PRESETS;

export type PresetOptions = {
  /** Overrides the preset's base URL; required for presets that have none. */
  readonly modelUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
};

/** A compatible provider with a preset's base URL and key header. */
export function createPresetProvider(name: PresetName, options: PresetOptions): CompatibleProvider {
  const preset: ProviderPreset = PROVIDER_PRESETS[name];
  const baseUrl = options.modelUrl ?? preset.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(
      `the ${name} preset has no base URL in this build: set modelUrl to its base URL`,
    );
  }
  return createCompatibleProvider({
    baseUrl,
    apiKey: options.apiKey,
    keyHeader: preset.keyHeader,
    fetch: options.fetch,
    clock: options.clock,
  });
}
