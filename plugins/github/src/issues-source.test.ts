import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import {
  env,
  facetdb,
  noul,
  type PluginSettings,
  type ProjectConfig,
  sourceCall,
  VERSION,
} from "facetdb";
import {
  createPluginHost,
  createPluginSourceConnector,
  type HostedSource,
  hostedSource,
  loadPlugin,
  type Plugin,
  type PluginHost,
  PluginHostError,
  type RecordStore,
  type SourceContext,
  type SourceDefinition,
  type SourcePage,
  type SourceRow,
  satisfies,
} from "facetdb/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createdAtOf, type FakeGithub, fakeGithub, json, type Seen } from "./fake-github.ts";
import {
  ACCEPTED,
  BAD_SIGNATURE,
  BODY_MAX,
  createGithubPlugin,
  GithubActionError,
  type GithubConfig,
  github,
  type IssuesSettings,
  issuesSettings,
  LABEL_MAX,
  NO_SIGNATURE,
  OTHER_REPOSITORY,
  PATH_MAX,
  type Receipt,
  SCAN_PAGE,
  TITLE_MAX,
  TOO_LARGE,
  UNREADABLE,
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOKS_OFF,
} from "./index.ts";

/**
 * The GitHub plugin's issues source on a handwritten GitHub answering through the plugin's `fetch`
 * parameter: nothing reaches the network, and no webhook is delivered by GitHub. The source runs as
 * the worker runs it: its settings parsed by the plugin host from a config that names
 * `github.issues(...)`, its context the host's, its webhook through the SDK's adapter where the
 * route is not needed. Every error is searched for every 8-character piece of the token and of the
 * webhook's secret.
 */

const TOKEN = "ghp_S0urc3T0k3nV4lu3F0rT3st1ngOnly0002";
const SECRET = "whsec_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const VARIABLE = "GITHUB_TOKEN";
const HOOK_VARIABLE = "GITHUB_WEBHOOK_SECRET";
const REPO = "your-org/your-repo";
const API = "https://api.github.com";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const ENV = { [VARIABLE]: TOKEN, [HOOK_VARIABLE]: SECRET };
const FIELDS = ["title", "body", "labels", "changed_files"];
/** U+FFFD, the replacement character, by its code point. */
const R = String.fromCodePoint(0xfffd);

type Kind = "issues" | "pull_requests";
type Context = SourceContext<GithubConfig, IssuesSettings>;

type WorldOptions = {
  readonly include?: readonly Kind[];
  readonly plugin?: PluginSettings;
  readonly environment?: Readonly<Record<string, string>>;
  readonly origin?: string;
  readonly basePath?: string;
};

type World = {
  readonly gh: FakeGithub;
  readonly plugin: Plugin<GithubConfig>;
  readonly host: PluginHost;
  readonly hosted: HostedSource;
  readonly issues: SourceDefinition<GithubConfig>;
};

/** The worked example in its one-source form, the plugin's settings as variables. */
function project(options: WorldOptions = {}, settings?: Record<string, unknown>): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      github: options.plugin ?? { token: env(VARIABLE), webhookSecret: env(HOOK_VARIABLE) },
    },
    source:
      settings === undefined
        ? github.issues({
            repo: REPO,
            ...(options.include === undefined ? {} : { include: options.include }),
          })
        : sourceCall("@facetdb/github", "issues", settings as never),
    read: FIELDS,
    questions: {
      not_priority: noul("Would the maintainers treat this as low priority?"),
    },
  });
}

/** Imports `@facetdb/github` as the given plugin; any other package is not installed. */
function importing(installed: unknown) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/github") {
      return installed;
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

function hostFor(
  plugin: Plugin<GithubConfig>,
  config: ProjectConfig,
  environment: Readonly<Record<string, string>>,
): Promise<PluginHost> {
  return createPluginHost({
    config,
    env: environment,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: importing({ default: plugin }),
    builtins: {},
  });
}

/** A fake GitHub with the repository, the plugin over it, its host, and the source as the host checked it. */
async function world(options: WorldOptions = {}): Promise<World> {
  const gh = fakeGithub({
    token: TOKEN,
    login: "facetdb-bot",
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
  });
  gh.repo(REPO);
  const plugin = createGithubPlugin({ fetch: gh.fetch, now: () => NOW });
  const environment = options.environment ?? ENV;
  const config = project(options);
  const host = await hostFor(plugin, config, environment);
  const hosted = hostedSource(host, config, config.sources[0] as never, environment);
  const issues = plugin.sources["issues"];
  if (issues === undefined) {
    throw new Error("the plugin has no issues source");
  }
  return { gh, plugin, host, hosted, issues };
}

/** The source's context as the SDK's adapter builds it; the clock never sleeps, the cursor is never used. */
function contextOf(w: World, signal = new AbortController().signal): Context {
  return {
    ...w.host.contextFor("@facetdb/github", signal),
    // The host parsed them with this schema already: parsed again only to carry their type.
    source: {
      name: "issues",
      settings: issuesSettings.parse(w.hosted.settings),
      actions: w.hosted.actions,
    },
    clock: {
      now: () => NOW,
      sleep: () => Promise.reject(new Error("the source never waits in these tests")),
    },
    cursor: {
      load: () => Promise.reject(new Error("the source keeps no cursor of its own yet")),
      save: () => Promise.reject(new Error("the source keeps no cursor of its own yet")),
    },
  } as Context;
}

function read(
  w: World,
  keys: readonly string[],
  ctx = contextOf(w),
): Promise<readonly SourceRow[]> {
  return w.issues.read(ctx, keys);
}

async function scanned(w: World, cursor: string | null = null): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  for await (const page of w.issues.scan(contextOf(w), cursor)) {
    pages.push(page);
  }
  return pages;
}

function receive(w: World, request: Request): Promise<Receipt> {
  const receiveFn = w.issues.receive;
  if (receiveFn === undefined) {
    throw new Error("the source has no receive");
  }
  return receiveFn(contextOf(w), request) as Promise<Receipt>;
}

/** What a promise threw; fails the test when it resolved. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("the call succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
}

/** The secret and every 8-character piece of it: a partial leak is found as a whole one is. */
function formsOf(secret: string): readonly string[] {
  const pieces: string[] = [secret, encodeURIComponent(secret), `Bearer ${secret}`];
  for (let at = 0; at + 8 <= secret.length; at += 1) {
    pieces.push(secret.slice(at, at + 8));
  }
  return pieces;
}

