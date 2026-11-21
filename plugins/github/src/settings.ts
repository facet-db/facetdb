import { type Infer, z } from "facetdb/plugin";

/**
 * The GitHub plugin's settings and the two names every request is built from, the repository and
 * the issue number. Each is checked where it enters (the config file, a source's settings, a
 * record's key) so that nothing it holds can change a request's host or path: the repository is
 * `owner/name` in the characters GitHub allows, the issue number a positive integer, the API's
 * address https (http only on this machine) with no user, query or fragment. The words never
 * quote a value: the plugin host prints none for a value read from a variable, and the repository
 * and the issue number are not secrets.
 */

/** The REST API every request goes to unless `apiUrl` names another (GitHub Enterprise Server). */
export const DEFAULT_API_URL = "https://api.github.com";

/**
 * A token as GitHub issues one: `ghp_…`, `github_pat_…`, `ghs_…` or a classic 40-character hex
 * token. Only letters, digits and `_`, so it cannot break the `authorization` header it goes into.
 */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** A user or organisation login: letters, digits and single dashes, at most 39, as GitHub allows. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A repository's name: letters, digits, `.`, `_` and `-`, at most 100; never only dots. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The words that say what a repository is, for every refusal of one. */
export const REPO_RULE =
  'must be the repository as "owner/name" (such as "your-org/your-repo"): one slash, the owner in letters, digits and dashes, the name in letters, digits, ".", "_" and "-"';

/** A repository split into the two segments of its path. */
export type Repo = { readonly owner: string; readonly name: string };

/** The repository `text` names, or undefined when it is not `owner/name` as GitHub writes one. */
export function parseRepo(text: string): Repo | undefined {
  const parts = text.split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  const [owner, name] = parts as [string, string];
  if (!OWNER.test(owner) || !REPO_NAME.test(name) || /^\.+$/.test(name)) {
    return undefined;
  }
  return { owner, name };
}

/** The refusal of an action that names no repository, with where to write it, in its own helper. */
export function repoRequired(action: "label" | "comment" | "assign"): string {
  return `the action names no repository: write it in the action, github.${action}({ repo: "your-org/your-repo", ... }), the repository whose issue number is the record's key (every GitHub action names it until a GitHub source of this plugin can give it)`;
}

/**
 * The `repo` setting of one action, required: the SDK gives an action's schema no sight of the
 * source it runs on when the config loads, and no source of this plugin exists yet, so an action
 * that named none would load clean and fail at every delivery.
 */
export function repoSetting(action: "label" | "comment" | "assign") {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined ? repoRequired(action) : `a repository ${REPO_RULE}`,
    })
    .refine((text) => parseRepo(text) !== undefined, { error: `a repository ${REPO_RULE}` });
}

/** The largest issue number taken: GitHub's numbers are 32-bit. */
const ISSUE_MAX = 2_147_483_647;

/** The issue a record's key names, or undefined when the key is not a positive integer as text. */
export function parseIssueNumber(key: string): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(key)) {
    return undefined;
  }
  const number = Number(key);
  return number <= ISSUE_MAX ? number : undefined;
}

/** The hosts an `apiUrl` may reach over plain http: this machine only (a local test server). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why an `apiUrl` is refused, or undefined when it holds. */
export function apiUrlProblem(text: string): string | undefined {
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(text) || !URL.canParse(text)) {
    return "is not a URL written as plain text";
  }
  const url = new URL(text);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return "must start with https:// (http:// only for a server on this machine, such as http://localhost:8080)";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return "must be the API's address alone, with no user, password, query or fragment (the token goes in plugins.github.token)";
  }
  if (/%2f|%5c|%2e/i.test(url.pathname)) {
    return "must not hold an encoded slash or dot in its path";
  }
  return undefined;
}

/** The API's address as requests are built from it (each request's path goes after its own). */
export function apiBase(apiUrl: string | undefined): URL {
  return new URL(apiUrl ?? DEFAULT_API_URL);
}

/** The plugin's settings: `plugins: { github: { token: env("GITHUB_TOKEN") } }`. */
export const pluginConfig = z.object({
  /**
   * A token that may change the repository's issues: a fine-grained token with Issues read and
   * write on it, or a classic token with the repo scope (public_repo for a public repository).
   */
  token: z.secret().regex(TOKEN, {
    error:
      "must be a GitHub token as GitHub gives it (ghp_…, github_pat_…, ghs_…): letters, digits and _ only, no spaces",
  }),
  /** GitHub Enterprise Server's REST API, such as https://github.example.com/api/v3. */
  apiUrl: z
    .string()
    .superRefine((text, context) => {
      const problem = apiUrlProblem(text);
      if (problem !== undefined) {
        context.addIssue({ code: "custom", message: `the API's address ${problem}` });
      }
    })
    .optional(),
});

export type GithubConfig = Infer<typeof pluginConfig>;
