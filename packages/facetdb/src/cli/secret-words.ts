import { hideSecrets, type SecretPart, secretParts, secretValueParts } from "@facetdb/server";
import type { ProjectConfig } from "../config/index.ts";
import type { PluginHost } from "../plugin/index.ts";
import { presetKeyOf } from "./commands/model-provider.ts";
import { CliError } from "./program.ts";
import { STORE_SECRET_VARIABLE, STORE_VARIABLE } from "./store-door.ts";

/**
 * The one hide of the worker's words. A driver's or a plugin's message can quote a connection
 * string, its password, its user and host, or a secret variable's value; every such word the worker
 * prints, logs, raises in an alert or serves the studio passes through the hide `createHide` builds
 * over `secretsOf`, and each secret becomes `[hidden]` with the rest of the sentence intact. The
 * host (with its port, when written `host:port`) and the user hide as whole words, as `secretParts`
 * hides them; a database's name and a driver's error code stay readable. Only an error's own
 * message is ever worded: its `cause` chain and an `AggregateError`'s errors never reach a reader.
 */

/** Words with every secret in force hidden. */
export type Hide = (text: string) => string;

/**
 * An error's words for a reader. A `CliError` is FacetDB's own sentence and fix, which never quote
 * a secret (the outside words one carries are hidden when it is built), so it stays whole: a short
 * secret that is an ordinary word (`facetdb`, `postgres`) never eats "facetdb doctor". Any other
 * error's message is a driver's, an engine's, a plugin's, the system's or the model provider's,
 * and goes through `hide`. Only the message is read: a `cause` or an `AggregateError`'s errors
 * never reach a reader.
 */
export function outsideWords(error: unknown, hide: Hide): string {
  if (error instanceof CliError) {
    return error.message;
  }
  return hide(error instanceof Error ? error.message : String(error));
}

/** The model's key when the config names no preset: the built-in TypeSafe provider's. */
const MODEL_KEY_VARIABLE = "TYPESAFE_API_KEY";

/**
 * What must never be shown back, for one config: the parts of the store's connection string and of
 * every source's, and the value of every variable the config makes a secret (each hosted plugin's
 * secret settings, the built-in webhook's signing secret among them; the model provider's key; the
 * store's own `FACETDB_SECRET`).
 */
export function secretsOf(from: {
  readonly config: ProjectConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly plugins: Pick<PluginHost, "all">;
}): readonly SecretPart[] {
  const { config, env, plugins } = from;
  const strings = [env[STORE_VARIABLE], ...config.sources.map((source) => source.database)];
  const variables = [
    STORE_SECRET_VARIABLE,
    MODEL_KEY_VARIABLE,
    presetKeyOf(config)?.variable,
    ...plugins
      .all()
      .flatMap((hosted) => hosted.variables.filter((named) => named.secret))
      .map((named) => named.variable),
  ];
  return [
    ...strings.flatMap((url) => (url === undefined || url === "" ? [] : secretParts(url))),
    ...variables.flatMap((variable) => {
      const value = variable === undefined ? undefined : env[variable];
      return value === undefined || value === "" ? [] : secretValueParts(value);
    }),
  ];
}

/**
 * The worker's hide over every config it loads: `loaded` takes the start's and each reload's as it
 * loads, and again once a reload puts its plugin settings in force, and the hide covers the secrets
 * of every one, never dropped. A source new in the file is hidden before it is in force, and one a
 * reload removed is still hidden in the words its closing loop leaves.
 */
export function hideOverLoads(from: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly plugins: Pick<PluginHost, "all">;
}): { readonly hide: Hide; readonly loaded: (config: ProjectConfig) => ProjectConfig } {
  // Keyed by the parts themselves, so a reload that changes nothing secret adds nothing.
  const seen = new Map<string, readonly SecretPart[]>();
  return {
    hide: createHide(() => [...seen.values()].flat()),
    loaded: (config) => {
      const parts = secretsOf({ config, env: from.env, plugins: from.plugins });
      seen.set(JSON.stringify(parts), parts);
      return config;
    },
  };
}

/**
 * The hide over `parts`, which it asks at every call, so a secret a reload brought in force is
 * hidden from its first word. A part answered by several sources hides as the widest asks (inside
 * a word, when any one says so); the longest goes first, so a part inside another goes with it.
 */
export function createHide(parts: () => readonly SecretPart[]): Hide {
  return (text) => {
    const anywhere = new Map<string, boolean>();
    for (const part of parts()) {
      anywhere.set(part.text, anywhere.get(part.text) === true || !part.bounded);
    }
    const ordered = [...anywhere]
      .map(([partText, wide]) => ({ text: partText, bounded: !wide }))
      .sort((a, b) => b.text.length - a.text.length);
    return hideSecrets(text, ordered);
  };
}
