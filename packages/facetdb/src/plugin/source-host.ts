import {
  formatPath,
  type ProjectConfig,
  type SourceCall,
  type SourceConfig,
  suggestedVariable,
} from "../config/index.ts";
import { listed, refusals, schemaSecrets, variablesIn } from "./action-host.ts";
import { shortName } from "./define.ts";
import { type PluginHost, PluginHostError, resolved, secretPlaces } from "./host.ts";
import type { SourceAction, SourceDefinition } from "./kinds.ts";

/**
 * The source host: a plugin source as the config names it (`source: sourceCall(plugin, source,
 * settings)`), checked against the plugins the host loaded when the worker started, as an action is
 * (action-host.ts): its plugin provides the source; no secret of the source's schema is written
 * into the file; every variable its settings name is set; and its settings, each variable read,
 * pass the source's own schema. The refusals name the setting and its fix, and a variable's name,
 * never its value. What passes is a `HostedSource`: what the adapter (source-connector.ts) hands
 * the plugin's functions.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** A plugin source the host can run: the plugin's own source and what its context holds. */
export type HostedSource = {
  /** The plugin's package, as the host loaded it: `@facetdb/github`. */
  readonly packageName: string;
  /** The source's name in its plugin: `issues`. */
  readonly entry: string;
  readonly definition: SourceDefinition<unknown>;
  /** The source's settings as its schema parsed them, each variable read; `{}` without a schema. Frozen. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The actions of this same plugin configured on the source, as the file writes them. Frozen. */
  readonly actions: readonly SourceAction[];
  /**
   * The variables the plugin's settings and this source's read, by name only, each once: what the
   * words for a refused credential point at.
   */
  readonly variables: readonly string[];
};

/** Where the config writes the source's call: `sources[0].source`. */
function placeOf(config: ProjectConfig, source: SourceConfig): string {
  const index = config.sources.findIndex((candidate) => candidate.name === source.name);
  return `sources[${index}].source`;
}

/** A value no plugin function can change: the context is shared by every call. */
function frozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      frozen(inner);
    }
  }
  return value;
}

/** The plugin's source a call names; refuses in words when the host did not load it. */
function entryOf(
  host: PluginHost,
  call: SourceCall,
  where: string,
): { readonly packageName: string; readonly definition: SourceDefinition<unknown> } {
  const hosted = host.plugin(call.plugin);
  if (hosted === undefined) {
    // The host loads every plugin the config names when the worker starts; one named only since
    // (a reload after the file changed) is not loaded until the worker starts again.
    throw new PluginHostError(
      "plugin-not-installed",
      `${where}.plugin names the plugin "${call.plugin}", which this worker did not load when it started`,
      "restart facetdb worker so it loads the plugin, after installing it with facetdb add if it is not installed",
    );
  }
  const definition = Object.hasOwn(hosted.plugin.sources, call.source)
    ? hosted.plugin.sources[call.source]
    : undefined;
  if (definition === undefined) {
    const names = Object.keys(hosted.plugin.sources);
    throw new PluginHostError(
      "plugin-no-source",
      `${where}.source is "${call.source}", but the plugin "${hosted.packageName}" has no source of that name: ${
        names.length === 0 ? "it provides no source" : `its sources are ${names.join(", ")}`
      }`,
      names.length === 0
        ? `read the records with another plugin, or with a table or the check API`
        : `change ${where}.source to one of ${names.join(", ")}`,
    );
  }
  return { packageName: hosted.packageName, definition };
}

/**
 * The plugin source `source` of `config`, checked and ready to run; throws the first refusal as a
 * `PluginHostError`. `source.source` must be set: a table or API source is not one.
 */
