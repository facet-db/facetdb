import type { QuestionSet } from "@facetdb/core";
import type { OnCapReached, ProjectConfig } from "./dsl.ts";
import { fromProjectJson, toProjectJson } from "./json.ts";
import { ConfigError, type ConfigIssue } from "./schema.ts";
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
 * A draft of the project's own settings (Settings' spending section): the monthly cap in billable
 * input tokens, `null` removing it, and what happens at 100%. Any other key is refused by
 * `judgeDraftProject` in plain words; the HTTP route already sends only these two.
 */
export type ProjectDraft = {
  readonly spendingCap?: number | null;
  readonly onCapReached?: OnCapReached;
} & Readonly<Record<string, unknown>>;

export type ProjectDraftJudgement =
  | {
      readonly ok: true;
      /** The whole project with the draft in place: what Apply renders into the file. */
      readonly config: ProjectConfig;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** The project keys a draft may change: the spending cap and what happens when it is reached. */
const PROJECT_DRAFT_KEYS: ReadonlySet<string> = new Set(["spendingCap", "onCapReached"]);

/**
 * Why a project key stays out of a project draft, said where a draft names it. `modelUrl` decides
 * where every record's state is sent, `studioUrl` where every link points and `alerts` where alerts
 * post: the operator's, edited by hand as `where` and actions are. `model` and `sources` are each source's own draft's, or the file's.
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
  alerts:
    "a draft cannot change alerts: they decide where the worker posts its alerts; edit alerts in facetdb.config.ts by hand",
  sources:
    "a project draft does not carry sources: change a source with its own draft (the Questions page), or edit facetdb.config.ts by hand",
  // The one-source form's plugin source: it names the plugin that reads every record and the
  // settings it reads them with, as an action names its plugin.
  source:
    "a draft cannot change source: it names the plugin that reads every record and the settings it reads them with; edit source in facetdb.config.ts by hand",
};

/**
 * Judges a project draft within `config`: the draft over `toProjectJson(config)`, `spendingCap`
 * removed where the draft sends `null`, read back through `fromProjectJson` with only the connection
 * variables the file already names (as a source draft is), so the cap meets the loader's own rules
 * at its own path (`spendingCap`). Nothing is written.
 */
export function judgeDraftProject(
  config: ProjectConfig,
  draft: ProjectDraft,
  env: Readonly<Record<string, string | undefined>>,
): ProjectDraftJudgement {
  const refused = Object.keys(draft)
    .filter((key) => !PROJECT_DRAFT_KEYS.has(key))
    .sort()
    .map(
      (key): ConfigIssue => ({
        path: key,
        message:
          REFUSED_PROJECT_KEYS[key] ??
          `a project draft changes only spendingCap and onCapReached, not ${key}; edit facetdb.config.ts by hand`,
      }),
    );
  if (refused.length > 0) {
    return { ok: false, issues: refused };
  }
  const { spendingCap, ...rest } = { ...toProjectJson(config), ...draft };
  // `null` removes the cap; a project with none, and a draft that does not name it, write no key.
  const json = spendingCap === null || spendingCap === undefined ? rest : { ...rest, spendingCap };
  try {
    return { ok: true, config: fromProjectJson(json, seenOf(namedVariables(config, []), env)) };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
}
