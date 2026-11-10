import {
  PLUGIN_KINDS,
  type PluginKind,
  type PluginManifest,
  parseQuestionSet,
} from "@facetdb/core";
import { ZodObject, type ZodType } from "zod";
import type {
  ActionDefinition,
  ChannelDefinition,
  PackDefinition,
  ProviderDefinition,
  SourceDefinition,
} from "./kinds.ts";
import { isValidRange, isValidVersion } from "./semver.ts";
import { type Infer, isSecretField } from "./zod.ts";

/** What an author passes to `definePlugin`. */
export type PluginDefinition<Schema extends ZodObject> = {
  /** `github` for `@facetdb/github` or `facetdb-plugin-github`; the full package name is accepted too. */
  readonly name: string;
  /** The plugin's own version, as semver. */
  readonly version: string;
  /** The range of FacetDB core versions the plugin supports, as semver: `^1.0.0`. */
  readonly facetdb: string;
  /** The one schema that validates the config file and draws the dashboard's settings form. */
  readonly config: Schema;
  readonly sources?: { readonly [name: string]: SourceDefinition<Infer<Schema>> };
  readonly actions?: { readonly [name: string]: ActionDefinition<Infer<Schema>> };
  readonly channels?: { readonly [name: string]: ChannelDefinition<Infer<Schema>> };
  readonly providers?: { readonly [name: string]: ProviderDefinition<Infer<Schema>> };
  readonly packs?: { readonly [name: string]: PackDefinition };
};

/** A defined plugin: its manifest, and what it provides by name. */
export type Plugin<Config = unknown> = {
  readonly [PLUGIN_BRAND]: true;
  readonly manifest: PluginManifest;
  readonly sources: { readonly [name: string]: SourceDefinition<Config> };
  readonly actions: { readonly [name: string]: ActionDefinition<Config> };
  readonly channels: { readonly [name: string]: ChannelDefinition<Config> };
  readonly providers: { readonly [name: string]: ProviderDefinition<Config> };
  readonly packs: { readonly [name: string]: PackDefinition };
};

/** `Symbol.for`, so a plugin built by another copy of this package is still recognised by the loader. */
export const PLUGIN_BRAND: unique symbol = Symbol.for("facetdb.plugin");

export type PluginIssue = {
  /** The field of the definition that is wrong: `config`, `facetdb`, `sources.issues`. */
  readonly field: string;
  readonly message: string;
};

/** A plugin definition that cannot be used. The message names every field and what to do. */
export class PluginError extends Error {
  readonly issues: readonly PluginIssue[];

  constructor(subject: string, issues: readonly PluginIssue[]) {
    super(
      [`${subject} is not valid:`, ...issues.map((i) => `  - ${i.field}: ${i.message}`)].join("\n"),
    );
    this.name = "PluginError";
    this.issues = issues;
  }
}

const SHORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENTRY_NAME = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const PACKAGE_PREFIXES = ["@facetdb/", "facetdb-plugin-"] as const;

/** `@facetdb/github` and `facetdb-plugin-github` are both `github`; a bare `github` is itself. */
export function shortName(name: string): string | undefined {
  const short = PACKAGE_PREFIXES.reduce((rest, prefix) => rest.replace(prefix, ""), name);
  return SHORT_NAME.test(short) &&
    (short === name || PACKAGE_PREFIXES.some((p) => name.startsWith(p)))
    ? short
    : undefined;
}