/**
 * Every place in `value` (an error or an answer, and all it holds: message, stack, own properties,
 * cause, its JSON, its inspection) where a form of the token or the webhook's secret is found, by
 * name; the names are all an assertion prints, so a failure never shows either.
 */
function leaks(value: unknown, secrets: readonly string[] = [TOKEN, SECRET]): string[] {
  const forms = secrets.flatMap(formsOf).map((form) => form.toLowerCase());
  const found: string[] = [];
  const seen = new Set<unknown>();
  const check = (text: string, where: string) => {
    const lower = text.toLowerCase();
    if (forms.some((form) => lower.includes(form))) {
      found.push(where);
    }
  };
  const visit = (current: unknown, where: string) => {
    if (typeof current === "string") {
      check(current, where);
      return;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (current instanceof Error) {
      check(String(current), `${where} as text`);
      check(current.stack ?? "", `${where}.stack`);
      check(JSON.stringify(current, Object.getOwnPropertyNames(current)), `${where} as JSON`);
    } else {
      check(JSON.stringify(current), `${where} as JSON`);
    }
    check(inspect(current, { showHidden: true, depth: 20 }), `${where} inspected`);
    for (const key of Object.getOwnPropertyNames(current)) {
      visit((current as Record<string, unknown>)[key], `${where}.${key}`);
    }
  };
  visit(value, "value");
  return found;
}

/** A failure of the source that holds neither secret and no `cause`, of the class expected by name. */
function failure(caught: unknown, name: "GithubActionError" | "SourceAccessLost"): Error {
  expect(leaks(caught)).toEqual([]);
  expect(caught instanceof Error && caught.name).toBe(name);
  expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  if (name === "GithubActionError") {
    expect(caught instanceof GithubActionError).toBe(true);
  }
  return caught as Error;
}

/** Every request went to the API's own address, with the token, the user agent and the API version. */
function stayedOnTheApi(gh: FakeGithub, api = API): void {
  expect(gh.unexpected.map((seen) => `${seen.method} ${seen.url.href}`)).toEqual([]);
  expect(gh.requests.filter((seen) => !seen.url.href.startsWith(`${api}/`)).length).toBe(0);
  for (const seen of gh.requests) {
    expect(seen.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "facetdb-github-plugin",
      "x-github-api-version": "2022-11-28",
    });
    // Only an issue's own read sees a redirect (a transferred issue); no request ever follows one.
    expect(seen.redirect).toBe(/\/issues\/\d+$/.test(seen.url.pathname) ? "manual" : "error");
  }
}

// --- the webhook's deliveries ----------------------------------------------------------------------

const REPOSITORY = {
  id: 4242,
  name: "your-repo",
  full_name: REPO,
  owner: { login: "your-org", id: 7 },
};

function issuesEvent(number: number, action = "opened", repository: object = REPOSITORY) {
  return {
    action,
    issue: { number, title: "Typo in README", body: "The word recieve.", labels: [] },
    repository,
    sender: { login: "someone" },
  };
}

function pullRequestEvent(number: number, action = "synchronize", repository: object = REPOSITORY) {
  return {
    action,
    number,
    pull_request: { number, title: "Fix the loader", body: null },
    repository,
    sender: { login: "someone" },
  };
}

