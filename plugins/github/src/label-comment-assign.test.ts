import { inspect } from "node:util";
import {
  type ActionCall,
  choice,
  env,
  facetdb,
  noul,
  type PluginSettings,
  type ProjectConfig,
  VERSION,
} from "facetdb";
import {
  ACTION_WORDS_MAX,
  type ActionContext,
  type ActionDefinition,
  actionSteps,
  checkActions,
  createPluginHost,
  firstPartyFailure,
  type Plugin,
  type PluginHost,
  PluginHostError,
  type QueuedAction,
} from "facetdb/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeGithub, fakeGithub, json, type Seen } from "./fake-github.ts";
import {
  COMMENT_MAX,
  createGithubPlugin,
  GithubActionError,
  type GithubConfig,
  github,
  MARKER_PREFIX,
  PAGES_MAX,
  RETRY_AFTER_MAX_MS,
  TIMEOUT_MS,
} from "./index.ts";
import { issueOf } from "./issue.ts";
import { urlOf } from "./rest.ts";

/**
 * The GitHub label, comment and assign actions, on a handwritten GitHub answering through the
 * plugin's `fetch` parameter: nothing reaches the network. Each action runs as the worker's runner
 * calls it (the context from the plugin host, the settings parsed by the action's schema), twice
 * where it matters, so a second delivery is seen to end in the same state with no write. The token
 * is searched for in every error.
 */

const TOKEN = "ghp_R4nd0mT0k3nV4lu3F0rT3st1ngOnly0001";
const VARIABLE = "GITHUB_TOKEN";
const LOGIN = "facetdb-bot";
const REPO = "your-org/your-repo";
const API = "https://api.github.com";
const ISSUE_PATH = `/repos/${REPO}/issues/7`;
/** What every comment action names: the repository and the comment's id. */
const C = { repo: REPO, id: "triage" };

type Decisions = Parameters<ActionDefinition["run"]>[2];
type Status = Parameters<ActionDefinition["run"]>[1]["status"];

const YES: Decisions = {
  not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 },
};
const NO: Decisions = {
  not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.08 },
};
const WAITING: Decisions = { not_priority: { kind: "needs_review" } };

function project(
  actions: readonly ActionCall[],
  settings: PluginSettings = { token: env(VARIABLE) },
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { github: settings },
    sources: [
      {
        name: "issues",
        api: true,
        read: ["title", "body"],
        questions: {
          not_priority: noul("Would the maintainers treat this as low priority?"),
          area: choice("Which part of the product is this about?", {
            billing: "Invoices and payments",
            docs: "The documentation",
          }),
        },
        thresholds: { not_priority: { yesAbove: 0.8, noBelow: 0.2 } },
        actions,
      },
    ],
  });
}

/** Imports `@facetdb/github` as the given plugin; any other package is not installed. */
function importing(installed: Plugin) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/github") {
      return { default: installed };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

function hostFor(installed: Plugin, config: ProjectConfig, token = TOKEN): Promise<PluginHost> {
  return createPluginHost({
    config,
    env: { [VARIABLE]: token },
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: importing(installed),
    builtins: {},
  });
}

type World = {
  readonly gh: FakeGithub;
  readonly plugin: Plugin<GithubConfig>;
  readonly host: PluginHost;
  readonly now: { ms: number };
};

/** The plugin's lines are the issues source's poll's, which no action runs. */
function noLine(line: string): never {
  throw new Error(`an action printed a line: ${line}`);
}

/** A fake GitHub with the repository and issue 7, the plugin over it, and its host. */
async function world(config: ProjectConfig = project([]), token = TOKEN): Promise<World> {
  const gh = fakeGithub({ token: TOKEN, login: LOGIN });
  gh.repo(REPO);
  gh.issue(REPO, 7);
  const now = { ms: Date.UTC(2026, 10, 14, 12, 0, 0) };
  const plugin = createGithubPlugin({ fetch: gh.fetch, now: () => now.ms, warn: noLine });
  const host = await hostFor(plugin, config, token);
  return { gh, plugin, host, now };
}

type Run = {
  readonly key?: string;
  readonly status?: Status;
  readonly decisions?: Decisions;
  /** The source the action runs on: the API source by default (no settings: not this plugin's). */
  readonly source?: ActionContext<unknown>["source"];
  readonly signal?: AbortSignal;
  /** Hands `run` the settings as they are, past the schema: to prove a guard behind it. */
  readonly raw?: boolean;
};

/** Runs one action as the worker's runner does: its settings parsed by its schema, its context from the host. */
async function run(
  w: World,
  name: "label" | "comment" | "assign",
  settings: Record<string, unknown>,
  options: Run = {},
): Promise<void> {
  const entry = w.plugin.actions[name];
  if (entry === undefined) {
    throw new Error(`the plugin has no ${name} action`);
  }
  const ctx = {
    ...w.host.contextFor("@facetdb/github", options.signal ?? new AbortController().signal),
    source: options.source ?? { name: "issues", settings: null },
  } as ActionContext<GithubConfig>;
  await entry.run(
    ctx as ActionContext<never>,
    {
      key: options.key ?? "7",
      state: { title: "Typo in README" },
      status: options.status ?? "done",
      stateHash: "h1",
      decidedAt: new Date("2026-11-14T10:00:00.000Z"),
    },
    options.decisions ?? YES,
    options.raw === true ? settings : entry.config.parse(settings),
  );
}

/** What a promise threw; fails the test when it resolved. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("the action succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
}

/** The token and every 8-character piece of it: a partial leak is found as a whole one is. */
function formsOf(token: string): readonly string[] {
  const pieces: string[] = [token, encodeURIComponent(token), `Bearer ${token}`];
  for (let at = 0; at + 8 <= token.length; at += 1) {
    pieces.push(token.slice(at, at + 8));
  }
  return pieces;
}

/**
 * Every place in `value` (an error and all it holds: message, stack, own properties, cause, its
 * JSON, its inspection) where a form of the token is found, by name; the names are all an
 * assertion prints, so a failure never shows the token.
 */
function leaks(value: unknown, token = TOKEN): string[] {
  const forms = formsOf(token).map((form) => form.toLowerCase());
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
  visit(value, "error");
  return found;
}

/**
 * A failure that holds no form of the token, no `cause` and nothing of GitHub's body; given a
 * function, what it throws (failing the test when it returns).
 */
function failure(caught: unknown): GithubActionError {
  let error = caught;
  if (typeof caught === "function") {
    try {
      (caught as () => unknown)();
      error = new Error("the call returned, and a failure was expected");
    } catch (thrownError) {
      error = thrownError;
    }
  }
  expect(leaks(error)).toEqual([]);
  expect(error instanceof GithubActionError).toBe(true);
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  expect(String((error as Error).message)).not.toContain("BODY-TEXT");
  return error as GithubActionError;
}

