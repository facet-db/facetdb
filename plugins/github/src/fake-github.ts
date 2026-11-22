import type { GithubFetch } from "./rest.ts";

/**
 * A handwritten GitHub for the action and source tests (facetdb-testing: fakes beside the test, no
 * network): the REST routes the actions and the issues source call, over an in-memory repository,
 * answered through the same `fetch` parameter the real plugin is given. Every request is recorded;
 * a script answers a request first when it returns a response (a rate limit, a 5xx, a page from
 * another host), and a request no route knows is answered 418 and recorded, so a test can say none
 * was made.
 *
 * The search (`GET /search/issues`) keeps the rules of GitHub's that the source depends on, as
 * GitHub documents them (never seen from a session): the query must say `is:issue` or `is:pr` (422
 * otherwise), `created:<=T` takes a time with its offset, and items created in the same second come
 * in no promised order (here: the lower number first, the opposite of the source's own order).
 * The repository's issues list (`GET /repos/{o}/{r}/issues`, the poll's) keeps its documented
 * `since`, read as strictly after (`list` below).
 */

/** One request as the fake saw it, its path's segments decoded. */
export type Seen = {
  readonly method: string;
  readonly url: URL;
  readonly segments: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly redirect: string;
  readonly signal: AbortSignal;
};

export type Script = (request: Seen) => Response | Promise<Response> | undefined;

export type FakeComment = { readonly id: number; body: string; readonly user: string | null };

export type FakeIssue = {
  labels: string[];
  assignees: string[];
  readonly comments: FakeComment[];
  title: string;
  body: string | null;
  /** GitHub's creation time, to the second: `YYYY-MM-DDTHH:MM:SSZ`. */
  createdAt: string;
  /** GitHub's time of its last change, to the second; its creation time until a test moves it. */
  updatedAt: string;
  open: boolean;
  /** A pull request's changed files, in GitHub's order; undefined for an issue. */
  files: string[] | undefined;
  /** How reading it answers once it is no longer here: 410 when deleted, 301 when transferred. */
  gone: "deleted" | "transferred" | undefined;
};

