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
  "vercel-ai-gateway": { baseUrl: "https://ai-gateway.vercel.sh", keyHeader: "authorization" },
  // The gateway URL carries the account and gateway ids, so the user supplies the full base URL.
  "cloudflare-ai-gateway": { keyHeader: "cf-aig-authorization" },
  ollama: { baseUrl: "http://localhost:11434" },
  // The hosts of these two are not in this build's references; the user supplies `modelUrl`.
  "strands-decider": { keyHeader: "authorization" },
  "solar-decide": { keyHeader: "authorization" },
} as const satisfies Record<string, ProviderPreset>;

export type PresetName = keyof typeof PROVIDER_PRESETS;

/**
 * Where a preset's key is read from and whether the FacetDB team has run the preset against its
 * vendor. Kept beside `PROVIDER_PRESETS`, which holds only an address and a header, so that table
 * stays free of anything that reads like a secret.
 */
export type PresetKey = {
  /** The environment variable the key is read from: the vendor's documented name where one exists. */
  readonly variable: string;
  /** False for a server that may need no key (a local Ollama, a self-hosted Decider). */
  readonly required: boolean;
  /**
   * True once a real request has gone through the preset: `strands-decider` only, run against the
   * publisher's server on 127.0.0.1; the others stay unproven until someone runs one
   * (`presets.live.test.ts` holds the Ollama case).
   */
  readonly proven: boolean;
};

/**
 * One key variable per preset, never `TYPESAFE_API_KEY`: a preset's address never sees the
 * TypeSafe key.
 *
 * Names as the vendors document them: Vercel's AI Gateway reads `AI_GATEWAY_API_KEY`; Cloudflare's
 * gateway authentication examples name the gateway token `CF_AIG_TOKEN` (sent as a bearer in
 * `cf-aig-authorization`), which is deliberately not `CLOUDFLARE_API_TOKEN`: that one is the broad
 * account token wrangler and terraform read, and a machine with it set for deploys would send it to
 * whatever `modelUrl` says (recalled, not checked against a live gateway); Ollama's cloud reads
 * `OLLAMA_API_KEY` and a local server needs none; Upstage's Solar API reads `UPSTAGE_API_KEY` (no
 * page of its own for Solar Decide was found). Strands Decider is an open-weight model with no
 * vendor service, so its name is this build's own.
 *
 * An optional key (`required: false`) is sent only to an https address or to this machine: over
 * plain http to another host it would cross the network in the clear, so it is withheld
 * (`mayCarryKey`).
 */
export const PRESET_KEYS = {
  "vercel-ai-gateway": { variable: "AI_GATEWAY_API_KEY", required: true, proven: false },
  "cloudflare-ai-gateway": { variable: "CF_AIG_TOKEN", required: true, proven: false },
  ollama: { variable: "OLLAMA_API_KEY", required: false, proven: false },
  "strands-decider": { variable: "STRANDS_DECIDER_API_KEY", required: false, proven: true },
  "solar-decide": { variable: "UPSTAGE_API_KEY", required: true, proven: false },
} as const satisfies Record<PresetName, PresetKey>;

/** Every preset's name, in the order the docs list them. */
export const PRESET_NAMES: readonly PresetName[] = Object.keys(PROVIDER_PRESETS) as PresetName[];

/** Whether a config's `provider` names one of the built-in presets. */
export function isPresetName(name: string): name is PresetName {
  return Object.hasOwn(PROVIDER_PRESETS, name);
}

/**
 * Whether a key may be sent to this address: an https one, or plain http to this machine
 * (`localhost`, `127.x.x.x`, `::1`). An address that does not parse carries none.
 */
export function mayCarryKey(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  const host = url.hostname;
  return (
    url.protocol === "http:" &&
    (host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host))
  );
}

/**
 * Whether a preset's optional key is set aside for its address: the preset's key is optional and
 * the address (the config's `modelUrl`, else the preset's own) is plain http to another host.
 */
export function keyWithheld(name: PresetName, modelUrl: string | undefined): boolean {
  if (PRESET_KEYS[name].required) {
    return false;
  }
  const preset: ProviderPreset = PROVIDER_PRESETS[name];
  const address = modelUrl ?? preset.baseUrl;
  return address !== undefined && !mayCarryKey(address);
}

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
