import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  channelAddressOf,
  formatPath,
  isEnvReference,
  type JsonValue,
  type PluginSettings,
  type PluginVariable,
  type ProjectConfig,
  pluginProviderOf,
  pluginVariables,
  suggestedVariable,
} from "../config/index.ts";
import { type Plugin, PluginError, shortName } from "./define.ts";
import type { PluginContext } from "./kinds.ts";
import {
  type FoundPlugin,
  findPlugin,
  type LoadPluginOptions,
  PluginNotInstalledError,
} from "./load.ts";
import { satisfies } from "./semver.ts";

/**
 * The plugin host: when the config loads, it loads once every plugin the config names (a `plugins`
 * key, an action's plugin, an alert channel's kind), checks each against the running core, parses
 * its settings with the manifest's own schema, and reads each variable the settings name from the
 * environment. A plugin is handed its settings and secrets through `contextFor`, and never the
 * environment: it sees no variable its settings do not name. Nothing here prints; a refusal is a
 * `PluginHostError` whose words carry a variable's name and never its value.
 */

/** Plugins shipped inside facetdb, by package name; a name found here is imported from nowhere (142 fills it). */
export const BUILTIN_PLUGINS: Readonly<Record<string, Plugin>> = {};

export type PluginHostOptions = {
  readonly config: ProjectConfig;
  /** The environment the worker runs in; a plugin is given only the variables its settings name. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The project's directory, where the plugins are installed, as the refusals name it. */
  readonly projectDir: string;
  /** The running FacetDB, checked against each plugin's `facetdb` range. */
  readonly coreVersion: string;
  /** Imports a plugin package from the project's directory: `importFromProject` in the process. */
  readonly importModule: LoadPluginOptions["importModule"];
  /** Plugins shipped inside facetdb, by package name: `BUILTIN_PLUGINS` in the process. */
  readonly builtins: Readonly<Record<string, Plugin>>;
};

/** One variable a hosted plugin's settings read: where it is written and its name, never its value. */
export type HostedVariable = {
  /** Inside the plugin's settings: `token`, `auth.password`, `hooks[0].secret`. */
  readonly path: string;
  readonly variable: string;
  /** Whether the manifest's schema marks the field as a secret (`z.secret()`). */
  readonly secret: boolean;
};

/** A plugin the config names, loaded and with its settings checked. */
export type HostedPlugin = {
  /** The package it came from (or is registered under, for a built-in): `@facetdb/github`. */
  readonly packageName: string;
  /** Its short name, `github`: an alert channel address's kind. */
  readonly name: string;
  readonly plugin: Plugin;
  /** Its settings as the file writes them, each variable `{ env: "NAME" }`: never a secret's value. */
  readonly settings: PluginSettings;
  readonly variables: readonly HostedVariable[];
};

export type PluginHost = {
  /**
   * The plugin a name the config uses stands for (a `plugins` key, an action's plugin, a channel's
   * kind), or a hosted plugin's package or short name; undefined for any other name.
   */
  plugin(name: string): HostedPlugin | undefined;
  /** Every hosted plugin, in the order the config first names each. */
  all(): readonly HostedPlugin[];
  /**
   * What a plugin's functions receive: its settings parsed by its schema (each variable read),
   * its secrets by path, and `signal`. Throws for a name `plugin` does not know: the host loads
   * every plugin the config names, so asking for another is a bug, not a setup problem.
   */
  contextFor(name: string, signal: AbortSignal): PluginContext<unknown>;
};

/** Each refusal's code, the docs page that fixes it (`CliError`'s code once the CLI maps it). */
export type PluginRefusal =
  | "plugin-not-installed"
  | "plugin-invalid"
  | "plugin-core-version"
  | "plugin-named-twice"
  | "plugin-secret-literal"
  | "plugin-variable-unset"
  | "plugin-settings"
  /** An alert channel whose plugin provides no channel for its kind (channel-host.ts). */
  | "plugin-no-channel"
  /** An alert channel's `where` that the channel's own schema, or its `check`, refuses (channel-host.ts). */
  | "channel-where"
  /** An action the config names that its plugin does not provide (action-host.ts). */
  | "plugin-no-action"
  /** An action's settings, or its `else`, that the action's own schema refuses (action-host.ts). */
  | "action-settings";