function sign(body: string | Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type DeliveryOptions = {
  /** The signature header; signed with the secret by default, left out when null. */
  readonly signature?: string | null;
  /** The raw body, when it is not the payload as JSON. */
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
  readonly headers?: Readonly<Record<string, string>>;
};

/** A delivery as GitHub sends one to the worker's route. */
function delivery(event: string | null, payload: unknown, options: DeliveryOptions = {}): Request {
  const body = options.body ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    ...(event === null ? {} : { "x-github-event": event }),
    ...options.headers,
  };
  const signature =
    options.signature !== undefined
      ? options.signature
      : body instanceof ReadableStream
        ? null
        : sign(body);
  if (signature !== null) {
    headers["x-hub-signature-256"] = signature;
  }
  return new Request("http://localhost:8787/v1/hooks/github/issues", {
    method: "POST",
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** A body that counts how many chunks were pulled from it: `chunks` of `size` bytes. */
function countedBody(chunks: number, size: number) {
  const counter = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (counter.pulled >= chunks) {
          controller.close();
          return;
        }
        counter.pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    },
    // Pulled only when read: nothing is fetched ahead.
    { highWaterMark: 0 },
  );
  return { stream, counter };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("issues-source: read", () => {
  it("reads an issue's title, body and labels (names, sorted) and no changed files, in one request with the token, a user agent and the API version", async () => {
    const w = await world();
    w.gh.issue(REPO, 7, {
      title: "Typo in README",
      body: "The word recieve.",
      labels: ["docs", "Bug", "good first issue"],
    });
    expect(await read(w, ["7"])).toEqual([
      {
        key: "7",
        state: {
          title: "Typo in README",
          body: "The word recieve.",
          labels: "Bug\ndocs\ngood first issue",
          changed_files: "",
        },
      },
    ]);
    expect(w.gh.log()).toEqual([`GET /repos/${REPO}/issues/7`]);
    stayedOnTheApi(w.gh);
  });

  it("reads a pull request with 250 changed files: the first 100 paths and the count, in three requests", async () => {
    const w = await world();
    const files = Array.from(
      { length: 250 },
      (_, i) => `src/file-${String(i).padStart(3, "0")}.ts`,
    );
    w.gh.issue(REPO, 8, { title: "Split the loader", body: null, labels: ["refactor"], files });
    const rows = await read(w, ["8"]);
    expect(rows).toEqual([
      {
        key: "8",
        state: {
          title: "Split the loader",
          body: null,
          labels: "refactor",
          changed_files: ["250 files changed; the first 100:", ...files.slice(0, 100)].join("\n"),
        },
      },
    ]);
    expect(w.gh.log()).toEqual([
      `GET /repos/${REPO}/issues/8`,
      `GET /repos/${REPO}/pulls/8/files?per_page=100`,
      `GET /repos/${REPO}/pulls/8`,
    ]);
    stayedOnTheApi(w.gh);
  });

  it("counts a pull request's files from their one page when there is no next page, with no request more", async () => {
    const w = await world();
    w.gh.issue(REPO, 9, { files: ["README.md", "docs/install.md", "src/a.ts"] });
    w.gh.issue(REPO, 10, { files: ["src/b.ts"] });
    w.gh.issue(REPO, 11, { files: [] });
    const rows = await read(w, ["9", "10", "11"]);
    expect(rows.map((row) => row.state["changed_files"])).toEqual([
      "3 files changed:\nREADME.md\ndocs/install.md\nsrc/a.ts",
      "1 file changed:\nsrc/b.ts",
      "0 files changed",
    ]);
    expect(w.gh.log().filter((line) => /\/pulls\/\d+$/.test(line))).toEqual([]);
  });

  it("leaves out a deleted issue (410), a missing one (404) and a transferred one (301, never followed), reading the repository once to be sure it is still there", async () => {
    const w = await world();
    w.gh.issue(REPO, 5, { gone: "deleted" });
    w.gh.issue(REPO, 6, { gone: "transferred" });
    w.gh.issue(REPO, 7, { title: "Still here" });
    const rows = await read(w, ["5", "6", "7", "9"]);
    expect(rows.map((row) => row.key)).toEqual(["7"]);
    expect(w.gh.log()).toEqual([
      `GET /repos/${REPO}/issues/5`,
      `GET /repos/${REPO}/issues/6`,
      `GET /repos/${REPO}/issues/7`,
      `GET /repos/${REPO}/issues/9`,
      `GET /repos/${REPO}`,
    ]);
    stayedOnTheApi(w.gh);

    // Nothing gone: the repository is not read.
    w.gh.clear();
    await read(w, ["7"]);
    expect(w.gh.log()).toEqual([`GET /repos/${REPO}/issues/7`]);
  });

  it("does not take every issue as deleted when the repository itself is gone, unseen or renamed: it fails, in words that hold no secret", async () => {
    const w = await world();
    // The token lost its access to the repository (or the name is wrong): GitHub answers 404 to all.
    w.gh.script((seen) =>
      seen.url.pathname.startsWith(`/repos/${REPO}`)
        ? json(404, { message: "Not Found" })
        : undefined,
    );
    const lost = failure(await thrown(read(w, ["7"])), "SourceAccessLost");
    expect(lost.message).toContain("GitHub answers 404 for the repository your-org/your-repo");
    expect(lost.message).toContain("plugins.github.token");

    // A renamed repository: GitHub redirects the repository and every issue to the new name.
    const renamed = await world();
    renamed.gh.script((seen) =>
      seen.url.pathname.startsWith(`/repos/${REPO}`)
        ? new Response(null, { status: 301, headers: { location: `${API}/repositories/4242` } })
        : undefined,
    );
    const error = failure(
      await thrown(read(renamed, ["7"])),
      "GithubActionError",
    ) as GithubActionError;
    expect(error.fix).toContain("renamed or moved");
    expect(renamed.gh.requests.map((seen) => seen.redirect)).toEqual(["manual", "error"]);
  });

  it("leaves out a key that is not an issue number as the source writes one, with no request, and a kind include leaves out", async () => {
    const w = await world();
    for (const key of ["007", "abc", "0", "-1", "1e3", "7.0", " 7", "99999999999", "٧"]) {
      expect(await read(w, [key]), key).toEqual([]);
    }
    expect(w.gh.requests).toEqual([]);

    const issuesOnly = await world({ include: ["issues"] });
    issuesOnly.gh.issue(REPO, 8, { files: ["a.ts"] });
    issuesOnly.gh.issue(REPO, 7);
    expect((await read(issuesOnly, ["8", "7"])).map((row) => row.key)).toEqual(["7"]);
    // The pull request's files are never asked for.
    expect(issuesOnly.gh.log()).toEqual([
      `GET /repos/${REPO}/issues/8`,
      `GET /repos/${REPO}/issues/7`,
    ]);

    const pullsOnly = await world({ include: ["pull_requests"] });
    pullsOnly.gh.issue(REPO, 8, { files: ["a.ts"] });
    pullsOnly.gh.issue(REPO, 7);
    expect((await read(pullsOnly, ["8", "7", "8"])).map((row) => row.key)).toEqual(["8"]);
  });

  it("keeps GitHub's text as text and bounds it: the body, the title, a label and a path are cut with …, never inside a character", async () => {
    const w = await world();
    const long = `a${"😀".repeat(40_000)}`;
    w.gh.issue(REPO, 7, {
      title: "t".repeat(2_000),
      body: long,
      labels: ["l".repeat(120), "bug"],
    });
    w.gh.issue(REPO, 8, { body: "a bell \u0007 and a tab \t, kept", files: ["p".repeat(600)] });
    const [issue, pull] = await read(w, ["7", "8"]);
    const body = issue?.state["body"] as string;
    expect(body.isWellFormed()).toBe(true);
    // An odd cut would split the last pair: one unit fewer, then the mark.
    expect(body).toBe(`${long.slice(0, BODY_MAX - 1)}…`);
    expect(issue?.state["title"]).toBe(`${"t".repeat(TITLE_MAX)}…`);
    expect(issue?.state["labels"]).toBe(`bug\n${"l".repeat(LABEL_MAX)}…`);
    // Text stays text: what the store keeps is not touched.
    expect(pull?.state["body"]).toBe("a bell \u0007 and a tab \t, kept");
    expect(pull?.state["changed_files"]).toBe(`1 file changed:\n${"p".repeat(PATH_MAX)}…`);
  });

  it("replaces a NUL and a lone surrogate with U+FFFD in the title, the body, each label and each path, before the bounds, so no author keeps an issue out of triage", async () => {
    const w = await world();
    w.gh.issue(REPO, 7, {
      title: "Crash \u0000 on start \uDC00",
      body: "a NUL \u0000, a lone high \uD800 and low \uDFFF, a pair 😀 kept",
      labels: ["lone\uD83D", "bad\u0000label"],
      files: ["src/\u0000.ts", "docs/\uDFFF.md"],
    });
    const [row] = await read(w, ["7"]);
    expect(row?.state).toEqual({
      title: `Crash ${R} on start ${R}`,
      body: `a NUL ${R}, a lone high ${R} and low ${R}, a pair 😀 kept`,
      labels: `bad${R}label\nlone${R}`,
      changed_files: `2 files changed:\nsrc/${R}.ts\ndocs/${R}.md`,
    });
    for (const value of Object.values(row?.state ?? {})) {
      expect((value as string).includes("\u0000") || !(value as string).isWellFormed()).toBe(false);
    }

    // Replaced first, then cut: a lone surrogate on the bound is kept as U+FFFD, never cut away as
    // half a pair, and a NUL on the bound is kept as one.
    const edge = await world();
    edge.gh.issue(REPO, 8, {
      title: `${"t".repeat(TITLE_MAX - 1)}\u0000tail`,
      body: `${"x".repeat(BODY_MAX - 1)}\uD800${"y".repeat(10)}`,
      labels: [`${"l".repeat(LABEL_MAX - 1)}\uDBFF more`],
      files: [`${"p".repeat(PATH_MAX - 1)}\uD801.ts`],
    });
    const [cut] = await read(edge, ["8"]);
    expect(cut?.state["title"]).toBe(`${"t".repeat(TITLE_MAX - 1)}${R}…`);
    expect(cut?.state["body"]).toBe(`${"x".repeat(BODY_MAX - 1)}${R}…`);
    expect(cut?.state["labels"]).toBe(`${"l".repeat(LABEL_MAX - 1)}${R}…`);
    expect(cut?.state["changed_files"]).toBe(`1 file changed:\n${"p".repeat(PATH_MAX - 1)}${R}…`);
  });

  it("throws SourceAccessLost on a refused token (401) and on a 403 that is not a rate limit, and a rate limit as GitHub's wait; no error holds the token", async () => {
    const refused = await world({ environment: { ...ENV, [VARIABLE]: `${TOKEN}x` } });
    refused.gh.issue(REPO, 7);
    const lost = failure(await thrown(read(refused, ["7"])), "SourceAccessLost");
    expect(lost.message).toContain("status 401");
    expect(lost.message).toContain("plugins.github.token");
    expect(leaks(lost, [`${TOKEN}x`])).toEqual([]);

    const forbidden = await world();
    forbidden.gh.script(() =>
      json(403, { message: "Resource not accessible by personal access token" }),
    );
    expect(failure(await thrown(read(forbidden, ["7"])), "SourceAccessLost").message).toContain(
      "status 403",
    );

    const limited = await world();
    limited.gh.script(() =>
      json(
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 90) },
      ),
    );
    const wait = failure(
      await thrown(read(limited, ["7"])),
      "GithubActionError",
    ) as GithubActionError;
    expect([wait.status, wait.retryAfterMs]).toEqual([403, 90_000]);

    const broken = await world();
    broken.gh.script(() => json(502, { message: `BODY-TEXT ${TOKEN}` }));
    const failed = failure(
      await thrown(read(broken, ["7"])),
      "GithubActionError",
    ) as GithubActionError;
    expect(failed.status).toBe(502);
    expect(failed.message).not.toContain("BODY-TEXT");

    const strange = await world();
    strange.gh.script(() => json(200, { number: 8, title: "another issue", labels: [] }));
    expect(failure(await thrown(read(strange, ["7"])), "GithubActionError").message).toContain(
      "is not that issue",
    );
  });
});

