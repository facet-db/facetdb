import {
  isPresetName,
  keyWithheld,
  PRESET_KEYS,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "@facetdb/model";
import { type ProjectConfig, pluginProviderOf } from "../../config/index.ts";
import type { PluginHost } from "../../plugin/index.ts";
import type { CliDeps } from "../program.ts";
import { loadPluginHost } from "./database.ts";

/**
 * The model a config names: the provider's own variable for a built-in preset, the plugin's for a
 * plugin's provider, `TYPESAFE_API_KEY` for neither. The commands that ask the model hand
 * `deps.provider` the plugin host a plugin's provider needs.
 */

/** The plugin host a plugin's provider needs, built as the config's other plugins are; none for any other provider. */
export async function pluginHostForProvider(
  deps: CliDeps,
  config: ProjectConfig,
  path: string,
): Promise<PluginHost | undefined> {
  if (config.provider === undefined || pluginProviderOf(config.provider) === undefined) {
    return undefined;
  }
  return loadPluginHost(deps, config, path);
}

/** What a config's built-in preset reads and where it asks, for the words of the worker and doctor. */
export type PresetChoice = {
  readonly provider: string;
  /** The variable its key is read from. */
  readonly variable: string;
  /** False for a server that may need no key. */
  readonly required: boolean;
  /** Whether the FacetDB team has run the preset against its vendor. */
  readonly proven: boolean;
  /** `modelUrl` when the config replaces the address, else the preset's own. */
  readonly address: string | undefined;
  /** True when the optional key is set aside because the address is plain http to another host. */
  readonly withheld: boolean;
};

/** The built-in preset the config names; undefined for no provider or a plugin's (whose variables its settings name). */
export function presetKeyOf(config: ProjectConfig): PresetChoice | undefined {
  const { provider } = config;
  if (provider === undefined || !isPresetName(provider)) {
    return undefined;
  }
  const preset: ProviderPreset = PROVIDER_PRESETS[provider];
  return {
    provider,
    ...PRESET_KEYS[provider],
    address: config.modelUrl ?? preset.baseUrl,
    withheld: keyWithheld(provider, config.modelUrl),
  };
}