/** A plugin the config names cannot run: what is wrong and what to do, never a secret's value. */
export class PluginHostError extends Error {
  readonly code: PluginRefusal;
  readonly fix: string;

  constructor(code: PluginRefusal, message: string, fix: string) {
    super(message);
    this.name = "PluginHostError";
    this.code = code;
    this.fix = fix;
  }
}

/**
 * The nearest directory of the package in a `node_modules` in `directory` or above it: the
 * project's own tree, the one Node's resolution would reach first.
 */
async function installedAbove(directory: string, specifier: string): Promise<string | undefined> {
  for (let at = directory; ; at = dirname(at)) {
    const packageDir = join(at, "node_modules", specifier);
    try {
      await access(join(packageDir, "package.json"));
      return packageDir;
    } catch {
      if (dirname(at) === at) {
        return undefined;
      }
    }
  }
}

/** The conditions Node's `import` matches in a package's `exports`, which it reads in their order. */
const IMPORT_CONDITIONS: ReadonlySet<string> = new Set([
  "node",
  "import",
  "module-sync",
  "default",
]);

/**
 * The file a package's `exports` hands an `import` of the package itself (its "." entry), as Node
 * reads it: a string, a list (the first that resolves), subpaths keyed by ".", or conditions taken
 * in the order written, the first one an import matches. Undefined when nothing matches.
 */
