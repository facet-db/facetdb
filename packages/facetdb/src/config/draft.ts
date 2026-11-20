import type { QuestionSet } from "@facetdb/core";
import type { ProjectConfig } from "./dsl.ts";
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
  const named = [
    ...new Set([
      ...config.sources.flatMap((source) => source.databaseEnv ?? []),
      ...(setup === undefined ? [] : [setup.variable]),
    ]),
  ].sort();
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
  const seen = Object.fromEntries(named.map((name) => [name, env[name]]));
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
