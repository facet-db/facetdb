import { type Infer, SourceAccessLost, z } from "facetdb/plugin";
import type { ManagedLabels } from "./managed-labels.ts";
import {
  GithubActionError,
  type Request as GithubRequest,
  nextLink,
  type Reply,
  rateLimited,
  refusal,
  type Session,
  send,
} from "./rest.ts";
import { ISSUE_MAX, type Repo } from "./settings.ts";

/**
 * What the issues source keeps of one issue or pull request, and the source's one way of asking
 * GitHub: the plugin's REST client (rest.ts), with a refused token thrown as the SDK's
 * `SourceAccessLost`.
 *
 * Every field is text, as the FacetDB store keeps a state; GitHub's text is untrusted and kept as
 * text. The host refuses a whole row whose state holds a NUL or a lone surrogate, so an author who
 * put one in their own issue would keep it out of triage: each is replaced here by U+FFFD (the
 * replacement character, one code unit for one), in the title, the body, every label and every
 * path, before the bounds. Each field is then bounded so that no answer of GitHub's can make a
 * state the host refuses by its size (over 1 MiB) either: the bounds below are in UTF-16 code
 * units, so a state takes at most about 0.75 MiB
 * of JSON even when every character is escaped as six bytes (the body 384 KiB, the paths 300 KiB,
 * the labels 60 KiB, the title 6 KiB), under the host's 1 MiB.
 * - `title`: at most `TITLE_MAX` characters (GitHub allows 256);
 * - `body`: at most `BODY_MAX` characters (GitHub's own limit for an issue's body, so a body GitHub
 *   wrote is never cut), or null for an issue with no description;
 * - `labels`: the label names but those the source's own label actions manage (managed-labels.ts),
 *   sorted, one a line, at most `LABELS_MAX` names (GitHub allows 100 on an issue) of at most
 *   `LABEL_MAX` characters (GitHub allows 50);
 * - `changed_files`: for a pull request, a first line with the count of changed files, then the
 *   first `FILES_SHOWN` paths in GitHub's order, one a line, each at most `PATH_MAX` characters;
 *   for an issue, empty.
 * A text cut at its bound ends with "…", never in the middle of a surrogate pair.
 *
 * A label FacetDB's own label actions manage is left out, so the state, and its hash, do not move
 * when FacetDB labels an issue: `read` and `scan` both build the state here, so a record stored by
 * either has the same state.
 */

/** What the source reads: `include` takes these, both by default. */
export const KINDS = ["issues", "pull_requests"] as const;
export type Kind = (typeof KINDS)[number];

export const TITLE_MAX = 1_024;
export const BODY_MAX = 65_536;
export const LABELS_MAX = 100;
export const LABEL_MAX = 100;
export const FILES_SHOWN = 100;
export const PATH_MAX = 512;

/** An issue's number as GitHub writes it in an answer: a whole number from 1, 32-bit. */
export const issueNumber = z.number().int().min(1).max(ISSUE_MAX);

/**
 * The parts of an issue or a pull request the state is made of, as the issue read
 * (`GET /repos/{o}/{r}/issues/{n}`) and the search answer them; a pull request carries a
 * `pull_request` object. Anything else GitHub sends is not read.
 */
export const issueFields = z.object({
  number: issueNumber,
  title: z.string(),
  body: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  pull_request: z.unknown().optional(),
});

export type IssueFields = Infer<typeof issueFields>;

/** Whether GitHub's answer is a pull request (it carries `pull_request`) or an issue. */
export function kindOf(item: Pick<IssueFields, "pull_request">): Kind {
  return item.pull_request === undefined || item.pull_request === null ? "issues" : "pull_requests";
}

/** U+FFFD, the replacement character, named by its code point so no tool can mistake it. */
export const REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * `text` as the store keeps it: every NUL and every lone surrogate (the two characters the host's
 * check of a state refuses, `source-connector.ts`) replaced by U+FFFD, the length unchanged
 * (`toWellFormed` writes U+FFFD for a lone surrogate too).
 */
export function storable(text: string): string {
  return text.replaceAll("\u0000", REPLACEMENT).toWellFormed();
}

