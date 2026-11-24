import type { Clock, PluginKind } from "@facetdb/core";
import type {
  Gallery,
  GalleryEntry,
  InstalledPlugin,
  JsonObject,
  PackView,
  PluginsDoor,
} from "@facetdb/server";
import { toJSONSchema } from "zod";
import { type ProjectConfig, pluginVariables } from "../../config/index.ts";
import {
  BUILTIN_PLUGINS,
  type HostedPlugin,
  type PluginHost,
  packageNames,
  pluginNamesOf,
  type RegistryIndex,
  satisfies,
} from "../../plugin/index.ts";
import type { CliDeps } from "../program.ts";
import {
  checkRegistryAddress,
  DEFAULT_REGISTRY,
  REGISTRY_TIMEOUT_MS,
  type RegistryRead,
  readRegistry,
  registryAddress,
} from "../registry/index.ts";
import { dependenciesOf, installed, isSet } from "./restart-wait.ts";
import { cutSettings } from "./url-settings-cut.ts";

/**
 * The CLI's door for the studio's Plugins page: the plugins the host loaded when the config did,
 * the registry's gallery through the one registry reader (`cli/registry`, shared with `facetdb
 * add`), and the packs of the hosted plugins. What leaves is data for the page: a variable is its
 * name and whether the environment has it, never its value; the registry's text is from outside and
 * is handed on as text, and the command beside an entry is built from its checked short name alone
 * (nothing is installed from a page). It also carries what the page draws and drafts with: each
 * plugin's key in `plugins`, whether it is built in, each entry's range held against this FacetDB,
 * and the built-in webhook's endpoints as their hosts alone, since an address can carry a token;
 * every plugin's addresses are cut so (`url-settings-cut.ts`), the same cut `GET /v1/config` is
 * answered with. An entry whose package the project depends on, is installed and the config file
 * names, but which the worker did not load when it started, says it loads at the next start, and
 * which of the variables the file names for it are not set (`nextStart`).
 */

export { DEFAULT_REGISTRY, REGISTRY_TIMEOUT_MS, registryAddress };

/** The worker reads the index at most this often, an unreachable registry included. */
export const REGISTRY_CACHE_MS = 10 * 60 * 1000;

export type PluginsDoorOptions = {
  /** The plugins the config names, loaded and checked (`loadWorkerConfig`). */
  readonly host: PluginHost;
  /**
   * The config in force (`fleet.config()`): the key each plugin's settings are written under in
   * `plugins`, which a studio draft names them by, as Apply judges a draft against it.
   */
  readonly config: () => ProjectConfig;
  /** The worker's environment: only whether a variable is set is read from it, never shown. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The running FacetDB, checked against each plugin's range as the host did. */
  readonly coreVersion: string;
  /** The registry's index address (`registryAddress`). */
  readonly registry: string;
  /** `CliDeps.fetch`: a test hands a fake, which reaches no network. */
  readonly fetch: CliDeps["fetch"];
  /** `CliDeps.abortAfter`. */
  readonly abortAfter: (ms: number) => AbortSignal;
  /**
   * `CliDeps.workspace`: a registry that is a file is read from the project's directory, and so is
   * the project's package.json.
   */
  readonly workspace: Pick<CliDeps["workspace"], "peek" | "lines">;
  /** The project's directory: node_modules is looked for from here up, as Node resolves a package. */
  readonly projectDir: string;
  /**
   * The config file as it loads now (the worker's `--config`), read only when an entry's package is
   * a dependency, installed and not hosted: which plugins a start would load. Absent where the
   * worker has no file, and then no entry waits for a restart.
   */
  readonly file?: () => Promise<ProjectConfig>;
  readonly clock: Clock;
};

/**
 * The names `config` uses for `entry`'s package (its `plugins` key, an action's, a channel's kind):
 * that package itself, or its short name where that name is the first of its packages the project
 * depends on, as the loader reads one.
 */
