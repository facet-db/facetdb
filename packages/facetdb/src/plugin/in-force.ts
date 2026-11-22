import { type BoundChannel, processZone } from "@facetdb/core";
import type { TimeSpan } from "@facetdb/server";
import { ZodObject } from "zod";
import {
  type ConfigIssue,
  type DraftPlugins,
  formatPath,
  isEnvReference,
  type ProjectConfig,
  pluginProviderOf,
  type SourceConfig,
  suggestedVariable,
} from "../config/index.ts";
import { type ChannelBinding, channelsOf, checkChannels, type ZoneReader } from "./channel-host.ts";
import { shortName } from "./define.ts";
import {
  type LivePluginHost,
  type PluginHost,
  PluginHostError,
  type PluginHostOptions,
  rehost,
  secretPlaces,
} from "./host.ts";
import { notifyQuiet } from "./notify.ts";
import { editablePaths } from "./zod.ts";

/**
 * A running worker's alert channels and plugin settings, and how a reload puts the file's in force
 * with no restart. At a reload, the plugins whose entry in `plugins` changed are settled again
 * (`rehost`: their schema, their variables, never a literal secret) and every channel is bound
 * again to the plugins as they would then stand (the binding and the quiet hours); only when both
 * hold are they put in force together: the plugin host swapped, the channels handed to the
 * process's alerts (and the notifications' quiet hours with them), and each source that uses a
 * changed plugin restarted by the fleet. When either fails, nothing of the reload is put in force:
 * the fleet keeps running on the config it had, as for a file that does not load, and says why in
 * the host's words, which name a variable and never its value. The plugins themselves are the ones
 * the start loaded: one the file names only since is refused, as at the start, with the command
 * that adds it.
 *
 * The same checks judge a studio draft before any diff (`draftPlugins`), so a draft the reload
 * would not put in force is refused first. A draft changes a plugin's setting only where the
 * plugin's own schema marks it `z.editable()` (deny by default: any other setting can decide where
 * the plugin sends its credential or a record's data, as GitHub's `apiUrl` or an SMTP `host` does);
 * it may not name a plugin the worker does not run, put a value at a path the schema marks secret,
 * or change the settings of the plugin that supplies the model provider (whose settings decide
 * where every record's state is sent, as `modelUrl` does); `judgeDraftProject` itself refuses any
 * `env(...)` the file does not name there. A draft's `alerts` stay the reviewer's to route.
 */

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What a reload made of the file's channels and plugin settings, for the fleet: in force, or not,
 * in which case the fleet keeps running on the config it had, as for a file that does not load.
 */
export type SettingsReload =
  | {
      readonly ok: true;
      /**
       * The plugin, by its package, whose settings changed and that `source` uses (its plugin
       * source or one of its actions): the fleet restarts that source's loop. Undefined for every
       * other source.
       */
      readonly restarts: (source: SourceConfig) => string | undefined;
      /** What the reload says of them, printed and handed back with its summary. */
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      /** Why they cannot be put in force, in the host's words: a variable's name, never its value. */
      readonly message: string;
      readonly fix: string;
    };

export type SettingsInForce = {
  /** The channels in force, as the file wrote them when they were bound: the Alerts page's list. */
  channels(): readonly ChannelBinding[];
  /**
   * The quiet period of a notification batch's channel at an instant (the outbox's `quietPeriod`):
   * the quiet hours of the alert channel in force with the same plugin and address.
   */
  quietPeriod(batchKey: string, at: number): TimeSpan | undefined;
  /** Puts the channels and plugin settings of `next` in force, or keeps those in force and says why. */
  reload(next: ProjectConfig): SettingsReload;
};

export type SettingsInForceDeps = {
  /** The config the worker started with, whose channels were bound at the start. */
  readonly config: ProjectConfig;
  /** The worker's plugin host, swapped when a reload's plugin settings are put in force. */
  readonly host: LivePluginHost;
  readonly env: Env;
  readonly coreVersion: string;
  readonly projectDir: string;
  /**
   * Binds `config`'s channels to the plugins of `host`, as the start bound them (`bindChannels` with
   * the process's outbox, clock and stop); throws the binding's `PluginHostError`.
   */
  readonly bind: (config: ProjectConfig, host: PluginHost) => readonly BoundChannel[];
  /** Hands newly bound channels to the process's alerts (core's `Alerts.rebind`). */
  readonly rebind: (channels: readonly BoundChannel[]) => void;
  /** Reads this machine's time zone for quiet hours with none; absent, the process's. */
  readonly machineZone?: ZoneReader;
};

const NOTHING: SettingsReload = { ok: true, restarts: () => undefined, notes: [] };