/**
 * The paths an action may reach: the issue's own; past it, the repository (read after a 404 on
 * the issue), its label list (a label created only when GitHub refuses to add a missing one), a
 * comment of the issue by its id, and /user (only when a comment holds the marker).
 */
function allowed(seen: Seen): boolean {
  const path = seen.url.pathname;
  return (
    seen.url.origin === API &&
    (path === ISSUE_PATH ||
      path.startsWith(`${ISSUE_PATH}/`) ||
      path === `/repos/${REPO}` ||
      path === `/repos/${REPO}/labels` ||
      /^\/repos\/your-org\/your-repo\/issues\/comments\/\d+$/.test(path) ||
      path === "/user")
  );
}

/**
 * Every request went to the one issue's paths, with the token, never following a redirect: the
 * read of the issue sees one (`manual`), every other request refuses it (`error`).
 */
function stayedOnTheIssue(gh: FakeGithub): void {
  expect(gh.unexpected.map((seen) => `${seen.method} ${seen.url.href}`)).toEqual([]);
  expect(gh.requests.filter((seen) => !allowed(seen)).map((seen) => seen.url.pathname)).toEqual([]);
  expect(
    gh.requests
      .filter(
        (seen) =>
          seen.redirect !==
          (seen.method === "GET" && seen.url.pathname === ISSUE_PATH ? "manual" : "error"),
      )
      .map((seen) => `${seen.method} ${seen.url.pathname} ${seen.redirect}`),
  ).toEqual([]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("label", () => {
  it("adds a label through the issue alone, GitHub creating one the repository lacks, and a second run writes nothing", async () => {
    const w = await world();
    const repo = w.gh.repo(REPO);
    const issue = w.gh.issue(REPO, 7);
    await run(w, "label", { repo: REPO, add: ["Not Priority"] });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`, `POST ${ISSUE_PATH}/labels`]);
    expect(w.gh.requests[1]?.body).toEqual({ labels: ["Not Priority"] });
    expect([repo.labels, issue.labels]).toEqual([["Not Priority"], ["Not Priority"]]);

    w.gh.clear();
    await run(w, "label", { repo: REPO, add: ["Not Priority"] });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`]);
    stayedOnTheIssue(w.gh);
  });

  it("creates the label in the repository only when GitHub refuses to add a missing one, then adds it again", async () => {
    const w = await world();
    w.gh.settings.labelsMustExist = true;
    const repo = w.gh.repo(REPO, { labels: ["bug"] });
    const issue = w.gh.issue(REPO, 7);
    await run(w, "label", { repo: REPO, add: ["Not Priority", "bug"] });
    expect(w.gh.log()).toEqual([
      `GET ${ISSUE_PATH}`,
      `POST ${ISSUE_PATH}/labels`,
      `POST /repos/${REPO}/labels`,
      `POST /repos/${REPO}/labels`,
      `POST ${ISSUE_PATH}/labels`,
    ]);
    expect(repo.labels).toEqual(["bug", "Not Priority"]);
    expect(issue.labels).toEqual(["Not Priority", "bug"]);

    w.gh.clear();
    await run(w, "label", { repo: REPO, add: ["Not Priority", "bug"] });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`]);
    stayedOnTheIssue(w.gh);
  });

  it("names a 422 on adding that names no missing label, and creates nothing", async () => {
    const w = await world();
    w.gh.script((seen) =>
      seen.method === "POST" && seen.url.pathname === `${ISSUE_PATH}/labels`
        ? json(422, { message: "BODY-TEXT", errors: [{ code: "invalid", field: "labels" }] })
        : undefined,
    );
    const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["Not Priority"] })));
    expect(error.status).toBe(422);
    expect(w.gh.writes()).toEqual([`POST ${ISSUE_PATH}/labels`]);
  });

  it("removes a label that is there, and a removal a person already made is not an error", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7, { labels: ["Not Priority", "bug"] });
    await run(w, "label", { repo: REPO, remove: ["not priority"] });
    expect(issue.labels).toEqual(["bug"]);
    expect(w.gh.writes()).toEqual([`DELETE ${ISSUE_PATH}/labels/Not%20Priority`]);

    // The person removed it already: nothing to remove, no request but the read, no error.
    w.gh.clear();
    await run(w, "label", { repo: REPO, remove: ["Not Priority"] });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`]);
  });

  it("takes GitHub's 404 on the removal (removed between the read and the write) as done", async () => {
    const w = await world();
    w.gh.issue(REPO, 7, { labels: ["Not Priority"] });
    w.gh.script((seen) =>
      seen.method === "DELETE" ? json(404, { message: "Label does not exist" }) : undefined,
    );
    await run(w, "label", { repo: REPO, remove: ["Not Priority"] });
    expect(w.gh.writes()).toEqual([`DELETE ${ISSUE_PATH}/labels/Not%20Priority`]);
  });

  it("takes a label created since the refusal (GitHub's 422 already_exists) as there", async () => {
    const w = await world();
    w.gh.settings.labelsMustExist = true;
    const repo = w.gh.repo(REPO);
    const issue = w.gh.issue(REPO, 7);
    // Another run creates the label between this run's refused addition and its own creation.
    w.gh.script((seen) => {
      if (seen.method === "POST" && seen.url.pathname === `/repos/${REPO}/labels`) {
        repo.labels.push("Not Priority");
        return json(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
      }
      return undefined;
    });
    await run(w, "label", { repo: REPO, add: ["Not Priority"] });
    expect(w.gh.writes()).toEqual([
      `POST ${ISSUE_PATH}/labels`,
      `POST /repos/${REPO}/labels`,
      `POST ${ISSUE_PATH}/labels`,
    ]);
    expect(issue.labels).toEqual(["Not Priority"]);
  });

  it("names any other 422 on a label's creation, and adds nothing", async () => {
    const w = await world();
    w.gh.settings.labelsMustExist = true;
    w.gh.script((seen) =>
      seen.method === "POST" && seen.url.pathname === `/repos/${REPO}/labels`
        ? json(422, { message: "BODY-TEXT", errors: [{ code: "invalid", field: "name" }] })
        : undefined,
    );
    const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["Not Priority"] })));
    expect([error.status, error.fix]).toEqual([
      422,
      "check the label names in the action's add (GitHub allows at most 50 characters)",
    ]);
    expect(w.gh.writes()).toEqual([`POST ${ISSUE_PATH}/labels`, `POST /repos/${REPO}/labels`]);
  });

  it("runs the worked example: else laid over add removes the label, and each branch is idempotent", async () => {
    const call = github.label({
      repo: REPO,
      when: { not_priority: true },
      add: ["Not Priority"],
      else: { remove: ["Not Priority"] },
    });
    const config = project([call]);
    const w = await world(config);
    const [source] = config.sources;
    if (source === undefined) {
      throw new Error("the config has a source");
    }
    // The settings the worker queues for a decision, as `when` and `else` resolve them.
    const queued = async (decisions: Decisions): Promise<QueuedAction[]> => {
      const rows: QueuedAction[] = [];
      for (const step of actionSteps(source, async (row) => {
        rows.push(row);
      })) {
        await step.run(
          { key: "7", state: {}, status: "done", stateHash: "h1", decidedAt: new Date() },
          decisions,
        );
      }
      return rows;
    };
    const [no] = await queued(NO);
    const [yes] = await queued(YES);
    expect(no?.payload.settings).toEqual({
      repo: REPO,
      add: ["Not Priority"],
      remove: ["Not Priority"],
    });
    expect(yes?.payload.settings).toEqual({ repo: REPO, add: ["Not Priority"] });

    // The example's source would be a GitHub source of this plugin, giving the same repo.
    const fromGithub = { name: "issues", settings: { repo: REPO } };
    const issue = w.gh.issue(REPO, 7);
    await run(w, "label", { ...yes?.payload.settings }, { source: fromGithub });
    expect(issue.labels).toEqual(["Not Priority"]);
    w.gh.clear();
    await run(w, "label", { ...yes?.payload.settings }, { source: fromGithub });
    expect(w.gh.writes()).toEqual([]);

    await run(w, "label", { ...no?.payload.settings }, { source: fromGithub, decisions: NO });
    expect(issue.labels).toEqual([]);
    w.gh.clear();
    await run(w, "label", { ...no?.payload.settings }, { source: fromGithub, decisions: NO });
    expect(w.gh.writes()).toEqual([]);
    stayedOnTheIssue(w.gh);
  });

  it("encodes every segment, so a label's name cannot change the request's path or query", async () => {
    // Each name, and the exact path its removal is sent to: a dot or an encoded dot stays one
    // segment of the issue's labels, never a step up or a step in place.
    const names: readonly (readonly [string, string])[] = [
      ["%2e", "%252e"],
      ["%2E%2E", "%252E%252E"],
      ["a.b", "a.b"],
      ["..x", "..x"],
      ["x.", "x."],
      ["x/../y", "x%2F..%2Fy"],
      ["%2e%2e/x", "%252e%252e%2Fx"],
      ["a/b?c#d %2F ..", "a%2Fb%3Fc%23d%20%252F%20.."],
    ];
    const w = await world();
    w.gh.issue(REPO, 7, { labels: names.map(([name]) => name) });
    await run(w, "label", { repo: REPO, remove: names.map(([name]) => name) });
    expect(
      w.gh.requests.filter((seen) => seen.method === "DELETE").map((seen) => seen.url.pathname),
    ).toEqual(names.map(([, segment]) => `${ISSUE_PATH}/labels/${segment}`));
    expect(w.gh.requests.every((seen) => seen.url.search === "")).toBe(true);
    stayedOnTheIssue(w.gh);
  });

  it("never sends a name of only dots, even one that got past the schema: the URL builder refuses it", async () => {
    for (const name of [".", ".."]) {
      const w = await world();
      w.gh.issue(REPO, 7, { labels: [name, "bug"] });
      const error = failure(
        await thrown(run(w, "label", { repo: REPO, remove: [name] }, { raw: true })),
      );
      expect(error.message).toContain("empty, . or .. segment");
      expect(w.gh.writes()).toEqual([]);
    }
    const base = new URL(API);
    for (const segment of [".", "..", ""]) {
      expect(() => urlOf(base, ["repos", "o", "r", "labels", segment])).toThrow(GithubActionError);
    }
    expect(urlOf(base, ["repos", "o", "r", "labels", "%2e"]).pathname).toBe(
      "/repos/o/r/labels/%252e",
    );
    expect(urlOf(new URL("https://github.example.com/api/v3/"), ["user"]).href).toBe(
      "https://github.example.com/api/v3/user",
    );
  });
});

