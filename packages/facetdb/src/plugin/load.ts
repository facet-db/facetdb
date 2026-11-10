import { isPlugin, type Plugin, PluginError, shortName } from "./define.ts";
import { satisfies } from "./semver.ts";

export type LoadPluginOptions = {
  /** The version of FacetDB core that is running, checked against the plugin's `facetdb` range. */
  readonly coreVersion: string;
  /** Imports a package by specifier. The composition root passes `(s) => import(s)`; tests a fake. */
  readonly importModule: (specifier: string) => Promise<unknown>;
};

const NOT_FOUND = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

/**
 * Finds a plugin by its short name (`github`) or package name and checks it against core. A short
 * name tries `@facetdb/<name>` first, then `facetdb-plugin-<name>`. A plugin whose `facetdb` range
 * excludes `coreVersion` is refused with the field named.
 */
export async function loadPlugin(spec: string, options: LoadPluginOptions): Promise<Plugin> {
  const short = shortName(spec);
  if (short === undefined) {
    throw new PluginError(`The plugin "${spec}"`, [
      {
        field: "name",
        message:
          "a plugin is named `github`, `@facetdb/github` or `facetdb-plugin-github`; install it with `facetdb add <name>`",
      },
    ]);
  }
  const candidates = spec === short ? [`@facetdb/${short}`, `facetdb-plugin-${short}`] : [spec];

  let loaded: { readonly specifier: string; readonly module: unknown } | undefined;
  for (const specifier of candidates) {
    try {
      loaded = { specifier, module: await options.importModule(specifier) };
      break;
    } catch (error) {
      // Only "this package is not installed" moves on; a plugin that throws while loading is broken.
      if (!(error instanceof Error && NOT_FOUND.has((error as { code?: string }).code ?? ""))) {
        throw error;
      }
    }
  }
  if (loaded === undefined) {
    throw new PluginError(`The plugin "${spec}"`, [
      {
        field: "name",
        message: `no package ${candidates.map((c) => `\`${c}\``).join(" or ")} is installed; run \`facetdb add ${short}\``,
      },
    ]);
  }

  const exported = (loaded.module as { default?: unknown } | null)?.default;
  if (!isPlugin(exported)) {
    throw new PluginError(`The package "${loaded.specifier}"`, [
      {
        field: "default export",
        message:
          "is not a plugin: it must export the result of `definePlugin` from `facetdb/plugin`",
      },
    ]);
  }
  if (shortName(exported.manifest.name) !== short) {
    throw new PluginError(`The package "${loaded.specifier}"`, [
      {
        field: "name",
        message: `the plugin inside calls itself "${exported.manifest.name}", not "${short}"`,
      },
    ]);
  }
  if (!satisfies(options.coreVersion, exported.manifest.coreVersions)) {
    throw new PluginError(`The plugin "${loaded.specifier}" ${exported.manifest.version}`, [
      {
        field: "facetdb",
        message: `supports FacetDB ${exported.manifest.coreVersions}, but this is FacetDB ${options.coreVersion}; install a version of the plugin that supports it, or upgrade or downgrade facetdb`,
      },
    ]);
  }
  return exported;
}