/** The plugin, by its package, that a source uses among `changed`; undefined when it uses none. */
function usedAmong(
  host: PluginHost,
  changed: ReadonlySet<string>,
  source: SourceConfig,
): string | undefined {
  const names = [
    ...(source.source === undefined ? [] : [source.source.plugin]),
    ...source.actions.map((action) => action.plugin),
  ];
  return names
    .map((name) => host.plugin(name)?.packageName)
    .find((name): name is string => name !== undefined && changed.has(name));
}

/** "the alert channels", "the plugin settings", or both: what a reload's note speaks of. */
function whatChanged(channels: boolean, plugins: boolean): string {
  if (channels && plugins) {
    return "alert channels and plugin settings";
  }
  return channels ? "alert channels" : "plugin settings";
}

export function createSettingsInForce(deps: SettingsInForceDeps): SettingsInForce {
  const machine = deps.machineZone ?? processZone;
  let bindings = channelsOf(deps.config);
  /** `plugins` as the file wrote it when its settings were last put in force. */
  let plugins = JSON.stringify(deps.config.plugins ?? {});
  /** The notifications' quiet hours: those of the channels in force, read on the live host. */
  let quiet = notifyQuiet(deps.config, deps.host, machine);

  return {
    channels: () => bindings,
    quietPeriod: (batchKey, at) => quiet(batchKey, at),
    reload(next) {
      const nextBindings = channelsOf(next);
      const channelsChanged = JSON.stringify(nextBindings) !== JSON.stringify(bindings);
      const pluginsChanged = JSON.stringify(next.plugins ?? {}) !== plugins;
      if (!channelsChanged && !pluginsChanged) {
        return NOTHING;
      }
      let host: PluginHost;
      let changed: readonly string[];
      let bound: readonly BoundChannel[];
      let quietNext: SettingsInForce["quietPeriod"];
      try {
        ({ host, changed } = rehost(deps.host.current(), next, deps));
        bound = deps.bind(next, host);
        quietNext = notifyQuiet(next, deps.host, machine);
      } catch (error) {
        if (error instanceof PluginHostError) {
          return {
            ok: false,
            message: `the ${whatChanged(channelsChanged, pluginsChanged)} it names cannot be put in force: ${error.message}`,
            fix: error.fix,
          };
        }
        throw error;
      }
      if (changed.length > 0) {
        deps.host.swap(host);
      }
      deps.rebind(bound);
      bindings = nextBindings;
      plugins = JSON.stringify(next.plugins ?? {});
      quiet = quietNext;
      const notes: string[] = [];
      if (channelsChanged) {
        notes.push(
          nextBindings.length === 0
            ? "facetdb.config.ts names no alert channel now, so from now on each alert is recorded on the Alerts page and sent nowhere; no restart was needed."
            : `The alert channels facetdb.config.ts names are in force now, with no restart: each alert from now on goes to the ${nextBindings.length === 1 ? "channel" : `${nextBindings.length} channels`} it names.`,
        );
      }
      if (changed.length > 0) {
        notes.push(
          `The settings of ${changed.map((name) => `the plugin ${name}`).join(", ")} in facetdb.config.ts are in force now, with no restart: each action and notification run from now on is handed them, and each source that uses ${changed.length === 1 ? "it" : "one of them"} finishes the batch in hand with the settings it began with, then restarts on them.`,
        );
        // The model provider is built once, over the plugins the worker started with: its settings
        // decide where every record's state is sent, as modelUrl does, so they wait for a restart.
        const ref = next.provider === undefined ? undefined : pluginProviderOf(next.provider);
        const supplier = ref === undefined ? undefined : host.plugin(ref.plugin)?.packageName;
        if (supplier !== undefined && changed.includes(supplier)) {
          notes.push(
            `The plugin ${supplier} supplies the model provider, which keeps the settings it started with until you restart facetdb worker.`,
          );
        }
      }
      const restarted = new Set(changed);
      return {
        ok: true,
        restarts: (source) =>
          restarted.size === 0 ? undefined : usedAmong(host, restarted, source),
        notes,
      };
    },
  };
}

export type DraftPluginsDeps = Pick<PluginHostOptions, "env" | "coreVersion" | "projectDir"> & {
  /** The plugin host in force (`LivePluginHost.current`): what a draft is judged against. */
  readonly host: () => PluginHost;
  /** Reads this machine's time zone for quiet hours with none; absent, the process's. */
  readonly machineZone?: ZoneReader;
};

type Path = readonly (string | number)[];

