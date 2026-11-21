import { isPresetName, PRESET_NAMES, PROVIDER_PRESETS, type ProviderPreset } from "@facetdb/model";

/**
 * The config's `provider`: a built-in preset's name (`openrouter`), or `<plugin>/<entry>` for a
 * provider an installed plugin supplies (`acme/solar`, `@facetdb/acme/solar`).
 */

/** The plugin a `provider` names and the entry of its `providers` that answers. */
export type PluginProviderRef = {
  readonly plugin: string;
  readonly entry: string;
};

// A plugin key as `plugins` reads one (short name or package name), a slash, an entry name as
// `definePlugin` reads one. A preset's name holds no slash, and neither does an entry's.
const PLUGIN_PROVIDER =
  /^((?:@facetdb\/|facetdb-plugin-)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:[_-][a-z0-9]+)*)$/;

/** The plugin and entry a `provider` names, or undefined for a preset or anything else. */
export function pluginProviderOf(provider: string): PluginProviderRef | undefined {
  const match = PLUGIN_PROVIDER.exec(provider);
  const plugin = match?.[1];
  const entry = match?.[2];
  return plugin === undefined || entry === undefined ? undefined : { plugin, entry };
}

/** Why a `provider` is neither a preset nor a plugin's, in plain words; undefined when it is one. */
export function providerIssue(provider: string): string | undefined {
  if (isPresetName(provider) || pluginProviderOf(provider) !== undefined) {
    return undefined;
  }
  return `provider must be one of ${PRESET_NAMES.join(", ")}, or "<plugin>/<entry>" for a provider an installed plugin supplies, such as "acme/solar"`;
}

/**
 * What is wrong with the `provider` and `modelUrl` of a project, each at its own path. A preset
 * with no address of its own needs `modelUrl`; a plugin's provider has no use for one, since its
 * address is its own setting.
 */
export function providerIssues(
  provider: string,
  modelUrl: string | undefined,
): readonly { readonly path: "provider" | "modelUrl"; readonly message: string }[] {
  const wrong = providerIssue(provider);
  if (wrong !== undefined) {
    return [{ path: "provider", message: wrong }];
  }
  if (isPresetName(provider)) {
    const preset: ProviderPreset = PROVIDER_PRESETS[provider];
    return preset.baseUrl === undefined && modelUrl === undefined
      ? [
          {
            path: "modelUrl",
            message: `the ${provider} provider has no address of its own in this build: set modelUrl to its base URL`,
          },
        ]
      : [];
  }
  return modelUrl === undefined
    ? []
    : [
        {
          path: "modelUrl",
          message: `modelUrl has no use with the plugin's provider "${provider}": the plugin names its own address in its settings (plugins)`,
        },
      ];
}
