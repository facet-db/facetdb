import { SourceAccessLost, type SourceContext, z } from "facetdb/plugin";
import { timeOf } from "./issues-scan.ts";
import { issueNumber, type Kind, kindOf, SOURCE_FIX, TOKEN_FIX } from "./issues-state.ts";
import {
  BODY_MAX_BYTES,
  GithubActionError,
  nextLink,
  PAGE_SIZE,
  type Reply,
  type Request,
  rateLimited,
  retryAfterMs,
  type Session,
  send,
  TIMEOUT_MS,
} from "./rest.ts";
import type { Repo } from "./settings.ts";

/**
 * The issues source's poll: GitHub does not send a failed webhook delivery again, so a worker that
 * was down, or one GitHub cannot reach, finds what changed by asking. The source's `watch` runs it:
 * at start, then `POLL_INTERVAL_MS` after each poll (`POLL_INTERVAL_NO_WEBHOOK_MS` with no
 * `webhookSecret`, when the poll is the only way the source hears of a change), it lists the
 * repository's issues and pull requests updated since its cursor, oldest change first, yields their
 * numbers and saves the cursor after each page. It asks with the REST list (`GET
 * /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=…`), never the search, which
 * allows 30 requests a minute.
 *
 * - The cursor is GitHub's `updated_at` of the last issue listed (`YYYY-MM-DDTHH:MM:SSZ`), saved
 *   through the context's cursor once the page's keys were taken in. A source with no cursor
 *   starts `START_MARGIN_MS` before the worker's now: the issues that exist already are
 *   `facetdb backfill`'s, never an unpaced flood. A cursor is never left ahead of GitHub's own
 *   clock: at the end of a poll, one later than the `Date` of GitHub's last answer (a first start
 *   on a worker whose clock runs ahead) is moved back to it, so what GitHub stamps after is listed.
 * - Every page is a fresh list from `since` one second before the cursor: an overlapping second,
 *   so an issue changed in the cursor's own second, before or after the page was read, is never
 *   skipped (GitHub lists what was updated after `since`). A fresh list rather than GitHub's page
 *   number, because a change made while the poll reads moves an issue to the list's end and pulls
 *   every later page up by one, so the next page number would skip an issue. Only when a full page
 *   does not move the cursor (more than 100 issues changed within its two seconds) is the same
 *   list's next page read by number, at most `STUCK_PAGES_MAX` pages, past which the poll says so
 *   and goes on from the next second, never past GitHub's now. An empty page ends the poll,
 *   whatever GitHub's `Link` says.
 * - GitHub writes `updated_at` to the second, so a second change made in the same second after a
 *   list is stamped as the first was. An issue is remembered as yielded at its `updated_at` only
 *   from an answer GitHub dated `SETTLE_MS` after that second ended (its `Date` header); until then
 *   every list that shows it yields it again (harmless: an unchanged state queues nothing). Once
 *   remembered it is not yielded again at that `updated_at`, so an idle repository costs one list
 *   a poll and no read. This is held in memory; an answer with no `Date` remembers nothing.
 * - Each item must belong to the source's repository and the list must keep to the order and the
 *   bound asked for; otherwise the poll fails in words (a `GithubActionError`), nothing of the page
 *   yielded and the cursor unmoved, so it never yields a key of another repository.
 * - A page whose answer could not be read whole (larger than `BODY_MAX_BYTES`, cut off, or slower
 *   than `TIMEOUT_MS`: a hundred issues with the longest bodies GitHub allows pass 16 MiB) is asked
 *   again with half as many issues a page, down to one, for the rest of the poll. One issue alone
 *   that cannot be read is said in one line and asked again at the next poll, the cursor kept:
 *   GitHub's own limits keep an issue far below 16 MiB, so only a server that is not GitHub's API
 *   sends one.
 * - GitHub's rate limit (a 429, or a 403 with no requests remaining or a `retry-after`) is waited
 *   out on the context's clock until GitHub's reset, with one line saying until when; it is not an
 *   error, and the poll goes on from where it stopped.
 * - A 401, a 403 that is not a rate limit, and a 404 for the repository throw `SourceAccessLost` in
 *   fixed words with the fix; GitHub's body is never quoted (rest.ts). The worker stops this source
 *   alone, tries it again with backoff, and says it in its own words (the SDK's `worded`: the
 *   plugin lost access, refused in watch; check the variables the source reads and their rights).
 * - A 5xx, a network failure or a timeout is said in one line and tried again at the next poll,
 *   from the cursor saved.
 *
 * Every wait is the context's clock: the source's stop ends it, and no timer is left behind.
 */

