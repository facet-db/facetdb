import {
  type KeyText,
  PreviewModelError,
  type PreviewResult,
  type PreviewRow,
  type QuestionSet,
  QuestionTestFieldsError,
  type QuestionTestPlan,
  type QuestionTestResult,
  type QuestionTestService,
  type TestEstimate,
} from "@facetdb/core";
import {
  type HistoryDoor,
  unreadHistory,
  VERSION_HISTORY_SHOWN,
  type VersionHistory,
  versionHistory,
} from "./versions.ts";

/**
 * The project configuration behind the studio's door ("two ways in, same project configuration"):
 * the project JSON the loader exports, a draft judged by the loader with its wording warnings, and
 * the live preview of a draft question set. This package does not depend on the `facetdb` package,
 * so `facetdb worker` hands in what only the CLI has: the export, the loader's judgement and a
 * preview per running source (`ServerDeps`, main.ts).
 */

/** A draft source as the project JSON writes one: its `name`, and any of its fields to change. */
export type SourceDraft = { readonly name: string } & Readonly<Record<string, unknown>>;

/**
 * A draft of the project's own spending settings (Settings): the monthly cap in billable input
 * tokens, `null` removing it, and what happens at 100%. The route sends no other key.
 */
export type ProjectDraft = {
  readonly spendingCap?: number | null;
  readonly onCapReached?: "pause" | "continue";
};

/** What Apply places into facetdb.config.ts: one source, or the project's spending settings. */
export type ConfigDraft = { readonly source: SourceDraft } | { readonly project: ProjectDraft };

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
  /** The project JSON (`toProjectJson` of the config in force): no connection string is ever in it. */
  json(): unknown;
  /** Judges a draft source, merged over the source of that name or added as a new one. */
  validate(draft: SourceDraft): DraftCheck;
  /**
   * The question-set versions the store keeps for each source of the config in force (the Questions
   * page's version history). Best effort: a read that fails is said, never a 500.
   */
  readonly history: HistoryDoor;
  /** The sources that do not run the file as last loaded; empty when every loop runs it. */
  pending(): readonly PendingSource[];
  /**
   * Apply: the diff a draft makes to `facetdb.config.ts`, and the write and the worker's reload.
   * Absent where nothing may write the file: `facetdb worker --once`.
   */
  readonly file?: ConfigFileDoor;
};

/** A refusal in plain words, with what to do about it. */
export type Words = { readonly message: string; readonly fix: string };

/**
 * Why Apply replaces the file only with `force`: what git says of it (anything but committed and
 * unmodified), with the terminal's words; the studio words each state its own way.
 */
export type UncommittedWords = Words & {
  readonly state: "modified" | "untracked" | "ignored" | "no-repository" | "no-git" | "unreadable";
};

/** What happened to one source when the worker reloaded the config. */
export type SourceReload = {
  readonly source: string;
  /**
   * `unchanged` keeps running; `restarted` runs the new question set from its next batch; `stopped`
   * was removed from the file; `started` is new in the file and runs from now on, the worker's own
   * check of its database having found its install; `not-started` is new and does not run yet, the
   * message saying why and what to do (`facetdb migrate`, Check again, a variable to set, or a
   * restart); `kept` changed in a way that needs `facetdb migrate` or a restart, and runs what it
   * ran; `failed` could not be opened anew and runs what it ran.
   */
  readonly outcome:
    | "unchanged"
    | "restarted"
    | "stopped"
    | "started"
    | "not-started"
    | "kept"
    | "failed";
  /** The question-set version it answers under now; null when it does not run. */
  readonly version: number | null;
  /** What happened and what to do, in plain words; null when there is nothing to say. */
  readonly message: string | null;
};

/**
 * A source whose loop does not run facetdb.config.ts as last loaded: the reload's `kept` and
 * `not-started` outcomes, asked for whenever a page needs them, not only in the reply to the Apply
 * that caused them. It goes from the list once the worker runs the file.
 */
export type PendingSource = {
  readonly source: string;
  readonly outcome: "kept" | "not-started";
  /** The reload's own words: why it is not running yet and what to do. */
  readonly message: string;
  /**
   * Whether `facetdb migrate --source X` is a step: false for a source that answers through POST
   * /v1/check, which has no install to migrate, and for a source new in the file whose problem no
   * install mends (its variable unset at the worker's start, its string refused by its database,
   * its database unread, the worker stopping): the reload's words say what does.
   */
  readonly migrate: boolean;
  /** Questions the file holds that the loop does not run; empty for a source that is not started. */
  readonly added: readonly string[];
  /** Questions the loop runs that the file no longer holds. */
  readonly removed: readonly string[];
  /**
   * True when a reload switches the source once its database holds the change (questions added, and
   * nothing else, on an engine whose checks can tell): "Check again" asks for that reload.
   */
  readonly checkAgain: boolean;
};

