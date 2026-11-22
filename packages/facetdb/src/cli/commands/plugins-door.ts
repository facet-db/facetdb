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
import {
  type HostedPlugin,
  type PluginHost,
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

/**
 * The CLI's door for the studio's Plugins page: the plugins the host loaded when the config did,
 * the registry's gallery through the one registry reader (`cli/registry`, shared with `facetdb
 * add`), and the packs of the hosted plugins. What leaves is data for the page: a variable is its
 * name and whether the environment has it, never its value; the registry's text is from outside and
 * is handed on as text, and the command beside an entry is built from its checked short name alone
 * (nothing is installed from a page).
 */

export { DEFAULT_REGISTRY, REGISTRY_TIMEOUT_MS, registryAddress };

/** The worker reads the index at most this often, an unreachable registry included. */
export const REGISTRY_CACHE_MS = 10 * 60 * 1000;

export type PluginsDoorOptions = {
  /** The plugins the config names, loaded and checked (`loadWorkerConfig`). */
  readonly host: PluginHost;
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
  /** `CliDeps.workspace`: a registry that is a file is read from the project's directory. */
  readonly workspace: Pick<CliDeps["workspace"], "peek" | "lines">;
  readonly clock: Clock;
};

function isSet(env: PluginsDoorOptions["env"], variable: string): boolean {
  const value = env[variable];
  return value !== undefined && value !== "";
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

function installedOf(hosted: HostedPlugin, options: PluginsDoorOptions): InstalledPlugin {
  const { plugin } = hosted;
  const { manifest } = plugin;
  const provides: Record<PluginKind, readonly string[]> = {
    source: Object.keys(plugin.sources),
    action: Object.keys(plugin.actions),
    channel: Object.keys(plugin.channels),
    provider: Object.keys(plugin.providers),
    pack: Object.keys(plugin.packs),
  };
  return {
    name: hosted.name,
    package: hosted.packageName,
    version: manifest.version,
    kinds: manifest.kinds,
    provides,
    core: {
      range: manifest.coreVersions,
      holds: satisfies(options.coreVersion, manifest.coreVersions),
    },
    settings: {
      schema: schemaOf(hosted),
      values: hosted.settings,
      variables: hosted.variables.map(({ path, variable, secret }) => ({
        path,
        variable,
        secret,
        set: isSet(options.env, variable),
      })),
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
      const plugins: GalleryEntry[] = result.index.plugins
        .filter((entry) => matches(entry, words))
        .map((entry) => ({
          name: entry.name,
          package: entry.package,
          description: entry.description,
          kinds: entry.kinds,
          facetdb: entry.facetdb,
          verified: entry.verified,
          downloads: entry.downloads,
          homepage: entry.homepage ?? null,
          installed: hosted.has(entry.package),
          // The reader checked the name against the short-name rule: nothing else goes in the line.
          command: `facetdb add ${entry.name}`,
        }));
      return { reachable: true, address, plugins };
    },
  };
}