function importTarget(exports: unknown): string | undefined {
  if (typeof exports === "string") {
    return exports;
  }
  if (Array.isArray(exports)) {
    for (const option of exports) {
      const target = importTarget(option);
      if (target !== undefined) {
        return target;
      }
    }
    return undefined;
  }
  if (typeof exports !== "object" || exports === null) {
    return undefined;
  }
  const entries = Object.entries(exports);
  if (entries.some(([key]) => key.startsWith("."))) {
    return importTarget((exports as Record<string, unknown>)["."]);
  }
  for (const [condition, target] of entries) {
    const found = IMPORT_CONDITIONS.has(condition) ? importTarget(target) : undefined;
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Imports a plugin as the project would: resolved from the config file's own directory, then
 * imported by file URL, never from the facetdb package's own `node_modules`. A plugin is the
 * project's dependency, in the monorepo and under `npx` alike. Only a `node_modules` on the config
 * file's own path counts: Node would also look in `NODE_PATH`, which `pnpm run` points at the store
 * facetdb itself was installed from. A package with `exports` is read by the conditions an `import`
 * matches (a plugin may export for `import` alone); one without is resolved by `createRequire` on
 * the config file's path (its `main`). A package that is not there rejects with Node's
 * `MODULE_NOT_FOUND`, which the loader reads as "not installed".
 */
export function importFromProject(configFile: string): LoadPluginOptions["importModule"] {
  const require = createRequire(configFile);
  return async (specifier) => {
    const packageDir = await installedAbove(dirname(configFile), specifier);
    if (packageDir === undefined) {
      throw Object.assign(
        new Error(`Cannot find package '${specifier}' from ${dirname(configFile)}`),
        { code: "MODULE_NOT_FOUND" },
      );
    }
    // A third party's file: read as data, judged before anything is taken from it.
    const packageJson: unknown = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    );
    const exports =
      typeof packageJson === "object" && packageJson !== null
        ? (packageJson as { exports?: unknown }).exports
        : undefined;
    if (exports === undefined) {
      return import(/* @vite-ignore */ pathToFileURL(require.resolve(specifier)).href);
    }
    const target = importTarget(exports);
    if (target === undefined || !target.startsWith("./")) {
      throw new Error(
        `the package ${specifier} exports no file an import can load (its package.json "exports" has no "import", "node" or "default" entry for the package itself)`,
      );
    }
    return import(/* @vite-ignore */ pathToFileURL(join(packageDir, target)).href);
  };
}

/** Where the config names a plugin, for the words of a refusal. */
type Use = { readonly name: string; readonly where: string };

/** Every name the config uses for a plugin, the first place each is used, in the file's order. */
function usesOf(config: ProjectConfig): Use[] {
  const uses: Use[] = Object.keys(config.plugins ?? {}).map((name) => ({
    name,
    where: formatPath(["plugins", name]),
  }));
  const providedBy = config.provider === undefined ? undefined : pluginProviderOf(config.provider);
  if (providedBy !== undefined) {
    uses.push({ name: providedBy.plugin, where: "provider" });
  }
  config.sources.forEach((source, index) => {
    source.actions.forEach((action, position) => {
      uses.push({
        name: action.plugin,
        where: `sources[${index}].actions[${position}].plugin`,
      });
    });
  });
  (config.alerts?.channels ?? []).forEach((channel, index) => {
    const address = channelAddressOf(channel);
    uses.push({ name: address.slice(0, address.indexOf(":")), where: `alerts.channels[${index}]` });
  });
  const seen = new Set<string>();
  return uses.filter((use) => {
    if (seen.has(use.name)) {
      return false;
    }
    seen.add(use.name);
    return true;
  });
}

async function find(
  use: Use,
  importModule: LoadPluginOptions["importModule"],
  projectDir: string,
): Promise<FoundPlugin> {
  try {
    return await findPlugin(use.name, importModule);
  } catch (error) {
    if (error instanceof PluginNotInstalledError) {
      const words = error.issues.map((issue) => issue.message).join("; ");
      throw new PluginHostError(
        "plugin-not-installed",
        `${use.where} names the plugin "${use.name}": ${words}`,
        `run facetdb add ${error.short} in ${projectDir}, or take "${use.name}" out of the config`,
      );
    }
    if (error instanceof PluginError) {
      throw new PluginHostError(
        "plugin-invalid",
        `${use.where} names the plugin "${use.name}", which cannot be used. ${error.message}`,
        "install a version of the plugin built with the current facetdb/plugin, or ask its author to fix what each line says",
      );
    }
    const why = error instanceof Error ? error.message : String(error);
    throw new PluginHostError(
      "plugin-invalid",
      `${use.where} names the plugin "${use.name}", which failed while it loaded: ${why}`,
      "reinstall the plugin, or install a version of it that loads",
    );
  }
}

/** One step of a secret path as `secretPaths` writes it: a key, `*`, `[]` or `[n]`. */
function stepsOf(pattern: string): string[] {
  return pattern.match(/\[\]|\[\d+\]|[^.[\]]+/g) ?? [];
}

function isObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every place in `value` a secret path reaches, with what the file wrote there. */
function reach(
  value: unknown,
  steps: readonly string[],
  path: readonly (string | number)[],
): { readonly path: readonly (string | number)[]; readonly value: unknown }[] {
  const [step, ...rest] = steps;
  if (step === undefined) {
    return [{ path, value }];
  }
  if (isEnvReference(value)) {
    return [];
  }
  if (step === "[]" || /^\[\d+\]$/.test(step)) {
    if (!Array.isArray(value)) {
      return [];
    }
    const items = value as readonly unknown[];
    const indices = step === "[]" ? items.map((_, index) => index) : [Number(step.slice(1, -1))];
    return indices
      .filter((index) => index < items.length)
      .flatMap((index) => reach(items[index], rest, [...path, index]));
  }
  if (!isObject(value)) {
    return [];
  }
  const keys = step === "*" ? Object.keys(value) : Object.hasOwn(value, step) ? [step] : [];
  return keys.flatMap((key) => reach(value[key], rest, [...path, key]));
}

/**
 * Every place in `settings` one of a schema's secret paths (`secretPaths`) reaches, with what the
 * file wrote there: a plugin's settings here, an action's in action-host.ts.
 */
export function secretPlaces(
  settings: unknown,
  patterns: readonly string[],
): { readonly path: readonly (string | number)[]; readonly value: unknown }[] {
  return patterns.flatMap((pattern) => reach(settings, stepsOf(pattern), []));
}

/** The settings with every `env("NAME")` replaced by the variable's value. */
export function resolved(value: JsonValue, env: PluginHostOptions["env"]): unknown {
  if (isEnvReference(value)) {
    return env[value.env];
  }
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((item) => resolved(item, env));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolved(item, env)]),
    );
  }
  return value;
}

/** Whether `path` begins with every step of `prefix`. */
export function startsWith(
  path: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
}

