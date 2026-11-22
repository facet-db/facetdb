import { type Infer, type SourcePage, type SourceRow, z } from "facetdb/plugin";
import {
  ask,
  type ChangedFiles,
  issueFields,
  issueNumber,
  KINDS,
  type Kind,
  kindOf,
  readChangedFiles,
  SOURCE_FIX,
  stateOf,
} from "./issues-state.ts";
import type { ManagedLabels } from "./managed-labels.ts";
import { GithubActionError, type Session } from "./rest.ts";
import type { Repo } from "./settings.ts";

/**
 * The issues source's scan: every open issue and pull request of the repository, newest first,
 * `SCAN_PAGE` a page.
 *
 * GitHub's list of a repository's issues pages by page number only, and a page number does not
 * survive the scan: an issue opened during it pushes every later page down by one (a row read
 * twice), and one closed pulls them up (a row never read). So each page is a fresh search
 * (`GET /search/issues`, `repo:o/r is:open is:issue` and `is:pr` searched apart, since GitHub's
 * issue search asks a query for one of the two, `sort=created`, `order=desc`, `per_page=100`;
 * GitHub's documented search, never run from a session), bounded by the cursor: the creation time of the
 * last row of the page before (`created:<=T`) and the numbers already yielded at exactly that
 * second, so neither a new issue (created after T) nor a closed one (simply absent) moves what is
 * left to read. With both kinds included, the two searches' first 100 are merged and the 100 newest
 * kept; what is not kept is asked again from the next page's bound.
 *
 * The cursor is JSON, `{"before":"<time>","seen":[1234]}`; `null` starts from the
 * newest open issue. An answer outside the bound (an item created after it, or with no creation
 * time to compare) fails the page (`unbounded`), and every page's cursor is checked to move on, so
 * a search that reads the bound otherwise than written never repeats pages nor goes round.
 *
 * A row's state is built as `read` builds it (issues-state.ts): the search answer carries the
 * title, the body and the labels, the source's managed labels left out as `read` leaves them
 * (managed-labels.ts), and a pull request's changed files are read for it.
 */

/** One page's rows, GitHub's largest page. */
export const SCAN_PAGE = 100;

/**
 * The most numbers a cursor may hold as seen at its one second: the bound on a cursor read back.
 * The scan stops in words long before it (more than `SCAN_PAGE` open issues created in one second,
 * which GitHub's search cannot page past), so a cursor the scan wrote never comes near it.
 */
export const SEEN_MAX = 1_000;

/** GitHub's timestamps: UTC, to the second. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * `value` when it is a time as GitHub writes one and as the scan compares them (UTC, to the second,
 * a real date that reads back the same, so two of them order as text), else undefined.
 */
export function timeOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace(/\.000Z$/, "Z") === value
    ? value
    : undefined;
}

/** Where the next page starts: after the rows created at or after `before` that it lists as seen. */
type Place = { readonly before: string; readonly seen: readonly number[] };

const placeShape = z.strictObject({
  before: z.string().refine((text) => timeOf(text) !== undefined),
  seen: z.array(issueNumber).max(SEEN_MAX),
});

/** The place a cursor names; a cursor this source did not write is refused in words. */
function placeOf(session: Session, cursor: string): Place {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch {
    parsed = undefined;
  }
  const place = placeShape.safeParse(parsed);
  if (!place.success) {
    throw new GithubActionError(
      `${session.subject}: the backfill's cursor is not one the GitHub issues source wrote`,
      "start the backfill of this source again from its beginning",
    );
  }
  return place.data;
}

/** One search answer: whether GitHub finished it, and its items, each judged on its own. */
const searchAnswer = z.object({
  incomplete_results: z.boolean(),
  items: z.array(z.unknown()),
});

/**
 * A search item: the state's fields and the repository it belongs to; its creation time is judged
 * apart (`timeOf`), as the one thing the query bounds.
 */
const searchItem = issueFields.extend({
  created_at: z.unknown().optional(),
  repository_url: z.string(),
});