function namesFor(
  used: readonly string[],
  entry: RegistryIndex["plugins"][number],
  dependencies: ReadonlySet<string>,
): readonly string[] {
  return used.filter(
    (name) =>
      name === entry.package ||
      (name === entry.name &&
        packageNames(name).find((candidate) => dependencies.has(candidate)) === entry.package),
  );
}

type NextStart = { readonly unset: readonly string[] };

/**
 * The entries the worker loads at its next start and not before, by package, each with the
 * variables the file names for it that are not set where the worker runs (a start would stop on
 * them): a dependency in package.json, installed under node_modules, named by the config file, its
 * range holding, not hosted now. The file is loaded only when some entry could be one; a file that
 * does not load names nothing, since a start would stop on it.
 */
async function nextStarts(
  entries: readonly RegistryIndex["plugins"][number][],
  hosted: ReadonlySet<string>,
  options: PluginsDoorOptions,
): Promise<ReadonlyMap<string, NextStart>> {
  const none = new Map<string, NextStart>();
  const file = options.file;
  if (file === undefined) {
    return none;
  }
  const dependencies = await dependenciesOf(options.workspace);
  const candidates: RegistryIndex["plugins"][number][] = [];
  for (const entry of entries) {
    if (
      dependencies.has(entry.package) &&
      !hosted.has(entry.package) &&
      satisfies(options.coreVersion, entry.facetdb) &&
      (await installed(options.workspace, options.projectDir, entry.package))
    ) {
      candidates.push(entry);
    }
  }
  if (candidates.length === 0) {
    return none;
  }
  let config: ProjectConfig;
  try {
    config = await file();
  } catch {
    return none;
  }
  const used = pluginNamesOf(config);
  const variables = pluginVariables(config);
  return new Map(
    candidates.flatMap((entry): (readonly [string, NextStart])[] => {
      const named = namesFor(used, entry, dependencies);
      if (named.length === 0) {
        return [];
      }
      const unset = variables
        .filter(({ plugin, variable }) => named.includes(plugin) && !isSet(options.env, variable))
        .map(({ variable }) => variable);
      return [[entry.package, { unset: [...new Set(unset)] }]];
    }),
  );
}

/** The settings schema as zod writes it for a form (what a file may hold), or null when it cannot. */
function schemaOf(hosted: HostedPlugin): JsonObject | null {
  try {
    // `input`: a field with a default is optional in the form; `any`: a refinement or transform
    // zod cannot draw is an unconstrained field, not a refusal to draw the rest.
    return toJSONSchema(hosted.plugin.manifest.config, {
      io: "input",
      unrepresentable: "any",
    }) as JsonObject;
  } catch {
    // The plugin's own schema failed while it was read; none of what it threw is kept.
    return null;
  }
}

/**
 * The key `config` writes `hosted`'s settings under in `plugins`: the one the host reads as that
 * plugin (`github` or `@facetdb/github`), else its short name, which a draft then adds.
 */
function keyOf(hosted: HostedPlugin, options: PluginsDoorOptions): string {
  const keys = Object.keys(options.config().plugins ?? {});
  return (
    keys.find((key) => options.host.plugin(key)?.packageName === hosted.packageName) ?? hosted.name
  );
}

