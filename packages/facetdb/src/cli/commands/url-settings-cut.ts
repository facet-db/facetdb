import {
  type ConfigDraft,
  formatPath,
  isEnvReference,
  type JsonValue,
  type ProjectConfig,
  type ProjectJson,
  type SourceDraft,
  type SourceJson,
  toProjectJson,
} from "../../config/index.ts";

/**
 * The one cut of what the studio is answered: every string inside a plugin's settings, a plugin
 * source's settings and an action's settings that is an address becomes its host, since the
 * userinfo, path or query of an address can carry a token. The rule reads the value, never the
 * setting's name or its plugin, so a setting a plugin adds tomorrow is cut the day it holds an
 * address: the built-in webhook's endpoints in either form (a string, or `{ url, allowPrivate }`),
 * `webhook({ url })` and its `else`, and any community plugin's address alike. The same cut is
 * answered to every reviewer, the operator included: none is made per request.
 *
 * Nothing written changes: `toProjectJson` stays whole (drafts and Apply judge against the file),
 * and a draft built from a cut answer has each cut value put back to the file's own before it is
 * judged (`restoreCut`), so Apply never writes a host where the file holds an address.
 */

/** What a value that holds an address but is not one the parser reads is answered as. */
export const NOT_A_URL = "an address that is not a URL";

/** A value as the studio is answered, and where in it an address was cut (`formatPath`'s form). */
export type Cut<Value> = { readonly value: Value; readonly hostOnly: readonly string[] };

type Path = readonly (string | number)[];
type Entries = { readonly [key: string]: JsonValue };

/**
 * What a page may see of `text`: an address's host, `NOT_A_URL` for text that holds an address the
 * parser does not read (`https://a b/?token=…`, `see https://…`), else the text itself. An address
 * is any text the URL parser reads with a host, whatever its scheme (`https:`, `wss:`, `smtps:`,
 * `postgres:`): a credential rides in any of them. `slack:#ops` and `ops@example.com` have no host
 * and are not addresses.
 */
export function shownText(text: string): string {
  if (URL.canParse(text)) {
    const { host } = new URL(text);
    if (host !== "") {
      return host;
    }
  }
  return text.includes("://") || /^\s*https?:/i.test(text) ? NOT_A_URL : text;
}

function isEntries(value: unknown): value is Entries {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` with every address inside it cut, each place listed relative to `at`'s start. */
function cutAt(value: JsonValue, at: Path, hostOnly: string[]): JsonValue {
  if (typeof value === "string") {
    const shown = shownText(value);
    if (shown !== value) {
      hostOnly.push(formatPath(at));
    }
    return shown;
  }
  // A variable is its name, which is never an address: answered as the file writes it.
  if (isEnvReference(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cutAt(item, [...at, index], hostOnly));
  }
  if (isEntries(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cutAt(item, [...at, key], hostOnly)]),
    );
  }
  return value;
}

/** A plugin's or an action's settings as the studio is answered, the paths relative to them. */
export function cutSettings(settings: Entries, at: Path = []): Cut<Entries> {
  const hostOnly: string[] = [];
  const value = cutAt(settings, at, hostOnly) as Entries;
  return { value, hostOnly };
}

function cutSource(source: SourceJson, index: number, hostOnly: string[]): SourceJson {
  const actions = source.actions.map((action, at) => {
    const cut = cutSettings(action.config, ["sources", index, "actions", at, "config"]);
    hostOnly.push(...cut.hostOnly);
    return { ...action, config: cut.value };
  });
  const plugin = source.source;
  if (plugin === undefined) {
    return { ...source, actions };
  }
  const settings = cutSettings(plugin.settings, ["sources", index, "source", "settings"]);
  hostOnly.push(...settings.hostOnly);
  return { ...source, actions, source: { ...plugin, settings: settings.value } };
}

/**
 * `GET /v1/config`'s project JSON: `json` with each plugin's settings, each plugin source's settings
 * and each action's settings cut, and `hostOnly` naming every place cut, in the project JSON's path
 * form (`plugins.webhook.endpoints.ops`, `sources[0].actions[1].config.else.url`). Everything else
 * is the export's own: a connection is its variable's name, a channel its address, and `modelUrl`
 * and `studioUrl` hold no credential by the schema.
 */
export function cutProjectJson(json: ProjectJson): ProjectJson & {
  readonly hostOnly: readonly string[];
} {
  const hostOnly: string[] = [];
  const plugins =
    json.plugins === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(json.plugins).map(([key, settings]) => {
            const cut = cutSettings(settings, ["plugins", key]);
            hostOnly.push(...cut.hostOnly);
            return [key, cut.value];
          }),
        );
  const sources = json.sources.map((source, index) => cutSource(source, index, hostOnly));
  return { ...json, ...(plugins === undefined ? {} : { plugins }), sources, hostOnly };
}

/**
 * `sent` with every value that is the cut of the file's value at the same place put back to the
 * file's value. Only a value the cut changed is put back, only where the file holds it, and only
 * the very text the cut answered: a list is matched place by place, and only when it is as long as
 * the file's, so no address moves to another place. Anything else is the draft's, judged as sent.
 */
function restoredAt(whole: unknown, sent: unknown): unknown {
  if (typeof whole === "string") {
    const shown = shownText(whole);
    return shown !== whole && sent === shown ? whole : sent;
  }
  if (Array.isArray(whole)) {
    const items: readonly unknown[] = whole;
    return Array.isArray(sent) && sent.length === items.length
      ? sent.map((item: unknown, index) => restoredAt(items[index], item))
      : sent;
  }
  if (isRecord(whole) && isRecord(sent)) {
    return Object.fromEntries(
      Object.entries(sent).map(([key, item]) => [
        key,
        restoredAt(Object.hasOwn(whole, key) ? whole[key] : undefined, item),
      ]),
    );
  }
  return sent;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A draft built from a cut answer, with the file's own values back where the cut changed them: a
 * project draft's `plugins` against the file's `plugins`, a source draft's `actions` and plugin
 * `source` against the file's source of that name. Apply and the validation then judge what the
 * file holds, so a draft that only carried the answer back changes nothing there, and an address is
 * never written as its host.
 */
export function restoreCut(file: ProjectConfig, draft: ConfigDraft): ConfigDraft {
  const json = toProjectJson(file);
  if ("project" in draft) {
    const { plugins } = draft.project;
    if (!isRecord(plugins) || json.plugins === undefined) {
      return draft;
    }
    const own = json.plugins;
    const restored = Object.fromEntries(
      Object.entries(plugins).map(([key, settings]) => [
        key,
        Object.hasOwn(own, key) ? restoredAt(own[key], settings) : settings,
      ]),
    );
    return { project: { ...draft.project, plugins: restored } };
  }
  return { source: restoreSourceCut(json, draft.source) };
}

/** A source draft with its `actions` and `source` put back where they are the file's cut. */
export function restoreSourceCut(json: ProjectJson, draft: SourceDraft): SourceDraft {
  const before = json.sources.find((source) => source.name === draft.name);
  if (before === undefined) {
    return draft;
  }
  const sent: Readonly<Record<string, unknown>> = draft;
  return {
    ...draft,
    ...(Object.hasOwn(sent, "actions")
      ? { actions: restoredAt(before.actions, sent["actions"]) }
      : {}),
    ...(Object.hasOwn(sent, "source") && before.source !== undefined
      ? { source: restoredAt(before.source, sent["source"]) }
      : {}),
  };
}
