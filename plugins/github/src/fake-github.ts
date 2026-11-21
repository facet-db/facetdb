import type { GithubFetch } from "./rest.ts";

/**
 * A handwritten GitHub for the action tests (facetdb-testing: fakes beside the test, no network):
 * the REST routes the actions call, over an in-memory repository, answered through the same
 * `fetch` parameter the real plugin is given. Every request is recorded; a script answers a
 * request first when it returns a response (a rate limit, a 5xx, a page from another host), and
 * a request no route knows is answered 418 and recorded, so a test can say none was made.
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
};

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
}) {
  const origin = options.origin ?? "https://api.github.com";
  const repos = new Map<string, FakeRepo>();
  const requests: Seen[] = [];
  const unexpected: Seen[] = [];
  const scripts: Script[] = [];
  /** `labelsMustExist`: adding a label the repository lacks is refused (422) instead of creating it. */
  const settings = { labelsMustExist: false };
  let nextComment = 1000;

  function repo(fullName: string, seed: Partial<Omit<FakeRepo, "issues">> = {}): FakeRepo {
    const made: FakeRepo = {
      hasIssues: seed.hasIssues ?? true,
      labels: seed.labels ?? [],
      issues: new Map(),
      collaborators: seed.collaborators ?? new Set(),
    };
    repos.set(fullName.toLowerCase(), made);
    return made;
  }

  function issue(fullName: string, number: number, seed: Partial<FakeIssue> = {}): FakeIssue {
    const target = repos.get(fullName.toLowerCase()) ?? repo(fullName);
    const made: FakeIssue = {
      labels: seed.labels ?? [],
      assignees: seed.assignees ?? [],
      comments: seed.comments ?? [],
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

  function issueJson(number: number, found: FakeIssue) {
    return {
      number,
      title: "an issue",
      labels: found.labels.map((name) => ({ id: 1, name, color: "ededed" })),
      assignees: found.assignees.map((login) => ({ login, id: 1 })),
    };
  }

  function route(seen: Seen): Response {
    const { method, segments: s, body } = seen;
    if (s.length === 1 && s[0] === "user" && method === "GET") {
      return json(200, { login: options.login, id: 1 });
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
      return json(200, issueJson(number, found));
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
        return json(201, issueJson(number, found));
      }
      if (method === "DELETE") {
        found.assignees = found.assignees.filter((one) => !has(logins, one));
        return json(200, issueJson(number, found));
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
    const seen: Seen = {
      method: init.method,
      url: parsed,
      segments: parsed.pathname
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
    for (const script of scripts) {
      const answer = await script(seen);
      if (answer !== undefined) {
        return answer;
      }
    }
    if (parsed.origin !== origin) {
      unexpected.push(seen);
      throw new TypeError("fetch failed");
    }
    if (init.headers["authorization"] !== `Bearer ${options.token}`) {
      return json(401, { message: "Bad credentials" });
    }
    return route(seen);
  };

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