function installedOf(hosted: HostedPlugin, options: PluginsDoorOptions): InstalledPlugin {
  const { plugin } = hosted;
  const { manifest } = plugin;
  // Every plugin's settings through the studio's one cut: each address is its host, the built-in
  // webhook's endpoints in either form and any other plugin's alike; a variable stays its name.
  // `hostOnly` says where a cut was made.
  const shown = cutSettings(hosted.settings);
  const provides: Record<PluginKind, readonly string[]> = {
    source: Object.keys(plugin.sources),
    action: Object.keys(plugin.actions),
    channel: Object.keys(plugin.channels),
    provider: Object.keys(plugin.providers),
    pack: Object.keys(plugin.packs),
  };
  return {
    name: hosted.name,
    key: keyOf(hosted, options),
    package: hosted.packageName,
    version: manifest.version,
    builtIn: Object.hasOwn(BUILTIN_PLUGINS, hosted.packageName),
    kinds: manifest.kinds,
    provides,
    core: {
      range: manifest.coreVersions,
      holds: satisfies(options.coreVersion, manifest.coreVersions),
    },
    settings: {
      schema: schemaOf(hosted),
      values: shown.value,
      variables: hosted.variables.map(({ path, variable, secret }) => ({
        path,
        variable,
        secret,
        set: isSet(options.env, variable),
      })),
      hostOnly: shown.hostOnly,
    },
  };
}

function packsOf(hosted: HostedPlugin): PackView[] {
  return Object.entries(hosted.plugin.packs).map(([name, pack]) => ({
    plugin: hosted.name,
    package: hosted.packageName,
    name,
    description: pack.description ?? null,
    reads: pack.reads === undefined ? null : [...pack.reads],
    questions: Object.fromEntries(
      pack.questions.map(({ name: question, ...rest }) => [question, rest]),
    ),
    thresholds: pack.thresholds,
  }));
}

/** Whether an entry matches every word of the search, anywhere in its name, package, text or kinds. */
function matches(entry: RegistryIndex["plugins"][number], words: readonly string[]): boolean {
  const text = [entry.name, entry.package, entry.description, ...entry.kinds].join(" ");
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

export function createPluginsDoor(options: PluginsDoorOptions): PluginsDoor {
  const checked = checkRegistryAddress(options.registry);
  // The page is read by every reviewer, so a file registry's path is not among what it is shown.
  const address = checked.usable ? checked.public : "";
  // One read in flight or finished, kept for REGISTRY_CACHE_MS on the injected clock: two requests
  // at once share it, and a failure is kept as long as an index, so an unreachable registry is
  // asked about no more often than a reachable one. `readRegistry` never rejects, so nothing
  // rejected is ever kept.
  let cached: { readonly at: number; readonly read: Promise<RegistryRead> } | undefined;
  const read = (
    usable: Extract<typeof checked, { readonly usable: true }>,
  ): Promise<RegistryRead> => {
    const now = options.clock.now();
    if (cached === undefined || now - cached.at >= REGISTRY_CACHE_MS) {
      cached = { at: now, read: readRegistry(usable, options) };
    }
    return cached.read;
  };

  return {
    facetdb: options.coreVersion,
    installed: () => options.host.all().map((hosted) => installedOf(hosted, options)),
    packs: () => options.host.all().flatMap(packsOf),
    gallery: async (search): Promise<Gallery> => {
      // An address that is refused is never fetched, and nothing is kept for it.
      if (!checked.usable) {
        return { reachable: false, address, why: checked.why };
      }
      const result = await read(checked);
      if ("why" in result) {
        return { reachable: false, address, why: result.why };
      }
      const hosted = new Set(options.host.all().map((plugin) => plugin.packageName));
      const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matching = result.index.plugins.filter((entry) => matches(entry, words));
      const waiting = await nextStarts(matching, hosted, options);
      const plugins: GalleryEntry[] = matching.map((entry) => ({
        name: entry.name,
        package: entry.package,
        description: entry.description,
        kinds: entry.kinds,
        facetdb: entry.facetdb,
        holds: satisfies(options.coreVersion, entry.facetdb),
        verified: entry.verified,
        downloads: entry.downloads,
        homepage: entry.homepage ?? null,
        installed: hosted.has(entry.package),
        nextStart: waiting.get(entry.package) ?? null,
        // The reader checked the name against the short-name rule: nothing else goes in the line.
        command: `facetdb add ${entry.name}`,
      }));
      return { reachable: true, address, plugins };
    },
  };
}
