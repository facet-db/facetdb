import type { QuestionSet } from "@facetdb/core";
import type { OnCapReached, ProjectConfig } from "./dsl.ts";
import { fromProjectJson, toProjectJson } from "./json.ts";
import { settingsVariables } from "./load.ts";
import { ConfigError, type ConfigIssue, formatPath, isPluginKey } from "./schema.ts";
import { type ConfigWarning, wordingWarnings } from "./warnings.ts";

/**
 * A draft from the studio: one source in the project JSON's shape, its `name` and the fields to
 * change, judged as the loader judges a file. The draft is merged over the source of that name, or
 * added as a new source, and the whole project is read back through `fromProjectJson`, so a draft
 * meets exactly the rules a config file meets (duplicates, pinned models, thresholds by type).
 */
export type SourceDraft = { readonly name: string } & Readonly<Record<string, unknown>>;

export type DraftJudgement =
  | {
      readonly ok: true;
      /** The draft source's question set, as the worker would run it. */
      readonly questionSet: QuestionSet;
      /** The wording warnings of the draft source, in the shape the CLI prints (`formatWarnings`). */
      readonly warnings: readonly ConfigWarning[];
      /** The whole project with the draft in place: what Apply renders into the file. */
      readonly config: ProjectConfig;
    }
  | {
      /** Every problem with its field path as the config file writes it: `sources[0].thresholds.urgency`. */
      readonly ok: false;
      readonly issues: readonly ConfigIssue[];
    };

/**
 * The studio's setup flow: the operator on the machine that runs the worker adds a new source,
 * which reads its connection string from a variable the file may not name yet. Only the setup's own
 * door passes it, and only for a request from that operator; a reviewer's draft never carries it,
 * so what a reviewer's draft may name stays as it was.
 */
export type NewSourceSetup = {
  /** The variable the new source reads its connection string from (`LISTINGS_URL`). */
  readonly variable: string;
};

/** A variable name as a shell sets one. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Judges `draft` within `config`. `env` is the environment the connection strings are read from, of
 * which only the variables the config's sources already name are read; a draft naming any other is
 * refused in the same words whether or not it is set. With `setup`, the draft must be a source the
 * config does not have, naming `setup.variable`, which is then read too. Nothing is written and
 * nothing changes: applying a draft is `planApply`'s.
 */
