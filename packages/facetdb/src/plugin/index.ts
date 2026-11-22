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
export type {
  SourceWebhooks,
  WebhookAlertPayload,
  WebhookOutbox,
} from "./builtin/webhook.ts";
export {
  BUILTIN_WEBHOOK,
  endpointProblem,
  WEBHOOK_ACTION,
  WEBHOOK_CHANNEL,
  WEBHOOK_ENDPOINT_GONE,
  WEBHOOK_PLUGIN,
  WEBHOOK_SECRET_VARIABLE,
  webhookRefusal,
  webhookSecret,
  withOutbox,
} from "./builtin/webhook.ts";
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
  SourceAction,
  SourceContext,
  SourceDefinition,
  SourcePage,
  SourceReceipt,
  SourceRequest,
  SourceRow,
  SourceSpec,
} from "./kinds.ts";
export { action, channel, pack, provider, SourceAccessLost, source } from "./kinds.ts";
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
export type {
  BackfillStore,
  IntakeReport,
  PluginSourceConnector,
  PluginSourceDeps,
  ReceiveOutcome,
  RecordStore,
} from "./source-connector.ts";
export {
  createPluginBackfillConnector,
  createPluginSourceConnector,
  keyProblem,
  MAX_CURSOR_LENGTH,
  MAX_EMPTY_PAGES,
  MAX_KEY_BYTES,
  MAX_STATE_BYTES,
  PluginSourceFailed,
  printableKey,
} from "./source-connector.ts";
export type { HostedSource } from "./source-host.ts";
export { checkSources, hostedSource } from "./source-host.ts";
export type { Infer } from "./zod.ts";
export { z } from "./zod.ts";