/** Between two polls of a source whose webhook is on: 5 minutes. */
export const POLL_INTERVAL_MS = 5 * 60_000;

/** Between two polls of a source with no `webhookSecret`, whose poll is all it hears: 60 seconds. */
export const POLL_INTERVAL_NO_WEBHOOK_MS = 60_000;

/** How far before the cursor each list starts: one second, GitHub's times being to the second. */
export const OVERLAP_MS = 1_000;

/**
 * How long after the second of an issue's `updated_at` ends GitHub's answer must be dated for the
 * issue to be remembered: 5 seconds, far past any lag between GitHub's own clocks and replicas.
 */
export const SETTLE_MS = 5_000;

/** How far before the worker's now a source with no cursor starts: a few seconds of its clock's drift. */
export const START_MARGIN_MS = 5_000;

/**
 * The wait for a rate limit GitHub gave no time for, or one already past by the worker's clock:
 * one minute, as GitHub asks of a client in that case.
 */
export const RATE_LIMIT_WAIT_MS = 60_000;

/** The most pages of one list read by number, when full pages do not move the cursor. */
export const STUCK_PAGES_MAX = 10;

/** What the poll is given: the source's session and settings, the context's clock and cursor. */
export type PollDeps = Pick<SourceContext<unknown>, "clock" | "cursor"> & {
  /** The source's requests: its token, its API, its stop (`signal`), its subject in every word. */
  readonly session: Session;
  readonly repo: Repo;
  readonly include: ReadonlySet<Kind>;
  /** The wait after each poll: `POLL_INTERVAL_MS`, or `POLL_INTERVAL_NO_WEBHOOK_MS`. */
  readonly interval: number;
  /** Prints one line for the operator: a rate limit's wait, a poll that failed. */
  readonly warn: (line: string) => void;
};

/** `ms` as GitHub writes a time: UTC, to the second it falls in. */
function stamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** The second a wait of `ms` from now ends in, as a line says it: rounded up, never early. */
function until(ms: number): string {
  return stamp(Math.ceil(ms / 1000) * 1000);
}

/** One item of GitHub's list: only what the poll reads of it. */
const listedItem = z.object({
  number: issueNumber,
  updated_at: z.string(),
  repository_url: z.string(),
  pull_request: z.unknown().optional(),
});

/** One issue or pull request the list named, judged. */
type Listed = { readonly number: number; readonly updatedAt: string; readonly kind: Kind };

/**
 * One page of the list: its items, whether GitHub said there is a next one, and when GitHub
 * answered it by its own clock (its `Date` header), in milliseconds, when it said.
 */
type Page = {
  readonly items: readonly Listed[];
  readonly more: boolean;
  readonly answeredAt: number | undefined;
};