function isEntries(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where `after` differs from `before`, down to each setting that differs: an `env(...)` and a value
 * are each one setting, a list differs by position and an object by key, a part one side lacks
 * read as empty, so an editable setting added inside a new object is still told apart.
 */
function changedPaths(before: unknown, after: unknown, path: Path = []): readonly Path[] {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  if (isEnvReference(before) || isEnvReference(after)) {
    return [path];
  }
  const list = (value: unknown) => (value === undefined ? [] : value);
  if (Array.isArray(list(before)) && Array.isArray(list(after))) {
    const [a, b] = [list(before) as readonly unknown[], list(after) as readonly unknown[]];
    return Array.from({ length: Math.max(a.length, b.length) }, (_, index) =>
      changedPaths(a[index], b[index], [...path, index]),
    ).flat();
  }
  const entries = (value: unknown) => (value === undefined ? {} : value);
  const [a, b] = [entries(before), entries(after)];
  if (isEntries(a) && isEntries(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      changedPaths(a[key], b[key], [...path, key]),
    );
  }
  return [path];
}

/** Whether a `z.editable()` path (`labels`, `teams.*`, `rules[].name`) covers a setting's place. */
function covers(pattern: string, path: Path): boolean {
  const steps = pattern === "" ? [] : (pattern.match(/\[\]|\[\d+\]|[^.[\]]+/g) ?? []);
  return (
    steps.length <= path.length &&
    steps.every((step, index) => {
      const at = path[index];
      if (step === "*") {
        return typeof at === "string";
      }
      if (step === "[]") {
        return typeof at === "number";
      }
      return /^\[\d+\]$/.test(step) ? at === Number(step.slice(1, -1)) : at === step;
    })
  );
}

/** A literal at a secret path: the value is never repeated, only where it is. */
function secretLiteralWords(at: string, packageName: string, variable: string): string {
  return `a draft cannot put a value at ${at}: it is a secret of the plugin "${packageName}", and a secret is read from an environment variable that facetdb.config.ts names, never written in it; name its variable in facetdb.config.ts by hand, such as env("${variable}")`;
}

/**
 * What a project draft's `alerts` and `plugins` are judged with: the plugins the worker runs now,
 * and the same checks a reload makes before it puts them in force. A refusal never repeats a value
 * the draft put at a secret path, nor any variable's value.
 */
export function draftPlugins(deps: DraftPluginsDeps): DraftPlugins {
  return {
    refusals(file, key, settings): readonly ConfigIssue[] {
      const at = formatPath(["plugins", key]);
      const host = deps.host();
      const hosted = host.plugin(key);
      if (hosted === undefined) {
        return [
          {
            path: at,
            message: `a draft changes the settings of a plugin this worker runs, and "${key}" is not one: it is not installed here, or facetdb.config.ts did not name it when the worker started; run facetdb add ${shortName(key) ?? key} on the worker's machine, name it in facetdb.config.ts by hand and restart facetdb worker`,
          },
        ];
      }
      const ref = file.provider === undefined ? undefined : pluginProviderOf(file.provider);
      const supplies =
        ref !== undefined && host.plugin(ref.plugin)?.packageName === hosted.packageName;
      if (supplies && JSON.stringify(settings) !== JSON.stringify(file.plugins?.[key] ?? {})) {
        return [
          {
            path: at,
            message: `a draft cannot change the settings of the plugin "${hosted.packageName}": it supplies the model provider (provider: "${file.provider}"), and its settings decide where every record's state is sent, as modelUrl does; edit ${at} in facetdb.config.ts by hand`,
          },
        ];
      }
      const literals = secretPlaces(settings, hosted.plugin.manifest.secrets)
        .filter((place) => typeof place.value === "string" || typeof place.value === "number")
        .map((place) => {
          const field = [...place.path].reverse().find((step) => typeof step === "string");
          return {
            path: formatPath(["plugins", key, ...place.path]),
            message: secretLiteralWords(
              formatPath(["plugins", key, ...place.path]),
              hosted.packageName,
              suggestedVariable(hosted.name, String(field ?? key)),
            ),
          };
        });
      if (literals.length > 0) {
        return literals;
      }
      // Deny by default: a setting changes only where the plugin's own schema marks it
      // z.editable(); any other can decide where its credential or a record's data goes.
      const schema = hosted.plugin.manifest.config;
      const editable = schema instanceof ZodObject ? editablePaths(schema).paths : [];
      return changedPaths(file.plugins?.[key] ?? {}, settings)
        .filter((path) => !editable.some((pattern) => covers(pattern, path)))
        .map((path) => {
          const where = formatPath(["plugins", key, ...path]);
          return {
            path: where,
            message: `a draft cannot change ${where}: the plugin "${hosted.packageName}" does not mark it as a setting the studio may change (z.editable()), and a plugin's setting can decide where it sends its credential or your records' data; edit ${where} in facetdb.config.ts by hand`,
          };
        });
    },
    check(config): readonly ConfigIssue[] {
      let host: PluginHost;
      try {
        ({ host } = rehost(deps.host(), config, deps));
      } catch (error) {
        if (error instanceof PluginHostError) {
          return [{ path: "plugins", message: `${error.message}; ${error.fix}` }];
        }
        throw error;
      }
      try {
        checkChannels(config, host, deps.env, deps.machineZone);
      } catch (error) {
        if (error instanceof PluginHostError) {
          return [{ path: "alerts", message: `${error.message}; ${error.fix}` }];
        }
        throw error;
      }
      return [];
    },
  };
}