describe("issues-source: receive", () => {
  it("answers the number of an issues event and of a pull_request event of the repository, asking GitHub nothing", async () => {
    const w = await world();
    expect(await receive(w, delivery("issues", issuesEvent(7)))).toEqual({
      status: ACCEPTED,
      keys: ["7"],
    });
    for (const action of [
      "edited",
      "labeled",
      "unlabeled",
      "reopened",
      "closed",
      "deleted",
      "transferred",
    ]) {
      expect((await receive(w, delivery("issues", issuesEvent(7, action)))).keys, action).toEqual([
        "7",
      ]);
    }
    for (const action of ["opened", "synchronize", "edited", "labeled", "closed"]) {
      expect(
        (await receive(w, delivery("pull_request", pullRequestEvent(8, action)))).keys,
        action,
      ).toEqual(["8"]);
    }
    // An issues event about a pull request (GitHub marks it so) is a pull request.
    const marked = issuesEvent(9);
    const pull = { ...marked, issue: { ...marked.issue, pull_request: { url: "x" } } };
    expect((await receive(w, delivery("issues", pull))).keys).toEqual(["9"]);
    expect(w.gh.requests).toEqual([]);
  });

  it("accepts a ping and any other event with no key, its body never parsed", async () => {
    const w = await world();
    const ping = { zen: "Keep it logically awesome.", hook_id: 1, repository: REPOSITORY };
    expect(await receive(w, delivery("ping", ping))).toEqual({ status: ACCEPTED, keys: [] });
    for (const event of ["push", "issue_comment", "pull_request_review", "star", "ISSUES"]) {
      expect(await receive(w, delivery(event, issuesEvent(7))), event).toEqual({
        status: ACCEPTED,
        keys: [],
      });
    }
    // Signed, not JSON: a ping's body is never read as data.
    expect(await receive(w, delivery("ping", undefined, { body: "{not json" }))).toEqual({
      status: ACCEPTED,
      keys: [],
    });
    expect(await receive(w, delivery(null, issuesEvent(7)))).toEqual({
      status: ACCEPTED,
      keys: [],
    });
  });

  it("honours include: a source of issues takes no pull request, a source of pull requests no issue", async () => {
    const issues = await world({ include: ["issues"] });
    expect((await receive(issues, delivery("issues", issuesEvent(7)))).keys).toEqual(["7"]);
    expect(await receive(issues, delivery("pull_request", pullRequestEvent(8)))).toEqual({
      status: ACCEPTED,
      keys: [],
    });
    const pulls = await world({ include: ["pull_requests"] });
    expect((await receive(pulls, delivery("issues", issuesEvent(7)))).keys).toEqual([]);
    expect((await receive(pulls, delivery("pull_request", pullRequestEvent(8)))).keys).toEqual([
      "8",
    ]);
  });

  it("refuses an event of another repository: its full name in any case, then its id once a signed event told it", async () => {
    const w = await world();
    const elsewhere = { ...REPOSITORY, id: 5, full_name: "your-org/elsewhere" };
    expect(await receive(w, delivery("issues", issuesEvent(7, "opened", elsewhere)))).toEqual({
      status: 422,
      keys: [],
      reason: OTHER_REPOSITORY,
    });
    // GitHub compares names in any case; this one teaches the id.
    const cased = { ...REPOSITORY, full_name: "Your-Org/Your-Repo" };
    expect((await receive(w, delivery("issues", issuesEvent(7, "opened", cased)))).keys).toEqual([
      "7",
    ]);
    // The same name from another repository (the name passed on after a rename): refused.
    const reused = { ...REPOSITORY, id: 9999 };
    expect(
      (await receive(w, delivery("pull_request", pullRequestEvent(8, "opened", reused)))).status,
    ).toBe(422);
    // The same repository under a new name: still the source's.
    const renamed = { ...REPOSITORY, full_name: "your-org/renamed" };
    expect((await receive(w, delivery("issues", issuesEvent(7, "opened", renamed)))).keys).toEqual([
      "7",
    ]);
  });

  it("checks the signature: good, bad, missing or malformed; and with no webhook secret set every delivery is 401, webhooks off", async () => {
    const w = await world();
    const payload = issuesEvent(7);
    const body = JSON.stringify(payload);
    const digest = createHmac("sha256", SECRET).update(body).digest("hex");
    expect((await receive(w, delivery("issues", payload))).status).toBe(ACCEPTED);

    const answers: Receipt[] = [];
    const bad = await receive(
      w,
      delivery("issues", payload, { signature: sign(body, `${SECRET}x`) }),
    );
    expect(bad).toEqual({ status: 401, keys: [], reason: BAD_SIGNATURE });
    answers.push(bad);
    const missing = await receive(w, delivery("issues", payload, { signature: null }));
    expect(missing).toEqual({ status: 401, keys: [], reason: NO_SIGNATURE });
    answers.push(missing);
    const last = digest.at(-1) === "0" ? "1" : "0";
    for (const signature of [
      `sha256=${digest.toUpperCase()}`,
      `SHA256=${digest}`,
      `sha1=${digest}`,
      `sha256=${digest.slice(0, 63)}`,
      `sha256=${digest}0`,
      `sha256=${digest.slice(0, 63)}${last}`,
      `sha256=${digest}, sha256=${digest}`,
      digest,
      "sha256=",
      `sha256=${"z".repeat(64)}`,
    ]) {
      const answer = await receive(w, delivery("issues", payload, { signature }));
      expect(answer, signature).toEqual({ status: 401, keys: [], reason: BAD_SIGNATURE });
      answers.push(answer);
    }

    const off = await world({
      plugin: { token: env(VARIABLE) },
      environment: { [VARIABLE]: TOKEN },
    });
    for (const signature of [sign(body), null]) {
      const answer = await receive(off, delivery("issues", payload, { signature }));
      expect(answer).toEqual({ status: 401, keys: [], reason: WEBHOOKS_OFF });
      answers.push(answer);
    }
    expect(WEBHOOKS_OFF).toContain("webhooks are off for this source");
    // No answer holds the secret, the token, the signature or the body.
    expect(leaks(answers)).toEqual([]);
    expect(JSON.stringify(answers)).not.toContain(digest.slice(0, 16));
    expect(JSON.stringify(answers)).not.toContain("recieve");
  });

  it("checks the signature over the bytes received, before any of them is read as JSON", async () => {
    const w = await world();
    // Unsigned or wrongly signed, a body that is not JSON is refused 401, never 400: nothing parsed.
    expect(
      (await receive(w, delivery("issues", undefined, { body: "{not json", signature: null })))
        .status,
    ).toBe(401);
    expect(
      (
        await receive(
          w,
          delivery("issues", undefined, { body: "{not json", signature: sign("{}") }),
        )
      ).status,
    ).toBe(401);
    // Signed, the same body is read, and refused as no event: so the 401s above came first.
    expect(await receive(w, delivery("issues", undefined, { body: "{not json" }))).toEqual({
      status: 400,
      keys: [],
      reason: UNREADABLE,
    });
    // The same JSON written otherwise is other bytes: its signature does not hold.
    const payload = issuesEvent(7);
    const spaced = JSON.stringify(payload, null, 2);
    expect(
      (
        await receive(
          w,
          delivery("issues", payload, { body: spaced, signature: sign(JSON.stringify(payload)) }),
        )
      ).status,
    ).toBe(401);
    // Bytes that are not UTF-8, signed as they are: the signature holds on the bytes, then the body is refused.
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(await receive(w, delivery("issues", undefined, { body: bytes }))).toEqual({
      status: 400,
      keys: [],
      reason: UNREADABLE,
    });
    // A body that cannot be read (locked by another reader, or failing) is answered, never thrown,
    // and what the stream failed with is in no answer.
    const locked = delivery("issues", issuesEvent(7));
    locked.body?.getReader();
    expect(await receive(w, locked)).toEqual({ status: 400, keys: [], reason: UNREADABLE });
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`the connection broke while reading ${SECRET}`));
      },
    });
    const broken = await receive(
      w,
      delivery("issues", undefined, { body: failing, signature: sign("{}") }),
    );
    expect(broken).toEqual({ status: 400, keys: [], reason: UNREADABLE });
    expect(leaks(broken)).toEqual([]);
    // With no signature, the body is never read at all.
    const { stream, counter } = countedBody(4, 1024);
    expect((await receive(w, delivery("issues", undefined, { body: stream }))).status).toBe(401);
    expect(counter.pulled).toBe(0);
    // Signed, an event of the wrong shape is refused as unreadable, with no key.
    for (const shape of [
      {},
      { issue: { number: "7" }, repository: REPOSITORY },
      { issue: { number: 7 } },
      [],
      null,
      7,
    ]) {
      expect(await receive(w, delivery("issues", shape)), JSON.stringify(shape)).toEqual({
        status: 400,
        keys: [],
        reason: UNREADABLE,
      });
    }
    expect((await receive(w, delivery("issues", issuesEvent(0)))).status).toBe(400);
    expect(
      (
        await receive(
          w,
          delivery("pull_request", { ...pullRequestEvent(8), pull_request: { number: 8.5 } }),
        )
      ).status,
    ).toBe(400);
  });

  it(`bounds the body at ${WEBHOOK_BODY_MAX_BYTES} bytes: a Content-Length past it and a body that grows past it are 413, read no further`, async () => {
    const w = await world();
    const declared = delivery("issues", issuesEvent(7), {
      headers: { "content-length": String(WEBHOOK_BODY_MAX_BYTES + 1) },
    });
    expect(await receive(w, declared)).toEqual({ status: 413, keys: [], reason: TOO_LARGE });

    const chunk = 64 * 1024;
    const { stream, counter } = countedBody(WEBHOOK_BODY_MAX_BYTES / chunk + 10, chunk);
    expect(
      await receive(w, delivery("issues", undefined, { body: stream, signature: sign("x") })),
    ).toEqual({ status: 413, keys: [], reason: TOO_LARGE });
    // Read to one chunk past the bound, and no further.
    expect(counter.pulled).toBeLessThanOrEqual(WEBHOOK_BODY_MAX_BYTES / chunk + 2);

    // A body of exactly the bound is read and judged.
    const ping = JSON.stringify({ zen: "x" });
    const exact = ping + " ".repeat(WEBHOOK_BODY_MAX_BYTES - ping.length);
    expect(await receive(w, delivery("ping", undefined, { body: exact }))).toEqual({
      status: ACCEPTED,
      keys: [],
    });
  });

  it("takes a form-encoded delivery, GitHub's other content type, signed over the form as sent", async () => {
    const w = await world();
    const body = `payload=${encodeURIComponent(JSON.stringify(issuesEvent(7)))}`;
    const form = { "content-type": "application/x-www-form-urlencoded" };
    expect(await receive(w, delivery("issues", undefined, { body, headers: form }))).toEqual({
      status: ACCEPTED,
      keys: ["7"],
    });
    expect(
      (await receive(w, delivery("issues", undefined, { body: "other=1", headers: form }))).status,
    ).toBe(400);
  });
});