/** A creation time by number, a minute apart, so that the higher number is the newer issue. */
export function createdAtOf(number: number): string {
  return new Date(Date.UTC(2026, 0, 1) + number * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type FakeRepo = {
  hasIssues: boolean;
  /** The repository's labels. */
  readonly labels: string[];
  readonly issues: Map<number, FakeIssue>;
  /** Logins (lowercase) GitHub may assign. */
  readonly collaborators: Set<string>;
};

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const NOT_FOUND = { message: "Not Found" };

export function fakeGithub(options: {
  readonly token: string;
  readonly login: string;
  readonly origin?: string;
  /** The API's path on its origin, as GitHub Enterprise Server's `/api/v3`; none by default. */
  readonly basePath?: string;
  /**
   * GitHub's clock: given, every answer carries its `Date` header (an HTTP date, to the second),
   * as GitHub's do, unless a script's answer sets its own; none by default.
   */
  readonly now?: () => number;
}) {
  const origin = options.origin ?? "https://api.github.com";
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const repos = new Map<string, FakeRepo>();
  /** Each repository's name as it was given (its case), for the URLs GitHub writes. */
  const names = new Map<FakeRepo, string>();
  const requests: Seen[] = [];
  const unexpected: Seen[] = [];
  const scripts: Script[] = [];
  /**
   * `labelsMustExist`: adding a label the repository lacks is refused (422) instead of creating it.
   * `incompleteSearch`: the search answers `incomplete_results: true`, as when it timed out.
   * `searchIgnoresBound`: the search reads the query but not its `created:<=` bound, so every page
   * answers as the first.
   */
  const settings = { labelsMustExist: false, incompleteSearch: false, searchIgnoresBound: false };
  let nextComment = 1000;

  function repo(fullName: string, seed: Partial<Omit<FakeRepo, "issues">> = {}): FakeRepo {
    const made: FakeRepo = {
      hasIssues: seed.hasIssues ?? true,
      labels: seed.labels ?? [],
      issues: new Map(),
      collaborators: seed.collaborators ?? new Set(),
    };
    repos.set(fullName.toLowerCase(), made);
    names.set(made, fullName);
    return made;
  }

  function issue(fullName: string, number: number, seed: Partial<FakeIssue> = {}): FakeIssue {
    const target = repos.get(fullName.toLowerCase()) ?? repo(fullName);
    const createdAt = seed.createdAt ?? createdAtOf(number);
    const made: FakeIssue = {
      labels: seed.labels ?? [],
      assignees: seed.assignees ?? [],
      comments: seed.comments ?? [],
      title: seed.title ?? `Issue ${number}`,
      body: seed.body === undefined ? `The body of ${number}.` : seed.body,
      createdAt,
      updatedAt: seed.updatedAt ?? createdAt,
      open: seed.open ?? true,
      files: seed.files,
      gone: seed.gone,
    };
    target.issues.set(number, made);
    return made;
  }

  /** A comment by `user`, given the next id. */
  function comment(target: FakeIssue, body: string, user: string | null): FakeComment {
    nextComment += 1;
    const made = { id: nextComment, body, user };
    target.comments.push(made);
    return made;
  }

  const has = (list: readonly string[], name: string) =>
    list.some((item) => item.toLowerCase() === name.toLowerCase());

  function issueJson(number: number, found: FakeIssue, target: FakeRepo) {
    const fullName = names.get(target) ?? "unknown/unknown";
    return {
      number,
      title: found.title,
      body: found.body,
      state: found.open ? "open" : "closed",
      created_at: found.createdAt,
      updated_at: found.updatedAt,
      labels: found.labels.map((name) => ({ id: 1, name, color: "ededed" })),
      assignees: found.assignees.map((login) => ({ login, id: 1 })),
      repository_url: `${origin}${basePath}/repos/${fullName}`,
      ...(found.files === undefined
        ? {}
        : {
            pull_request: {
              url: `${origin}${basePath}/repos/${fullName}/pulls/${number}`,
              merged_at: null,
            },
          }),
    };
  }

  /** One page of `items` as GitHub pages a list: `per_page` and `page`, a `Link` to the next and the last. */
  function paged(seen: Seen, items: readonly unknown[]): Response {
    const size = Math.min(100, Number(seen.url.searchParams.get("per_page") ?? "30"));
    const page = Number(seen.url.searchParams.get("page") ?? "1");
    const last = Math.max(1, Math.ceil(items.length / size));
    const link = (to: number) => `<${origin}${seen.url.pathname}?per_page=${size}&page=${to}>`;
    return json(
      200,
      items.slice((page - 1) * size, page * size),
      page < last ? { link: `${link(page + 1)}; rel="next", ${link(last)}; rel="last"` } : {},
    );
  }

  /**
   * `GET /search/issues`: the open issues or pull requests of one repository, newest first, as
   * the source asks (`repo:`, `is:open`, `is:issue` or `is:pr`, `created:<=` with an offset,
   * `sort=created`, `order=desc`); any other term or order is refused 422, as a query GitHub would
   * read otherwise would be a defect of the source.
   */
  function search(seen: Seen): Response {
    const params = seen.url.searchParams;
    if (params.get("sort") !== "created" || params.get("order") !== "desc") {
      return json(422, { message: "Validation Failed", errors: [{ code: "invalid" }] });
    }
    let fullName: string | undefined;
    let pulls: boolean | undefined;
    let open = false;
    let before: number | undefined;
    for (const term of (params.get("q") ?? "").split(" ").filter((part) => part !== "")) {
      if (term.startsWith("repo:")) {
        fullName = term.slice("repo:".length);
      } else if (term === "is:open") {
        open = true;
      } else if (term === "is:issue" || term === "is:pr") {
        pulls = term === "is:pr";
      } else if (/^created:<=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(term)) {
        before = settings.searchIgnoresBound
          ? undefined
          : Date.parse(term.slice("created:<=".length));
      } else {
        return json(422, { message: "Validation Failed", errors: [{ code: "invalid" }] });
      }
    }
    if (pulls === undefined) {
      return json(422, { message: "Query must include 'is:issue' or 'is:pull-request'" });
    }
    const target = fullName === undefined ? undefined : repos.get(fullName.toLowerCase());
    if (target === undefined || !open) {
      return json(422, { message: "Validation Failed", errors: [{ code: "invalid" }] });
    }
    const found = [...target.issues.entries()]
      .filter(
        ([, one]) =>
          one.open &&
          one.gone === undefined &&
          (one.files !== undefined) === pulls &&
          (before === undefined || Date.parse(one.createdAt) <= before),
      )
      .sort(([a, x], [b, y]) =>
        x.createdAt === y.createdAt ? a - b : x.createdAt < y.createdAt ? 1 : -1,
      );
    const size = Math.min(100, Number(params.get("per_page") ?? "30"));
    const page = Number(params.get("page") ?? "1");
    return json(200, {
      total_count: found.length,
      incomplete_results: settings.incompleteSearch,
      items: found
        .slice((page - 1) * size, page * size)
        .map(([number, one]) => ({ ...issueJson(number, one, target), score: 1 })),
    });
  }

  /**
   * `GET /repos/{o}/{r}/issues`: the repository's issues and pull requests as the poll asks for
   * them (`state=all`, `sort=updated`, `direction=asc`, `since`, `per_page`, `page`), by GitHub's
   * documentation (never seen from a session): those updated after `since` ("only show results
   * that were last updated after the given time", read here as strictly after, to the second),
   * oldest change first, with a `Link` to the next page that keeps the query. Changes in the same
   * second come in no promised order (here: the lower number first). A deleted or transferred
   * issue is not listed. Any other parameter or value is refused 422.
   */
  function list(seen: Seen, target: FakeRepo): Response {
    const params = seen.url.searchParams;
    const known = new Set(["state", "sort", "direction", "since", "per_page", "page"]);
    const since = params.get("since") ?? "";
    if (
      [...params.keys()].some((key) => !known.has(key)) ||
      params.get("state") !== "all" ||
      params.get("sort") !== "updated" ||
      params.get("direction") !== "asc" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since)
    ) {
      return json(422, { message: "Validation Failed", errors: [{ code: "invalid" }] });
    }
    const after = Date.parse(since);
    const found = [...target.issues.entries()]
      .filter(([, one]) => one.gone === undefined && Date.parse(one.updatedAt) > after)
      .sort(([a, x], [b, y]) =>
        x.updatedAt === y.updatedAt ? a - b : x.updatedAt < y.updatedAt ? -1 : 1,
      );
    const size = Math.min(100, Number(params.get("per_page") ?? "30"));
    const page = Number(params.get("page") ?? "1");
    const last = Math.max(1, Math.ceil(found.length / size));
    const link = (to: number) => {
      const url = new URL(seen.url.href);
      url.searchParams.set("page", String(to));
      return `<${url.href}>`;
    };
    return json(
      200,
      found
        .slice((page - 1) * size, page * size)
        .map(([number, one]) => issueJson(number, one, target)),
      page < last ? { link: `${link(page + 1)}; rel="next", ${link(last)}; rel="last"` } : {},
    );
  }

  function route(seen: Seen): Response {
    const { method, segments: s, body } = seen;
    if (s.length === 1 && s[0] === "user" && method === "GET") {
      return json(200, { login: options.login, id: 1 });
    }
    if (s.length === 2 && s[0] === "search" && s[1] === "issues" && method === "GET") {
      return search(seen);
    }
    if (s[0] !== "repos" || s.length < 3) {
      return wrong(seen);
    }
    const target = repos.get(`${s[1]}/${s[2]}`.toLowerCase());
    if (target === undefined) {
      return json(404, NOT_FOUND);
    }
    const rest = s.slice(3);
    if (rest.length === 0 && method === "GET") {
      return json(200, { full_name: `${s[1]}/${s[2]}`, has_issues: target.hasIssues });
    }
    if (rest[0] === "pulls" && rest.length >= 2 && method === "GET") {
      const number = Number(rest[1]);
      const pull = target.issues.get(number);
      if (pull === undefined || pull.files === undefined || pull.gone !== undefined) {
        return json(404, NOT_FOUND);
      }
      if (rest.length === 2) {
        return json(200, { number, title: pull.title, changed_files: pull.files.length });
      }
      if (rest.length === 3 && rest[2] === "files") {
        return paged(
          seen,
          pull.files.map((filename) => ({ filename, status: "modified", additions: 1 })),
        );
      }
      return wrong(seen);
    }
    if (rest[0] === "labels") {
      if (rest.length === 2 && method === "GET") {
        const name = rest[1] as string;
        return has(target.labels, name) ? json(200, { name }) : json(404, NOT_FOUND);
      }
      if (rest.length === 1 && method === "POST") {
        const name = (body as { name: string }).name;
        if (has(target.labels, name)) {
          return json(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
        }
        target.labels.push(name);
        return json(201, { name });
      }
      return wrong(seen);
    }
    if (rest.length === 1 && rest[0] === "issues" && method === "GET") {
      return list(seen, target);
    }
    if (rest[0] !== "issues" || rest.length < 2) {
      return wrong(seen);
    }
    if (rest[1] === "comments" && rest.length === 3 && method === "PATCH") {
      const id = Number(rest[2]);
      for (const one of target.issues.values()) {
        const found = one.comments.find((item) => item.id === id);
        if (found !== undefined) {
          found.body = (body as { body: string }).body;
          return json(200, { id, body: found.body, user: { login: found.user } });
        }
      }
      return json(404, NOT_FOUND);
    }
    const number = Number(rest[1]);
    const found = target.issues.get(number);
    if (!target.hasIssues) {
      return json(410, { message: "Issues are disabled for this repo" });
    }
    if (found === undefined) {
      return json(404, NOT_FOUND);
    }
    const tail = rest.slice(2);
    if (tail.length === 0 && method === "GET") {
      if (found.gone === "deleted") {
        return json(410, { message: "This issue was deleted" });
      }
      if (found.gone === "transferred") {
        return new Response(null, {
          status: 301,
          headers: { location: `${origin}/repositories/99/issues/1` },
        });
      }
      return json(200, issueJson(number, found, target));
    }
    if (tail[0] === "labels") {
      if (tail.length === 1 && method === "POST") {
        const names = (body as { labels: string[] }).labels;
        const unknown = names.filter((name) => !has(target.labels, name));
        if (unknown.length > 0 && settings.labelsMustExist) {
          // The scripted strict mode: GitHub refusing a label the repository lacks.
          return json(422, {
            message: "Validation Failed",
            errors: [{ resource: "Label", field: "name", code: "missing" }],
          });
        }
        // As GitHub is believed to do (never seen from a session): a label the repository lacks
        // is created when it is added to an issue.
        target.labels.push(...unknown);
        for (const name of names) {
          if (!has(found.labels, name)) {
            found.labels.push(name);
          }
        }
        return json(
          200,
          found.labels.map((name) => ({ name })),
        );
      }
      if (tail.length === 2 && method === "DELETE") {
        const name = tail[1] as string;
        if (!has(found.labels, name)) {
          return json(404, { message: "Label does not exist" });
        }
        found.labels = found.labels.filter((item) => item.toLowerCase() !== name.toLowerCase());
        return json(
          200,
          found.labels.map((label) => ({ name: label })),
        );
      }
      return wrong(seen);
    }
    if (tail[0] === "assignees" && tail.length === 1) {
      const logins = (body as { assignees: string[] }).assignees;
      if (method === "POST") {
        for (const one of logins) {
          if (
            target.collaborators.has(one.toLowerCase()) &&
            !has(found.assignees, one) &&
            found.assignees.length < 10
          ) {
            found.assignees.push(one);
          }
        }
        return json(201, issueJson(number, found, target));
      }
      if (method === "DELETE") {
        found.assignees = found.assignees.filter((one) => !has(logins, one));
        return json(200, issueJson(number, found, target));
      }
      return wrong(seen);
    }
    if (tail[0] === "comments" && tail.length === 1) {
      if (method === "GET") {
        const size = Number(seen.url.searchParams.get("per_page") ?? "30");
        const page = Number(seen.url.searchParams.get("page") ?? "1");
        const items = found.comments.slice((page - 1) * size, page * size);
        const last = Math.max(1, Math.ceil(found.comments.length / size));
        const headers: Record<string, string> =
          page < last
            ? {
                link: `<${origin}${seen.url.pathname}?per_page=${size}&page=${page + 1}>; rel="next", <${origin}${seen.url.pathname}?per_page=${size}&page=${last}>; rel="last"`,
              }
            : {};
        return json(
          200,
          items.map((item) => ({
            id: item.id,
            body: item.body,
            user: item.user === null ? null : { login: item.user, type: "User" },
          })),
          headers,
        );
      }
      if (method === "POST") {
        const made = comment(found, (body as { body: string }).body, options.login);
        return json(201, { id: made.id, body: made.body, user: { login: options.login } });
      }
    }
    return wrong(seen);
  }

  function wrong(seen: Seen): Response {
    unexpected.push(seen);
    return json(418, { message: "no such route in the fake" });
  }

  const fetch: GithubFetch = async (url, init) => {
    const parsed = new URL(url);
    // The path under the API's own; undefined for a path outside it.
    const inside = parsed.pathname.startsWith(`${basePath}/`)
      ? parsed.pathname.slice(basePath.length)
      : undefined;
    const seen: Seen = {
      method: init.method,
      url: parsed,
      segments: (inside ?? parsed.pathname)
        .split("/")
        .slice(1)
        .map((segment) => decodeURIComponent(segment)),
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      redirect: init.redirect,
      signal: init.signal,
    };
    requests.push(seen);
    // An answer comes back later than the request goes out, so two runs interleave as they would.
    await Promise.resolve();
    return dated(await answer(seen, parsed, inside, init));
  };

  /** The answer to one request: a script's first, else the routes'. */
  async function answer(
    seen: Seen,
    parsed: URL,
    inside: string | undefined,
    init: Parameters<GithubFetch>[1],
  ): Promise<Response> {
    for (const script of scripts) {
      const scripted = await script(seen);
      if (scripted !== undefined) {
        return scripted;
      }
    }
    if (parsed.origin !== origin || inside === undefined) {
      unexpected.push(seen);
      throw new TypeError("fetch failed");
    }
    if (init.headers["authorization"] !== `Bearer ${options.token}`) {
      return json(401, { message: "Bad credentials" });
    }
    return route(seen);
  }

  /** `response` with GitHub's `Date` header, when the fake has a clock and it carries none. */
  function dated(response: Response): Response {
    if (options.now !== undefined && !response.headers.has("date")) {
      response.headers.set("date", new Date(options.now()).toUTCString());
    }
    return response;
  }

  return {
    fetch,
    requests,
    unexpected,
    repo,
    issue,
    comment,
    settings,
    /** Answers the requests `script` returns a response for, before any route. */
    script(script: Script) {
      scripts.push(script);
    },
    /** The requests that changed something, as `METHOD /path`. */
    writes(): string[] {
      return requests
        .filter((seen) => seen.method !== "GET")
        .map((seen) => `${seen.method} ${seen.url.pathname}`);
    },
    /** Every request as `METHOD /path?query`, for an order a test asserts. */
    log(): string[] {
      return requests.map((seen) => `${seen.method} ${seen.url.pathname}${seen.url.search}`);
    },
    clear() {
      requests.length = 0;
    },
  };
}

export type FakeGithub = ReturnType<typeof fakeGithub>;
