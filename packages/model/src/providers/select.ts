import type { Clock, ModelProvider } from "@facetdb/core";
import { createTypeSafeProvider } from "../typesafe/client.ts";
import { createCompatibleProvider } from "./compatible.ts";
import { assertPinned } from "./models.ts";
import {
  createPresetProvider,
  isPresetName,
  keyWithheld,
  PRESET_KEYS,
  PRESET_NAMES,
} from "./presets.ts";

/** A preset that needs a key was chosen and its variable is not set. */
export class ProviderKeyMissingError extends Error {
  readonly provider: string;
  readonly variable: string;

  constructor(provider: string, variable: string) {
    super(`${variable} is not set, so the ${provider} provider has no key`);
    this.name = "ProviderKeyMissingError";
    this.provider = provider;
    this.variable = variable;
  }
}

/** The config's `provider` is not a built-in preset (a plugin's provider is resolved elsewhere). */
export class UnknownProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `"${provider}" is not a built-in provider: the presets are ${PRESET_NAMES.join(", ")}; a provider an installed plugin supplies is named "<plugin>/<entry>"`,
    );
    this.name = "UnknownProviderError";
    this.provider = provider;
  }
}

export type SelectProviderOptions = {
  /** `provider` from the config: a built-in preset's name. Absent means `modelUrl`, else TypeSafe. */
  readonly provider?: string | undefined;
  /** `modelUrl` from the config: a compatible server's base URL; beside a preset, it replaces the preset's address. */
  readonly modelUrl?: string | undefined;
  /**
   * `TYPESAFE_API_KEY`, for the TypeSafe request this config makes with no `provider`: TypeSafe
   * direct, or a server at `modelUrl`. A preset never receives it.
   */
  readonly apiKey?: string | undefined;
  /** The environment's variables: a preset reads the one variable it names, and no other. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
};

/**
 * The selection rule for the composition roots. With a `provider`, the preset's address (or
 * `modelUrl`, which replaces it) and the key of the variable the preset names: the TypeSafe key is
 * never sent. With none, as before: `modelUrl` picks a compatible provider at that base URL
 * (carrying `TYPESAFE_API_KEY` when it is set), otherwise the request goes to TypeSafe direct with
 * its key. One provider serves one question set; the response's `model` is what the log records.
 */
export function selectProvider(options: SelectProviderOptions): ModelProvider {
  if (options.provider !== undefined) {
    return selectPreset(options.provider, options);
  }
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
  const direct = createTypeSafeProvider({
    apiKey: options.apiKey,
    fetch: options.fetch,
    clock: options.clock,
  });
  // The pinned-name rule is every provider's, TypeSafe direct included.
  return {
    async ask(request) {
      assertPinned(request.model);
      return direct.ask(request);
    },
  };
}

function selectPreset(name: string, options: SelectProviderOptions): ModelProvider {
  if (!isPresetName(name)) {
    throw new UnknownProviderError(name);
  }
  const { variable, required } = PRESET_KEYS[name];
  const value = options.env?.[variable];
  const key = value === undefined || value === "" ? undefined : value;
  if (key === undefined && required) {
    throw new ProviderKeyMissingError(name, variable);
  }
  return createPresetProvider(name, {
    modelUrl: options.modelUrl,
    // An optional key never crosses the network in the clear: withheld from plain http elsewhere.
    apiKey: keyWithheld(name, options.modelUrl) ? undefined : key,
    fetch: options.fetch,
    clock: options.clock,
  });
}