/** The worker's reload of the written file: per source, or the reason the file did not load. */
export type ReloadSummary =
  | {
      readonly loaded: true;
      readonly sources: readonly SourceReload[];
      /** Changes to the project as a whole that take a restart of the worker (the model URL, the alert channels; never the spending cap). */
      readonly notes: readonly string[];
    }
  | ({ readonly loaded: false } & Words);

/** The diff a draft would make, shown before anything is written. */
export type FileDiff =
  | {
      readonly kind: "planned";
      /** The config file, as the worker was started with it (`--config`). */
      readonly path: string;
      /** Unified, `--- a/facetdb.config.ts` first; empty when the draft changes nothing. */
      readonly diff: string;
      readonly changed: boolean;
      /** Sent back to confirm: names this exact change, so what is written is what was shown. */
      readonly plan: string;
      /** Why the write would be refused without `force` (git keeps no copy of what is there now). */
      readonly uncommitted: UncommittedWords | null;
      /** The file holds lines of the person's own (comments, code) the whole-file write drops. */
      readonly dropsOwnText: boolean;
      readonly warnings: readonly DraftWarning[];
    }
  | { readonly kind: "invalid"; readonly issues: readonly DraftIssue[] }
  /** The file is missing, is a link, or does not load as it is now. */
  | ({ readonly kind: "unreadable" } & Words);

/** How a confirmed apply went. */
export type FileApply =
  | {
      readonly kind: "applied";
      readonly path: string;
      readonly diff: string;
      readonly reload: ReloadSummary;
    }
  | { readonly kind: "unchanged"; readonly path: string }
  /** The file or the draft changed since the diff was made: nothing was written. */
  | { readonly kind: "stale" }
  /** The written file did not load, so the text it replaced was put back: nothing changed. */
  | ({ readonly kind: "reverted" } & Words)
  | ({ readonly kind: "uncommitted" } & UncommittedWords)
  | { readonly kind: "invalid"; readonly issues: readonly DraftIssue[] }
  | ({ readonly kind: "unreadable" } & Words);

/**
 * A confirmed Apply: the plan the diff answered with, whether to replace a file git keeps no copy
 * of, and the reviewer who confirmed it, as the session names them (a question set the write
 * changes names them in its Question set changed alert).
 */
export type ApplyOptions = {
  readonly plan: string;
  readonly force: boolean;
  readonly by: string;
};

/** The CLI's door to `facetdb.config.ts`: the loader, the exporter, git and the reload are its. */
export type ConfigFileDoor = {
  /** Reads the file again and applies it to the running loops, as after a write. */
  reload(): Promise<ReloadSummary>;
  diff(draft: ConfigDraft): Promise<FileDiff>;
  apply(draft: ConfigDraft, options: ApplyOptions): Promise<FileApply>;
};