/** The variables' names for a sentence, each once: `GITHUB_TOKEN and SHARED_KEY`. */
function listed(variables: readonly PluginVariable[]): string {
  return [...new Set(variables.map(({ variable }) => variable))].join(" and ");
}

/** A value no plugin function can change: its context is shared by every call. */
function frozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      frozen(inner);
    }
  }
  return value;
}

/** A hosted plugin and what its context holds; the values stay inside the host. */
type Loaded = {
  readonly hosted: HostedPlugin;
  readonly config: unknown;
  readonly secrets: Readonly<Record<string, string>>;
};

/** Checks one plugin's settings and reads its variables; throws the first refusal. */
function settle(found: FoundPlugin, key: string | undefined, options: PluginHostOptions): Loaded {
  const { plugin, specifier } = found;
  const { manifest } = plugin;
  const short = shortName(specifier) ?? specifier;
  const at = key ?? short;
  const where = (path: readonly (string | number)[]) => formatPath(["plugins", at, ...path]);
  const settings: PluginSettings = key === undefined ? {} : (options.config.plugins?.[key] ?? {});

  if (!satisfies(options.coreVersion, manifest.coreVersions)) {
    throw new PluginHostError(
      "plugin-core-version",
      `the plugin "${specifier}" ${manifest.version} supports FacetDB ${manifest.coreVersions}, but this is FacetDB ${options.coreVersion}`,
      `install a version of the plugin that supports FacetDB ${options.coreVersion} (facetdb add ${short}), or upgrade or downgrade facetdb`,
    );
  }

  // A secret the manifest's schema marks (`z.secret()`) is always a variable's name: the schema
  // of the config file judged the keys that look like one; this is every one the plugin declares.
  const places = secretPlaces(settings, manifest.secrets);
  const literal = places.find(
    (place) => typeof place.value === "string" || typeof place.value === "number",
  );
  if (literal !== undefined) {
    const field = String(
      [...literal.path].reverse().find((step) => typeof step === "string") ?? at,
    );
    const variable = suggestedVariable(short, field);
    throw new PluginHostError(
      "plugin-secret-literal",
      `${where(literal.path)} is a secret of the plugin "${specifier}" written into the config file, and secrets never go in this file or its JSON export`,
      `put it in an environment variable and name the variable there: ${field}: env("${variable}"), then set ${variable} where the worker runs`,
    );
  }

  const named = pluginVariables(options.config).filter((entry) => entry.plugin === key);
  const unset = named.filter(({ variable }) => {
    const value = options.env[variable];
    return value === undefined || value === "";
  });
  if (unset.length > 0) {
    const lines = unset.map(
      ({ variable, path }) => `${variable} is not set (${where(path)} reads it)`,
    );
    const names = [...new Set(unset.map(({ variable }) => variable))];
    throw new PluginHostError(
      "plugin-variable-unset",
      `the plugin "${specifier}" cannot start: ${lines.join("; ")}`,
      `set ${names.join(" and ")} where the worker runs, then start it again`,
    );
  }
  const input = resolved(settings, options.env);
  let parsed: ReturnType<typeof manifest.config.safeParse>;
  try {
    parsed = manifest.config.safeParse(input);
  } catch {
    // A schema that throws (a transform or a refine on a value it cannot read) is the plugin's
    // fault, and what it threw may quote a variable's value: none of its words are kept.
    const reads = named.length === 0 ? "" : `, which reads ${listed(named)}`;
    throw new PluginHostError(
      "plugin-settings",
      `the schema of the plugin "${specifier}" failed while it read ${where([])}${reads}, instead of refusing a value in words`,
      `check what ${where([])} holds${named.length === 0 ? "" : ` and the value of ${listed(named)}`}; if they are what the plugin documents, ask its author to make its schema refuse a value rather than fail`,
    );
  }
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const path = issue.path as (string | number)[];
      // A schema's reason may quote what it was given, so where a variable fed the value (at this
      // path, inside it, or in what holds it) it is never printed: only the variable's name is.
      const fed = named.filter(
        (entry) => startsWith(entry.path, path) || startsWith(path, entry.path),
      );
      return fed.length === 0
        ? `${where(path)}: ${issue.message}`
        : `${where(path)}: the value of ${listed(fed)} is refused by the plugin's schema (its reason is not shown, as it could quote the value)`;
    });
    throw new PluginHostError(
      "plugin-settings",
      `the settings of the plugin "${specifier}" are refused by its schema:\n${lines.map((line) => `  - ${line}`).join("\n")}`,
      key === undefined
        ? `the config names the plugin but gives it no settings: add plugins: { ${JSON.stringify(at)}: { ... } } to the config file with what each line asks for`
        : `change ${where([])} in the config file, or the variable it names, as each line says`,
    );
  }

  const secretPaths = new Set(places.map((place) => formatPath(place.path)));
  const secrets: Record<string, string> = {};
  for (const place of places) {
    if (isEnvReference(place.value)) {
      secrets[formatPath(place.path)] = options.env[place.value.env] as string;
    }
  }
  return {
    hosted: {
      packageName: specifier,
      name: short,
      plugin,
      settings,
      variables: named.map(({ path, variable }) => ({
        path: formatPath(path),
        variable,
        secret: secretPaths.has(formatPath(path)),
      })),
    },
    config: frozen(parsed.data),
    secrets: frozen(secrets),
  };
}