/** An HTTP date as GitHub writes its `Date` header: `Sat, 14 Nov 2026 12:00:00 GMT`. */
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** When GitHub answered, by its `Date` header, in milliseconds; undefined when it did not say. */
function answeredAt(reply: Reply): number | undefined {
  const header = reply.headers.get("date")?.trim();
  if (header === undefined || !HTTP_DATE.test(header)) {
    return undefined;
  }
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether an issue listed changed in the second `updatedAt` may be remembered: the answer that
 * listed it was dated `SETTLE_MS` after that second ended, so no later change can share the stamp.
 */
function settled(updatedAt: string, answered: number | undefined): boolean {
  return answered !== undefined && answered >= Date.parse(updatedAt) + 1_000 + SETTLE_MS;
}

/** The access error for a 401, a 403 that is not a rate limit, or a 404 for the repository. */
function accessLost(session: Session, repo: Repo, step: string, status: number): SourceAccessLost {
  const name = `${repo.owner}/${repo.name}`;
  if (status === 404) {
    return new SourceAccessLost(
      `${session.subject}: GitHub answers 404 to ${step}: the token cannot see the repository ${name}, or no repository has that name; give the token in the variable plugins.github.token names access to the repository (a fine-grained token with Issues and Pull requests read on it), or correct the source's repo; the source is tried again by itself`,
    );
  }
  const what =
    status === 401
      ? "GitHub does not accept the token"
      : "the token is not allowed to list the repository's issues and pull requests";
  return new SourceAccessLost(
    `${session.subject}: ${what} (status ${status}) for ${step}; ${TOKEN_FIX}`,
  );
}

/** Why a list GitHub did not answer usably is tried again, in words that never quote it. */
function whyUnanswered(status: number | undefined): string {
  if (status === undefined) {
    return `GitHub could not be reached (the network failed, GitHub did not answer within ${TIMEOUT_MS / 1000} seconds, or it answered with a redirect, which is never followed: a renamed repository redirects, so check the source's repo)`;
  }
  if (status >= 500) {
    return `GitHub answered ${status}, a failure on its side`;
  }
  if (status >= 300 && status < 400) {
    return "GitHub answered with a redirect, which is never followed (a renamed repository redirects: write its current owner/name in the source's repo)";
  }
  return `GitHub's answer (status ${status}) could not be read`;
}

/** The failure of a list that does not keep to what was asked, in fixed words. */
function untrusted(
  session: Session,
  since: string,
  what: string,
  status: number,
): GithubActionError {
  return new GithubActionError(
    `${session.subject}: GitHub's list of the issues updated since ${since} ${what}`,
    `the poll takes nothing of the page and keeps its cursor; ${SOURCE_FIX}`,
    status,
  );
}

/**
 * A page GitHub answered, judged: a list of issues of the source's repository, each changed at or
 * after `since` and none before the one ahead of it (oldest change first); anything else fails.
 */
function pageOf(session: Session, repo: Repo, since: string, reply: Reply): Page {
  if (!Array.isArray(reply.body)) {
    throw untrusted(session, since, "is not the list FacetDB asked for", reply.status);
  }
  const own = `/repos/${repo.owner}/${repo.name}`.toLowerCase();
  const items: Listed[] = [];
  let latest = since;
  for (const entry of reply.body as readonly unknown[]) {
    const item = listedItem.safeParse(entry);
    if (!item.success) {
      throw untrusted(
        session,
        since,
        "holds an item that is not an issue FacetDB can read",
        reply.status,
      );
    }
    const url = URL.canParse(item.data.repository_url)
      ? new URL(item.data.repository_url)
      : undefined;
    if (url === undefined || !url.pathname.toLowerCase().endsWith(own)) {
      throw untrusted(
        session,
        since,
        "holds an issue of another repository (a renamed repository is listed under its new name only: check the source's repo)",
        reply.status,
      );
    }
    // Same-format UTC times order as text: GitHub lists after `since`, oldest change first.
    const updatedAt = timeOf(item.data.updated_at);
    if (updatedAt === undefined || updatedAt < latest) {
      throw untrusted(
        session,
        since,
        "holds an issue changed before since, out of the order asked (oldest change first), or with no time of change FacetDB can read",
        reply.status,
      );
    }
    latest = updatedAt;
    items.push({ number: item.data.number, updatedAt, kind: kindOf(item.data) });
  }
  return {
    items,
    more: nextLink(reply.headers.get("link")) !== undefined,
    answeredAt: answeredAt(reply),
  };
}

/**
 * Page `number` of the list from `since`, `size` issues a page, waiting out a rate limit first.
 * `unread` when GitHub answered it but the answer could not be read whole (too large, cut off, too
 * slow); undefined when there is none this poll: GitHub failed (said in a line; the next poll tries
 * again) or the source stopped. A refused token throws `SourceAccessLost`; a refused request or an
 * untrusted answer throws.
 */
async function listPage(
  deps: PollDeps,
  since: string,
  number: number,
  size: number,
): Promise<Page | "unread" | undefined> {
  const { session, repo, clock, warn } = deps;
  const accept = [401, 403, 404, 429];
  const request: Request = {
    method: "GET",
    path: ["repos", repo.owner, repo.name, "issues"],
    query: {
      state: "all",
      sort: "updated",
      direction: "asc",
      since,
      per_page: String(size),
      ...(number === 1 ? {} : { page: String(number) }),
    },
    step: `listing the issues and pull requests updated since ${since}`,
    accept,
  };
  for (;;) {
    let reply: Reply;
    try {
      reply = await send(session, request);
    } catch (error) {
      if (session.signal.aborted) {
        return undefined;
      }
      if (!(error instanceof GithubActionError)) {
        throw error;
      }
      const { status } = error;
      // Answered, but not read whole: a smaller page may be.
      if (status !== undefined && status >= 200 && status < 300) {
        return "unread";
      }
      // A 4xx the poll does not read itself is a request GitHub refuses as asked: asking again
      // changes nothing. One it reads only fails here when its answer could not be read.
      if (status !== undefined && status >= 400 && status < 500 && !accept.includes(status)) {
        throw error;
      }
      warn(
        `${session.subject}: the poll could not list the issues updated since ${since}: ${whyUnanswered(status)}; it tries again at ${until(clock.now() + deps.interval)}`,
      );
      return undefined;
    }
    if (rateLimited(reply)) {
      const asked = retryAfterMs(reply, clock.now());
      const wait = asked === undefined || asked === 0 ? RATE_LIMIT_WAIT_MS : Math.max(asked, 1_000);
      warn(
        `${session.subject}: GitHub's rate limit stopped the poll (status ${reply.status}); it waits until ${until(clock.now() + wait)}, then goes on from where it stopped`,
      );
      await clock.sleep(wait, session.signal);
      if (session.signal.aborted) {
        return undefined;
      }
      continue;
    }
    if (reply.status === 401 || reply.status === 403 || reply.status === 404) {
      throw accessLost(session, repo, request.step, reply.status);
    }
    return pageOf(session, repo, since, reply);
  }
}

/** Forgets what was yielded before `since`: GitHub lists nothing changed before it again. */
function forget(yielded: Map<number, string>, since: string): void {
  for (const [number, updatedAt] of yielded) {
    if (updatedAt < since) {
      yielded.delete(number);
    }
  }
}

/**
 * The cursor a poll ends with: `at`, or GitHub's own time of its last answer when `at` is later
 * (a cursor from the worker's clock, ahead of GitHub's), saved, so what GitHub stamps after its
 * answer is still listed.
 */
async function notAhead(deps: PollDeps, at: string, answered: number | undefined): Promise<string> {
  if (answered === undefined || stamp(answered) >= at) {
    return at;
  }
  const back = stamp(answered);
  await deps.cursor.save(back);
  return back;
}

/**
 * One poll from the cursor `from`: every page until GitHub has no next one, each page's keys
 * yielded and then the cursor saved; returns the cursor it reached.
 */
async function* poll(
  deps: PollDeps,
  from: string,
  yielded: Map<number, string>,
): AsyncGenerator<readonly string[], string, undefined> {
  const { session, clock, cursor, include, warn } = deps;
  let at = from;
  let since = stamp(Date.parse(at) - OVERLAP_MS);
  let number = 1;
  let size = PAGE_SIZE;
  for (;;) {
    const listed = await listPage(deps, since, number, size);
    if (listed === undefined) {
      return at;
    }
    if (listed === "unread") {
      if (size > 1) {
        // The same list again from its start, half as many a page, for the rest of this poll.
        size = Math.floor(size / 2);
        number = 1;
        continue;
      }
      warn(
        `${session.subject}: GitHub's list of the issues updated since ${since} could not be read even one issue a page (larger than the ${BODY_MAX_BYTES / (1024 * 1024)} MiB FacetDB reads, cut off, or slower than ${TIMEOUT_MS / 1000} seconds); the poll keeps its cursor and tries again at ${until(clock.now() + deps.interval)}`,
      );
      return at;
    }
    const page = listed;
    if (page.items.length === 0) {
      // Nothing more changed: the poll ends, whatever GitHub's `Link` says.
      return await notAhead(deps, at, page.answeredAt);
    }
    const keys: string[] = [];
    for (const item of page.items) {
      if (yielded.get(item.number) === item.updatedAt) {
        continue;
      }
      // Remembered only once no later change can share its `updated_at`: until then each list
      // that shows it yields it again, so a change in the same second after this list is read.
      if (settled(item.updatedAt, page.answeredAt)) {
        yielded.set(item.number, item.updatedAt);
      }
      if (include.has(item.kind)) {
        keys.push(String(item.number));
      }
    }
    if (keys.length > 0) {
      yield keys;
    }
    const last = (page.items.at(-1) as Listed).updatedAt;
    let next = last > at ? last : undefined;
    if (next === undefined && page.more && number >= STUCK_PAGES_MAX) {
      const after = Date.parse(at) + 1_000;
      if (after > (page.answeredAt ?? clock.now())) {
        // That second is not over by GitHub's clock: the next poll reads it again.
        return await notAhead(deps, at, page.answeredAt);
      }
      // GitHub's own list holds more, but no poll pages through it: said, and the poll goes on.
      warn(
        `${session.subject}: more than ${STUCK_PAGES_MAX * size} issues and pull requests changed within the two seconds from ${since}, more than the poll reads; it goes on from the second after ${at}, and facetdb backfill reads any open issue it passed`,
      );
      next = stamp(after);
    }
    if (next !== undefined) {
      at = next;
      // Saved once the keys above were taken in: a crash repeats this page, never skips it.
      await cursor.save(at);
      since = stamp(Date.parse(at) - OVERLAP_MS);
      forget(yielded, since);
      number = 1;
    } else {
      // A full page that does not move the cursor: the same list's next page, by number.
      number += 1;
    }
    if (!page.more) {
      return await notAhead(deps, at, page.answeredAt);
    }
  }
}

/**
 * Where the poll starts: the saved cursor; with none, `START_MARGIN_MS` before the worker's now,
 * saved at once (what exists already is the backfill's). A saved cursor that is not a time the
 * poll wrote is said in a line and replaced, as a first start.
 */
async function startingCursor(deps: PollDeps): Promise<string> {
  const saved = await deps.cursor.load();
  if (saved !== null && timeOf(saved) !== undefined) {
    return saved;
  }
  const start = stamp(deps.clock.now() - START_MARGIN_MS);
  if (saved !== null) {
    deps.warn(
      `${deps.session.subject}: the poll's saved place is not a time it wrote, so it starts from ${start}, a few seconds before now; facetdb backfill reads the open issues changed before it`,
    );
  }
  await deps.cursor.save(start);
  return start;
}

/**
 * The poll as the source's `watch`: at start, then `interval` after each poll, until the source
 * stops (its signal ends the wait between two polls, a rate limit's wait and any request).
 */
export async function* reconcile(
  deps: PollDeps,
): AsyncGenerator<readonly string[], void, undefined> {
  const { session, clock } = deps;
  let at = await startingCursor(deps);
  /** Each number yielded at a settled `updated_at`, since the cursor's overlapping second. */
  const yielded = new Map<number, string>();
  while (!session.signal.aborted) {
    at = yield* poll(deps, at, yielded);
    // A stopped source's signal ends this wait at once, and the loop with it.
    await clock.sleep(deps.interval, session.signal);
  }
}