/** A running source the preview can read: the fields its connector reads, and the preview over it. */
export type PreviewSource = {
  readonly read: readonly string[];
  readonly where: string | undefined;
  /** How its keys are written for a person (MongoDB's `65f1…`); undefined where a key is its own text. */
  readonly keyText: KeyText | undefined;
  preview(questionSet: QuestionSet, limit: number): Promise<PreviewResult>;
  /** The question set the worker runs this source with: the "now" side of a test (`facetdb test`). */
  readonly current: QuestionSet;
  /** A draft tested against `current` on this source's newest and reviewed records. */
  readonly testQuestionSet: QuestionTestService["testQuestionSet"];
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

/** How a draft's test went; each refusal is the preview's, since the test asks the model the same way. */
export type TestOutcome =
  | {
      /** Only the estimate was asked for: the records read, the model not called. */
      readonly kind: "estimated";
      readonly estimate: TestEstimate;
      readonly warnings: readonly DraftWarning[];
    }
  | {
      readonly kind: "tested";
      readonly result: Extract<QuestionTestResult, { kind: "tested" }>;
      readonly warnings: readonly DraftWarning[];
    }
  | { readonly kind: "unknown_project" }
  | { readonly kind: "invalid"; readonly issues: readonly DraftIssue[] }
  | { readonly kind: "unknown_source"; readonly source: string }
  | { readonly kind: "fields_differ"; readonly source: string }
  | Extract<PreviewOutcome, { readonly kind: "capped" | "model_failed" }>;

/**
 * `GET /v1/config`: the project JSON, each source's version history beside it and the sources that
 * do not run the file yet.
 */
export type ProjectWithHistory = {
  readonly project: unknown;
  readonly versions: Readonly<Record<string, VersionHistory>>;
  readonly pending: readonly PendingSource[];
};

export type ConfigService = {
  json(projectId: string): Promise<ConfigOutcome<ProjectWithHistory>>;
  validate(projectId: string, draft: SourceDraft): ConfigOutcome<ValidateOutcome>;
  preview(projectId: string, draft: SourceDraft, limit: number): Promise<PreviewOutcome>;
  /** With `estimateOnly`, reads the records and prices the run without calling the model. */
  test(
    projectId: string,
    draft: SourceDraft,
    options: { readonly sample: number; readonly estimateOnly: boolean },
  ): Promise<TestOutcome>;
  /** The diff a source or project draft makes to the config file; nothing is written. */
  diff(projectId: string, draft: ConfigDraft): Promise<FileOutcome<FileDiff>>;
  /** Writes the file the confirmed plan names, and the worker reloads it. */
  apply(
    projectId: string,
    draft: ConfigDraft,
    options: ApplyOptions,
  ): Promise<FileOutcome<FileApply>>;
  /** Check again: the worker reads the file and its databases again; nothing is written. */
  reload(projectId: string): Promise<FileOutcome<FileReload>>;
};

/** The reload Check again asked for. */
export type FileReload = { readonly kind: "reloaded"; readonly reload: ReloadSummary };

/** A file door's outcome, or why this worker has none to ask. */
export type FileOutcome<Outcome> =
  | Outcome
  | { readonly kind: "unknown_project" }
  | { readonly kind: "unavailable" };

export type ConfigServiceDeps = {
  readonly config: ProjectConfigDoor;
  /** The running source of that name, or undefined when this worker runs none. */
  readonly preview: (source: string) => PreviewSource | undefined;
  /**
   * The worker's log (ServerDeps `log`): a reason the browser is not told (the store's own error
   * can name its host or role) is written here.
   */
  readonly log: (line: string) => void;
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

/**
 * What a test needs of the source's connector: every field the draft reads is among the fields the
 * worker opened it with (the current version's hash is the running source's own), and the same
 * `where`, since the connector judges it. A draft that reads fewer fields is fine: the model is
 * shown only the draft's.
 */
function testableOn(questionSet: QuestionSet, source: PreviewSource): boolean {
  return (
    questionSet.read.every((field) => source.read.includes(field)) &&
    questionSet.where === source.where
  );
}

export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  const { config } = deps;
  const ours = (projectId: string) => projectId === config.projectId;

  return {
    async json(projectId) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      const project = config.json();
      // The config is the worker's memory; the history is the store's, read per source and best
      // effort: a store that cannot be read costs the history its versions, with a note, never
      // the config (the Decisions page's source names and Settings read this endpoint too).
      const versions = await Promise.all(
        config.history.sources().map(async ({ name, inForce }) => {
          try {
            // One past the versions shown, so the oldest listed is still compared with the one before.
            const stored = await config.history.read(name, VERSION_HISTORY_SHOWN + 1);
            return [name, versionHistory({ inForce, versions: stored })] as const;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deps.log(`the version history of ${name} could not be read from the store: ${reason}`);
            return [name, unreadHistory(name, inForce)] as const;
          }
        }),
      );
      return {
        kind: "ok",
        value: { project, versions: Object.fromEntries(versions), pending: config.pending() },
      };
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

    async test(projectId, draft, options) {
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
      if (!testableOn(check.questionSet, source)) {
        return { kind: "fields_differ", source: draft.name };
      }
      try {
        let plan: QuestionTestPlan;
        try {
          plan = await source.testQuestionSet({
            current: source.current,
            draft: check.questionSet,
            sample: options.sample,
            reviewed: true,
          });
        } catch (error) {
          if (error instanceof QuestionTestFieldsError) {
            return { kind: "fields_differ", source: draft.name };
          }
          throw error;
        }
        if (options.estimateOnly) {
          return { kind: "estimated", estimate: plan.estimate, warnings: check.warnings };
        }
        const result = await plan.run();
        if (result.kind === "capped") {
          return {
            kind: "capped",
            message: result.message,
            fix: result.fix,
            retryAfterSeconds: result.retryAfterSeconds,
          };
        }
        return { kind: "tested", result, warnings: check.warnings };
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
    },

    diff(projectId, draft) {
      if (!ours(projectId)) {
        return Promise.resolve({ kind: "unknown_project" });
      }
      return config.file === undefined
        ? Promise.resolve({ kind: "unavailable" })
        : config.file.diff(draft);
    },

    apply(projectId, draft, options) {
      if (!ours(projectId)) {
        return Promise.resolve({ kind: "unknown_project" });
      }
      return config.file === undefined
        ? Promise.resolve({ kind: "unavailable" })
        : config.file.apply(draft, options);
    },

    async reload(projectId) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      if (config.file === undefined) {
        return { kind: "unavailable" };
      }
      return { kind: "reloaded", reload: await config.file.reload() };
    },
  };
}
