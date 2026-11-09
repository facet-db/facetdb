import type { ZodType } from "zod";

/** The five extension points a plugin can provide. */
export const PLUGIN_KINDS = ["source", "action", "channel", "provider", "pack"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * A plugin's manifest. `config` is the one schema that validates the config file and draws the
 * dashboard's settings form. `coreVersions` is the semver range of FacetDB core the plugin
 * supports; `facetdb add` refuses a mismatch.
 */
export type PluginManifest = {
  /** `facetdb-plugin-<name>` for community plugins, `@facetdb/<name>` for first-party ones. */
  readonly name: string;
  readonly version: string;
  readonly kinds: readonly PluginKind[];
  /** Names of the secrets the plugin needs; the values never appear in a manifest or a log. */
  readonly secrets: readonly string[];
  readonly config: ZodType;
  readonly coreVersions: string;
};
