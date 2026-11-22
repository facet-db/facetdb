import { z } from "facetdb/plugin";
import { GithubActionError, type Session, send, TRIED_AGAIN } from "./rest.ts";
import { parseIssueNumber, parseRepo, REPO_RULE, type Repo } from "./settings.ts";

/**
 * The one issue an action may touch: the repository the action's own `repo` names (required in
 * every action today, refused at load when missing), else, for 148, the `repo` a GitHub source of
 * this plugin gives; and the issue number from the record's key. Both are judged before any
 * request, so a key or a setting can never point a request at another issue, repository or host.
 */

/** The issue an action runs on: its repository and its number. */
export type IssueRef = {
  readonly repo: Repo;
  readonly number: number;
  /** `your-org/your-repo#7`, for the words of a failure. */
  readonly label: string;
};

/** The source an action runs on, as its context gives it (the SDK's `ActionContext.source`). */
type ActionSource = {
  readonly name: string;
  readonly settings: Readonly<Record<string, unknown>> | null;
};

/**
 * The issue `key` names in the repository the action runs on, or a failure in fixed words.
 *
 * On a source of this same plugin (the issues source: the context gives its settings), the
 * repository is the source's, since the record's key is an issue number of that repository: an
 * action naming another repository is refused, both named, before any request (it would change
 * issue #N of a repository the key does not name), and one naming the same repository runs. On any
 * other source the action's own `repo` is the repository. With neither, the action is refused here,
 * before any request; the schemas refuse that case at load today, since `repo` is required.
 */
export function issueOf(
  action: string,
  source: ActionSource,
  ownRepo: string | undefined,
  key: string,
): IssueRef {
  const subject = `github ${action} on the source ${source.name}`;
  // Each refusal here is certain before any request, and the same at every try of this row: it is
  // refused for good (`temporary` false), given up at once with its fix.
  const refused = (what: string, fix: string) =>
    new GithubActionError(what, fix, undefined, undefined, false);
  let repoText: string;
  if (source.settings !== null) {
    // A source of this plugin (the issues source): the repository is its own.
    const given = source.settings["repo"];
    if (typeof given !== "string" || parseRepo(given) === undefined) {
      throw refused(
        `${subject}: the GitHub source gives no repository FacetDB can read`,
        `set the source's repo: it ${REPO_RULE}`,
      );
    }
    if (ownRepo !== undefined && ownRepo.toLowerCase() !== given.toLowerCase()) {
      throw refused(
        `${subject}: the action names the repository ${ownRepo}, but the source reads ${given}, whose issue numbers are the records' keys`,
        `write repo: "${given}" in the action, the source's own repository, so the action changes the issue the record names`,
      );
    }
    repoText = given;
  } else if (ownRepo !== undefined) {
    repoText = ownRepo;
  } else {
    throw refused(
      `${subject}: the source is not a GitHub source, so the action does not know the repository`,
      "name it in the action, github." +
        `${action}({ repo: "your-org/your-repo", ... }), and make the record's key the issue's number`,
    );
  }
  // The schemas judged both texts; parsed again here so the type carries the two segments.
  const repo = parseRepo(repoText) as Repo;
  const number = parseIssueNumber(key);
  if (number === undefined) {
    throw refused(
      `${subject}: the record's key is not an issue number (a whole number from 1, written with digits only)`,
      "run the action on a source whose record key is the issue's number",
    );
  }
  return { repo, number, label: `${repo.owner}/${repo.name}#${number}` };
}

/** The issue's path under the API: `repos/{owner}/{name}/issues/{number}`. */
export function issuePath(issue: IssueRef, ...rest: readonly string[]): readonly string[] {
  return ["repos", issue.repo.owner, issue.repo.name, "issues", String(issue.number), ...rest];
}

/** The repository's own path: `repos/{owner}/{name}`. */
export function repoPath(issue: IssueRef, ...rest: readonly string[]): readonly string[] {
  return ["repos", issue.repo.owner, issue.repo.name, ...rest];
}

