/**
 * `facetdb/plugin`: the authoring API of a plugin.
 *
 * ```ts
 * import { definePlugin, source, action, z } from "facetdb/plugin";
 * ```
 *
 * `definePlugin` checks the manifest (name, version, the `facetdb` core range, the config schema,
 * every entry) and throws a `PluginError` naming each wrong field. To type `ctx.config` inside
 * `source`, `action`, ... annotate the first parameter: `(ctx: PluginContext<Infer<typeof config>>)`.
 */
export type { Plugin, PluginDefinition, PluginIssue } from "./define.ts";
export { definePlugin, isPlugin, PluginError } from "./define.ts";
export type {
  ActionDefinition,
  ActionSpec,
  ChannelDefinition,
  ChannelSpec,
  PackDefinition,
  PackSpec,
  PluginContext,
  ProviderDefinition,
  ProviderSpec,
  SourceDefinition,
  SourcePage,
  SourceRow,
  SourceSpec,
} from "./kinds.ts";
export { action, channel, pack, provider, source } from "./kinds.ts";
export type { LoadPluginOptions } from "./load.ts";
export { loadPlugin } from "./load.ts";
export { satisfies } from "./semver.ts";
export type { Infer } from "./zod.ts";
export { z } from "./zod.ts";
