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
    }
  | {
      /** Every problem with its field path as the config file writes it: `sources[0].thresholds.urgency`. */
      readonly ok: false;
      readonly issues: readonly ConfigIssue[];
    };

/**
 * Judges `draft` within `config`. `env` is the environment the connection strings are read from, of
 * which only the variables the config's sources already name are read; a draft naming any other is
 * refused in the same words whether or not it is set. Nothing is written and nothing changes:
 * applying a draft is not built yet.
 */
export function judgeDraftSource(
  config: ProjectConfig,
  draft: SourceDraft,
  env: Readonly<Record<string, string | undefined>>,
): DraftJudgement {
  // A draft comes over HTTP: it sees only the variables the loaded config already names, so naming
  // any other one tells its sender nothing about whether it is set or what it holds.
  const named = [...new Set(config.sources.flatMap((source) => source.databaseEnv ?? []))].sort();
  const database = draft["database"];
  const variable =
    typeof database === "object" && database !== null && "env" in database
      ? database.env
      : undefined;
  if (typeof variable === "string" && !named.includes(variable)) {
    return {
      ok: false,
      issues: [
        {
          path: "database.env",
          message: `a draft reads only the connection variables facetdb.config.ts already names (${named.length === 0 ? "none" : named.join(", ")}); name one of those, or add the source to facetdb.config.ts`,
        },
      ],
    };
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
  return { ok: true, questionSet, warnings };
}
