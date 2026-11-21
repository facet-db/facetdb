import type { Clock, ModelProvider } from "@facetdb/core";
import { ProviderKeyMissingError, selectProvider } from "@facetdb/model";
import { type ProjectConfig, pluginProviderOf } from "../config/index.ts";
import { createPluginProvider, type PluginHost, PluginProviderError } from "../plugin/index.ts";
import { CliError } from "./program.ts";

/**
 * The model provider of a config, the composition root's one door to it: a plugin's provider
 * through the plugin host, a built-in preset with the key of its own variable, otherwise today's
 * rule (`modelUrl`'s server, else TypeSafe with `TYPESAFE_API_KEY`). A missing key, or a plugin
 * that supplies no such provider, is the CLI's error with what to do; no key is in its words.
 */
export function modelProviderOf(options: {
  readonly config: ProjectConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  /** The process's stop signal, handed to a plugin's provider; read only for a plugin's. */
  readonly stopSignal: () => AbortSignal;
  /** The plugin host of the config, for a plugin's provider. */
  readonly plugins: PluginHost | undefined;
}): ModelProvider {
  const { config, env, plugins } = options;
  try {
    const plugin = config.provider === undefined ? undefined : pluginProviderOf(config.provider);
    if (config.provider !== undefined && plugin !== undefined) {
      if (plugins === undefined) {
        throw new Error(
          `the plugin host was not built for the provider ${config.provider}: this command asked for the model before loading it`,
        );
      }
      return createPluginProvider({
        provider: config.provider,
        ref: plugin,
        host: plugins,
        signal: options.stopSignal(),
      });
    }
    return selectProvider({
      provider: config.provider,
      modelUrl: config.modelUrl,
      apiKey: env["TYPESAFE_API_KEY"],
      env,
      fetch: options.fetch,
      clock: options.clock,
    });
  } catch (error) {
    if (error instanceof ProviderKeyMissingError) {
      throw new CliError(
        "model-key",
        error.message,
        `set ${error.variable} to your ${error.provider} key where this command runs, then run it again`,
      );
    }
    if (error instanceof PluginProviderError) {
      throw new CliError("model-provider", error.message, error.fix);
    }
    throw error;
  }
}
