import type { PluginKind, Question, ThresholdOverride } from "@facetdb/core";

/**
 * The CLI's door for the studio's Plugins page: the plugins the worker hosts, the registry's
 * gallery and the question packs of the hosted plugins. Only the `facetdb` package can build one
 * (the plugin host imports the plugins, the registry reader checks the index), so the server is
 * handed these plain operations and never imports that package. Everything here is data for the
 * page: a variable is its name and whether it is set, never its value, and the registry's words are
 * text from outside.
 */

/** A JSON value the page reads and the server does not look inside: a schema, a setting. */
export type JsonObject = { readonly [key: string]: unknown };

/** One variable a plugin's settings name: where it is written, its name, and whether it is set. */
export type PluginVariableView = {
  /** Inside the plugin's settings: `token`, `auth.password`, `hooks[0].secret`. */
  readonly path: string;
  /** The variable's name. Its value is never part of any response. */
  readonly variable: string;
  /** Whether the plugin's schema marks the field as a secret (`z.secret()`). */
  readonly secret: boolean;
  /** Whether the worker's environment has a non-empty value for it. */
  readonly set: boolean;
};

/** A plugin the config names, loaded and with its settings checked. */
export type InstalledPlugin = {
  /** The short name: `github`. */
  readonly name: string;
  /**
   * The key the config writes its settings under in `plugins` (`github`, or `@facetdb/github` where
   * the file names it so): what a studio draft names it by. Its short name when the config gives it
   * no settings.
   */
  readonly key: string;
  /** The package it came from: `@facetdb/github`. */
  readonly package: string;
  readonly version: string;
  /** Shipped inside facetdb (the webhook), so its version is facetdb's own. */
  readonly builtIn: boolean;
  readonly kinds: readonly PluginKind[];
  /** The names of what it provides, by kind: `{ source: ["issues"], action: ["label"], ... }`. */
  readonly provides: { readonly [kind in PluginKind]: readonly string[] };
  /** The range of FacetDB core versions it supports, and whether this one is inside it. */
  readonly core: { readonly range: string; readonly holds: boolean };
  readonly settings: {
    /**
     * The settings schema as a JSON schema (zod's own conversion of the manifest's one schema; a
     * secret field carries `"secret": true`, and one the plugin marks `z.editable()` carries
     * `"editable": true`, the only settings a studio draft may change), or null when zod cannot
     * write it as one.
     */
    readonly schema: JsonObject | null;
    /**
     * The settings as the config file writes them: a variable is `{ "env": "NAME" }`, and an
     * address at a `hostOnly` path is its host alone.
     */
    readonly values: JsonObject;
    readonly variables: readonly PluginVariableView[];
    /**
     * Where `values` holds an address cut to its host, in `variables`' path form: any setting of
     * any plugin that holds an address, whose userinfo, path or query can carry a token, so this
     * answer never carries the rest of such an address. `GET /v1/config` answers the same cut.
     */
    readonly hostOnly: readonly string[];
  };
};

/** A registry entry as the gallery shows it. Its text is from outside: data, never markup or a command. */
export type GalleryEntry = {
  /** The short name, checked by the registry reader. */
  readonly name: string;
  readonly package: string;
  readonly description: string;
  readonly kinds: readonly PluginKind[];
  /** The range of FacetDB core versions the entry says it supports. */
  readonly facetdb: string;
  /** Whether that range holds for the FacetDB this worker runs: `facetdb add` refuses it where not. */
  readonly holds: boolean;
  readonly verified: boolean;
  readonly downloads: number;
  readonly homepage: string | null;
  /** Whether the worker hosts a plugin from this entry's package. */
  readonly installed: boolean;
  /**
   * Set when the worker loads this entry's package at its next start and not before: the project's
   * package.json lists it in `dependencies`, it is installed under node_modules, the config file
   * names it, its range holds, and the running worker did not load it; `unset` names the variables
   * the file names for it that are not set where the worker runs, which a start would stop on
   * (names only, never a value). Read from those files alone, never by loading the plugin. Null
   * otherwise.
   */
  readonly nextStart: { readonly unset: readonly string[] } | null;
  /** `facetdb add <name>`, built from the checked short name alone. */
  readonly command: string;
};

export type Gallery =
  | {
      readonly reachable: true;
      readonly address: string;
      readonly plugins: readonly GalleryEntry[];
    }
  | {
      readonly reachable: false;
      /** The address that was tried, without any credentials or query it held. */
      readonly address: string;
      /** In words: the registry could not be reached or its index could not be read. */
      readonly why: string;
    };

/** One question pack of a hosted plugin, in the shape a source draft's questions take. */
export type PackView = {
  /** The plugin's short name and package. */
  readonly plugin: string;
  readonly package: string;
  readonly name: string;
  readonly description: string | null;
  /** The state fields its questions read, as the pack declares them; null when it does not say. */
  readonly reads: readonly string[] | null;
  /** By question name, as `POST /v1/config/validate`'s source draft writes them. */
  readonly questions: { readonly [name: string]: Omit<Question, "name"> };
  readonly thresholds: { readonly [question: string]: ThresholdOverride };
};

export type PluginsDoor = {
  /** The FacetDB this worker runs, which each plugin's core range is held against. */
  readonly facetdb: string;
  /** Every plugin the worker hosts, in the order the config first names each. */
  installed(): readonly InstalledPlugin[];
  /** The registry's entries that match `search` (every word of it, anywhere in an entry); all when absent. */
  gallery(search: string | undefined): Promise<Gallery>;
  /** The packs of the hosted plugins. */
  packs(): readonly PackView[];
};

/**
 * A surface with no plugin host (a test's app): every list is empty, the registry is not asked, and
 * no FacetDB version is named, there being no range to hold against one.
 */
export const NO_PLUGINS: PluginsDoor = {
  facetdb: "",
  installed: () => [],
  gallery: () => Promise.resolve({ reachable: true, address: "", plugins: [] }),
  packs: () => [],
};
