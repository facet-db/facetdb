import { dirname, resolve } from "node:path";
import { formatPath, type ProjectConfig, pluginVariables } from "../../config/index.ts";
import {
  BUILTIN_PLUGINS,
  channelsOf,
  type PluginHost,
  packageNames,
  shortName,
} from "../../plugin/index.ts";
import type { CliDeps } from "../program.ts";

/**
 * What waits for the worker's restart: plugin code loads only when a worker starts, so a plugin the
 * config file names since is not in force until then. Read from files alone, never by loading a
 * plugin: the project's package.json, each package's own package.json under node_modules (as data,
 * never through a link, a size cap, unreadable meaning not installed), and the config file's names.
 * The Apply door and the setup flow refuse a write while the file names such a plugin, since the
 * reload would put the write back; the Plugins page says which gallery entries load at the next
 * start.
 */

type Files = Pick<CliDeps["workspace"], "peek" | "lines">;
type Env = Readonly<Record<string, string | undefined>>;

/** The most of a package.json read: a real one is a few KB (as `facetdb add` reads one). */
const MAX_PACKAGE_JSON = 1_000_000;

/** A JSON file of the project's tree, as data; undefined when it is not a regular file, too large or not JSON. */
async function readJson(files: Files, path: string): Promise<unknown> {
  const found = await files.peek(path).catch(() => undefined);
  if (found?.kind !== "file" || (found.bytes ?? 0) > MAX_PACKAGE_JSON) {
    return undefined;
  }
  let text = "";
  try {
    for await (const line of files.lines(path)) {
      text += `${line}\n`;
      if (text.length > MAX_PACKAGE_JSON) {
        return undefined;
      }
    }
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isEntries(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The packages the project's package.json lists in `dependencies`, where `facetdb add` puts a plugin. */
export async function dependenciesOf(files: Files): Promise<ReadonlySet<string>> {
  const parsed = await readJson(files, "package.json");
  const dependencies = isEntries(parsed) ? parsed["dependencies"] : undefined;
  return new Set(isEntries(dependencies) ? Object.keys(dependencies) : []);
}

/**
 * Whether `specifier` is installed where the worker would import it from: the first
 * `node_modules/<specifier>/package.json` from the project's directory up, as Node resolves it,
 * that names the package. A built-in plugin is always there.
 */
export async function installed(
  files: Files,
  projectDir: string,
  specifier: string,
): Promise<boolean> {
  if (Object.hasOwn(BUILTIN_PLUGINS, specifier)) {
    return true;
  }
  for (let level = 0; ; level += 1) {
    const prefix = "../".repeat(level);
    const path = `${prefix}node_modules/${specifier}/package.json`;
    const found = await files.peek(path).catch(() => undefined);
    if (found !== undefined && found.kind !== "none") {
      const parsed = await readJson(files, path);
      return isEntries(parsed) && parsed["name"] === specifier;
    }
    const directory = resolve(projectDir, prefix);
    if (dirname(directory) === directory) {
      return false;
    }
  }
}

/** The packages a name the config uses may stand for: itself, or a short name's two. */
function packagesOf(name: string): readonly string[] {
  return shortName(name) === name ? packageNames(name) : [name];
}

/** One plugin the file names that the running worker did not load: where, and the variables it reads. */
export type WaitingPlugin = {
  /** Its short name: `slack`. */
  readonly name: string;
  /** The names the file uses for it (`slack`, `@facetdb/slack`). */
  readonly named: readonly string[];
  /** Where the file names it: `plugins.slack`, `slack:#ops`. */
  readonly places: readonly string[];
  /** The variables its entry in `plugins` reads. */
  readonly variables: readonly string[];
};

/**
 * The plugins `config` names, in `plugins` or as an alert channel's kind, that `host` did not load
 * when the worker started: what a reload refuses the whole file for (`rehost`, the channel binding).
 */
export function waitingPlugins(host: PluginHost, config: ProjectConfig): readonly WaitingPlugin[] {
  const found = new Map<string, { named: Set<string>; places: string[]; variables: Set<string> }>();
  const add = (name: string, place: string) => {
    if (host.plugin(name) !== undefined) {
      return;
    }
    const short = shortName(name) ?? name;
    const entry = found.get(short) ?? { named: new Set(), places: [], variables: new Set() };
    entry.named.add(name);
    entry.places.push(place);
    found.set(short, entry);
    return entry;
  };
  const variables = pluginVariables(config);
  for (const key of Object.keys(config.plugins ?? {})) {
    const entry = add(key, formatPath(["plugins", key]));
    for (const { plugin, variable } of variables) {
      if (plugin === key) {
        entry?.variables.add(variable);
      }
    }
  }
  for (const binding of channelsOf(config)) {
    add(binding.kind, binding.address);
  }
  return [...found].map(([name, entry]) => ({
    name,
    named: [...entry.named],
    places: entry.places,
    variables: [...entry.variables],
  }));
}

/** `a`, `a and b`, `a, b and c`. */
export function listed(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1) as string}`;
}

export function isSet(env: Env, variable: string): boolean {
  const value = env[variable];
  return value !== undefined && value !== "";
}

/**
 * Why nothing can be applied until the worker restarts, in words for whoever reads the studio, or
 * undefined when `waiting` is empty. It says what the restart needs and no more: an install for a
 * package that is not there, a variable that is not set (by its name, never a value), then the
 * restart, or the hand edit that takes the plugin out of the file.
 */
export async function restartWords(
  waiting: readonly WaitingPlugin[],
  look: { readonly files: Files; readonly projectDir: string; readonly env: Env },
): Promise<{ readonly message: string; readonly fix: string } | undefined> {
  if (waiting.length === 0) {
    return undefined;
  }
  const states = await Promise.all(
    waiting.map(async (plugin) => {
      const there = await Promise.all(
        plugin.named.flatMap(packagesOf).map((pkg) => installed(look.files, look.projectDir, pkg)),
      );
      return { ...plugin, there: there.some(Boolean) };
    }),
  );
  const one = states.length === 1;
  const names = listed(states.map((state) => state.name));
  const missing = states.filter((state) => !state.there).map((state) => state.name);
  const unset = [
    ...new Set(states.flatMap((state) => state.variables.filter((name) => !isSet(look.env, name)))),
  ];
  const head = `facetdb.config.ts names the plugin${one ? "" : "s"} ${names}`;
  const message =
    missing.length === 0
      ? `${head}, which ${one ? "loads" : "load"} when facetdb worker restarts${unset.length === 0 ? "" : ` with ${listed(unset)} set`}; nothing can be applied until then.`
      : one
        ? `${head}, which is not installed; nothing can be applied until it is and facetdb worker restarts.`
        : `${head}, which load only when facetdb worker restarts, and ${listed(missing)} ${missing.length === 1 ? "is" : "are"} not installed; nothing can be applied until then.`;
  const steps = [
    ...(missing.length === 0
      ? []
      : [`run ${missing.map((name) => `facetdb add ${name}`).join(" and ")} in the project`]),
    ...(unset.length === 0 ? [] : [`set ${listed(unset)}`]),
  ];
  const places = listed(states.flatMap((state) => state.places));
  const fix = `Whoever runs the worker: ${steps.length === 0 ? "restart it" : `${steps.join(", ")} and restart it`}, or take ${places} out of the file.`;
  return { message, fix };
}