/**
 * Builds the host for a config: every plugin it names is found (a built-in by its package name
 * first), checked against the running core, and its settings parsed and its variables read. The
 * first problem stops it, as a `PluginHostError` naming the setting and the fix.
 */
export async function createPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const { builtins } = options;
  // Each package is imported once, however many names the config gives it (`github`,
  // `@facetdb/github`): a short name and a package name try the same specifier.
  const imported = new Map<string, Promise<unknown>>();
  const importModule: LoadPluginOptions["importModule"] = (specifier) => {
    let module = imported.get(specifier);
    if (module === undefined) {
      module = Object.hasOwn(builtins, specifier)
        ? Promise.resolve({ default: builtins[specifier] })
        : options.importModule(specifier);
      imported.set(specifier, module);
    }
    return module;
  };

  const uses = usesOf(options.config);
  const found = new Map<string, FoundPlugin>();
  for (const use of uses) {
    found.set(use.name, await find(use, importModule, options.projectDir));
  }

  // Two `plugins` keys may name one package (`github` and `@facetdb/github`): one would be ignored.
  const keyOf = new Map<string, string>();
  for (const key of Object.keys(options.config.plugins ?? {})) {
    const specifier = (found.get(key) as FoundPlugin).specifier;
    const first = keyOf.get(specifier);
    if (first !== undefined) {
      throw new PluginHostError(
        "plugin-named-twice",
        `${formatPath(["plugins", first])} and ${formatPath(["plugins", key])} are both the settings of the plugin "${specifier}"`,
        `keep one of them in the config file and remove the other`,
      );
    }
    keyOf.set(specifier, key);
  }

  const loaded = new Map<string, Loaded>();
  const byName = new Map<string, Loaded>();
  for (const use of uses) {
    const at = found.get(use.name) as FoundPlugin;
    let entry = loaded.get(at.specifier);
    if (entry === undefined) {
      entry = settle(at, keyOf.get(at.specifier), options);
      loaded.set(at.specifier, entry);
      byName.set(at.specifier, entry);
    }
    byName.set(use.name, entry);
  }
  // A hosted plugin answers to its short name too, as the loader reads one: `@facetdb/<name>`
  // before `facetdb-plugin-<name>` when both are hosted.
  const preferred = [...loaded.values()].sort(
    (a, b) =>
      Number(b.hosted.packageName.startsWith("@facetdb/")) -
      Number(a.hosted.packageName.startsWith("@facetdb/")),
  );
  for (const entry of preferred) {
    if (!byName.has(entry.hosted.name)) {
      byName.set(entry.hosted.name, entry);
    }
  }

  return {
    plugin: (name) => byName.get(name)?.hosted,
    all: () => [...loaded.values()].map((entry) => entry.hosted),
    contextFor: (name, signal) => {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new Error(
          `the plugin "${name}" is not one the config names, so the host has no context for it`,
        );
      }
      return { config: entry.config, secrets: entry.secrets, signal };
    },
  };
}
