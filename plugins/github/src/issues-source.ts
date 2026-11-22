import {
  type Infer,
  SourceAccessLost,
  type SourceContext,
  type SourceDefinition,
  type SourceRow,
  source,
  z,
} from "facetdb/plugin";
import { scanIssues } from "./issues-scan.ts";
import {
  ask,
  type ChangedFiles,
  issueFields,
  KINDS,
  type Kind,
  kindOf,
  readChangedFiles,
  SOURCE_FIX,
  stateOf,
} from "./issues-state.ts";
import { type Receipt, receiveEvent } from "./issues-webhook.ts";
import { POLL_INTERVAL_MS, POLL_INTERVAL_NO_WEBHOOK_MS, reconcile } from "./reconcile.ts";
import { GithubActionError, type GithubFetch, type Session } from "./rest.ts";
import {
  apiBase,
  type GithubConfig,
  parseIssueNumber,
  parseRepo,
  REPO_RULE,
  type Repo,
} from "./settings.ts";

/**
 * The GitHub plugin's `issues` source: a record per issue or pull request of one repository, its
 * key the number, its state the title, the body, the labels and the changed files
 * (issues-state.ts).
 *
 * - `receive`: GitHub's signed webhook deliveries name the numbers that changed (issues-webhook.ts).
 * - `read`: one `GET /repos/{o}/{r}/issues/{n}` a key, and for a pull request its first page of
 *   changed files (`GET /repos/{o}/{r}/pulls/{n}/files`, and `GET /repos/{o}/{r}/pulls/{n}` for the
 *   count when there is more than a page); requests one after another, as GitHub asks.
 * - `scan`: every open issue and pull request, newest first, through GitHub's search (issues-scan.ts).
 * - `watch`: the poll that finds what a webhook missed (reconcile.ts):
 *   at start and every 5 minutes, every 60 s with no webhook secret, the issues and pull
 *   requests updated since its cursor, until the source stops.
 *
 * Every request goes to `apiUrl` only (rest.ts builds each from its segments) with the token, a
 * user agent and the API version; a 401, or a 403 that is not a rate limit, is the SDK's
 * `SourceAccessLost`. A plugin never writes a decision: the worker does, through the store.
 */

/** The source's settings: `github.issues({ repo: "your-org/your-repo", include: ["issues"] })`. */
export const issuesSettings = z.object({
  /**
   * `owner/name`: the repository whose issues are the records. Named `repo`, as the GitHub actions
   * on this source read it (issue.ts, `issueOf`): an action naming another repository is refused.
   */
  repo: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'the source names no repository: write it in the source, github.issues({ repo: "your-org/your-repo" })'
          : `a repository ${REPO_RULE}`,
    })
    .refine((text) => parseRepo(text) !== undefined, { error: `a repository ${REPO_RULE}` }),
  /** What the source reads: issues, pull requests, or both (the default). */
  include: z
    .array(z.enum(KINDS, { error: 'include takes "issues" and "pull_requests"' }))
    .min(1, { error: 'include names at least one of "issues" and "pull_requests"' })
    .default([...KINDS]),
});

export type IssuesSettings = Infer<typeof issuesSettings>;

type Context = SourceContext<GithubConfig, IssuesSettings>;

/**
 * What the source is given besides its context, wired in index.ts (the clock is the worker's):
 * `fetch`, and where the poll's lines go (a rate limit's wait, a poll GitHub failed).
 */
export type SourceDeps = {
  readonly fetch: GithubFetch;
  readonly warn: (line: string) => void;
};

/** The repository the source reads; its schema judged it. */
function repoOf(ctx: Context): Repo {
  return parseRepo(ctx.source.settings.repo) as Repo;
}

/** The session of one call of the source: its requests, its token, its stop, the worker's clock. */
function sessionOf(deps: SourceDeps, ctx: Context, repo: Repo): Session {
  return {
    fetch: deps.fetch,
    now: () => ctx.clock.now(),
    token: ctx.config.token,
    base: apiBase(ctx.config.apiUrl),
    signal: ctx.signal,
    subject: `github issues source on ${repo.owner}/${repo.name}`,
  };
}

/**
 * Returns when the repository answers as itself, so that what an issue's read answered (a 404, a
 * 410, a redirect) means that issue alone is gone; read once per `read` that saw one. A redirect or
 * no answer (a renamed repository, or an `apiUrl` that is GitHub Enterprise Server's web address)
 * fails in words; a 404 is a token that cannot see the repository (GitHub answers 404, not 403, to
 * a token without access to a private repository) or a repository that is not there: either way
 * the source cannot read it, `SourceAccessLost`, so the worker stops this source alone and tries
 * again later rather than skip every record as deleted.
 */
