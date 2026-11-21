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
  RegistryError,
  type RegistryIndex,
  readRegistryIndex,
  satisfies,
} from "../../plugin/index.ts";

/**
 * The CLI's door for the studio's Plugins page: the plugins the host loaded when the config did,
 * the registry's gallery through the index reader, and the packs of the hosted plugins. What leaves
 * is data for the page: a variable is its name and whether the environment has it, never its value;
 * the registry's text is from outside and is handed on as text, and the command beside an entry is
 * built from its checked short name alone (nothing is installed from a page).
 */

/** Where `facetdb add` reads the registry unless `FACETDB_REGISTRY` names another. */
export const DEFAULT_REGISTRY = "https://registry.facetdb.dev/index.json";

/** The registry's address as `facetdb add` resolves it: `FACETDB_REGISTRY`, else the default. */
export function registryAddress(env: Readonly<Record<string, string | undefined>>): string {
  const named = env["FACETDB_REGISTRY"];
  return named === undefined || named === "" ? DEFAULT_REGISTRY : named;
}

/** The worker reads the index at most this often, an unreachable registry included. */
export const REGISTRY_CACHE_MS = 10 * 60 * 1000;
/** One read of the index may take this long. */
export const REGISTRY_TIMEOUT_MS = 10_000;
/** The largest index text read; the real index is a few hundred lines. */
const MAX_INDEX_CHARS = 2_000_000;
/** How many of an index's problems, and how many characters of a reason, the page is told. */
const MAX_PROBLEMS = 3;
const MAX_REASON = 300;

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
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
  /** `CliDeps.abortAfter`. */
  readonly abortAfter: (ms: number) => AbortSignal;
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
    questions: Object.fromEntries(
      pack.questions.map(({ name: question, ...rest }) => [question, rest]),
    ),
    thresholds: pack.thresholds,
  }));
}

/** What the address in `FACETDB_REGISTRY` (or the default) is: one to fetch, shown without its query, or refused. */
type Checked =
  | { readonly usable: true; readonly shown: string }
  | { readonly usable: false; readonly why: string };

/**
 * Judged before anything is fetched, and never echoed: an address that holds a username or a
 * password, is not http or https, or does not parse is refused in fixed words. A usable one is
 * shown without its query and fragment, which may hold a token.
 */
function checkedAddress(address: string): Checked {
  const refused = (why: string): Checked => ({
    usable: false,
    why: `FACETDB_REGISTRY is not an address FacetDB can read (${why}): set it to an http or https address without a username or a password, such as ${DEFAULT_REGISTRY}, or unset it to use that one`,
  });
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return refused("it is not a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refused("it is not an http or https address");
  }
  if (url.username !== "" || url.password !== "") {
    return refused("it holds a username or a password");
  }
  url.search = "";
  url.hash = "";
  return { usable: true, shown: url.href };
}

function cut(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON)}...`;
}

/** What one read of the index came to: the index, or why it could not be had, in words. */
type Read = { readonly index: RegistryIndex } | { readonly why: string };

/**
 * One read of the index. It never rejects, and no word of a caught error reaches the answer: each
 * kind of failure has its own fixed words (what an error says can quote the address, credentials
 * included), and the reader's own problems are bounded text.
 */
async function readIndex(options: PluginsDoorOptions): Promise<Read> {
  const whereToChange =
    options.registry === DEFAULT_REGISTRY ? "; FACETDB_REGISTRY sets another address" : "";
  try {
    let response: Response;
    try {
      response = await options.fetch(options.registry, {
        signal: options.abortAfter(REGISTRY_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        why: timedOut
          ? `the registry did not answer within ${REGISTRY_TIMEOUT_MS / 1000} seconds${whereToChange}`
          : `the registry could not be reached${whereToChange}`,
      };
    }
    if (!response.ok) {
      return {
        why: `the registry answered with HTTP status ${response.status}${whereToChange}`,
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { why: `the registry's answer could not be read to the end${whereToChange}` };
    }
    if (text.length > MAX_INDEX_CHARS) {
      return { why: `the registry's index is larger than ${MAX_INDEX_CHARS} characters` };
    }
    try {
      return { index: readRegistryIndex(text) };
    } catch (error) {
      if (!(error instanceof RegistryError)) {
        return { why: "the registry's index could not be read" };
      }
      const more = error.problems.length - MAX_PROBLEMS;
      const shown = error.problems.slice(0, MAX_PROBLEMS).join("; ");
      return {
        why: cut(
          `the registry's index cannot be read: ${shown}${more > 0 ? `; and ${more} more` : ""}`,
        ),
      };
    }
  } catch {
    // Whatever else failed (the timeout signal's own factory, say): fixed words, nothing kept.
    return { why: "the registry could not be read" };
  }
}

/** Whether an entry matches every word of the search, anywhere in its name, package, text or kinds. */
function matches(entry: RegistryIndex["plugins"][number], words: readonly string[]): boolean {
  const text = [entry.name, entry.package, entry.description, ...entry.kinds].join(" ");
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

export function createPluginsDoor(options: PluginsDoorOptions): PluginsDoor {
  const checked = checkedAddress(options.registry);
  const address = checked.usable ? checked.shown : "";
  // The raw value, wherever it turns up in a reason, is the address as shown: a second layer under
  // the fixed words, for the reader's problems, which quote the index.
  const scrubbed = (why: string): string =>
    options.registry === "" ? why : why.replaceAll(options.registry, () => address);
  // One read in flight or finished, kept for REGISTRY_CACHE_MS on the injected clock: two requests
  // at once share it, and a failure is kept as long as an index, so an unreachable registry is
  // asked about no more often than a reachable one. `readIndex` never rejects, so nothing
  // rejected is ever kept.
  let cached: { readonly at: number; readonly read: Promise<Read> } | undefined;
  const read = (): Promise<Read> => {
    const now = options.clock.now();
    if (cached === undefined || now - cached.at >= REGISTRY_CACHE_MS) {
      cached = { at: now, read: readIndex(options) };
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
      const result = await read();
      if ("why" in result) {
        return { reachable: false, address, why: scrubbed(result.why) };
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