export function judgeDraftSource(
  config: ProjectConfig,
  draft: SourceDraft,
  env: Readonly<Record<string, string | undefined>>,
  setup?: NewSourceSetup,
): DraftJudgement {
  if (setup !== undefined) {
    const refusal = setupRefusal(config, draft, setup);
    if (refusal !== undefined) {
      return { ok: false, issues: [refusal] };
    }
  }
  // A draft comes over HTTP: it sees only the variables the loaded config already names, so naming
  // any other one tells its sender nothing about whether it is set or what it holds.
  const named = namedVariables(config, setup === undefined ? [] : [setup.variable]);
  const refused = (path: string): DraftJudgement => ({
    ok: false,
    issues: [
      {
        path,
        message: `a draft reads only the connection variables facetdb.config.ts already names (${named.length === 0 ? "none" : named.join(", ")}); name one of those, or add the source to facetdb.config.ts`,
      },
    ],
  });
  const database = draft["database"];
  const variable =
    typeof database === "object" && database !== null && "env" in database
      ? database.env
      : undefined;
  if (typeof variable === "string" && !named.includes(variable)) {
    return refused("database.env");
  }
  // By whichever key it arrives (`databaseEnv` is a source key the schema takes too): no variable
  // the file does not already name, said in the same words, set or not.
  const direct = draft["databaseEnv"];
  if (direct !== undefined && (typeof direct !== "string" || !named.includes(direct))) {
    return refused("databaseEnv");
  }
  const seen = seenOf(named, env);
  const json = toProjectJson(config);
  const index = json.sources.findIndex((source) => source.name === draft.name);
  const sources: unknown[] =
    index === -1
      ? [...json.sources, draft]
      : json.sources.map((source, at) => (at === index ? { ...source, ...draft } : source));
  let judged: ProjectConfig;
  try {
    judged = fromProjectJson({ ...json, sources }, seen);
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
  // The judged project as a whole, whatever key carried it: every connection variable is one the
  // file names already.
  const stray = judged.sources.findIndex(
    (candidate) => candidate.databaseEnv !== undefined && !named.includes(candidate.databaseEnv),
  );
  if (stray !== -1) {
    return refused(`sources[${stray}].databaseEnv`);
  }
  const source = judged.sources.find((candidate) => candidate.name === draft.name);
  if (source === undefined) {
    throw new Error(`the judged project lost the draft source ${draft.name}`);
  }
  const questionSet: QuestionSet = {
    questions: source.questions,
    read: source.read,
    model: source.model ?? judged.model,
    thresholds: source.thresholds,
    ...(source.where === undefined ? {} : { where: source.where }),
  };
  // No rows were measured here, so no state-size warning: the preview's own rows carry their size.
  const warnings = wordingWarnings(questionSet, 0).map((warning) => ({
    ...warning,
    source: source.name,
  }));
  return { ok: true, questionSet, warnings, config: judged };
}

/** Why a setup's draft is not a new source naming its own variable, or undefined when it is. */
function setupRefusal(
  config: ProjectConfig,
  draft: SourceDraft,
  setup: NewSourceSetup,
): ConfigIssue | undefined {
  if (config.sources.some((source) => source.name === draft.name)) {
    return {
      path: "name",
      message: `facetdb.config.ts already has a source called "${draft.name}": the setup adds a new source; choose another name, or change "${draft.name}" on the Questions page`,
    };
  }
  if (!VARIABLE_NAME.test(setup.variable)) {
    return {
      path: "database.env",
      message: `"${setup.variable}" is not the name of an environment variable: use letters, digits and underscores, not starting with a digit`,
    };
  }
  const database = draft["database"];
  const named =
    typeof database === "object" && database !== null && "env" in database
      ? database.env
      : undefined;
  if (named !== setup.variable || draft["databaseEnv"] !== undefined) {
    return {
      path: "database.env",
      message: `the new source reads its connection string from ${setup.variable}, so its draft names that variable and no other`,
    };
  }
  return undefined;
}

/** The connection variables the config's sources name (and `also`), sorted, each once. */
function namedVariables(config: ProjectConfig, also: readonly string[]): string[] {
  return [
    ...new Set([...config.sources.flatMap((source) => source.databaseEnv ?? []), ...also]),
  ].sort();
}

/** The environment as a draft's judgement reads it: only the variables `named` lists. */
function seenOf(
  named: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(named.map((name) => [name, env[name]]));
}

/**
 * A draft of the project's own settings: Settings' spending section (the monthly cap in billable
 * input tokens, `null` removing it, and what happens at 100%), and the Alerts page's channels and
 * the Plugins page's settings. `alerts` is the whole of `alerts` in the project JSON's shape,
 * `null` taking it out; `plugins` holds the settings of each plugin it names, by its key in
 * `plugins`, each replacing that plugin's entry whole and leaving the others as they are; only the
 * settings the plugin marks `z.editable()` may differ from the file's. Any other key is refused by
 * `judgeDraftProject` in plain words.
 */
export type ProjectDraft = {
  readonly spendingCap?: number | null;
  readonly onCapReached?: OnCapReached;
  readonly alerts?: unknown;
  readonly plugins?: unknown;
} & Readonly<Record<string, unknown>>;

export type ProjectDraftJudgement =
  | {
      readonly ok: true;
      /** The whole project with the draft in place: what Apply renders into the file. */
      readonly config: ProjectConfig;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * What a project draft's `alerts` and `plugins` are judged with beyond the schema: the plugins the
 * worker runs, which only the CLI's plugin host knows. The worker hands one in (`draftPlugins` in
 * the plugin module); a draft that carries either key is refused without it.
 */
export type DraftPlugins = {
  /**
   * Why the draft's settings for the plugin at `key` cannot go in, judged before the schema reads
   * them and before any variable is: a plugin the worker does not run, the settings of the plugin
   * that supplies the model provider, a value at a path the plugin's own schema marks secret, and
   * any change to a setting the plugin's schema does not mark `z.editable()` (deny by default).
   */
  refusals(file: ProjectConfig, key: string, settings: unknown): readonly ConfigIssue[];
  /**
   * The loader's own checks of the whole project with the draft in place, as the worker's start
   * makes them: each plugin's settings parsed by its schema with its variables read, and each alert
   * channel bound to its plugin's channel with its quiet hours' zone.
   */
  check(config: ProjectConfig): readonly ConfigIssue[];
};

/** The project keys a draft may change: the spending cap and its 100%, the channels, plugin settings. */
const PROJECT_DRAFT_KEYS: ReadonlySet<string> = new Set([
  "spendingCap",
  "onCapReached",
  "alerts",
  "plugins",
]);

/**
 * Why a project key stays out of a project draft, said where a draft names it. `modelUrl` decides
 * where every record's state is sent and `studioUrl` where every link points: the operator's,
 * edited by hand as `where` and actions are. `model` and `sources` are each source's own draft's,
 * or the file's.
 */
const REFUSED_PROJECT_KEYS: Readonly<Record<string, string>> = {
  model:
    "a project draft cannot change the model: change a source's model on the Questions page, or the project's model in facetdb.config.ts by hand",
  modelUrl:
    "a draft cannot change modelUrl: it decides where every record's state is sent; edit modelUrl in facetdb.config.ts by hand",
  provider:
    "a draft cannot change provider: it decides where every record's state is sent and which key goes with it; edit provider in facetdb.config.ts by hand",
  studioUrl:
    "a draft cannot change studioUrl: it is the address every alert and notification link opens; edit studioUrl in facetdb.config.ts by hand",
  sources:
    "a project draft does not carry sources: change a source with its own draft (the Questions page), or edit facetdb.config.ts by hand",
  // The one-source form's plugin source: it names the plugin that reads every record and the
  // settings it reads them with, as an action names its plugin.
  source:
    "a draft cannot change source: it names the plugin that reads every record and the settings it reads them with; edit source in facetdb.config.ts by hand",
};

/** A plain object, as `plugins` is: anything else is the schema's to refuse in its own words. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why the `env(...)` a draft's settings for the plugin at `key` carry are not the file's own: each
 * must be the very variable the file names at that very place. A draft that could name another, or
 * move one, could have a plugin send one of the machine's variables to a third party as a "token"
 * or a channel. Judged on the text alone, before anything reads a variable, in words that are the
 * same whether or not the variable is set.
 */
function pluginVariableRefusals(
  file: ProjectConfig,
  key: string,
  settings: unknown,
): readonly ConfigIssue[] {
  const own = new Map(
    settingsVariables(key, file.plugins?.[key] ?? {}).map(({ path, variable }) => [
      formatPath(path),
      variable,
    ]),
  );
  return settingsVariables(key, settings).flatMap(({ path, variable }): ConfigIssue[] => {
    const named = own.get(formatPath(path));
    if (named === variable) {
      return [];
    }
    const at = formatPath(["plugins", key, ...path]);
    return [
      {
        path: at,
        message:
          named === undefined
            ? `a draft cannot make ${at} read a variable: a draft keeps each env(...) of a plugin's settings where facetdb.config.ts writes it, and adds none; write a value there, or name the variable in facetdb.config.ts by hand`
            : `a draft cannot change which variable ${at} reads: facetdb.config.ts names ${named} there, and the variable a plugin reads is named in facetdb.config.ts by hand`,
      },
    ];
  });
}

/**
 * Judges a project draft within `config`: the draft over `toProjectJson(config)`, `spendingCap` and
 * `alerts` removed where the draft sends `null`, each plugin it names replacing that plugin's entry
 * in `plugins`, read back through `fromProjectJson` with only the connection variables the file
 * already names (as a source draft is), so each value meets the loader's own rules at its own path.
 * A draft carrying `alerts` or `plugins` meets `plugins` too: its variables and secrets first,
 * before the schema, then the worker's own checks of its plugins and channels. A draft that carries
 * neither is judged as before. Nothing is written.
 */
export function judgeDraftProject(
  config: ProjectConfig,
  draft: ProjectDraft,
  env: Readonly<Record<string, string | undefined>>,
  plugins?: DraftPlugins,
): ProjectDraftJudgement {
  const refused = Object.keys(draft)
    .filter((key) => !PROJECT_DRAFT_KEYS.has(key))
    .sort()
    .map(
      (key): ConfigIssue => ({
        path: key,
        message:
          REFUSED_PROJECT_KEYS[key] ??
          `a project draft changes only spendingCap, onCapReached, alerts and plugins, not ${key}; edit facetdb.config.ts by hand`,
      }),
    );
  if (refused.length > 0) {
    return { ok: false, issues: refused };
  }
  const drafted = (["alerts", "plugins"] as const).filter((key) => Object.hasOwn(draft, key));
  if (drafted.length > 0 && plugins === undefined) {
    return {
      ok: false,
      issues: drafted.map((key) => ({
        path: key,
        message: `${key} in a draft is judged against the plugins a running facetdb worker loaded, and this one has none to judge it with; apply it from the studio of a running facetdb worker, or edit facetdb.config.ts by hand`,
      })),
    };
  }
  const settings = draft.plugins;
  if (isPlainObject(settings)) {
    // A key `plugins` may not have is the schema's to refuse, in its words: none is repeated here.
    // A variable's refusal first and alone for its plugin: its place would be refused twice else.
    const issues = Object.entries(settings)
      .filter(([key]) => isPluginKey(key))
      .flatMap(([key, entry]) => {
        const variables = pluginVariableRefusals(config, key, entry);
        return variables.length > 0 ? variables : (plugins?.refusals(config, key, entry) ?? []);
      });
    if (issues.length > 0) {
      return { ok: false, issues };
    }
  }
  const json = toProjectJson(config);
  const { spendingCap, alerts, plugins: _plugins, ...rest } = { ...json, ...draft };
  const merged = {
    ...rest,
    // `null` removes the cap, or every channel; a project with none, and a draft that does not
    // name it, write no key.
    ...(spendingCap === null || spendingCap === undefined ? {} : { spendingCap }),
    ...(alerts === null || alerts === undefined ? {} : { alerts }),
    // Anything but an object of entries is the schema's to refuse, in its words.
    ...(settings === undefined
      ? json.plugins === undefined
        ? {}
        : { plugins: json.plugins }
      : { plugins: isPlainObject(settings) ? { ...json.plugins, ...settings } : settings }),
  };
  let judged: ProjectConfig;
  try {
    judged = fromProjectJson(merged, seenOf(namedVariables(config, []), env));
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
  const issues = drafted.length === 0 ? [] : (plugins?.check(judged) ?? []);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config: judged };
}