/** `text` held to `max` UTF-16 code units, ending with "…" when cut; a surrogate pair is never split. */
export function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** The order of label names: by their lowercase form, then as written; the same on every machine. */
function byName(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x !== y) {
    return x < y ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A pull request's changed files: the first `FILES_SHOWN` paths, and how many files it changes. */
export type ChangedFiles = { readonly paths: readonly string[]; readonly total: number };

function filesText(files: ChangedFiles): string {
  const count = `${files.total} ${files.total === 1 ? "file" : "files"} changed`;
  const head =
    files.total > files.paths.length ? `${count}; the first ${files.paths.length}:` : `${count}:`;
  return files.paths.length === 0
    ? count
    : [head, ...files.paths.map((path) => cut(storable(path), PATH_MAX))].join("\n");
}

/**
 * The record's state: every field text (or null for a missing body), made storable, then held to
 * its bound; a label `managed` names is left out before the bound, compared as GitHub names it.
 */
export function stateOf(
  item: IssueFields,
  files: ChangedFiles | undefined,
  managed: ManagedLabels,
): Readonly<Record<string, string | null>> {
  const names = item.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((name) => !managed.has(name))
    .map((name) => cut(storable(name), LABEL_MAX))
    .sort(byName)
    .slice(0, LABELS_MAX);
  return {
    title: cut(storable(item.title), TITLE_MAX),
    body: item.body === undefined || item.body === null ? null : cut(storable(item.body), BODY_MAX),
    labels: names.join("\n"),
    changed_files: files === undefined ? "" : filesText(files),
  };
}

/** The end of every refused token's words: where it is set and what it needs. */
export const TOKEN_FIX =
  "put a valid token in the variable plugins.github.token names: a fine-grained token with Issues and Pull requests read on the repository (a classic token with the repo scope, or public_repo for a public repository); the source is tried again by itself, so a token restored is picked up without a restart";

/** The fix of a source's failure other than a refused token. */
export const SOURCE_FIX =
  "check that apiUrl names GitHub's REST API (for GitHub Enterprise Server, its address ending in /api/v3); the source is tried again";

/**
 * One request of the source: `send` (rest.ts), with a 401, and a 403 that is not a rate limit,
 * thrown as `SourceAccessLost` in fixed words (the worker stops this source alone and tries it again
 * later); a 403 rate limit is the `GithubActionError` `refusal` makes, with the wait GitHub asked
 * for: it fails the read or the scan, which the worker tries again (the poll waits out its own
 * list's, reconcile.ts). The token is in no word of either.
 */
export async function ask(session: Session, request: GithubRequest): Promise<Reply> {
  const reply = await send(session, {
    ...request,
    accept: [...(request.accept ?? []), 401, 403],
  });
  if (reply.status === 401) {
    throw new SourceAccessLost(
      `${session.subject}: GitHub does not accept the token (status 401) for ${request.step}; ${TOKEN_FIX}`,
    );
  }
  if (reply.status === 403) {
    if (rateLimited(reply)) {
      throw refusal(session, request, reply);
    }
    throw new SourceAccessLost(
      `${session.subject}: the token is not allowed ${request.step} (status 403); ${TOKEN_FIX}`,
    );
  }
  return reply;
}

/** One page of a pull request's files: only each file's path is read. */
const filesPage = z.array(z.object({ filename: z.string() }));

/** A pull request's own count of changed files. */
const pullCount = z.object({ changed_files: z.number().int().nonnegative() });

/**
 * The changed files of pull request `number`: its first page of files (`per_page` 100), and the
 * count, which is that page's length when GitHub gives no next page and the pull request's own
 * `changed_files` otherwise (one request more). Undefined when GitHub answers 404 or 410 (the pull
 * request is gone since it was listed). No further page is read.
 */
export async function readChangedFiles(
  session: Session,
  repo: Repo,
  number: number,
): Promise<ChangedFiles | undefined> {
  const pull = ["repos", repo.owner, repo.name, "pulls", String(number)];
  const listed = await ask(session, {
    method: "GET",
    path: [...pull, "files"],
    query: { per_page: String(FILES_SHOWN) },
    step: `reading the changed files of #${number}`,
    accept: [404, 410],
  });
  if (listed.status === 404 || listed.status === 410) {
    return undefined;
  }
  const files = filesPage.safeParse(listed.body);
  if (!files.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading the changed files of #${number} is not a list of files FacetDB can read`,
      SOURCE_FIX,
      listed.status,
    );
  }
  const paths = files.data.slice(0, FILES_SHOWN).map((file) => file.filename);
  if (nextLink(listed.headers.get("link")) === undefined && files.data.length <= FILES_SHOWN) {
    return { paths, total: files.data.length };
  }
  const counted = await ask(session, {
    method: "GET",
    path: pull,
    step: `reading the count of changed files of #${number}`,
    accept: [404, 410],
  });
  if (counted.status === 404 || counted.status === 410) {
    return undefined;
  }
  const count = pullCount.safeParse(counted.body);
  if (!count.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to reading the count of changed files of #${number} is not a pull request FacetDB can read`,
      SOURCE_FIX,
      counted.status,
    );
  }
  return { paths, total: Math.max(count.data.changed_files, paths.length) };
}
