import { createHash } from "node:crypto";
import { judgeDraftSource, type SourceDraft } from "./draft.ts";
import type { ProjectConfig } from "./dsl.ts";
import { configFileSource } from "./json.ts";
import type { ConfigIssue } from "./schema.ts";
import { unifiedDiff } from "./text-diff.ts";
import type { ConfigWarning } from "./warnings.ts";

/**
 * Apply: the studio edits `facetdb.config.ts` in place. A draft is judged within the project as the
 * file loads now, the whole project is rendered by the JSON-to-config exporter from that validated
 * JSON alone, and the file's diff is shown before anything is written. Nothing a draft carries
 * reaches the file as code: every value goes through `JSON.stringify`, a connection string is never
 * in it (only `process.env.<variable>` of a variable the file already names), and an action is
 * `actionCall("<plugin>", "<action>", {...})`. The write goes beside the file and is renamed into
 * place, so a reader sees the old file or the new one.
 */

/** What git says of the config file: only `clean` lets Apply replace it without `force`. */
export type GitState =
  | { readonly kind: "clean" }
  | { readonly kind: "modified" }
  | { readonly kind: "untracked" }
  | { readonly kind: "ignored" }
  | { readonly kind: "no-repository" }
  | { readonly kind: "no-git" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** What is at the config file's path, never read through a symbolic link. */
export type ConfigFileRead =
  | { readonly kind: "file"; readonly text: string }
  | { readonly kind: "missing" }
  /** A link, a directory: Apply never writes through one, nor replaces it with a file. */
  | { readonly kind: "not-a-file" };

/**
 * The config file's door, wired by the composition root (`main.ts`): the disk and the `git` command
 * in the process, handwritten fakes in a test. Paths are relative to the project directory.
 */
export type ConfigFiles = {
  read(path: string): Promise<ConfigFileRead>;
  /** Writes `text` beside the file and renames it into place (export's `Workspace.writeParts`). */
  replace(path: string, text: string): Promise<void>;
  gitState(path: string): Promise<GitState>;
};

/** The change Apply would make, as shown before it is made. */
export type ApplyPlan = {
  readonly path: string;
  /** The file as it was read. */
  readonly before: string;
  /** The file the exporter renders from the project with the draft in place. */
  readonly after: string;
  /** `before` into `after`, unified; empty when nothing changes. */
  readonly diff: string;
  readonly changed: boolean;
  /**
   * Names this exact change (the path, the file before and after): the confirmation sends it back,
   * so what is written is what was shown, and a file or draft changed meanwhile is refused.
   */
  readonly id: string;
  /** The project as the written file loads. */
  readonly config: ProjectConfig;
  /** The wording warnings of the draft source; never a refusal. */
  readonly warnings: readonly ConfigWarning[];
};

export type PlanResult =
  | { readonly ok: true; readonly plan: ApplyPlan }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * The fields a draft never changes, because what they hold runs as the operator's own code: `where`
 * is SQL spliced into the source's queries and its trigger, and an action names a plugin and its
 * settings (a webhook's URL among them), which run with the record's state. A draft for a source
 * the file has must carry the file's own; a new source carries none.
 */
function operatorOnly(file: ProjectConfig, judged: ProjectConfig, name: string): ConfigIssue[] {
  const index = judged.sources.findIndex((source) => source.name === name);
  const drafted = judged.sources[index];
  if (drafted === undefined) {
    return [];
  }
  const before = file.sources.find((source) => source.name === name);
  const issues: ConfigIssue[] = [];
  if (drafted.where !== before?.where) {
    issues.push({
      path: `sources[${index}].where`,
      message: `a draft cannot ${before === undefined ? "give a new source" : "change"} the where filter: it is SQL that runs in your database as written; edit the where filter in facetdb.config.ts by hand`,
    });
  }
  if (JSON.stringify(drafted.actions) !== JSON.stringify(before?.actions ?? [])) {
    issues.push({
      path: `sources[${index}].actions`,
      message: `a draft cannot ${before === undefined ? "give a new source" : "change"} actions: they run plugins with each record's state and the settings they name; edit the actions in facetdb.config.ts by hand`,
    });
  }
  return issues;
}

/** Whether the file's text reads `process.env.<name>` (or `process.env["<name>"]`). */
function namesVariable(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `process\\.env(?:\\.${escaped}(?![A-Za-z0-9_$])|\\[\\s*["'\`]${escaped}["'\`]\\s*\\])`,
  ).test(text);
}

/**
 * The variable each source reads its connection from, as the file names it. The loader records the
 * variable by the value it found (DATABASE_URL first), so where two variables hold the same string
 * on this machine it may name another one than the file does, and Apply would write that one: a
 * different database wherever they differ. The file's own name wins; where the file names more than
 * one of them, or none, Apply cannot tell and refuses.
 */
function pinVariables(
  config: ProjectConfig,
  text: string,
  env: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly config: ProjectConfig }
  | { readonly ok: false; readonly issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const sources = config.sources.map((source, index) => {
    const value = source.database;
    if (source.databaseEnv === undefined || value === undefined) {
      return source;
    }
    const holding = Object.keys(env)
      .filter((name) => env[name] === value)
      .sort();
    if (holding.length <= 1) {
      return source;
    }
    const used = holding.filter((name) => namesVariable(text, name));
    const [only] = used;
    if (used.length === 1 && only !== undefined) {
      return { ...source, databaseEnv: only };
    }
    // Only the names the file's own text holds are said back: which other variables exist where the
    // worker runs, and that they hold this string, is nothing a draft may learn.
    const which = used.length > 1 ? used.join(", ") : "Several variables";
    issues.push({
      path: `sources[${index}].database`,
      message: `${which} hold the same connection string where the worker runs, and Apply cannot tell from facetdb.config.ts which of them "${source.name}" reads, so it would not write the right one; give "${source.name}" a variable whose value no other variable shares, or edit facetdb.config.ts by hand`,
    });
    return source;
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config: { ...config, sources } };
}

/**
 * Judges `draft` within the project as the file loads now (`current.config`), renders the whole
 * project through the exporter and diffs it against the file's text. `env` is the worker's: a draft
 * may name only the connection variables the file already names (`judgeDraftSource`).
 */
export function planApply(
  current: { readonly path: string; readonly text: string; readonly config: ProjectConfig },
  draft: SourceDraft,
  env: Readonly<Record<string, string | undefined>>,
): PlanResult {
  const pinned = pinVariables(current.config, current.text, env);
  if (!pinned.ok) {
    return pinned;
  }
  const file = pinned.config;
  const judged = judgeDraftSource(file, draft, env);
  if (!judged.ok) {
    return judged;
  }
  // The exporter writes `process.env.<variable>` for each table source, the variable a name the
  // schema has judged (`databaseEnv`). One the loader could not record (its value unset where the
  // worker runs) would be written as DATABASE_URL: another connection than the one in force.
  const issues = judged.config.sources.flatMap((source, index): ConfigIssue[] =>
    source.api || source.databaseEnv !== undefined
      ? []
      : [
          {
            path: `sources[${index}].database`,
            message: `the variable "${source.name}" reads its connection string from is not set where the worker runs, so Apply cannot write the source back; set it, restart facetdb worker, then apply again`,
          },
        ],
  );
  issues.push(...operatorOnly(file, judged.config, draft.name));
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const after = configFileSource(judged.config);
  const id = createHash("sha256")
    .update(`${current.path}\u0000${current.text}\u0000${after}`)
    .digest("hex");
  return {
    ok: true,
    plan: {
      path: current.path,
      before: current.text,
      after,
      diff: unifiedDiff(current.path, current.text, after),
      changed: after !== current.text,
      id,
      config: judged.config,
      warnings: judged.warnings,
    },
  };
}

/** Why the file is not replaced without `force`, in words with the fix; undefined when git keeps it. */
export function uncommittedWords(
  state: GitState,
  path: string,
): { readonly message: string; readonly fix: string } | undefined {
  const commit = `git add ${path} && git commit`;
  const force = 'apply again with force ("force": true)';
  switch (state.kind) {
    case "clean":
      return undefined;
    case "modified":
      return {
        message: `${path} has changes git has not committed, and Apply would replace them`,
        fix: `commit them (${commit}), or ${force} to replace them`,
      };
    case "untracked":
      return {
        message: `${path} has never been committed to git, so nothing could bring back what it holds now once Apply replaced it`,
        fix: `commit it first (${commit}), or ${force} to replace it`,
      };
    case "ignored":
      return {
        message: `${path} is ignored by git, so git keeps no copy of it to bring back once Apply replaced it`,
        fix: `${force} to replace it (copy it aside first to keep this version), or stop ignoring it and commit it`,
      };
    case "no-repository":
      return {
        message: `${path} is not in a git repository, so Apply cannot tell whether it holds changes kept nowhere else`,
        fix: `${force} to replace it, or put the project under git (git init, then ${commit}) so Apply can check`,
      };
    case "no-git":
      return {
        message: `git is not installed here, so Apply cannot tell whether ${path} has changes that are not committed`,
        fix: `${force} to replace it, or install git so Apply can check`,
      };
    case "unreadable":
      return {
        message: `git could not say whether ${path} has changes that are not committed (${state.reason})`,
        fix: `run git status in the project to see why, or ${force} to replace it`,
      };
  }
}

export type ApplyResult =
  | { readonly kind: "written" }
  /** The plan changes nothing: nothing was written. */
  | { readonly kind: "unchanged" }
  /** The file is no longer the one the plan was made from: nothing was written. */
  | { readonly kind: "moved" }
  | { readonly kind: "not-a-file" }
  | { readonly kind: "uncommitted"; readonly message: string; readonly fix: string };

/**
 * Writes the plan's file, aside and renamed into place, unless git shows the file holds changes it
 * could not bring back (anything but a committed, unmodified file) and `force` was not given. The
 * file is read again first: one changed since the plan was made is never replaced.
 */
export async function apply(
  plan: ApplyPlan,
  options: { readonly force: boolean; readonly files: ConfigFiles },
): Promise<ApplyResult> {
  const { files } = options;
  const now = await files.read(plan.path);
  if (now.kind !== "file") {
    return { kind: "not-a-file" };
  }
  if (now.text !== plan.before) {
    return { kind: "moved" };
  }
  if (!plan.changed) {
    return { kind: "unchanged" };
  }
  if (!options.force) {
    const refusal = uncommittedWords(await files.gitState(plan.path), plan.path);
    if (refusal !== undefined) {
      return { kind: "uncommitted", ...refusal };
    }
  }
  await files.replace(plan.path, plan.after);
  return { kind: "written" };
}
