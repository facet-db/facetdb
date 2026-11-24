/**
 * `facetdb/plugin`: the authoring API of a plugin.
 *
 * ```ts
 * import { definePlugin, source, action, z } from "facetdb/plugin";
 * ```
 *
 * `definePlugin` checks the manifest (name, version, the `facetdb` core range, the config schema,
 * every entry) and throws a `PluginError` naming each wrong field. To type `ctx.config` inside
 * `source`, `action`, ... annotate the first parameter: `(ctx: PluginContext<Infer<typeof
 * config>>)`. In the config schema, `z.secret()` marks a setting read from the environment, and
 * `z.editable()` one a studio draft may change; every other setting is changed in the file by hand.
 */
export type {
  ActionPayload,
  ActionRunnerDeps,
  ActionSource,
  QueuedAction,
} from "./action-host.ts";
export {
  ACTION_WORDS_MAX,
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
  webhookAllowsPrivate,
  webhookRefusal,
  webhookSecret,
  withOutbox,
} from "./builtin/webhook.ts";
export type {
  ChannelBinding,
  ChannelHostDeps,
  FirstPartyFailure,
  ZoneReader,
} from "./channel-host.ts";
export {
  bindChannels,
  ChannelRefused,
  channelsOf,
  checkChannels,
  DELIVERY_BOUND_MS,
  DELIVERY_STOPPED,
  DELIVERY_TIMED_OUT,
  deliveryFailedWords,
  deliveryFailureLine,
  FIRST_PARTY_DELIVERY_ERRORS,
  firstPartyCredentialRefused,
  firstPartyFailure,
  quietWindowFor,
  revealsSecret,
  sendsSeverity,
  summaryFailureLine,
  summaryUnmarkedLine,
} from "./channel-host.ts";
export type { Plugin, PluginDefinition, PluginIssue } from "./define.ts";
export { definePlugin, isPlugin, PluginError, packageNames, shortName } from "./define.ts";
export type {
  HostedPlugin,
  HostedVariable,
  LivePluginHost,
  PluginHost,
  PluginHostOptions,
  PluginRefusal,
} from "./host.ts";
export {
  BUILTIN_PLUGINS,
  createPluginHost,
  importFromProject,
  livePluginHost,
  PluginHostError,
  pluginNamesOf,
} from "./host.ts";
export type { SettingsInForce, SettingsReload } from "./in-force.ts";
export { createSettingsInForce, draftPlugins } from "./in-force.ts";
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
export {
  action,
  channel,
  NOTIFY_ACTION,
  pack,
  provider,
  SourceAccessLost,
  source,
} from "./kinds.ts";
export type { FoundPlugin, LoadPluginOptions } from "./load.ts";
export { findPlugin, loadPlugin, PluginNotInstalledError } from "./load.ts";
export type { DigestRunnerDeps, Notification, NotifyDeps, NotifyQueueing } from "./notify.ts";
export {
  batchKeyOf,
  conditionWords,
  createDigestRunner,
  digestText,
  notificationText,
  notifyAddress,
  notifyQuiet,
  sendNotification,
} from "./notify.ts";
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
  ReceiveAbandoned,
} from "./source-connector.ts";
export type { HostedSource } from "./source-host.ts";
export { checkSources, hostedSource } from "./source-host.ts";
export type { Infer } from "./zod.ts";
export { z } from "./zod.ts";