type SearchItem = Omit<Infer<typeof searchItem>, "created_at"> & { readonly created_at: string };

/**
 * GitHub's search answered outside the query it was given: an item created after the cursor's
 * `created:<=` bound, or one with no creation time to compare with it. Paging on would repeat
 * pages (a bound read coarser than the second) or go round between two places for ever (a bound
 * ignored), so the page fails, in fixed words, and its cursor is never handed out.
 */
function unbounded(session: Session, what: string, status: number | undefined): GithubActionError {
  return new GithubActionError(
    `${session.subject}: GitHub's search for the ${what} answered an issue created after the time the query bounds it to, or with no creation time FacetDB can read, so the search did not keep to the query`,
    "the likely cause is the search syntax: GitHub not reading created:<= with a time and its offset (such as created:<=2026-11-14T10:00:00+00:00) to the second, as the scan writes it; the backfill stops at this page rather than repeat pages or go round, and keeps the cursor of the last page it finished",
    status,
  );
}

/** Newest first; at the same second, the higher number first (GitHub numbers in creation order). */
function newestFirst(a: SearchItem, b: SearchItem): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  return b.number - a.number;
}

/** One search of one kind: its items of the repository, and whether GitHub gave a full page. */
async function searchOf(
  session: Session,
  repo: Repo,
  kind: Kind,
  place: Place | undefined,
): Promise<{ readonly items: readonly SearchItem[]; readonly full: boolean }> {
  const what = kind === "issues" ? "open issues" : "open pull requests";
  const terms = [
    `repo:${repo.owner}/${repo.name}`,
    "is:open",
    kind === "issues" ? "is:issue" : "is:pr",
  ];
  if (place !== undefined) {
    // GitHub's search reads a time with its offset: `created:<=YYYY-MM-DDTHH:MM:SS+00:00`.
    terms.push(`created:<=${place.before.replace(/Z$/, "+00:00")}`);
  }
  const reply = await ask(session, {
    method: "GET",
    path: ["search", "issues"],
    query: { q: terms.join(" "), sort: "created", order: "desc", per_page: String(SCAN_PAGE) },
    step: `searching the ${what}`,
    invalid:
      "GitHub refused to search the repository: check the source's repo and that the token can see the repository (GitHub does not search a repository a token cannot see)",
  });
  const answer = searchAnswer.safeParse(reply.body);
  if (!answer.success) {
    throw new GithubActionError(
      `${session.subject}: GitHub's answer to searching the ${what} is not a search answer FacetDB can read`,
      SOURCE_FIX,
      reply.status,
    );
  }
  if (answer.data.incomplete_results) {
    throw new GithubActionError(
      `${session.subject}: GitHub's search for the ${what} ended before it was complete`,
      "GitHub's search timed out; the backfill reads this page again when it runs again, from the last page it finished",
      reply.status,
    );
  }
  const own = `/repos/${repo.owner}/${repo.name}`.toLowerCase();
  const items: SearchItem[] = [];
  for (const entry of answer.data.items) {
    const item = searchItem.safeParse(entry);
    if (!item.success) {
      throw new GithubActionError(
        `${session.subject}: an item of GitHub's answer to searching the ${what} is not an issue FacetDB can read`,
        SOURCE_FIX,
        reply.status,
      );
    }
    const url = URL.canParse(item.data.repository_url)
      ? new URL(item.data.repository_url)
      : undefined;
    if (url === undefined || !url.pathname.toLowerCase().endsWith(own)) {
      throw new GithubActionError(
        `${session.subject}: GitHub's answer to searching the ${what} holds an issue of another repository`,
        "check the source's repo (a renamed repository is searched under its new name only); the backfill does not go on with an answer it cannot trust",
        reply.status,
      );
    }
    // Same-format UTC times order as text: one after the bound is outside the query.
    const created = timeOf(item.data.created_at);
    if (created === undefined || (place !== undefined && created > place.before)) {
      throw unbounded(session, what, reply.status);
    }
    // An item of the other kind is left to its own search.
    if (kindOf(item.data) === kind) {
      items.push({ ...item.data, created_at: created });
    }
  }
  return { items, full: answer.data.items.length >= SCAN_PAGE };
}

