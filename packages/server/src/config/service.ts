import {
  type KeyText,
  PreviewModelError,
  type PreviewResult,
  type PreviewRow,
  type QuestionSet,
} from "@facetdb/core";

/**
 * The project configuration behind the studio's door ("two ways in, same project configuration"):
 * the project JSON the loader exports, a draft judged by the loader with its wording warnings, and
 * the live preview of a draft question set. This package does not depend on the `facetdb` package,
 * so `facetdb worker` hands in what only the CLI has: the export, the loader's judgement and a
 * preview per running source (`ServerDeps`, main.ts).
 */

/** A draft source as the project JSON writes one: its `name`, and any of its fields to change. */
export type SourceDraft = { readonly name: string } & Readonly<Record<string, unknown>>;

/** A problem the loader found, with its field path as the config file writes it (`sources[0].questions.urgency.levels`). */
export type DraftIssue = { readonly path: string; readonly message: string };

/** A wording warning in the CLI's shape: never a refusal. */
export type DraftWarning = {
  readonly source: string;
  /** The question it is about; null when it is about the whole state. */
  readonly question: string | null;
  readonly code: string;
  readonly message: string;
  readonly fix: string;
};

/** The loader's judgement of a draft placed into the project. */
export type DraftCheck =
  | {
      readonly ok: true;
      /** The draft source's question set as the worker would run it. */
      readonly questionSet: QuestionSet;
      readonly warnings: readonly DraftWarning[];
    }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

/** What `facetdb worker` hands the server about its project's configuration. */
export type ProjectConfigDoor = {
  /** The project the worker serves; a key of another project in the same store sees none of it. */
  readonly projectId: string;
  /** The project JSON (`toProjectJson` of the loaded config): no connection string is ever in it. */
  json(): unknown;
  /** Judges a draft source, merged over the source of that name or added as a new one. */
  validate(draft: SourceDraft): DraftCheck;
};

/** A running source the preview can read: the fields its connector reads, and the preview over it. */
export type PreviewSource = {
  readonly read: readonly string[];
  readonly where: string | undefined;
  /** How its keys are written for a person (MongoDB's `65f1…`); undefined where a key is its own text. */
  readonly keyText: KeyText | undefined;
  preview(questionSet: QuestionSet, limit: number): Promise<PreviewResult>;
};

export type ConfigOutcome<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "unknown_project" };

export type ValidateOutcome = {
  readonly valid: boolean;
  readonly issues: readonly DraftIssue[];
  readonly warnings: readonly DraftWarning[];
};

export type PreviewOutcome =
  | {
      readonly kind: "previewed";
      /** Newest first, each key as the user writes it (MongoDB's `65f1…`, never `oid:65f1…`). */
      readonly rows: readonly PreviewRow[];
      readonly decided: number;
      readonly review: number;
      readonly cost: { readonly inputTokens: number; readonly dollars: number };
      readonly warnings: readonly DraftWarning[];
    }
  | { readonly kind: "unknown_project" }
  | { readonly kind: "invalid"; readonly issues: readonly DraftIssue[] }
  | { readonly kind: "unknown_source"; readonly source: string }
  | { readonly kind: "fields_differ"; readonly source: string }
  | {
      readonly kind: "capped";
      readonly message: string;
      readonly fix: string;
      /** Whole seconds until the month resets. */
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: "model_failed"; readonly key: string; readonly reason: string };

export type ConfigService = {
  json(projectId: string): ConfigOutcome<unknown>;
  validate(projectId: string, draft: SourceDraft): ConfigOutcome<ValidateOutcome>;
  preview(projectId: string, draft: SourceDraft, limit: number): Promise<PreviewOutcome>;
};

export type ConfigServiceDeps = {
  readonly config: ProjectConfigDoor;
  /** The running source of that name, or undefined when this worker runs none. */
  readonly preview: (source: string) => PreviewSource | undefined;
};

function sameFields(
  questionSet: QuestionSet,
  source: Pick<PreviewSource, "read" | "where">,
): boolean {
  return (
    questionSet.read.length === source.read.length &&
    questionSet.read.every((field, index) => field === source.read[index]) &&
    questionSet.where === source.where
  );
}

export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  const { config } = deps;
  const ours = (projectId: string) => projectId === config.projectId;

  return {
    json(projectId) {
      return ours(projectId) ? { kind: "ok", value: config.json() } : { kind: "unknown_project" };
    },

    validate(projectId, draft) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      const check = config.validate(draft);
      return {
        kind: "ok",
        value: check.ok
          ? { valid: true, issues: [], warnings: check.warnings }
          : { valid: false, issues: check.issues, warnings: [] },
      };
    },

    async preview(projectId, draft, limit) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      const check = config.validate(draft);
      if (!check.ok) {
        return { kind: "invalid", issues: check.issues };
      }
      const source = deps.preview(draft.name);
      if (source === undefined) {
        return { kind: "unknown_source", source: draft.name };
      }
      // The connector reads the fields the worker opened it with; another `read` or `where` would
      // show the model a state the source does not have.
      if (!sameFields(check.questionSet, source)) {
        return { kind: "fields_differ", source: draft.name };
      }
      let result: PreviewResult;
      try {
        result = await source.preview(check.questionSet, limit);
      } catch (error) {
        if (error instanceof PreviewModelError) {
          return {
            kind: "model_failed",
            key: source.keyText?.toText(error.key) ?? error.key,
            reason: error.message,
          };
        }
        throw error;
      }
      if (result.kind === "capped") {
        return {
          kind: "capped",
          message: result.message,
          fix: result.fix,
          retryAfterSeconds: result.retryAfterSeconds,
        };
      }
      return {
        kind: "previewed",
        rows: result.rows.map((row) => ({
          ...row,
          key: source.keyText?.toText(row.key) ?? row.key,
        })),
        decided: result.decided,
        review: result.review,
        cost: result.cost,
        warnings: check.warnings,
      };
    },
  };
}