async function confirmRepository(session: Session, repo: Repo): Promise<void> {
  const name = `${repo.owner}/${repo.name}`;
  const reply = await ask(session, {
    method: "GET",
    path: ["repos", repo.owner, repo.name],
    step: `reading the repository ${name}`,
    accept: [404],
    unreached: {
      what: `${session.subject}: reading the repository ${name} was answered with a redirect, which is never followed, or GitHub could not be reached for it`,
      fix: "the repository may have been renamed or moved: write its current owner/name in the source's repo; or apiUrl may name GitHub Enterprise Server's web address: write its REST API, such as https://github.example.com/api/v3; the source is tried again",
    },
  });
  if (reply.status === 404) {
    throw new SourceAccessLost(
      `${session.subject}: GitHub answers 404 for the repository ${name}: the token cannot see it, or no repository has that name; give the token in the variable plugins.github.token names access to the repository, or correct the source's repo`,
    );
  }
  if (!z.object({ full_name: z.string() }).safeParse(reply.body).success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading the repository ${name} is not a repository FacetDB can read`,
      SOURCE_FIX,
      reply.status,
    );
  }
}

/**
 * The state of each key, in the order asked, each key once. A key that is not an issue number as
 * this source writes one (decimal digits, no leading zero), a number GitHub answers 404 or 410 for
 * or redirects (deleted, transferred), and one of a kind `include` leaves out, are left out, as the
 * SDK's `read` says. A failure of any request fails the whole read (the worker reads them again).
 */
async function readIssues(
  deps: SourceDeps,
  ctx: Context,
  keys: readonly string[],
): Promise<SourceRow[]> {
  const repo = repoOf(ctx);
  const include = new Set<Kind>(ctx.source.settings.include);
  const session = sessionOf(deps, ctx, repo);
  const rows: SourceRow[] = [];
  let missing = false;
  for (const key of new Set(keys)) {
    const number = parseIssueNumber(key);
    if (number === undefined) {
      continue;
    }
    const reply = await ask(session, {
      method: "GET",
      path: ["repos", repo.owner, repo.name, "issues", key],
      step: `reading #${number}`,
      accept: [404, 410],
      // A transferred issue answers 301 to where it went: seen, never followed with the token.
      redirect: "manual",
    });
    if (reply.moved || reply.status === 404 || reply.status === 410) {
      missing = true;
      continue;
    }
    const item = issueFields.safeParse(reply.body);
    if (!item.success || item.data.number !== number) {
      throw new GithubActionError(
        `${session.subject}: GitHub's answer to reading #${number} is not that issue as FacetDB reads one`,
        SOURCE_FIX,
        reply.status,
      );
    }
    const kind = kindOf(item.data);
    if (!include.has(kind)) {
      continue;
    }
    let files: ChangedFiles | undefined;
    if (kind === "pull_requests") {
      files = await readChangedFiles(session, repo, number);
      if (files === undefined) {
        missing = true;
        continue;
      }
    }
    rows.push({ key, state: stateOf(item.data, files) });
  }
  if (missing) {
    await confirmRepository(session, repo);
  }
  return rows;
}

/** The issues source, over the `fetch` it is given. */
export function issuesSource(
  deps: SourceDeps,
): SourceDefinition<GithubConfig, typeof issuesSettings> {
  /**
   * Each source's repository id, once a signed event of it said it, by API and repository: kept for
   * the life of the worker, so an event naming the same `owner/name` from another repository (the
   * name passed on after a rename or a transfer) is refused from then on.
   */
  const ids = new Map<string, number>();
  return source<GithubConfig, typeof issuesSettings>({
    config: issuesSettings,
    watch(ctx) {
      const repo = repoOf(ctx);
      return reconcile({
        session: sessionOf(deps, ctx, repo),
        repo,
        include: new Set<Kind>(ctx.source.settings.include),
        // With no webhook secret every delivery is refused: the poll is all the source hears.
        interval:
          ctx.config.webhookSecret === undefined ? POLL_INTERVAL_NO_WEBHOOK_MS : POLL_INTERVAL_MS,
        clock: ctx.clock,
        cursor: ctx.cursor,
        warn: deps.warn,
      });
    },
    read: (ctx, keys) => readIssues(deps, ctx, keys),
    scan(ctx, cursor) {
      const repo = repoOf(ctx);
      return scanIssues(
        sessionOf(deps, ctx, repo),
        repo,
        new Set<Kind>(ctx.source.settings.include),
        cursor,
      );
    },
    receive(ctx, request): Promise<Receipt> {
      const repo = repoOf(ctx);
      const known = `${apiBase(ctx.config.apiUrl).href} ${repo.owner}/${repo.name}`.toLowerCase();
      return receiveEvent(
        {
          secret: ctx.config.webhookSecret,
          repo,
          include: new Set<Kind>(ctx.source.settings.include),
          knownId: ids.get(known),
          learn: (id) => ids.set(known, id),
        },
        request,
      );
    },
  });
}