/** The parts of an issue the actions read: its labels' names and its assignees' logins. */
const issueShape = z.object({
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })).nullish(),
});

/** The one field of a repository read: whether it takes issues at all. */
const repoShape = z.object({ has_issues: z.boolean() });

/** The issue as the actions read it. */
export type IssueState = {
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
};

/**
 * Returns when the repository answers as itself and takes issues, so that what the issue's read
 * answered (a 404, a 410, a redirect) means the issue alone is gone or moved; throws otherwise, in
 * fixed words. The repository is read with `redirect: "error"`: a renamed repository (GitHub
 * redirects every request to its old name) and an `apiUrl` naming GitHub Enterprise Server's web
 * address without `/api/v3` (it redirects, or answers a page) fail here, named, instead of every
 * action passing as done on an issue it never saw. A 404 here is a typo in the repository's name
 * or a token that cannot see it; a 401, 403, 429 or 5xx is named as any request's is.
 */
async function confirmRepository(
  session: Session,
  issue: IssueRef,
  issueStatus: number,
): Promise<void> {
  const name = `${issue.repo.owner}/${issue.repo.name}`;
  const repository = await send(session, {
    method: "GET",
    path: repoPath(issue),
    step: `reading the repository ${name} (the issue was not found where it was asked for)`,
    unreached: {
      what: `${session.subject}: reading the repository ${name} was answered with a redirect, which is never followed, or GitHub could not be reached for it`,
      fix: `the repository may have been renamed or moved: write its current owner/name in the action's repo; or apiUrl may name GitHub Enterprise Server's web address: write its REST API, such as https://github.example.com/api/v3; if neither, check that the worker reaches the API over HTTPS; ${TRIED_AGAIN}`,
    },
  });
  const parsed = repoShape.safeParse(repository.body);
  if (!parsed.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading the repository ${name} is not a repository FacetDB can read`,
      `check that apiUrl names GitHub's REST API (for GitHub Enterprise Server, its address ending in /api/v3), not its web pages; ${TRIED_AGAIN}`,
      repository.status,
    );
  }
  if (!parsed.data.has_issues) {
    // Refused for good: the issue's own 404 or 410 says so, and FacetDB gives it up at once, so the
    // fix promises no retry.
    throw new GithubActionError(
      `${session.subject}: issues are turned off in the repository ${name}`,
      "turn issues on in the repository's settings, or take the action out of the config",
      issueStatus === 0 ? undefined : issueStatus,
      undefined,
      false,
    );
  }
}

/**
 * The issue's labels and assignees, or undefined when the issue alone is gone or moved: the issue's
 * read answers a 404 (deleted, or never there), a 410 (deleted) or a redirect (GitHub's 301 for an
 * issue transferred to another repository), AND the repository answers as itself and takes issues
 * (`confirmRepository`). Then nothing is left to change here and nothing to try again: done, with
 * nothing written. Otherwise the action fails in words that name the cause.
 *
 * The read of the issue alone takes `redirect: "manual"`, so a redirect is seen and never
 * followed, and the token never travels with it; every other request refuses a redirect outright.
 */
export async function readIssue(
  session: Session,
  issue: IssueRef,
): Promise<IssueState | undefined> {
  const reply = await send(session, {
    method: "GET",
    path: issuePath(issue),
    step: "reading the issue",
    accept: [404, 410],
    redirect: "manual",
  });
  if (reply.moved || reply.status === 404 || reply.status === 410) {
    await confirmRepository(session, issue, reply.status);
    return undefined;
  }
  const parsed = issueShape.safeParse(reply.body);
  if (!parsed.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading the issue is not an issue FacetDB can read`,
      `check that apiUrl names GitHub's REST API (for GitHub Enterprise Server, its address ending in /api/v3), not its web pages; ${TRIED_AGAIN}`,
      reply.status,
    );
  }
  return {
    labels: parsed.data.labels.map((label) => (typeof label === "string" ? label : label.name)),
    assignees: (parsed.data.assignees ?? []).map((assignee) => assignee.login),
  };
}