describe("issues-source: scan", () => {
  /** 250 open issues and pull requests (every fifth a pull request), and 10 closed ones. */
  function seeded(gh: FakeGithub): void {
    for (let number = 1; number <= 260; number += 1) {
      gh.issue(REPO, number, {
        title: `Issue ${number}`,
        labels: number % 7 === 0 ? ["bug"] : [],
        open: number <= 250,
        ...(number % 5 === 0 ? { files: [`src/${number}.ts`] } : {}),
      });
    }
  }

  const searches = (gh: FakeGithub) =>
    gh.requests.filter((seen) => seen.url.pathname === "/search/issues");

  it("pages 250 open issues and pull requests newest first, 100 a page: three pages, the last with no cursor", async () => {
    const w = await world();
    seeded(w.gh);
    const pages = await scanned(w);
    expect(pages.map((page) => page.rows.length)).toEqual([SCAN_PAGE, SCAN_PAGE, 50]);
    expect(pages.flatMap((page) => page.rows.map((row) => Number(row.key)))).toEqual(
      Array.from({ length: 250 }, (_, i) => 250 - i),
    );
    expect(pages.map((page) => page.next === null)).toEqual([false, false, true]);
    expect(JSON.parse(pages[0]?.next as string)).toEqual({ before: createdAtOf(151), seen: [151] });

    // Two searches a page, one per kind, each newest first; from page two, bounded by the cursor.
    const queries = searches(w.gh).map((seen) => Object.fromEntries(seen.url.searchParams));
    expect(queries).toHaveLength(6);
    expect(queries[0]).toEqual({
      q: `repo:${REPO} is:open is:issue`,
      sort: "created",
      order: "desc",
      per_page: "100",
    });
    expect(queries[1]?.["q"]).toBe(`repo:${REPO} is:open is:pr`);
    expect(queries[2]?.["q"]).toBe(
      `repo:${REPO} is:open is:issue created:<=${createdAtOf(151).replace("Z", "+00:00")}`,
    );
    stayedOnTheApi(w.gh);

    // A row's state is the one read gives for the same issue or pull request.
    const rows = new Map(pages.flatMap((page) => page.rows).map((row) => [row.key, row.state]));
    for (const row of await read(w, ["70", "35", "1"])) {
      expect(rows.get(row.key), row.key).toEqual(row.state);
    }
    expect(rows.get("35")?.["changed_files"]).toBe("1 file changed:\nsrc/35.ts");
  });

  it("resumes from page two's cursor: a new scan from it reads pages two and three as the first did", async () => {
    const w = await world();
    seeded(w.gh);
    const pages = await scanned(w);
    w.gh.clear();
    const resumed = await scanned(w, pages[0]?.next as string);
    expect(resumed).toEqual(pages.slice(1));
    expect(searches(w.gh)).toHaveLength(4);
  });

  it("is not moved by an issue opened or closed during the scan: no page shifts, no row is read twice, none skipped", async () => {
    const w = await world();
    seeded(w.gh);
    const iterator = w.issues.scan(contextOf(w), null)[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as SourcePage;
    expect(first.rows.map((row) => row.key).at(-1)).toBe("151");

    // During the scan: an issue opened (the newest), and one of page two's closed.
    w.gh.issue(REPO, 261, { createdAt: createdAtOf(400) });
    const closing = w.gh.issue(REPO, 120);
    closing.open = false;

    const second = (await iterator.next()).value as SourcePage;
    const third = (await iterator.next()).value as SourcePage;
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    // Page two starts where page one ended (a page number would start it one row early, at 151).
    expect(second.rows[0]?.key).toBe("150");
    const keys = [first, second, third].flatMap((page) => page.rows.map((row) => Number(row.key)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      Array.from({ length: 250 }, (_, i) => 250 - i).filter((number) => number !== 120),
    );
  });

  it("neither loses nor repeats issues created in the same second across a page boundary, whatever order GitHub gives them in", async () => {
    const w = await world();
    for (let number = 1; number <= 150; number += 1) {
      // 21 issues share one second, the page's boundary inside them.
      w.gh.issue(REPO, number, {
        createdAt: number >= 40 && number <= 60 ? createdAtOf(60) : createdAtOf(number),
      });
    }
    const pages = await scanned(w, null);
    const keys = pages.flatMap((page) => page.rows.map((row) => Number(row.key)));
    expect([...keys].sort((a, b) => a - b)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(pages.map((page) => page.rows.length)).toEqual([100, 50]);
    // The cursor names the second and every number already read at it.
    const place = JSON.parse(pages[0]?.next as string) as { before: string; seen: number[] };
    expect(place.before).toBe(createdAtOf(60));
    expect(place.seen).toHaveLength(10);
  });

  it("with include issues searches issues only, one search a page, and yields one empty page for a repository with none open", async () => {
    const w = await world({ include: ["issues"] });
    seeded(w.gh);
    const pages = await scanned(w);
    // A full answer may have more behind it: the third search finds the last one. The row read at
    // the boundary second is asked again and dropped, so a page can hold one row fewer than 100.
    expect(pages.map((page) => page.rows.length)).toEqual([100, 99, 1]);
    const rows = pages.flatMap((page) => page.rows);
    expect(new Set(rows.map((row) => row.key)).size).toBe(200);
    expect(rows.every((row) => row.state["changed_files"] === "")).toBe(true);
    const queries = searches(w.gh).map((seen) => seen.url.searchParams.get("q") ?? "");
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => q.includes(" is:issue") && !q.includes("is:pr"))).toBe(true);

    const empty = await world();
    expect(await scanned(empty)).toEqual([{ rows: [], next: null }]);
  });

  it("fails a page GitHub's search did not finish, a cursor it did not write, and an answer holding another repository's issue", async () => {
    const w = await world();
    seeded(w.gh);
    w.gh.settings.incompleteSearch = true;
    expect(failure(await thrown(scanned(w)), "GithubActionError").message).toContain(
      "ended before it was complete",
    );
    w.gh.settings.incompleteSearch = false;
    for (const cursor of [
      "2",
      "page=2",
      "{}",
      '{"before":"2026-01-01","seen":[]}',
      '{"before":"2026-02-30T00:00:00Z","seen":[]}',
      '{"before":"2026-01-01T00:00:00Z","seen":[0]}',
      '{"before":"2026-01-01T00:00:00Z","seen":[],"page":2}',
    ]) {
      expect(
        failure(await thrown(scanned(w, cursor)), "GithubActionError").message,
        cursor,
      ).toContain("not one the GitHub issues source wrote");
    }
    w.gh.script((seen) =>
      seen.url.pathname === "/search/issues"
        ? json(200, {
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                number: 3,
                title: "x",
                body: null,
                labels: [],
                created_at: createdAtOf(3),
                repository_url: `${API}/repos/your-org/elsewhere`,
              },
            ],
          })
        : undefined,
    );
    expect(failure(await thrown(scanned(w)), "GithubActionError").message).toContain(
      "another repository",
    );
  });

  describe("when GitHub's search does not keep to the created:<= bound", () => {
    /** The pages a scan yields before it ends or fails, and its failure; it never runs past ten. */
    async function until(
      w: World,
      cursor: string | null = null,
    ): Promise<{ readonly pages: SourcePage[]; readonly error: unknown }> {
      const pages: SourcePage[] = [];
      try {
        for await (const page of w.issues.scan(contextOf(w), cursor)) {
          pages.push(page);
          if (pages.length > 10) {
            return { pages, error: new Error("the scan went round") };
          }
        }
      } catch (error) {
        return { pages, error };
      }
      return { pages, error: undefined };
    }

    /** A search answer of one item of the repository, created at `createdAt` (or with none). */
    function oneItem(createdAt: unknown): Response {
      return json(200, {
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 999,
            title: "x",
            body: null,
            labels: [],
            ...(createdAt === undefined ? {} : { created_at: createdAt }),
            repository_url: `${API}/repos/${REPO}`,
          },
        ],
      });
    }

    /** The words of the failure: the query not kept to, and the syntax as the likely cause. */
    function unboundedFailure(error: unknown): void {
      const failed = failure(error, "GithubActionError") as GithubActionError;
      expect(failed.message).toContain("the search did not keep to the query");
      expect(failed.fix).toContain("the likely cause is the search syntax");
      expect(failed.fix).toContain("created:<=");
    }

    it("fails the page on an item created one second after the bound, the cursor past page one never handed out", async () => {
      const w = await world();
      seeded(w.gh);
      w.gh.script((seen) => {
        const bound = /created:<=(\S+)\+00:00/.exec(seen.url.searchParams.get("q") ?? "")?.[1];
        if (seen.url.pathname !== "/search/issues" || bound === undefined) {
          return undefined;
        }
        const after = new Date(Date.parse(`${bound}Z`) + 1_000).toISOString();
        return oneItem(after.replace(/\.\d{3}Z$/, "Z"));
      });
      const { pages, error } = await until(w);
      unboundedFailure(error);
      // Page one was finished and yielded; page two failed and gave no cursor.
      expect(pages).toHaveLength(1);
      expect(searches(w.gh)).toHaveLength(3);
    });

    it("ends in that failure, not a loop, when the search ignores the bound and answers every page as the first", async () => {
      const w = await world();
      seeded(w.gh);
      w.gh.settings.searchIgnoresBound = true;
      const { pages, error } = await until(w);
      unboundedFailure(error);
      expect(pages).toHaveLength(1);
      expect(searches(w.gh)).toHaveLength(3);

      // Resumed from page one's cursor, it fails at once, with no page.
      w.gh.clear();
      const resumed = await until(w, pages[0]?.next as string);
      unboundedFailure(resumed.error);
      expect(resumed.pages).toEqual([]);
      expect(searches(w.gh)).toHaveLength(1);
    });

    it("fails the page on an item with a missing or unreadable creation time, on the first page as on any", async () => {
      for (const createdAt of [
        undefined,
        null,
        1_700_000_000,
        "2026-02-30T00:00:00Z",
        "2026-01-01T00:00:00.000Z",
        "yesterday",
      ]) {
        const w = await world({ include: ["issues"] });
        w.gh.script((seen) =>
          seen.url.pathname === "/search/issues" ? oneItem(createdAt) : undefined,
        );
        const { pages, error } = await until(w);
        unboundedFailure(error);
        expect(pages, String(createdAt)).toEqual([]);
      }
    });
  });

  it("throws SourceAccessLost when the token is refused during a scan", async () => {
    const w = await world({ environment: { ...ENV, [VARIABLE]: `${TOKEN}y` } });
    seeded(w.gh);
    failure(await thrown(scanned(w)), "SourceAccessLost");
  });
});

