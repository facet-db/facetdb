import { createHash } from "node:crypto";
import {
  type DraftPlugins,
  judgeDraftProject,
  judgeDraftSource,
  type NewSourceSetup,
  type ProjectDraft,
  type SourceDraft,
} from "./draft.ts";
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
 * in it (only `env("<variable>")` of a variable the file already names), and an action is
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

/** Each state in which Apply replaces the file only with `force`; the studio words each its own way. */
export type UncommittedState = Exclude<GitState["kind"], "clean">;

/** Why the file is not replaced without `force`: the state, and the terminal's words with the fix. */
export type Uncommitted = {
  readonly state: UncommittedState;
  readonly message: string;
  readonly fix: string;
};

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
  /** The wording warnings of the draft source; never a refusal; none for a project draft. */
  readonly warnings: readonly ConfigWarning[];
  /**
   * The file holds lines the exporter would not write for the project as it loads now (comments,
   * code or a layout of the person's own): the whole-file write drops them.
   */
  readonly dropsOwnText: boolean;
};

/**
 * What Apply places into the file: one source (the Questions page, the setup flow), or the
 * project's own settings (Settings' spending cap, the Alerts page's channels and the Plugins page's
 * settings), never both in one draft.
 */
export type ConfigDraft = { readonly source: SourceDraft } | { readonly project: ProjectDraft };

export type PlanResult =
  | { readonly ok: true; readonly plan: ApplyPlan }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * The fields a draft never changes, because what they hold runs as the operator's own code: `where`
 * is SQL spliced into the source's queries and its trigger, and an action names a plugin and its
 * settings (a webhook's URL among them), which run with the record's state. A draft for a source
 * the file has must carry the file's own; a new source carries none.
 */
function operatorOnly(
  file: ProjectConfig,
  judged: ProjectConfig,
  name: string,
  setup: NewSourceSetup | undefined,
): ConfigIssue[] {
  const index = judged.sources.findIndex((source) => source.name === name);
  const drafted = judged.sources[index];
  if (drafted === undefined) {
    return [];
  }
  const before = file.sources.find((source) => source.name === name);
  const issues: ConfigIssue[] = [];
  // The operator's own setup of a source the file does not have yet may give it a where filter: the
  // setup shows it in the install SQL and in this diff, as typed, before anything runs. Actions
  // stay refused: the setup offers none.
  const operatorsNewSource = setup !== undefined && before === undefined;
  if (drafted.where !== before?.where && !operatorsNewSource) {
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
  // A plugin source names the plugin that reads every record and its settings, as an action does;
  // adding one from the studio is not offered.
  if (JSON.stringify(drafted.source) !== JSON.stringify(before?.source)) {
    issues.push({
      path: `sources[${index}].source`,
      message: `a draft cannot ${before === undefined ? "give a new source" : "change"} source: it names the plugin that reads every record and the settings it reads them with; edit source in facetdb.config.ts by hand`,
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
 * The variable each source reads its connection from, as the file names it. A source written as
 * `env("X")` named it, and the loader marked the name as the file's own (`databaseEnvNamed`): it is
 * kept as it is. One written as `process.env.X` arrived as a string, and the loader recorded the
 * variable by the value it found (DATABASE_URL first), so where two variables hold the same string
 * on this machine it may name another one than the file does, and Apply would write that one: a
 * different database wherever they differ. The file's own name wins; where the file names more than
 * one of them, or none, Apply cannot tell and refuses. The mark decides, never the text: a file
 * holding `env("X")` for one source and `process.env.X` for another would otherwise confirm the
 * guess for the second by the first's name.
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
    if (source.databaseEnv === undefined || value === undefined || source.databaseEnvNamed) {
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

/** The project with the draft in place, and the draft source's wording warnings (a project draft has none). */
function judgeDraft(
  file: ProjectConfig,
  draft: ConfigDraft,
  env: Readonly<Record<string, string | undefined>>,
  setup: NewSourceSetup | undefined,
  plugins: DraftPlugins | undefined,
):
  | {
      readonly ok: true;
      readonly config: ProjectConfig;
      readonly warnings: readonly ConfigWarning[];
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] } {
  if ("source" in draft) {
    return judgeDraftSource(file, draft.source, env, setup);
  }
  const judged = judgeDraftProject(file, draft.project, env, plugins);
  return judged.ok ? { ok: true, config: judged.config, warnings: [] } : judged;
}

/**
 * Judges `draft` within the project as the file loads now (`current.config`), renders the whole
 * project through the exporter and diffs it against the file's text. `env` is the worker's: a draft
 * may name only the connection variables the file already names (`judgeDraftSource`). `setup` is
 * the studio's setup flow's alone: the operator on this machine adding a new source, which may name
 * its own variable and carry a where filter; a project draft never takes one. `plugins` is the
 * running worker's: a project draft's `alerts` and `plugins` are judged against the plugins it
 * loaded, and refused without them.
 */
export function planApply(
  current: { readonly path: string; readonly text: string; readonly config: ProjectConfig },
  draft: ConfigDraft,
  env: Readonly<Record<string, string | undefined>>,
  setup?: NewSourceSetup,
  plugins?: DraftPlugins,
): PlanResult {
  const pinned = pinVariables(current.config, current.text, env);
  if (!pinned.ok) {
    return pinned;
  }
  const file = pinned.config;
  // A project draft (Settings' spending cap, the channels, a plugin's settings) changes no source,
  // so it has no where filter or actions to guard and no wording to warn about; the whole file is
  // still rendered again, so the variables stay pinned above and the unset-variable check below
  // holds for it too.
  const judged = judgeDraft(file, draft, env, setup, plugins);
  if (!judged.ok) {
    return judged;
  }
  // The exporter writes `env("<variable>")` for each table source, the variable a name the schema
  // has judged (`databaseEnv`). One the loader could not record (its value unset where the worker
  // runs) would be written as DATABASE_URL: another connection than the one in force.
  const issues = judged.config.sources.flatMap((source, index): ConfigIssue[] =>
    source.api || source.source !== undefined || source.databaseEnv !== undefined
      ? []
      : [
          {
            path: `sources[${index}].database`,
            message: `the variable "${source.name}" reads its connection string from is not set where the worker runs, so Apply cannot write the source back; set it, restart facetdb worker, then apply again`,
          },
        ],
  );
  if ("source" in draft) {
    issues.push(...operatorOnly(file, judged.config, draft.source.name, setup));
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const after = configFileSource(judged.config);
  const id = createHash("sha256")
    .update(`${current.path}\u0000${current.text}\u0000${after}`)
    .digest("hex");
  // FacetDB's own lines are the ones the exporter writes for the project as it loads now: any other
  // line in the file (a comment, a helper, a layout of the person's own) is gone once it is rewritten.
  const own = new Set(configFileSource(file).split("\n"));
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
      dropsOwnText: current.text.split("\n").some((line) => !own.has(line)),
    },
  };
}

/** Why the file is not replaced without `force`, in words with the fix; undefined when git keeps it. */
export function uncommittedWords(state: GitState, path: string): Uncommitted | undefined {
  if (state.kind === "clean") {
    return undefined;
  }
  return { state: state.kind, ...terminalWords(state, path) };
}

/** The terminal's words for a file git keeps no copy of, with the fix (`force` or a commit). */
function terminalWords(
  state: Exclude<GitState, { readonly kind: "clean" }>,
  path: string,
): { readonly message: string; readonly fix: string } {
  const commit = `git add ${path} && git commit`;
  const force = 'apply again with force ("force": true)';
  switch (state.kind) {
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
  | ({ readonly kind: "uncommitted" } & Uncommitted);

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