describe("assign", () => {
  it("assigns who is missing and unassigns who is there, and a second run writes nothing", async () => {
    const w = await world();
    w.gh.repo(REPO, { collaborators: new Set(["octocat", "hubot"]) });
    const issue = w.gh.issue(REPO, 7, { assignees: ["hubot"] });
    await run(w, "assign", { repo: REPO, add: ["Octocat"], remove: ["HUBOT", "nobody"] });
    expect(issue.assignees).toEqual(["Octocat"]);
    expect(w.gh.writes()).toEqual([
      `POST ${ISSUE_PATH}/assignees`,
      `DELETE ${ISSUE_PATH}/assignees`,
    ]);
    expect(w.gh.requests.find((seen) => seen.method === "DELETE")?.body).toEqual({
      assignees: ["hubot"],
    });

    w.gh.clear();
    await run(w, "assign", { repo: REPO, add: ["Octocat"], remove: ["HUBOT", "nobody"] });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`]);
    stayedOnTheIssue(w.gh);
  });

  it("says which login GitHub did not assign, as GitHub skips it in silence", async () => {
    const w = await world();
    const error = failure(await thrown(run(w, "assign", { repo: REPO, add: ["stranger"] })));
    expect(error.message).toContain("did not assign stranger");
    expect(error.fix).toContain("can see the repository");
  });
});

describe("comment", () => {
  const BODY = "Not priority: {{not_priority}} ({{not_priority.probability}}), status {{status}}.";

  it("posts one comment with its marker first, leaves it alone on a second run, and edits it in place when the text differs", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    await run(w, "comment", { ...C, body: BODY });
    // No comment holds the marker: whose token it is does not matter, and is not asked.
    expect(w.gh.log()).toEqual([
      `GET ${ISSUE_PATH}`,
      `GET ${ISSUE_PATH}/comments?per_page=100`,
      `POST ${ISSUE_PATH}/comments`,
    ]);
    const [posted] = issue.comments;
    expect(posted?.body).toBe(
      `${MARKER_PREFIX} source=issues id=triage -->\n\nNot priority: yes (0.93), status done.`,
    );

    w.gh.clear();
    await run(w, "comment", { ...C, body: BODY });
    expect(w.gh.log()).toEqual([
      `GET ${ISSUE_PATH}`,
      `GET ${ISSUE_PATH}/comments?per_page=100`,
      "GET /user",
    ]);

    w.gh.clear();
    await run(w, "comment", { ...C, body: BODY }, { decisions: WAITING, status: "needs_review" });
    expect(w.gh.writes()).toEqual([`PATCH /repos/${REPO}/issues/comments/${posted?.id}`]);
    expect(issue.comments).toHaveLength(1);
    // The marker survives the action's own edit: it is the first line of every write.
    expect(issue.comments[0]?.body).toBe(
      `${MARKER_PREFIX} source=issues id=triage -->\n\nNot priority: needs review (needs review), status needs review.`,
    );
    stayedOnTheIssue(w.gh);
  });

  it("finds its comment among several pages of others' and edits it, following GitHub's Link header", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    for (let n = 0; n < 130; n += 1) {
      w.gh.comment(issue, `comment ${n}`, `user${n}`);
    }
    await run(w, "comment", { ...C, body: BODY });
    for (let n = 0; n < 120; n += 1) {
      w.gh.comment(issue, `later ${n}`, `user${n}`);
    }
    w.gh.clear();
    await run(w, "comment", { ...C, body: BODY }, { decisions: NO });
    expect(w.gh.log()).toEqual([
      `GET ${ISSUE_PATH}`,
      `GET ${ISSUE_PATH}/comments?per_page=100`,
      `GET ${ISSUE_PATH}/comments?per_page=100&page=2`,
      `GET ${ISSUE_PATH}/comments?per_page=100&page=3`,
      "GET /user",
      `PATCH /repos/${REPO}/issues/comments/${issue.comments[130]?.id}`,
    ]);
    expect(issue.comments.filter((one) => one.body.startsWith(MARKER_PREFIX))).toHaveLength(1);
    expect(issue.comments[130]?.body).toContain("Not priority: no (0.08)");
  });

  it("never follows a next page on another host, and posts nothing it cannot be sure of", async () => {
    const w = await world();
    w.gh.script((seen) =>
      seen.url.pathname.endsWith("/comments") && seen.method === "GET"
        ? json(200, [], { link: '<https://evil.example.com/steal?page=2>; rel="next"' })
        : undefined,
    );
    const error = failure(await thrown(run(w, "comment", { ...C, body: BODY })));
    expect(error.message).toContain("not on the same API and path");
    expect(w.gh.requests.map((seen) => seen.url.origin)).toEqual([API, API]);
    expect(w.gh.writes()).toEqual([]);
  });

  it(`stops past ${PAGES_MAX} pages without posting a comment that could be a second one`, async () => {
    const w = await world();
    w.gh.script((seen) => {
      if (!(seen.url.pathname.endsWith("/comments") && seen.method === "GET")) {
        return undefined;
      }
      const page = Number(seen.url.searchParams.get("page") ?? "1");
      return json(200, [], {
        link: `<${API}${seen.url.pathname}?per_page=100&page=${page + 1}>; rel="next"`,
      });
    });
    const error = failure(await thrown(run(w, "comment", { ...C, body: BODY })));
    expect(error.message).toContain(`past ${PAGES_MAX} pages`);
    expect(w.gh.requests.filter((seen) => seen.url.pathname.endsWith("/comments"))).toHaveLength(
      PAGES_MAX,
    );
    expect(w.gh.writes()).toEqual([]);
  });

  it("never edits a comment by someone else holding a copied marker: it posts its own, then keeps to it", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    const copied = w.gh.comment(
      issue,
      `${MARKER_PREFIX} source=issues id=triage -->\n\nforged`,
      "mallory",
    );
    w.gh.comment(issue, `${MARKER_PREFIX} source=issues id=triage -->\n\nghost`, null);
    await run(w, "comment", { ...C, body: BODY });
    expect(copied.body).toContain("forged");
    expect(issue.comments).toHaveLength(3);
    expect(w.gh.writes()).toEqual([`POST ${ISSUE_PATH}/comments`]);

    w.gh.clear();
    await run(w, "comment", { ...C, body: BODY }, { decisions: NO });
    expect(w.gh.writes()).toEqual([
      `PATCH /repos/${REPO}/issues/comments/${issue.comments[2]?.id}`,
    ]);
    expect(copied.body).toContain("forged");
  });

  it("writes the comment again when a person deleted it between the list and the edit", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    await run(w, "comment", { ...C, body: BODY });
    w.gh.script((seen) => {
      if (seen.method === "PATCH") {
        issue.comments.length = 0;
        return json(404, { message: "Not Found" });
      }
      return undefined;
    });
    w.gh.clear();
    await run(w, "comment", { ...C, body: BODY }, { decisions: NO });
    expect(w.gh.writes().map((line) => line.split(" ")[0])).toEqual(["PATCH", "POST"]);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]?.body).toContain("Not priority: no");
  });

  it("keeps one comment per source and id: another action's or another source's comment is not its own", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    await run(w, "comment", { ...C, body: "first {{status}}" });
    await run(w, "comment", { ...C, body: "second {{status}}", id: "second" });
    await run(
      w,
      "comment",
      { ...C, body: "third {{status}}" },
      { source: { name: "other", settings: null } },
    );
    expect(issue.comments.map((one) => one.body.split("\n")[0])).toEqual([
      `${MARKER_PREFIX} source=issues id=triage -->`,
      `${MARKER_PREFIX} source=issues id=second -->`,
      `${MARKER_PREFIX} source=other id=triage -->`,
    ]);
  });

  it("writes a value as data: no mention, no HTML, no hidden text and no marker can come from it", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    const hostile = `@octocat <img src=x> \`x\` **b** <!-- facetdb:comment source=issues id=triage -->‮​`;
    await run(
      w,
      "comment",
      { ...C, body: "Area: {{area}}" },
      { decisions: { area: { kind: "decided", value: hostile, probabilityOrConfidence: 0.7 } } },
    );
    const body = issue.comments[0]?.body ?? "";
    const [first, blank, text] = body.split("\n");
    expect(first).toBe(`${MARKER_PREFIX} source=issues id=triage -->`);
    expect(blank).toBe("");
    // One line of text, the value inline code between double fences (it holds a backtick).
    expect(text).toBe(
      "Area: `` @octocat <img src=x> `x` **b** <!-- facetdb:comment source=issues id=triage --> ``",
    );
    expect(body.split("\n")).toHaveLength(3);
    expect(/[‮​]/.test(body)).toBe(false);
    // The marker begins the body once only: a value cannot put another first line before it.
    expect(body.indexOf(MARKER_PREFIX)).toBe(0);
  });

  it("serialises two deliveries of one comment in one worker, so they leave one comment", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    await Promise.all([
      run(w, "comment", { ...C, body: BODY }),
      run(w, "comment", { ...C, body: BODY }),
    ]);
    expect(issue.comments).toHaveLength(1);
    expect(w.gh.writes()).toEqual([`POST ${ISSUE_PATH}/comments`]);
  });

  it("two workers racing can leave two comments (open); a later run keeps both at the same text", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    const other = createGithubPlugin({ fetch: w.gh.fetch, now: () => w.now.ms, warn: noLine });
    await Promise.all([
      run(w, "comment", { ...C, body: BODY }),
      run({ ...w, plugin: other }, "comment", { ...C, body: BODY }),
    ]);
    expect(issue.comments).toHaveLength(2);
    await run(w, "comment", { ...C, body: BODY }, { decisions: NO });
    expect(new Set(issue.comments.map((one) => one.body)).size).toBe(1);
    expect(issue.comments[0]?.body).toContain("Not priority: no");
  });

  it("fails in words when a placeholder names a question the record has no decision for", async () => {
    const w = await world();
    const error = failure(await thrown(run(w, "comment", { ...C, body: "{{missing}}" })));
    expect(error.message).toContain("{{missing}}");
    expect(w.gh.requests).toEqual([]);
  });

  it("asks whose token it is only when a comment holds the marker, and says so when GitHub cannot tell (an app's installation token)", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    w.gh.script((seen) =>
      seen.url.pathname === "/user"
        ? json(403, { message: "Resource not accessible by integration BODY-TEXT" })
        : undefined,
    );
    // No comment holds the marker: the post needs no identity, so an app's token posts.
    await run(w, "comment", { ...C, body: BODY });
    expect(w.gh.log().includes("GET /user")).toBe(false);
    expect(issue.comments).toHaveLength(1);

    w.gh.clear();
    const error = failure(await thrown(run(w, "comment", { ...C, body: BODY }, { decisions: NO })));
    expect(error.status).toBe(403);
    expect(error.fix).toContain("a token GitHub ties to an account");
    expect(w.gh.writes()).toEqual([]);
  });

  it("leaves a stored body alone when it differs only in line endings or trailing whitespace", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    await run(w, "comment", { ...C, body: "line one\nline two {{status}}" });
    const stored = issue.comments[0];
    if (stored === undefined) {
      throw new Error("the first run posted a comment");
    }
    stored.body = `${stored.body.replaceAll("\n", "  \r\n")} \t\r\n`;
    w.gh.clear();
    await run(w, "comment", { ...C, body: "line one\nline two {{status}}" });
    expect(w.gh.writes()).toEqual([]);

    // A real change is still written.
    await run(
      w,
      "comment",
      { ...C, body: "line one\nline two {{status}}" },
      { status: "needs_review" },
    );
    expect(w.gh.writes()).toEqual([`PATCH /repos/${REPO}/issues/comments/${stored.id}`]);
  });
});