export function hostedSource(
  host: PluginHost,
  config: ProjectConfig,
  source: SourceConfig,
  env: Env,
): HostedSource {
  const call = source.source;
  if (call === undefined) {
    throw new Error(`the source ${source.name} is not a plugin source`);
  }
  const where = placeOf(config, source);
  const { packageName, definition } = entryOf(host, call, where);
  const base = `${where}.settings`;
  const what = `${where} (${call.plugin} ${call.source})`;

  const patterns = schemaSecrets(definition.config, what, "source");
  const literal = secretPlaces(call.settings, patterns).find(
    (place) => typeof place.value === "string" || typeof place.value === "number",
  );
  if (literal !== undefined) {
    const field = String(
      [...literal.path].reverse().find((step) => typeof step === "string") ?? call.source,
    );
    const variable = suggestedVariable(shortName(call.plugin) ?? call.plugin, field);
    throw new PluginHostError(
      "plugin-secret-literal",
      `${formatPath([base, ...literal.path])} is a secret of the source ${call.plugin} ${call.source} written into the config file, and secrets never go in this file or its JSON export`,
      `put it in an environment variable and name the variable there: ${field}: env("${variable}"), then set ${variable} where the worker runs`,
    );
  }

  const named = variablesIn(call.settings);
  const unset = named.filter(({ variable }) => env[variable] === undefined || env[variable] === "");
  if (unset.length > 0) {
    throw new PluginHostError(
      "plugin-variable-unset",
      `${what} cannot run: ${unset
        .map(
          ({ variable, path }) =>
            `${variable} is not set (${formatPath([base, ...path])} reads it)`,
        )
        .join("; ")}`,
      `set ${listed(unset)} where the worker runs, then start it again`,
    );
  }

  let settings: Readonly<Record<string, unknown>> = {};
  const schema = definition.config;
  if (schema === undefined) {
    if (Object.keys(call.settings).length > 0) {
      throw new PluginHostError(
        "source-settings",
        `${base} gives settings to the source ${call.plugin} ${call.source}, which takes none`,
        `take the settings out of ${where}, or check the plugin's documentation for where they belong (its own settings go under plugins)`,
      );
    }
  } else {
    const input = resolved(call.settings, env);
    const lines = refusals({ config: schema }, input, base, named, "source");
    if (lines.length > 0) {
      throw new PluginHostError(
        "source-settings",
        `the settings of ${what} are refused by the source's schema:\n${lines.map((line) => `  - ${line}`).join("\n")}`,
        `change ${base} in the config file, or the variable it names, as each line says`,
      );
    }
    // Judged above without a throw and without an issue; a schema that answers otherwise the second
    // time is the plugin's fault, refused in fixed words (what it threw could quote a value).
    let again: ReturnType<typeof schema.safeParse> | undefined;
    try {
      again = schema.safeParse(input);
    } catch {
      again = undefined;
    }
    if (again === undefined || !again.success) {
      throw new PluginHostError(
        "source-settings",
        `${base}: the source's schema failed while it read these settings, instead of refusing a value in words`,
        "install a version of the plugin whose source schema reads its settings the same way every time, or ask its author to fix it",
      );
    }
    settings = again.data as Readonly<Record<string, unknown>>;
  }

  const actions: SourceAction[] = source.actions
    .filter((action) => host.plugin(action.plugin)?.packageName === packageName)
    .map((action) => ({ action: action.action, config: action.config }));
  const hosted = host.plugin(call.plugin);
  const variables = [
    ...new Set([
      ...(hosted?.variables ?? []).map((variable) => variable.variable),
      ...named.map(({ variable }) => variable),
    ]),
  ];
  return {
    packageName,
    entry: call.source,
    definition,
    settings: frozen(settings),
    actions: frozen(actions),
    variables,
  };
}

/**
 * Checks every plugin source of `config` against the plugins the host loaded: `facetdb worker`,
 * `studio`, `dev` and doctor, at load, beside `checkActions`. Throws the first refusal.
 */
export function checkSources(config: ProjectConfig, host: PluginHost, env: Env): void {
  for (const source of config.sources) {
    if (source.source !== undefined) {
      hostedSource(host, config, source, env);
    }
  }
}
