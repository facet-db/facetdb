import { z } from "facetdb/plugin";

/**
 * GitHub's REST API over `fetch`. Every request goes to the configured API's origin and nowhere
 * else: its path is built here from segments, each one encoded, a `Link` header is followed only to
 * the same origin and path, and no redirect is ever followed (`redirect: "error"`), so the token in
 * the `authorization` header never travels to another host. Each request ends after `TIMEOUT_MS` or
 * when the worker's signal fires, whichever comes first, its timer cleared as soon as it is
 * answered.
 *
 * GitHub's answers are untrusted: a body is read up to `BODY_MAX_BYTES`, judged by the shape the
 * caller expects, and never quoted. Every failure is a `GithubActionError` written from fixed
 * words; nothing `fetch` threw is passed on or hung on it as a `cause` (a network error's message
 * can quote the request).
 */

/** What the plugin needs from `fetch`; the default export passes the real one, tests a fake. */
export type GithubFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    /**
     * A redirect is an error: following it would carry the token to whatever host it names. The
     * read of the issue alone takes `manual`, to see a moved issue's 301 without following it.
     */
    readonly redirect: "error" | "manual";
    /** Aborted when the worker stops the action or after `TIMEOUT_MS`, whichever comes first. */
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/**
 * The end of every failure's fix: the outbox tries a failed action again with backoff for 24
 * hours, then raises "Action gave up".
 */
export const TRIED_AGAIN =
  'the action is tried again for 24 hours, then FacetDB raises an "Action gave up" alert';

/** One request's longest wait, its answer read to the end included, as the Slack and Telegram plugins. */
export const TIMEOUT_MS = 10_000;

/** The longest body read: a page of 100 comments is far below it. */
export const BODY_MAX_BYTES = 16 * 1024 * 1024;

/** The most pages one list is read over: 1,000 comments at 100 a page. */
export const PAGES_MAX = 10;

/** One page's size, GitHub's largest. */
export const PAGE_SIZE = 100;

/**
 * The longest wait a rate limit passes on, in milliseconds: one hour, the outbox's longest wait
 * between two attempts, so GitHub never asks FacetDB to wait longer than a failure does.
 */
export const RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * An action GitHub did not let finish, in words that never quote the token, a URL or GitHub's
 * body. A rate limit (a 429, or a 403 GitHub marks as one) and a 5xx carry `status`, and a rate
 * limit the wait GitHub asked for as `retryAfterMs`, the shape the Slack and Telegram errors use;
 * the outbox tries every failed action again with its own backoff for 24 hours.
 */
export class GithubActionError extends Error {
  /** The HTTP status GitHub answered; undefined when no answer came or the action never asked. */
  readonly status: number | undefined;
  /** For a rate limit: how long GitHub asked to wait, in milliseconds, when it said. */
  readonly retryAfterMs: number | undefined;
  /** What to do, in plain words; also the end of `message`, for a reader who prints only that. */
  readonly fix: string;

  constructor(
    what: string,
    fix: string,
    status: number | undefined = undefined,
    retryAfterMs: number | undefined = undefined,
  ) {
    super(`${what}. ${fix}`);
    this.name = "GithubActionError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.fix = fix;
  }
}

/** Everything one action's requests share: where they go, as whom, and when they stop. */
export type Session = {
  readonly fetch: GithubFetch;
  /** The clock a rate limit's reset time is read against, in milliseconds since the epoch. */
  readonly now: () => number;
  readonly token: string;
  /** The API's address with no trailing slash (`apiBase`). */
  readonly base: URL;
  /** The worker's signal for this attempt. */
  readonly signal: AbortSignal;
  /** Opens every error's words: `github label on your-org/your-repo#7`. */
  readonly subject: string;
};

/** One answer, its body parsed from JSON (undefined for an empty body). */
export type Reply = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  /**
   * A redirect seen and not followed (a request with `redirect: "manual"` only): a 3xx, or the
   * opaque redirect a browser-like `fetch` gives with status 0. Never a success.
   */
  readonly moved: boolean;
};

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** A request: its path as segments (each encoded here), its query, its JSON body. */
export type Request = {
  readonly method: Method;
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** What the request does, for the words of a failure: `adding the labels`. */
  readonly step: string;
  /** Statuses besides 2xx the caller reads itself (a 404 that means "already absent"). */
  readonly accept?: readonly number[];
  /** The fix for a 422, which only the caller can say. */
  readonly invalid?: string;
  /** `manual` for the read of the issue alone: a redirect comes back as `moved`, unfollowed. */
  readonly redirect?: "manual";
  /**
   * The words for this request answered with a redirect it does not follow, or not answered at
   * all (the real `fetch` throws on a refused redirect, which reads as a network failure), when
   * the caller can say more than the general ones: the check of a repository names a rename and a
   * wrong `apiUrl`.
   */
  readonly unreached?: { readonly what: string; readonly fix: string };
};