export function definePlugin<Schema extends ZodObject>(
  definition: PluginDefinition<Schema>,
): Plugin<Infer<Schema>> {
  // Plugins are written in JavaScript too, and a plugin is third-party code: the definition is a
  // boundary, so every field is checked here and not trusted from its type.
  const input: Readonly<Record<string, unknown>> = definition;
  const issues: PluginIssue[] = [];

  const name = input["name"];
  if (typeof name !== "string" || shortName(name) === undefined) {
    issues.push({
      field: "name",
      message:
        'must be the short name ("github") or the package name (`@facetdb/github`, `facetdb-plugin-github`), in lowercase letters, digits and dashes',
    });
  }
  const version = input["version"];
  if (typeof version !== "string" || !isValidVersion(version)) {
    issues.push({
      field: "version",
      message: 'must be a semver version such as "1.0.0"',
    });
  }
  const range = input["facetdb"];
  if (typeof range !== "string" || !isValidRange(range)) {
    issues.push({
      field: "facetdb",
      message:
        'must be the semver range of FacetDB core versions the plugin supports, such as "^1.0.0"',
    });
  }
  const config = input["config"];
  if (!(config instanceof ZodObject)) {
    issues.push({
      field: "config",
      message:
        config === undefined
          ? "is missing: a plugin declares one config schema, `z.object({ ... })`, which validates the config file and draws the settings form"
          : "must be a `z.object({ ... })` schema",
    });
  }

  const sources = entries(input, "sources", issues);
  const actions = entries(input, "actions", issues);
  const channels = entries(input, "channels", issues);
  const providers = entries(input, "providers", issues);
  const packs = entries(input, "packs", issues);

  for (const [kind, list] of [
    ["source", sources],
    ["action", actions],
    ["channel", channels],
    ["provider", providers],
    ["pack", packs],
  ] as const) {
    for (const [entry, value] of Object.entries(list)) {
      checkEntry(kind, entry, value, issues);
    }
  }

  const kinds = PLUGIN_KINDS.filter(
    (kind): kind is PluginKind =>
      Object.keys(
        { source: sources, action: actions, channel: channels, provider: providers, pack: packs }[
          kind
        ],
      ).length > 0,
  );
  if (kinds.length === 0) {
    issues.push({
      field: "sources",
      message:
        "a plugin provides at least one of sources, actions, channels, providers or packs; none is declared",
    });
  }

  if (issues.length > 0 || !(config instanceof ZodObject)) {
    throw new PluginError(
      `The plugin ${typeof name === "string" ? `"${name}"` : "definition"}`,
      issues,
    );
  }

  const secrets = Object.entries(config.shape as Record<string, ZodType>)
    .filter(([, field]) => isSecretField(field))
    .map(([field]) => field);

  return {
    [PLUGIN_BRAND]: true,
    manifest: {
      name: name as string,
      version: version as string,
      kinds,
      secrets,
      config,
      coreVersions: range as string,
    },
    sources,
    actions,
    channels,
    providers,
    packs,
  } as Plugin<Infer<Schema>>;
}

/** True for a value `definePlugin` returned, whichever copy of this package built it. */
export function isPlugin(value: unknown): value is Plugin {
  return typeof value === "object" && value !== null && PLUGIN_BRAND in value;
}

function entries(
  input: Readonly<Record<string, unknown>>,
  field: string,
  issues: PluginIssue[],
): Readonly<Record<string, unknown>> {
  const value = input[field];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ field, message: "must be an object of definitions keyed by name" });
    return {};
  }
  return value as Record<string, unknown>;
}

const KIND_HELPER: Readonly<Record<PluginKind, string>> = {
  source: "source({ watch, read, scan })",
  action: "action({ config, run })",
  channel: "channel({ config, deliver })",
  provider: "provider({ config, ask })",
  pack: "pack({ questions })",
};

const REQUIRED_FUNCTIONS: Readonly<Record<PluginKind, readonly string[]>> = {
  source: ["watch", "read", "scan"],
  action: ["run"],
  channel: ["deliver"],
  provider: ["ask"],
  pack: [],
};

function checkEntry(kind: PluginKind, name: string, value: unknown, issues: PluginIssue[]): void {
  const field = `${kind}s.${name}`;
  if (!ENTRY_NAME.test(name)) {
    issues.push({
      field,
      message: "the name must use lowercase letters, digits, dashes and underscores",
    });
  }
  const definition = value as Readonly<Record<string, unknown>> | null;
  if (typeof definition !== "object" || definition === null || definition["kind"] !== kind) {
    issues.push({ field, message: `must be made with ${KIND_HELPER[kind]}` });
    return;
  }
  for (const method of REQUIRED_FUNCTIONS[kind]) {
    if (typeof definition[method] !== "function") {
      issues.push({ field: `${field}.${method}`, message: "is missing: it must be a function" });
    }
  }
  if (
    (kind === "action" || kind === "channel" || kind === "provider") &&
    !(definition["config"] instanceof ZodObject)
  ) {
    issues.push({
      field: `${field}.config`,
      message: "is missing: declare the settings of one use as `z.object({ ... })`",
    });
  }
  if (kind === "pack") {
    const parsed = parseQuestionSet({
      questions: definition["questions"],
      // A pack brings questions and their thresholds; the fields and the model belong to the
      // source that uses it, so the checks that need them run on placeholders.
      read: ["text"],
      model: "jev-1.14.0",
      thresholds: definition["thresholds"],
    });
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        issues.push({ field, message: error });
      }
    }
  }
}