describe("the issue and the repository", () => {
  it("does nothing, with no error, when the issue is gone (404 or 410) and the repository answers", async () => {
    for (const status of [404, 410]) {
      const w = await world();
      w.gh.script((seen) =>
        seen.url.pathname === ISSUE_PATH ? json(status, { message: "BODY-TEXT" }) : undefined,
      );
      for (const name of ["label", "assign"] as const) {
        await run(w, name, { repo: REPO, add: ["x"] });
      }
      await run(w, "comment", { ...C, body: "{{status}}" });
      expect(w.gh.writes()).toEqual([]);
      expect(w.gh.log().filter((line) => line === `GET /repos/${REPO}`)).toHaveLength(3);
    }
  });

  /** A 301 to another host, as GitHub answers for a moved issue or a renamed repository. */
  const moved = () =>
    new Response(null, {
      status: 301,
      headers: { location: "https://elsewhere.example.com/repositories/9/issues/3" },
    });
  /** What a browser-like `fetch` gives for a redirect under `manual`: status 0, no headers. */
  const opaque = () =>
    ({
      type: "opaqueredirect",
      status: 0,
      headers: new Headers(),
      body: null,
    }) as unknown as Response;

  /** Every request went to the configured API alone, never to a redirect's Location. */
  function onlyTheApi(gh: FakeGithub): void {
    expect(gh.requests.map((seen) => seen.url.origin).filter((origin) => origin !== API)).toEqual(
      [],
    );
    stayedOnTheIssue(gh);
  }

  it("reads a redirect on the issue, with the repository answering as itself, as a transferred issue: done, nothing written", async () => {
    for (const answer of [moved, opaque]) {
      const w = await world();
      w.gh.script((seen) => (seen.url.pathname === ISSUE_PATH ? answer() : undefined));
      await run(w, "label", { repo: REPO, add: ["x"] });
      await run(w, "assign", { repo: REPO, add: ["octocat"] });
      await run(w, "comment", { ...C, body: "{{status}}" });
      expect(w.gh.log()).toEqual([
        `GET ${ISSUE_PATH}`,
        `GET /repos/${REPO}`,
        `GET ${ISSUE_PATH}`,
        `GET /repos/${REPO}`,
        `GET ${ISSUE_PATH}`,
        `GET /repos/${REPO}`,
      ]);
      expect(w.gh.writes()).toEqual([]);
      // The issue's read sees the redirect (`manual`); the repository's refuses one (`error`).
      expect(w.gh.requests.map((seen) => seen.redirect)).toEqual([
        "manual",
        "error",
        "manual",
        "error",
        "manual",
        "error",
      ]);
      onlyTheApi(w.gh);
    }
  });

  it("fails, naming a rename or a wrong apiUrl, when the repository redirects too, whatever form either redirect takes", async () => {
    for (const [onIssue, onRepo] of [
      [moved, moved],
      [opaque, moved],
      [opaque, opaque],
      [moved, opaque],
    ] as const) {
      const w = await world();
      w.gh.script((seen) => {
        if (seen.url.pathname === ISSUE_PATH) {
          return onIssue();
        }
        return seen.url.pathname === `/repos/${REPO}` ? onRepo() : undefined;
      });
      for (const [name, settings] of [
        ["label", { repo: REPO, add: ["x"] }],
        ["assign", { repo: REPO, add: ["octocat"] }],
        ["comment", { ...C, body: "{{status}}" }],
      ] as const) {
        const error = failure(await thrown(run(w, name, settings)));
        expect(error.message).toContain(
          `reading the repository ${REPO} was answered with a redirect`,
        );
        expect(error.fix).toContain("renamed or moved");
        expect(error.fix).toContain("/api/v3");
        expect(error.fix).toContain("Action gave up");
      }
      expect(w.gh.writes()).toEqual([]);
      onlyTheApi(w.gh);
    }
  });

  it("fails with the same words when the repository's read never comes back (the real fetch throws on a refused redirect)", async () => {
    const w = await world();
    w.gh.script((seen) => {
      if (seen.url.pathname === ISSUE_PATH) {
        return moved();
      }
      if (seen.url.pathname === `/repos/${REPO}`) {
        throw new TypeError(
          `fetch failed: unexpected redirect to https://elsewhere.example.com ${TOKEN}`,
        );
      }
      return undefined;
    });
    const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
    expect(error.fix).toContain("renamed or moved");
    expect(error.status).toBeUndefined();
  });

  it("fails when what answers for the repository is not a repository (a web page on a GitHub Enterprise Server host)", async () => {
    const w = await world();
    w.gh.script((seen) => {
      if (seen.url.pathname === ISSUE_PATH) {
        return moved();
      }
      return seen.url.pathname === `/repos/${REPO}`
        ? new Response("<html>BODY-TEXT sign in</html>", { status: 200 })
        : undefined;
    });
    const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
    expect(error.message).toContain("is not a repository FacetDB can read");
    expect(error.fix).toContain("/api/v3");
    expect(w.gh.writes()).toEqual([]);
  });

  it("names a refusal of the repository's read (401, 403, 429, 5xx) as any request's, after a redirect or a 404 on the issue", async () => {
    for (const onIssue of [moved, () => json(404, { message: "Not Found" })]) {
      for (const [status, part] of [
        [401, "expired or revoked"],
        [403, "Issues read and write"],
        [502, "the trouble is GitHub's"],
      ] as const) {
        const w = await world();
        w.gh.script((seen) => {
          if (seen.url.pathname === ISSUE_PATH) {
            return onIssue();
          }
          return seen.url.pathname === `/repos/${REPO}`
            ? json(status, { message: "BODY-TEXT" })
            : undefined;
        });
        const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
        expect([error.status, error.fix.includes(part)]).toEqual([status, true]);
      }
    }
  });

  it("fails on a redirect to any other request, which never asks to see one", async () => {
    const w = await world();
    w.gh.script((seen) =>
      seen.method === "POST"
        ? new Response(null, { status: 301, headers: { location: `${API}/elsewhere` } })
        : undefined,
    );
    const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
    expect(error.message).toContain("with a redirect, which is never followed");
    expect(w.gh.requests.find((seen) => seen.method === "POST")?.redirect).toBe("error");
  });

  it("fails when the repository is not found either, or takes no issues, rather than pass as a deleted issue", async () => {
    const w = await world();
    let error = failure(
      await thrown(run(w, "label", { repo: "your-org/other-repo", add: ["x"] }, { key: "7" })),
    );
    expect(error.status).toBe(404);
    expect(error.fix).toContain("token can see it");

    w.gh.repo(REPO, { hasIssues: false });
    error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
    expect(error.message).toContain("issues are turned off");
    expect(w.gh.writes()).toEqual([]);
  });

  it("refuses, before any request, an action naming another repository than its GitHub source's", async () => {
    const w = await world();
    w.gh.issue("your-org/elsewhere", 7);
    const fromGithub = { name: "issues", settings: { repo: REPO } };
    for (const [name, settings] of [
      ["label", { repo: "your-org/elsewhere", add: ["x"] }],
      ["assign", { repo: "your-org/elsewhere", add: ["octocat"] }],
      ["comment", { ...C, repo: "your-org/elsewhere", body: "{{status}}" }],
    ] as const) {
      const error = failure(await thrown(run(w, name, settings, { source: fromGithub })));
      expect(error.message).toContain("names the repository your-org/elsewhere");
      expect(error.message).toContain(`the source reads ${REPO}`);
      expect(error.fix).toContain(`repo: "${REPO}"`);
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("runs an action naming its GitHub source's own repository, however its case is written", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7);
    const fromGithub = { name: "issues", settings: { repo: REPO } };
    await run(w, "label", { repo: "Your-Org/Your-Repo", add: ["x"] }, { source: fromGithub });
    expect(w.gh.log()).toEqual([`GET ${ISSUE_PATH}`, `POST ${ISSUE_PATH}/labels`]);
    expect(issue.labels).toEqual(["x"]);
  });

  it("reads the repository from a GitHub source of this plugin when the action names none", () => {
    // The schemas require `repo` today, so `run` never gets here without one: the path 148 opens
    // is proven on `issueOf`, which every action calls before any request.
    const fromGithub = { name: "issues", settings: { repo: REPO } };
    expect(issueOf("label", fromGithub, undefined, "7").label).toBe(`${REPO}#7`);
    for (const repo of ["your-org/../x", "a", 7, undefined]) {
      const error = failure(() =>
        issueOf("label", { name: "issues", settings: { repo } }, undefined, "7"),
      );
      expect(error.fix).toContain("set the source's repo");
    }
    const error = failure(() => issueOf("label", { name: "api", settings: null }, undefined, "7"));
    expect(error.message).toContain("not a GitHub source");
    expect(error.fix).toContain('repo: "your-org/your-repo"');
  });

  it("refuses a record key that is not an issue number before any request", async () => {
    const w = await world();
    for (const key of [
      "0",
      "-1",
      "07",
      "1e3",
      "7/../8",
      "7?x=1",
      "7#x",
      " 7",
      "7%2F8",
      "2147483648",
      "",
    ]) {
      const error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] }, { key })));
      expect(error.message).toContain("not an issue number");
    }
    expect(w.gh.requests).toEqual([]);
  });

  it("never closes, locks or deletes: every request across the actions is a read or a reversible change", async () => {
    const w = await world();
    w.gh.repo(REPO, { collaborators: new Set(["octocat"]) });
    w.gh.issue(REPO, 7, { labels: ["old"], assignees: [] });
    await run(w, "label", { repo: REPO, add: ["new"], remove: ["old"] });
    await run(w, "assign", { repo: REPO, add: ["octocat"] });
    await run(w, "assign", { repo: REPO, remove: ["octocat"] });
    await run(w, "comment", { ...C, body: "{{status}}" });
    await run(w, "comment", { ...C, body: "{{status}}" }, { status: "needs_review" });
    const kinds = new Set(
      w.gh.requests.map(
        (seen) =>
          `${seen.method} ${seen.url.pathname
            .replace(ISSUE_PATH, "<issue>")
            .replace(/\d{4,}$/, "<id>")
            .replace(/labels\/.+$/, "labels/<name>")}`,
      ),
    );
    expect([...kinds].sort()).toEqual(
      [
        "DELETE <issue>/labels/<name>",
        "DELETE <issue>/assignees",
        "GET /user",
        "GET <issue>",
        "GET <issue>/comments",
        "PATCH /repos/your-org/your-repo/issues/comments/<id>",
        "POST <issue>/assignees",
        "POST <issue>/comments",
        "POST <issue>/labels",
      ].sort(),
    );
    stayedOnTheIssue(w.gh);
  });
});