/**
 * A segment the URL parser would read as a step up or a step in place: `.` and `..`, also written
 * `%2e` (WHATWG URL reads both forms). `encodeURIComponent` leaves dots alone, so a name of only
 * dots would climb out of the path it was meant for (`labels/..` is the repository itself).
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * The URL of `path` under the API: every segment encoded, so none can add a segment or a query.
 * Throws, whatever the caller, on a segment that is empty, `.` or `..` once encoded, and on any
 * path the URL parser would not keep exactly as built, so no name can reach another route.
 */
export function urlOf(
  base: URL,
  path: readonly string[],
  query?: Readonly<Record<string, string>>,
): URL {
  const encoded = path.map((segment) => encodeURIComponent(segment));
  // A URL's path is never empty (`https://api.github.com` has `/`): its trailing slash is dropped.
  const expected = `${base.pathname.replace(/\/+$/, "")}/${encoded.join("/")}`;
  const url = new URL(base.href);
  url.pathname = expected;
  url.search = query === undefined ? "" : new URLSearchParams(query).toString();
  if (
    encoded.some((segment) => segment === "" || DOT_SEGMENT.test(segment)) ||
    url.pathname !== expected
  ) {
    throw new GithubActionError(
      "a request's path would hold an empty, . or .. segment, which could reach another route than the one meant, so it is not sent",
      "a label's name or a login may not be only dots or empty: change it in the action's settings",
    );
  }
  return url;
}

/** Thrown by `untilStopped` when its signal fires first; never leaves this module. */
class Stopped extends Error {}

/**
 * `work`, or a `Stopped` rejection as soon as `signal` fires, whichever comes first: a `fetch` that
 * ignores its signal cannot hold the action past it. The listener is removed once either settles.
 */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // `work` may still settle after this gave up on it; its outcome is not wanted.
  work.catch(() => undefined);
  if (signal.aborted) {
    throw new Stopped();
  }
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Stopped());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort as () => void);
  }
}