describe("issues-source: the plugin", () => {
  it("passes the SDK's manifest checks through loadPlugin, declaring a core range this FacetDB satisfies", async () => {
    const loaded = await loadPlugin("github", {
      coreVersion: VERSION,
      importModule: importing(await import("./index.ts")),
    });
    expect(loaded.manifest).toMatchObject({
      name: "github",
      kinds: ["source", "action", "pack"],
      secrets: ["token", "webhookSecret"],
    });
    expect(satisfies(VERSION, loaded.manifest.coreVersions)).toBe(true);
    expect(Object.keys(loaded.sources)).toEqual(["issues"]);
    expect(typeof loaded.sources["issues"]?.receive).toBe("function");
  });

  it("writes github.issues as the source's call, and the host parses its settings: both kinds by default, a wrong repo or kind refused", async () => {
    expect(github.issues({ repo: REPO })).toEqual({
      plugin: "@facetdb/github",
      source: "issues",
      settings: { repo: REPO },
    });
    expect(github.issues({ repo: REPO, include: ["issues"] }).settings).toEqual({
      repo: REPO,
      include: ["issues"],
    });
    const w = await world();
    expect(w.hosted.settings).toEqual({ repo: REPO, include: ["issues", "pull_requests"] });

    const refusal = async (settings: Record<string, unknown>) => {
      const config = project({}, settings);
      const plugin = createGithubPlugin({
        fetch: fakeGithub({ token: TOKEN, login: "x" }).fetch,
        now: () => NOW,
      });
      try {
        hostedSource(await hostFor(plugin, config, ENV), config, config.sources[0] as never, ENV);
      } catch (error) {
        if (error instanceof PluginHostError) {
          return error.message;
        }
        throw error;
      }
      throw new Error("the settings were taken");
    };
    expect(await refusal({})).toContain("the source names no repository");
    expect(await refusal({ repo: "your-repo" })).toContain('"owner/name"');
    expect(await refusal({ repo: "your-org/../x" })).toContain('"owner/name"');
    expect(await refusal({ repo: REPO, include: ["comments"] })).toContain(
      'include takes "issues" and "pull_requests"',
    );
    expect(await refusal({ repo: REPO, include: [] })).toContain("at least one");
  });

  it("watch yields nothing and ends when the source stops, leaving no timer", async () => {
    vi.useFakeTimers();
    const w = await world();
    const stop = new AbortController();
    const iterator = w.issues.watch(contextOf(w, stop.signal))[Symbol.asyncIterator]();
    const next = iterator.next();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    stop.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(w.gh.requests).toEqual([]);
  });

  it("takes a signed delivery through the SDK's adapter: the record read and queued once; a forged one queues nothing", async () => {
    const w = await world();
    w.gh.issue(REPO, 7, { title: "Typo in README", body: "recieve", labels: ["docs"] });
    w.gh.issue(REPO, 8, { title: "a NUL \u0000 and a lone \uD800", body: "a NUL \u0000 inside" });
    const states = new Map<string, string>();
    const unused = () => Promise.reject(new Error("not used here"));
    const store: RecordStore = {
      capabilities: {
        inlineColumns: false,
        pushWakeup: false,
        transactions: true,
        sideTable: false,
        multipleWorkers: true,
      },
      install: () => Promise.resolve(),
      uninstall: () => Promise.resolve(),
      watch: async function* () {},
      read: unused,
      write: unused,
      current: unused,
      scan: unused,
      enqueue: unused,
      claim: unused,
      claimKey: unused,
      ack: unused,
      release: unused,
      upsertRecord(key, state) {
        const changed = states.get(key) !== JSON.stringify(state);
        states.set(key, JSON.stringify(state));
        return Promise.resolve(changed);
      },
    };
    const lines: string[] = [];
    const adapter = createPluginSourceConnector({
      store,
      name: "issues",
      hosted: w.hosted,
      context: (signal) => w.host.contextFor("@facetdb/github", signal),
      fields: FIELDS,
      clock: { now: () => NOW, sleep: () => Promise.resolve() },
      cursors: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
      cursorRun: "plugin-source:test",
      note: (line) => lines.push(line),
    });
    try {
      const taken = await adapter.receive(delivery("issues", issuesEvent(7)));
      expect(taken.status).toBe(ACCEPTED);
      expect(taken.intake.queued).toEqual(["7"]);
      expect(JSON.parse(states.get("7") as string)).toEqual({
        title: "Typo in README",
        body: "recieve",
        labels: "docs",
        changed_files: "",
      });
      // The same delivery again: the same state, nothing queued.
      expect((await adapter.receive(delivery("issues", issuesEvent(7)))).intake.unchanged).toEqual([
        "7",
      ]);

      const body = JSON.stringify(issuesEvent(7));
      const forged = await adapter.receive(
        delivery("issues", undefined, { body, signature: sign(body, "a guessed secret") }),
      );
      expect(forged.status).toBe(401);
      expect(forged.intake.queued).toEqual([]);

      // An issue holding a NUL and a lone surrogate passes the host's check of a state and is
      // queued: neither keeps it out of triage.
      const nul = await adapter.receive(delivery("issues", issuesEvent(8)));
      expect(nul.intake).toMatchObject({ queued: ["8"], refused: [] });
      expect(JSON.parse(states.get("8") as string)).toMatchObject({
        title: `a NUL ${R} and a lone ${R}`,
        body: `a NUL ${R} inside`,
      });
      expect(lines).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("sends every request of read and scan to apiUrl alone, GitHub Enterprise Server's /api/v3 included", async () => {
    const api = "http://localhost:8080/api/v3";
    const w = await world({
      plugin: { token: env(VARIABLE), webhookSecret: env(HOOK_VARIABLE), apiUrl: api },
      origin: "http://localhost:8080",
      basePath: "/api/v3",
    });
    w.gh.issue(REPO, 1);
    w.gh.issue(REPO, 2, { files: Array.from({ length: 120 }, (_, i) => `f${i}`) });
    w.gh.issue(REPO, 3, { gone: "deleted" });
    expect((await read(w, ["1", "2", "3"])).map((row) => row.key)).toEqual(["1", "2"]);
    expect((await scanned(w)).flatMap((page) => page.rows.map((row) => row.key))).toEqual([
      "2",
      "1",
    ]);
    expect(w.gh.requests.length).toBeGreaterThan(5);
    stayedOnTheApi(w.gh, api);
    expect(w.gh.requests.every((seen: Seen) => seen.url.origin === "http://localhost:8080")).toBe(
      true,
    );
  });
});
