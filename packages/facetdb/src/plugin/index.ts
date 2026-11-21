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
export type {
  ActionPayload,
  ActionRunnerDeps,
  ActionSource,
  QueuedAction,
} from "./action-host.ts";
export {
  actionSteps,
  checkActions,
  checkSourceActions,
  createActionRunner,
  RECORD_CHANGED,
  RECORD_GONE,
  SUPERSEDED,
  WAITS_FOR_PERSON,
} from "./action-host.ts";
export type { ChannelBinding, ChannelHostDeps } from "./channel-host.ts";
export {
  bindChannels,
  channelsOf,
  checkChannels,
  DELIVERY_BOUND_MS,
  DELIVERY_STOPPED,
  DELIVERY_TIMED_OUT,
  deliveryFailedWords,
  deliveryFailureLine,
  revealsSecret,
  sendsSeverity,
} from "./channel-host.ts";
export type { Plugin, PluginDefinition, PluginIssue } from "./define.ts";
export { definePlugin, isPlugin, PluginError, packageNames, shortName } from "./define.ts";
export type {
  HostedPlugin,
  HostedVariable,
  PluginHost,
  PluginHostOptions,
  PluginRefusal,
} from "./host.ts";
export {
  BUILTIN_PLUGINS,
  createPluginHost,
  importFromProject,
  PluginHostError,
} from "./host.ts";
export type {
  ActionContext,
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
export type { FoundPlugin, LoadPluginOptions } from "./load.ts";
export { findPlugin, loadPlugin, PluginNotInstalledError } from "./load.ts";
export type { PluginProviderOptions } from "./provider.ts";
export {
  checkPluginProvider,
  createPluginProvider,
  PluginProviderError,
  PluginProviderFailure,
} from "./provider.ts";
// The reader's side of the registry; the generator's functions stay in registry.ts for
// registry-build.ts and the tests.
export type { RegistryIndex, RegistryListing } from "./registry.ts";
export { RegistryError, readRegistryIndex } from "./registry.ts";
export { satisfies } from "./semver.ts";
export type { Infer } from "./zod.ts";
export { z } from "./zod.ts";