describe("GitHub's refusals", () => {
  const SETTINGS = { repo: REPO, add: ["x"] };

  /** The failure of a label run whose issue read GitHub answers with `response`. */
  async function refusedWith(response: () => Response, w?: World): Promise<GithubActionError> {
    const used = w ?? (await world());
    used.gh.script((seen) => (seen.url.pathname === ISSUE_PATH ? response() : undefined));
    return failure(await thrown(run(used, "label", SETTINGS)));
  }

  it("names a 401 and a 403 with their fix, never GitHub's words", async () => {
    let error = await refusedWith(() =>
      json(401, { message: `Bad credentials BODY-TEXT ${TOKEN}` }),
    );
    expect([error.status, error.retryAfterMs]).toEqual([401, undefined]);
    expect(error.fix).toContain("expired or revoked");
    error = await refusedWith(() => json(403, { message: "Must have admin rights BODY-TEXT" }));
    expect([error.status, error.retryAfterMs]).toEqual([403, undefined]);
    expect(error.fix).toContain("Issues read and write");
  });

  it("throws a rate limit with its wait, read from retry-after or the reset time, held to an hour", async () => {
    let error = await refusedWith(() =>
      json(429, { message: "BODY-TEXT" }, { "retry-after": "30" }),
    );
    expect([error.status, error.retryAfterMs]).toEqual([429, 30_000]);

    const w = await world();
    const reset = String(Math.floor(w.now.ms / 1000) + 90);
    error = await refusedWith(
      () =>
        json(
          403,
          { message: "API rate limit exceeded BODY-TEXT" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": reset,
          },
        ),
      w,
    );
    expect([error.status, error.retryAfterMs]).toEqual([403, 90_000]);
    expect(error.message).toContain("rate limit");

    error = await refusedWith(() =>
      json(
        403,
        { message: "You have exceeded a secondary rate limit BODY-TEXT" },
        {
          "retry-after": "999999",
        },
      ),
    );
    expect([error.status, error.retryAfterMs]).toEqual([403, RETRY_AFTER_MAX_MS]);

    error = await refusedWith(() =>
      json(403, { message: "You have exceeded a secondary rate limit" }),
    );
    expect([error.status, error.retryAfterMs]).toEqual([403, undefined]);
    expect(error.message).toContain("rate limit");
  });

  it("says which refusals are for good, as the action host reads them for the outbox", async () => {
    const kept = (error: GithubActionError) =>
      firstPartyFailure("@facetdb/github", error, [TOKEN], ACTION_WORDS_MAX);

    // A refused token: for good, the words kept whole, the fix among them.
    let error = await refusedWith(() => json(401, { message: `Bad credentials ${TOKEN}` }));
    expect(error.temporary).toBeUndefined();
    expect(kept(error)).toEqual({ words: error.message, permanent: true });
    expect(error.message).toContain(error.fix);
    // A missing repository: GitHub's 404 for it, for good.
    const missing = failure(
      await thrown(run(await world(), "label", { repo: "your-org/other-repo", add: ["x"] })),
    );
    expect([missing.status, kept(missing)?.permanent]).toEqual([404, true]);

    // A rate limit is never for good, 403 or not, with or without a wait.
    error = await refusedWith(() =>
      json(403, { message: "You have exceeded a secondary rate limit" }),
    );
    expect(error.temporary).toBe(true);
    expect(kept(error)).toMatchObject({ permanent: false });
    // GitHub Enterprise Server's older secondary limit: a 403 naming its abuse detection, no wait.
    error = await refusedWith(() =>
      json(403, {
        message:
          "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.",
      }),
    );
    expect([error.status, error.retryAfterMs, error.temporary]).toEqual([403, undefined, true]);
    expect(error.message).toContain("rate limit");
    expect(kept(error)).toMatchObject({ permanent: false });
    error = await refusedWith(() => json(429, { message: "BODY-TEXT" }, { "retry-after": "30" }));
    expect(kept(error)).toMatchObject({ retryAfterMs: 30_000, permanent: false });
    // GitHub's own trouble is tried again on the backoff.
    error = await refusedWith(() => new Response("<html>BODY-TEXT</html>", { status: 502 }));
    expect(kept(error)).toMatchObject({ permanent: false });

    // Issues turned off, and a key that is no issue number: for good, the fix promising no retry.
    const w = await world();
    w.gh.repo(REPO, { hasIssues: false });
    error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] })));
    expect([error.temporary, kept(error)?.permanent]).toEqual([false, true]);
    expect(error.fix).not.toContain("tried again");
    error = failure(await thrown(run(w, "label", { repo: REPO, add: ["x"] }, { key: "07" })));
    expect([error.status, error.temporary, kept(error)?.permanent]).toEqual([
      undefined,
      false,
      true,
    ]);
  });

  it("throws a 5xx so the outbox tries again, and names a 422 for what it is", async () => {
    let error = await refusedWith(() => new Response("<html>BODY-TEXT</html>", { status: 502 }));
    expect(error.status).toBe(502);
    expect(error.fix).toContain("tried again");

    const w = await world();
    w.gh.script((seen) =>
      seen.method === "POST" && seen.url.pathname.endsWith("/comments")
        ? json(422, { message: "Body is too long BODY-TEXT" })
        : undefined,
    );
    error = failure(await thrown(run(w, "comment", { ...C, body: "{{status}}" })));
    expect([error.status, error.fix]).toEqual([422, "check the comment's body"]);
  });

  it("drops whatever fetch threw, even when it quotes the token", async () => {
    const w = await world();
    w.gh.script(() => {
      throw Object.assign(new TypeError(`fetch failed: ${TOKEN}`), {
        cause: new Error(`connect to ${API} with Bearer ${TOKEN}`),
      });
    });
    const error = failure(await thrown(run(w, "label", SETTINGS)));
    expect(error.message).toContain("could not be reached");
    expect(error.status).toBeUndefined();
  });

  it("stops a request after 10 seconds with no timer left behind @timing", async () => {
    vi.useFakeTimers();
    const w = await world();
    w.gh.script(() => new Promise<Response>(() => undefined));
    const pending = thrown(run(w, "label", SETTINGS));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const error = failure(await pending);
    expect(error.message).toContain(`within ${TIMEOUT_MS / 1000} seconds`);
    expect(vi.getTimerCount()).toBe(0);
    expect(w.gh.requests[0]?.signal.aborted).toBe(true);
  });

  it("stops at once when the worker's signal fires, and clears its timer @timing", async () => {
    vi.useFakeTimers();
    const w = await world();
    w.gh.script(() => new Promise<Response>(() => undefined));
    const stop = new AbortController();
    const pending = thrown(run(w, "label", SETTINGS, { signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(1);
    stop.abort();
    const error = failure(await pending);
    expect(error.message).toContain("was stopped before GitHub answered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the token to the API alone, in the authorization header, and follows no redirect", async () => {
    const w = await world();
    await run(w, "label", SETTINGS);
    for (const seen of w.gh.requests) {
      expect(seen.url.origin).toBe(API);
      expect(seen.headers["authorization"] === `Bearer ${TOKEN}`).toBe(true);
      expect(seen.url.href.includes(TOKEN)).toBe(false);
    }
    // The read of the issue sees a redirect without following it; every other request refuses one.
    expect(w.gh.requests.map((seen) => seen.redirect)).toEqual(["manual", "error"]);
  });
});

describe("when the config loads", () => {
  /** The refusal `checkActions` throws for these actions and plugin settings, or undefined. */
  async function loaded(
    actions: readonly ActionCall[],
    settings?: PluginSettings,
    token = TOKEN,
  ): Promise<PluginHostError | undefined> {
    const config = project(actions, settings);
    const plugin = createGithubPlugin({
      fetch: fakeGithub({ token, login: LOGIN }).fetch,
      now: Date.now,
      warn: noLine,
    });
    try {
      const host = await hostFor(plugin, config, token);
      checkActions(config, host, { [VARIABLE]: token });
    } catch (error) {
      if (error instanceof PluginHostError) {
        expect(leaks(error, token)).toEqual([]);
        return error;
      }
      throw error;
    }
    return undefined;
  }

  const BODY_OK = "{{status}}: {{not_priority}} at {{ not_priority.probability }}, area {{area}}";

  it("takes the three actions as the config writes them, each naming its repository", async () => {
    expect(
      await loaded([
        github.label({
          repo: REPO,
          when: { not_priority: true },
          add: ["Not Priority"],
          else: { remove: ["Not Priority"] },
        }),
        github.label({ repo: REPO, when: { status: "needs_review" }, add: ["needs-triage"] }),
        github.comment({ ...C, body: BODY_OK, when: { status: "needs_review" } }),
        github.comment({ ...C, id: "second-note", body: "{{status}}" }),
        github.assign({ repo: REPO, add: ["octocat"], when: { area: "billing" } }),
      ]),
    ).toBeUndefined();
    expect(
      await loaded([], { token: env(VARIABLE), apiUrl: "https://github.example.com/api/v3" }),
    ).toBeUndefined();
    expect(
      await loaded([], { token: env(VARIABLE), apiUrl: "http://localhost:8080" }),
    ).toBeUndefined();
  });

  it("refuses, on a source that is not a GitHub source, an action naming no repository, and says where to write it", async () => {
    for (const [helper, call] of [
      ["label", github.label({ add: ["x"] } as never)],
      ["assign", github.assign({ add: ["octocat"] } as never)],
      ["comment", github.comment({ id: "triage", body: "{{status}}" } as never)],
      [
        "label",
        github.label({
          when: { not_priority: true },
          add: ["x"],
          else: { remove: ["x"] },
        } as never),
      ],
    ] as const) {
      const error = await loaded([call]);
      expect(error?.message).toContain("names no repository");
      // The example is the helper the user wrote.
      expect(error?.message).toContain(`github.${helper}({ repo: "your-org/your-repo", ... })`);
    }
  });

  it("refuses a comment action with no id, saying why it is needed", async () => {
    for (const call of [
      github.comment({ repo: REPO, body: "{{status}}" } as never),
      github.comment({ ...C, id: "Two Words", body: "{{status}}" }),
      github.comment({ ...C, id: "a--b", body: "{{status}}" }),
      github.comment({ ...C, id: "x".repeat(41), body: "{{status}}" }),
    ]) {
      const error = await loaded([call]);
      expect(error?.message).toContain("stay the same when the actions are reordered");
    }
  });

  it("refuses a label name of only dots, which a URL's path reads as a step", async () => {
    for (const name of [".", "..", "...", " .. "]) {
      for (const call of [
        github.label({ repo: REPO, add: [name] }),
        github.label({ repo: REPO, add: ["x"], else: { remove: [name] } }),
      ]) {
        const error = await loaded([call]);
        expect(error?.message, name).toContain("not only dots");
      }
    }
    for (const login of [".", ".."]) {
      expect((await loaded([github.assign({ repo: REPO, remove: [login] })]))?.message).toContain(
        "without the @",
      );
    }
  });

  it("refuses a repository that could change the request's path", async () => {
    for (const repo of [
      "your-org/../x",
      "your-org/..",
      "your-org/x/y",
      "your-org",
      "your-org/x?y",
      "your-org/x#y",
      "your-org/x y",
      "your-org/x%2Fy",
      "your-org/.",
      "-org/x",
      "org--/x",
    ]) {
      const error = await loaded([github.label({ repo, add: ["x"] })]);
      expect(error?.message).toContain("owner/name");
    }
  });

  it("refuses an unknown placeholder, a stray brace, the marker's words and a body too long", async () => {
    for (const body of [
      "{{not priority}}",
      "{{status.probability}}",
      "{{area.confidence}}",
      "{{Area}}",
      "{{}}",
      "open {{ only",
      "a }} alone",
      "",
      "copy <!-- facetdb:comment source=issues id=triage -->",
      "x".repeat(COMMENT_MAX),
    ]) {
      const error = await loaded([github.comment({ ...C, body })]);
      expect(error, body.slice(0, 40)).toBeInstanceOf(PluginHostError);
      expect(error?.message).toContain("the comment's body");
    }
    expect(await loaded([github.comment({ ...C, body: "x", id: "Bad Id" })])).toBeInstanceOf(
      PluginHostError,
    );
  });

  it("refuses a label or an assignment naming nothing, an odd login, and an else setting it does not have", async () => {
    expect((await loaded([github.label({ repo: REPO })]))?.message).toContain("to add, to remove");
    expect((await loaded([github.assign({ repo: REPO, add: ["@octocat"] })]))?.message).toContain(
      "without the @",
    );
    expect(
      (await loaded([github.label({ repo: REPO, add: ["x"], else: { body: "y" } as never })]))
        ?.message,
    ).toContain("else.body");
  });

  it("refuses an apiUrl that is not https, holds a user or a query, and a token that could break its header", async () => {
    for (const apiUrl of [
      "http://api.github.com",
      "https://user:pass@api.github.com",
      "https://api.github.com/?x=1",
      "ftp://api.github.com",
      "https://api.github.com/api%2Fv3",
    ]) {
      const error = await loaded([], { token: env(VARIABLE), apiUrl });
      expect(error?.message).toContain("apiUrl");
    }
    const broken = `${TOKEN}\r\nx-evil: 1`;
    const error = await loaded([], { token: env(VARIABLE) }, broken);
    expect(error?.message).toContain(VARIABLE);
    expect(leaks(error, broken)).toEqual([]);
  });

  it("declares the token and the webhook's secret as the plugin's secrets, and the three actions", () => {
    const plugin = createGithubPlugin({
      fetch: fakeGithub({ token: TOKEN, login: LOGIN }).fetch,
      now: Date.now,
      warn: noLine,
    });
    expect(plugin.manifest.secrets).toEqual(["token", "webhookSecret"]);
    expect(Object.keys(plugin.actions).sort()).toEqual(["assign", "comment", "label"]);
    expect(github.comment({ ...C, body: "x", when: { status: "done" } })).toEqual({
      plugin: "@facetdb/github",
      action: "comment",
      config: { repo: REPO, id: "triage", body: "x", when: { status: "done" } },
    });
  });
});