/** Lets go of a body that is not read, so its connection is freed now. Never fails the action. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is freed when the response is collected.
  }
}

/** The body as text, read up to `BODY_MAX_BYTES`; undefined when it is longer. */
async function boundedText(response: Response, stop: AbortSignal): Promise<string | undefined> {
  const stream = response.body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await untilStopped(reader.read(), stop);
      if (done) {
        return text + decoder.decode();
      }
      size += value.byteLength;
      if (size > BODY_MAX_BYTES) {
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** The words for a request the worker stopped, or that outlived `TIMEOUT_MS`. */
function stoppedError(session: Session, step: string, status?: number): GithubActionError {
  if (session.signal.aborted) {
    return new GithubActionError(
      `${session.subject}: ${step} was stopped before GitHub answered`,
      "the worker stopped the action (it is stopping, or the action took too long); it is tried again",
      status,
    );
  }
  return new GithubActionError(
    `${session.subject}: GitHub did not answer ${step} within ${TIMEOUT_MS / 1000} seconds`,
    "GitHub or the way to it is slow: the action is tried again; if it keeps happening, check that the worker reaches the API over HTTPS",
    status,
  );
}

/** A request's answer read to its end, or a `GithubActionError` in fixed words. */
async function exchange(session: Session, request: Request, url: URL): Promise<Reply> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  const stop = AbortSignal.any([session.signal, deadline.signal]);
  try {
    let response: Response;
    try {
      const sent = session.fetch(url.href, {
        method: request.method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${session.token}`,
          "user-agent": "facetdb-github-plugin",
          "x-github-api-version": "2022-11-28",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: request.redirect ?? "error",
        signal: stop,
      });
      response = await untilStopped(sent, stop);
    } catch {
      // What `fetch` threw is dropped whole: its message or its cause may quote the request.
      if (stop.aborted) {
        throw stoppedError(session, request.step);
      }
      if (request.unreached !== undefined) {
        throw new GithubActionError(request.unreached.what, request.unreached.fix);
      }
      throw new GithubActionError(
        `${session.subject}: GitHub could not be reached for ${request.step} (the network failed, or GitHub answered with a redirect, which is never followed)`,
        `check that the worker reaches the API over HTTPS, that the repository's name is its current one and that apiUrl names the REST API; ${TRIED_AGAIN}`,
      );
    }
    const { status, headers } = response;
    // Node's `fetch` hands a manual redirect back as its 3xx; a browser's as an opaque redirect
    // with status 0. Either is a redirect, read here and never followed, never a success.
    if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      await discard(response);
      if (request.redirect !== "manual") {
        const kept = status === 0 ? undefined : status;
        if (request.unreached !== undefined) {
          throw new GithubActionError(request.unreached.what, request.unreached.fix, kept);
        }
        throw new GithubActionError(
          `${session.subject}: GitHub answered ${request.step} with a redirect, which is never followed`,
          `check that the repository's name is its current one (a renamed or moved repository redirects) and that apiUrl names the REST API; ${TRIED_AGAIN}`,
          kept,
        );
      }
      return { status, headers, body: undefined, moved: true };
    }
    if (status === 204 || (request.method === "DELETE" && status >= 200 && status < 300)) {
      // Nothing in these answers is read; a refused removal's body is, to tell a rate limit.
      await discard(response);
      return { status, headers, body: undefined, moved: false };
    }
    let text: string | undefined;
    try {
      text = await boundedText(response, stop);
    } catch {
      if (stop.aborted) {
        throw stoppedError(session, request.step, status);
      }
      throw new GithubActionError(
        `${session.subject}: GitHub's answer to ${request.step} (status ${status}) could not be read to its end`,
        "the connection broke while GitHub answered; the action is tried again",
        status,
      );
    }
    if (text === undefined) {
      throw new GithubActionError(
        `${session.subject}: GitHub's answer to ${request.step} is larger than FacetDB reads (${BODY_MAX_BYTES / (1024 * 1024)} MiB)`,
        "check that apiUrl names GitHub's REST API",
        status,
      );
    }
    if (text.trim() === "") {
      return { status, headers, body: undefined, moved: false };
    }
    try {
      return { status, headers, body: JSON.parse(text) as unknown, moved: false };
    } catch {
      // A proxy's or a gateway's page: judged by its status alone.
      return { status, headers, body: undefined, moved: false };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** GitHub's error body: only `message`, read to tell a rate limit, never quoted. */
const errorBody = z.object({ message: z.string() });

/** A number of whole seconds in a header, or undefined for anything else. */
function seconds(header: string | null): number | undefined {
  return header !== null && /^\d{1,10}$/.test(header.trim()) ? Number(header.trim()) : undefined;
}

/**
 * Whether a 403 or a 429 is GitHub's rate limit (https://docs.github.com/rest/using-the-rest-api/
 * rate-limits-for-the-rest-api): a 429; a 403 with `x-ratelimit-remaining: 0` (the primary limit)
 * or a `retry-after` (a secondary one); or a 403 whose message says rate limit.
 */
export function rateLimited(reply: Reply): boolean {
  if (reply.status === 429) {
    return true;
  }
  if (reply.status !== 403) {
    return false;
  }
  if (
    reply.headers.get("x-ratelimit-remaining")?.trim() === "0" ||
    seconds(reply.headers.get("retry-after")) !== undefined
  ) {
    return true;
  }
  const parsed = errorBody.safeParse(reply.body);
  return parsed.success && /rate limit/i.test(parsed.data.message);
}

/**
 * The wait a rate limit asks for: `retry-after` in seconds, else until `x-ratelimit-reset` (epoch
 * seconds) by the session's clock; held to `RETRY_AFTER_MAX_MS`, undefined when GitHub said neither.
 */
function retryAfterMs(reply: Reply, now: number): number | undefined {
  const after = seconds(reply.headers.get("retry-after"));
  if (after !== undefined) {
    return Math.min(after * 1000, RETRY_AFTER_MAX_MS);
  }
  const reset = seconds(reply.headers.get("x-ratelimit-reset"));
  if (reset !== undefined) {
    return Math.min(Math.max(0, reset * 1000 - now), RETRY_AFTER_MAX_MS);
  }
  return undefined;
}

/** The fix for a 403 that is not a rate limit: the token's access. */
export const FORBIDDEN_FIX =
  "the token may not do this on the repository: give a fine-grained token Issues read and write on it (a classic token the repo scope, or public_repo for a public repository), from an account with write access; a locked issue takes comments from collaborators only";

/** The failure for an answer the caller did not accept, named for what its status means. */
export function refusal(session: Session, request: Request, reply: Reply): GithubActionError {
  const { status } = reply;
  const at = `${session.subject}: GitHub answered ${status} to ${request.step}`;
  if (rateLimited(reply)) {
    const wait = retryAfterMs(reply, session.now());
    return new GithubActionError(
      `${session.subject}: GitHub's rate limit stopped ${request.step} (status ${status}${wait === undefined ? "" : `, retry after ${Math.ceil(wait / 1000)} s`})`,
      "the action is tried again later; if it keeps happening, the token makes too many requests (one token shared by many workers or tools)",
      status,
      wait,
    );
  }
  if (status === 401) {
    return new GithubActionError(
      `${at}: GitHub does not accept the token`,
      "the token is wrong, expired or revoked: put a valid one in the variable plugins.github.token names, then restart the worker",
      status,
    );
  }
  if (status === 403) {
    return new GithubActionError(`${at}: the token is not allowed to`, FORBIDDEN_FIX, status);
  }
  if (status === 404) {
    return new GithubActionError(
      `${at}: GitHub found nothing there`,
      "check the repository's name and that the token can see it (a token without access to a private repository is answered 404)",
      status,
    );
  }
  if (status === 410) {
    return new GithubActionError(
      `${at}: Gone, the issue was deleted or issues are turned off in the repository`,
      "turn issues on in the repository's settings, or take the action out of the config",
      status,
    );
  }
  if (status === 422) {
    return new GithubActionError(
      `${at}: GitHub refused the request as not valid`,
      request.invalid ?? "check the action's settings in the config file",
      status,
    );
  }
  if (status >= 500) {
    return new GithubActionError(
      `${at}: GitHub failed on its side`,
      "the trouble is GitHub's, not the settings': the action is tried again later",
      status,
    );
  }
  return new GithubActionError(
    `${at}, which FacetDB does not read as done`,
    "check that apiUrl names GitHub's REST API; the action is tried again",
    status,
  );
}

/**
 * Sends one request; resolves with a 2xx answer, one of the statuses the request accepts, or a
 * redirect marked `moved` (only to a request that asked for `manual`), and throws the failure for
 * any other.
 */
export async function send(session: Session, request: Request): Promise<Reply> {
  const reply = await exchange(session, request, urlOf(session.base, request.path, request.query));
  if (
    reply.moved ||
    (reply.status >= 200 && reply.status < 300) ||
    (request.accept ?? []).includes(reply.status)
  ) {
    return reply;
  }
  throw refusal(session, request, reply);
}

/** The `rel="next"` URL of a `Link` header, or undefined. */
function nextLink(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(",")) {
    const match = /^\s*<([^<>]*)>\s*;(.*)$/.exec(part);
    if (match !== null && /(?:^|;)\s*rel="?next"?\s*(?:;|$)/.test(match[2] ?? "")) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Every item of a list GitHub pages through (`per_page` 100), following `Link: rel="next"` only to
 * the same origin and path as the first page and at most `PAGES_MAX` pages; a page that is not an
 * array is refused. Each item is returned as GitHub sent it, for the caller to judge.
 */
export async function pages(session: Session, request: Request): Promise<unknown[]> {
  const first = urlOf(session.base, request.path, {
    ...request.query,
    per_page: String(PAGE_SIZE),
  });
  const items: unknown[] = [];
  let url: URL | undefined = first;
  for (let page = 1; url !== undefined; page += 1) {
    if (page > PAGES_MAX) {
      throw new GithubActionError(
        `${session.subject}: ${request.step} runs past ${PAGES_MAX} pages of ${PAGE_SIZE}`,
        "the issue has more than FacetDB reads, so the action does nothing rather than guess; it is tried again, then given up with an alert",
      );
    }
    const reply = await exchange(session, request, url);
    if (reply.status < 200 || reply.status >= 300) {
      throw refusal(session, request, reply);
    }
    if (!Array.isArray(reply.body)) {
      throw new GithubActionError(
        `${session.subject}: GitHub's answer to ${request.step} is not the list FacetDB asked for`,
        "check that apiUrl names GitHub's REST API; the action is tried again",
        reply.status,
      );
    }
    items.push(...(reply.body as unknown[]));
    const link = nextLink(reply.headers.get("link"));
    const next = link !== undefined && URL.canParse(link) ? new URL(link) : undefined;
    if (link === undefined) {
      url = undefined;
    } else if (
      next === undefined ||
      next.origin !== first.origin ||
      next.pathname !== first.pathname ||
      next.username !== "" ||
      next.password !== ""
    ) {
      // The token goes with every request: a page elsewhere would carry it there.
      throw new GithubActionError(
        `${session.subject}: GitHub's next page for ${request.step} is not on the same API and path, and is not followed`,
        "check that apiUrl names GitHub's REST API and that nothing between the worker and it rewrites its answers",
        reply.status,
      );
    } else {
      url = next;
    }
  }
  return items;
}