/** The place after `kept`, the rows of a page, newest first: its last row's second, and who was seen at it. */
function placeAfter(kept: readonly SearchItem[], place: Place | undefined): Place {
  const before = (kept[kept.length - 1] as SearchItem).created_at;
  const seen = new Set(place !== undefined && place.before === before ? place.seen : []);
  for (const item of kept) {
    if (item.created_at === before) {
      seen.add(item.number);
    }
  }
  return { before, seen: [...seen].sort((a, b) => b - a) };
}

/** One page from `place`: its rows, and the place of the next page, undefined after the last. */
async function pageOf(
  session: Session,
  repo: Repo,
  include: ReadonlySet<Kind>,
  managed: ManagedLabels,
  place: Place | undefined,
): Promise<{ readonly rows: readonly SourceRow[]; readonly next: Place | undefined }> {
  const searches: { readonly items: readonly SearchItem[]; readonly full: boolean }[] = [];
  // One request after the other, as GitHub asks of a client.
  for (const kind of KINDS) {
    if (include.has(kind)) {
      searches.push(await searchOf(session, repo, kind, place));
    }
  }
  const seen = new Set(place?.seen ?? []);
  const fresh = new Map<number, SearchItem>();
  for (const item of searches.flatMap((search) => search.items)) {
    if (!(item.created_at === place?.before && seen.has(item.number))) {
      fresh.set(item.number, item);
    }
  }
  const ordered = [...fresh.values()].sort(newestFirst);
  const kept = ordered.slice(0, SCAN_PAGE);
  const more = searches.some((search) => search.full) || ordered.length > kept.length;
  if (more && kept.length === 0) {
    throw new GithubActionError(
      `${session.subject}: more than ${SCAN_PAGE} open issues of the repository were created in the same second, which GitHub's search cannot page past`,
      "the backfill stops here rather than skip issues; their changes still reach the source through its webhook and its poll",
    );
  }
  const next = more ? placeAfter(kept, place) : undefined;
  // Every page moves the place on: to an earlier second, or to more numbers read at the same one.
  // Items past the bound are refused above, so this holds; it is checked so a page can never hand
  // out the place it started from, whatever GitHub answers.
  if (
    next !== undefined &&
    place !== undefined &&
    (next.before > place.before ||
      (next.before === place.before && next.seen.length <= place.seen.length))
  ) {
    throw unbounded(session, "open issues and pull requests", undefined);
  }
  if (next !== undefined && next.seen.length > SEEN_MAX) {
    throw new GithubActionError(
      `${session.subject}: more than ${SEEN_MAX} open issues of the repository were created in the same second, which the backfill's cursor cannot hold`,
      "the backfill stops here rather than skip issues; their changes still reach the source through its webhook and its poll",
    );
  }
  const rows: SourceRow[] = [];
  for (const item of kept) {
    let files: ChangedFiles | undefined;
    if (kindOf(item) === "pull_requests") {
      files = await readChangedFiles(session, repo, item.number);
      if (files === undefined) {
        // Gone since the search listed it: nothing to read.
        continue;
      }
    }
    rows.push({ key: String(item.number), state: stateOf(item, files, managed) });
  }
  return { rows, next };
}

/** The scan: pages from `cursor` (null: the newest open issue) until no open issue is left. */
export async function* scanIssues(
  session: Session,
  repo: Repo,
  include: ReadonlySet<Kind>,
  managed: ManagedLabels,
  cursor: string | null,
): AsyncGenerator<SourcePage, void, undefined> {
  let place = cursor === null ? undefined : placeOf(session, cursor);
  for (;;) {
    const page = await pageOf(session, repo, include, managed, place);
    yield { rows: page.rows, next: page.next === undefined ? null : JSON.stringify(page.next) };
    if (page.next === undefined) {
      return;
    }
    place = page.next;
  }
}
