/**
 * @facetdb/github: issues and pull requests as a source, labels, comments and assignments as
 * actions, and the issue triage question pack. Over `fetch` to GitHub's REST API, no SDK.
 *
 * ```ts
 * import { github } from "@facetdb/github";
 * plugins: { github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") } },   // apiUrl for GitHub Enterprise Server
 * source: github.issues({ repo: "your-org/your-repo", include: ["issues", "pull_requests"] }),
 * read: ["title", "body", "labels", "changed_files"],
 * actions: [
 *   github.label({ repo: "your-org/your-repo", when: { not_priority: true }, add: ["Not Priority"], else: { remove: ["Not Priority"] } }),
 *   github.comment({ repo: "your-org/your-repo", id: "triage", when: { status: "needs_review" }, body: "Triage: not priority is {{not_priority}} ({{not_priority.probability}})." }),
 *   github.assign({ repo: "your-org/your-repo", when: { needs_owner: true }, add: ["octocat"] }),
 * ],
 * ```
 *
 * The `issues` source reads one repository's issues and pull requests, the record's key the number:
 * GitHub's signed webhook names what changed (`receive`), `read` reads it, `scan` pages through
 * every open one for `facetdb backfill` (issues-source.ts). Its own poll is not built yet.
 *
 * `repo` is required in every action, and refused at load when missing: the SDK lets an action's
 * schema see nothing of the source it is configured on, so an action cannot yet take the repository
 * from the GitHub source when the config loads (an action-level load hook that sees the source, as
 * `ChannelSpec.check` does for a channel, would let the example leave it out). On the issues source
 * an action naming another repository than the source's is refused when it runs (issue.ts). The
 * comment action needs an `id` and a token tied to an account (actions.ts).
 *
 * The poll and the triage pack join the same `createGithubPlugin` and the same `github` helpers.
 */
import { type ActionCall, actionCall, type JsonValue, type SourceCall, sourceCall } from "facetdb";
import { definePlugin, type Plugin } from "facetdb/plugin";
import { type ActionDeps, githubActions } from "./actions.ts";
import { issuesSource } from "./issues-source.ts";
import type { Kind } from "./issues-state.ts";
import { type GithubConfig, pluginConfig } from "./settings.ts";

export type { ActionDeps as GithubPluginOptions } from "./actions.ts";
export { COMMENT_MAX, MARKER_PREFIX, NEEDS_REVIEW, VALUE_MAX } from "./comment-body.ts";
export { SCAN_PAGE, SEEN_MAX } from "./issues-scan.ts";
export { type IssuesSettings, issuesSettings } from "./issues-source.ts";
export {
  BODY_MAX,
  FILES_SHOWN,
  KINDS,
  LABEL_MAX,
  LABELS_MAX,
  PATH_MAX,
  TITLE_MAX,
} from "./issues-state.ts";
export {
  ACCEPTED,
  BAD_SIGNATURE,
  NO_SIGNATURE,
  OTHER_REPOSITORY,
  type Receipt,
  TOO_LARGE,
  UNREADABLE,
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOKS_OFF,
} from "./issues-webhook.ts";
export {
  BODY_MAX_BYTES,
  GithubActionError,
  type GithubFetch,
  PAGE_SIZE,
  PAGES_MAX,
  RETRY_AFTER_MAX_MS,
  TIMEOUT_MS,
} from "./rest.ts";
export { DEFAULT_API_URL, type GithubConfig } from "./settings.ts";

/** The plugin, its two side effects passed in: `fetch` and the clock (the source reads the worker's). */
export function createGithubPlugin(options: ActionDeps): Plugin<GithubConfig> {
  return definePlugin({
    name: "github",
    version: "0.0.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: pluginConfig,
    sources: { issues: issuesSource({ fetch: options.fetch }) },
    actions: githubActions(options),
  });
}

/** The plugin the worker loads: the one place the real `fetch` and clock are wired. */
export default createGithubPlugin({
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => Date.now(),
});

/** A `when` term, as `facetdb` reads it: a decision value, a status, or `{ atLeast }` on a number. */
type Condition = { readonly [term: string]: boolean | string | { readonly atLeast: number } };

/** What every use of an action may add to its settings: a condition, and what applies otherwise. */
type Conditional<Settings> = Settings & {
  readonly when?: Condition;
  readonly else?: Partial<Settings>;
};

/** Settings the label and the assign actions share: the names to add and to remove. */
type Lists = {
  /** `owner/name`: the repository whose issue number is the record's key. */
  readonly repo: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
};

export type LabelOptions = Conditional<Lists>;
export type AssignOptions = Conditional<Lists>;
export type CommentOptions = Conditional<{
  /** `owner/name`: the repository whose issue number is the record's key. */
  readonly repo: string;
  /** `{{name}}`, `{{name.probability}}` and `{{status}}` are filled from the decision. */
  readonly body: string;
  /** Names this comment in its hidden marker: the same across reorders, one per comment action. */
  readonly id: string;
}>;

export type IssuesOptions = {
  /** `owner/name`: the repository whose issues and pull requests are the records. */
  readonly repo: string;
  /** What the source reads; both by default. */
  readonly include?: readonly Kind[];
};

/** Settings as the config file holds them: JSON, with nothing left undefined. */
function written(options: object): { readonly [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(options)) as { readonly [key: string]: JsonValue };
}

export const github = {
  /** `github.issues({ repo: "your-org/your-repo", include: ["issues", "pull_requests"] })`. */
  issues(options: IssuesOptions): SourceCall {
    return sourceCall("@facetdb/github", "issues", written(options));
  },
  /** `github.label({ repo, add: ["Not Priority"], else: { remove: ["Not Priority"] }, when })`. */
  label(options: LabelOptions): ActionCall {
    return actionCall("@facetdb/github", "label", written(options));
  },
  /** `github.comment({ repo, id: "triage", body: "Not priority: {{not_priority}}", when })`. */
  comment(options: CommentOptions): ActionCall {
    return actionCall("@facetdb/github", "comment", written(options));
  },
  /** `github.assign({ repo, add: ["octocat"], when })`. */
  assign(options: AssignOptions): ActionCall {
    return actionCall("@facetdb/github", "assign", written(options));
  },
};
