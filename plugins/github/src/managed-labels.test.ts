import { createHmac } from "node:crypto";
import { type ActionCall, env, facetdb, noul, type ProjectConfig, VERSION } from "facetdb";
import {
  type ActionContext,
  type ActionDefinition,
  actionSteps,
  type BackfillStore,
  createPluginBackfillConnector,
  createPluginHost,
  createPluginSourceConnector,
  type HostedSource,
  hostedSource,
  type Plugin,
  type PluginHost,
  type PluginSourceConnector,
  type PluginSourceDeps,
  type QueuedAction,
  type SourceContext,
  type SourceDefinition,
} from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import { type FakeGithub, type FakeIssue, fakeGithub } from "./fake-github.ts";
import {
  ACCEPTED,
  createGithubPlugin,
  type GithubConfig,
  github,
  type IssuesSettings,
  issuesSettings,
  OTHER_REPOSITORY,
  type Receipt,
} from "./index.ts";
import { managedLabels } from "./managed-labels.ts";

/**
 * A label FacetDB's own actions manage never asks the model again, on the worked example (triaging
 * GitHub issues) over a handwritten GitHub answering through the plugin's `fetch`: nothing reaches
 * the network. The source runs as the worker runs it: its settings and its actions from the plugin
 * host, its reads, scans and webhooks through the SDK's adapters, where the state hash is core's.
 * The actions run as the worker queues them (`actionSteps`, `when` and `else` resolved) and as the
 * outbox runs them (the plugin's own `run`, the settings through the action's schema).
 */

const TOKEN = "ghp_M4n4g3dL4b3lsT0k3nF0rT3st1ngOnly0003";
const SECRET = "whsec_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
/** The token is a maintainer's own personal access token: GitHub names the maintainer as its sender. */
const MAINTAINER = "maintainer";
const REPO = "your-org/your-repo";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const ENV = { GITHUB_TOKEN: TOKEN, GITHUB_WEBHOOK_SECRET: SECRET };
const FIELDS = ["title", "body", "labels", "changed_files"];
const REPOSITORY = {
  id: 4242,
  name: "your-repo",
  full_name: REPO,
  owner: { login: "your-org", id: 7 },
};

/**
 * The worked example's actions as the config writes them, each naming its repository as the SDK
 * asks today (index.ts). Its Slack message is another plugin's action, which a GitHub source is
 * never handed (`ctx.source.actions` holds this plugin's alone).
 */
const EXAMPLE: readonly ActionCall[] = [
  github.label({
    repo: REPO,
    when: { not_priority: true },
    add: ["Not Priority"],
    else: { remove: ["Not Priority"] },
  }),
  github.label({
    repo: REPO,
    when: { impacts_only_oss: true },
    add: ["Impacts only OSS"],
    else: { remove: ["Impacts only OSS"] },
  }),
  github.label({ repo: REPO, when: { status: "needs_review" }, add: ["needs-triage"] }),
];

function example(actions: readonly ActionCall[]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") },
    },
    source: github.issues({ repo: REPO, include: ["issues", "pull_requests"] }),
    read: FIELDS,
    questions: {
      not_priority: noul(
        "Would the maintainers treat this as low priority? Low priority means cosmetic issues, " +
          "feature requests with no concrete use case, questions the docs answer, and unsupported setups.",
      ),
      impacts_only_oss: noul(
        "Does this affect only the self-hosted open-source version and not the hosted platform? " +
          "Hosted-only parts: billing, team management, cloud sync.",
      ),
    },
    thresholds: {
      not_priority: { yesAbove: 0.8, noBelow: 0.2 },
      impacts_only_oss: { yesAbove: 0.8, noBelow: 0.2 },
    },
    actions: [...actions],
  });
}

/** The plugin's lines are its poll's, which read, scan, receive and the actions never print. */
function noLine(line: string): never {
  throw new Error(`the plugin printed a line: ${line}`);
}

/** Imports `@facetdb/github` as the given plugin; any other package is not installed. */
function importing(installed: Plugin<GithubConfig>) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/github") {
      return { default: installed };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

/**
 * The store's side of the adapters, in memory: a record's state kept as the pairs core's state hash
 * is taken over (its fields in the config's order), so a state is "changed", and queued, exactly
 * when its hash moves. Every other connector call is unused here.
 */
function memoryStore(): BackfillStore {
  const states = new Map<string, string>();
  const unused = () => Promise.reject(new Error("not used here"));
  return {
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
    insertRecord: unused,
    upsertRecord(key, state) {
      const pairs = JSON.stringify(FIELDS.map((field) => [field, state[field]]));
      const changed = states.get(key) !== pairs;
      states.set(key, pairs);
      return Promise.resolve(changed);
    },
  };
}

type World = {
  readonly gh: FakeGithub;
  readonly plugin: Plugin<GithubConfig>;
  readonly host: PluginHost;
  readonly config: ProjectConfig;
  readonly hosted: HostedSource;
  readonly issues: SourceDefinition<GithubConfig>;
  /** The worker's adapter of the source: what a webhook and the poll's keys go through. */
  readonly adapter: PluginSourceConnector;
  /** What the adapters share: the store, the source as the host checked it, the context. */
  readonly deps: PluginSourceDeps & { readonly store: BackfillStore };
};

/** A fake GitHub with the repository, the plugin over it, its host, and the example's source. */
async function world(actions: readonly ActionCall[] = EXAMPLE): Promise<World> {
  const gh = fakeGithub({ token: TOKEN, login: MAINTAINER });
  gh.repo(REPO);
  // `warn` is where the poll writes its lines; given as a value rather than written in the call, so
  // the plugin's options may name it or not.
  const options = { fetch: gh.fetch, now: () => NOW, warn: noLine };
  const plugin = createGithubPlugin(options);
  const config = example(actions);
  const host = await createPluginHost({
    config,
    env: ENV,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: importing(plugin),
    builtins: {},
  });
  const hosted = hostedSource(host, config, config.sources[0] as never, ENV);
  const issues = plugin.sources["issues"];
  if (issues === undefined) {
    throw new Error("the plugin has no issues source");
  }
  const deps = {
    store: memoryStore(),
    name: "issues",
    hosted,
    context: (signal: AbortSignal) => host.contextFor("@facetdb/github", signal),
    fields: FIELDS,
    clock: { now: () => NOW, sleep: () => Promise.resolve() },
    cursors: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
    cursorRun: "plugin-source:test",
    note: noLine,
  };
  const adapter = createPluginSourceConnector(deps);
  return { gh, plugin, host, config, hosted, issues, adapter, deps };
}

/** The source's context as the SDK's adapter builds it, for read and receive. */
function contextOf(w: World): SourceContext<GithubConfig, IssuesSettings> {
  return {
    ...w.host.contextFor("@facetdb/github", new AbortController().signal),
    source: {
      name: "issues",
      // The host parsed them with this schema already: parsed again only to carry their type.
      settings: issuesSettings.parse(w.hosted.settings),
      actions: w.hosted.actions,
    },
    clock: {
      now: () => NOW,
      sleep: () => Promise.reject(new Error("read and receive never wait")),
    },
    cursor: {
      load: () => Promise.reject(new Error("read and receive use no cursor")),
      save: () => Promise.reject(new Error("read and receive use no cursor")),
    },
  } as SourceContext<GithubConfig, IssuesSettings>;
}

/** The `labels` state field of `key` as the source reads it. */
async function labelsOf(w: World, key: string): Promise<string | null | undefined> {
  const [row] = await w.issues.read(contextOf(w), [key]);
  return row?.state["labels"];
}

/**
 * The hash of `key`'s state as the store keeps it: core's own state hash, which the SDK's backfill
 * adapter computes for each row the source's `scan` returns. Its state is checked to be `read`'s.
 */
async function hashOf(w: World, key: string): Promise<string> {
  const backfill = createPluginBackfillConnector(w.deps);
  try {
    let cursor: string | null = null;
    do {
      const page = await backfill.scan(cursor);
      const row = page.rows.find((one) => one.key === key);
      if (row !== undefined) {
        const [read] = await w.issues.read(contextOf(w), [key]);
        expect(row.state).toEqual(read?.state);
        return row.hash;
      }
      cursor = page.next;
    } while (cursor !== null);
    throw new Error(`the scan found no open issue ${key}`);
  } finally {
    await backfill.close();
  }
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

/** A delivery as GitHub sends one to the worker's route, signed with the source's secret. */
function delivery(event: "issues" | "pull_request", payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request("http://localhost:8787/v1/hooks/github/issues", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-github-event": event,
      "x-hub-signature-256": sign(body),
    },
    body,
  });
}

/** An `issues` event of `number`, sent by `sender`, with `extra` beside the issue (a label, changes). */
function issuesEvent(
  number: number,
  action: string,
  sender: string,
  extra: object = {},
  repository: object = REPOSITORY,
) {
  return {
    action,
    issue: { number, title: "Typo in README", body: "The word recieve.", labels: [] },
    ...extra,
    repository,
    sender: { login: sender },
  };
}

/** GitHub's event for a label added to (`labeled`) or taken off (`unlabeled`) an issue. */
function labelEvent(
  number: number,
  action: "labeled" | "unlabeled",
  name: string,
  sender: string,
  repository: object = REPOSITORY,
) {
  return issuesEvent(
    number,
    action,
    sender,
    { label: { id: 1, name, color: "ededed", default: false } },
    repository,
  );
}

/** The same for a pull request, which GitHub sends as a `pull_request` event. */
function pullLabelEvent(
  number: number,
  action: "labeled" | "unlabeled",
  name: string,
  sender: string,
) {
  return {
    action,
    number,
    pull_request: { number, title: "Fix the loader", body: null },
    label: { id: 1, name, color: "ededed", default: false },
    repository: REPOSITORY,
    sender: { login: sender },
  };
}

/** The keys the source's own `receive` names for a delivery. */
async function keysOf(
  w: World,
  event: "issues" | "pull_request",
  payload: unknown,
): Promise<Receipt> {
  const receive = w.issues.receive;
  if (receive === undefined) {
    throw new Error("the source has no receive");
  }
  return (await receive(contextOf(w), delivery(event, payload))) as Receipt;
}

type Decisions = Parameters<ActionDefinition["run"]>[2];
type Status = Parameters<ActionDefinition["run"]>[1]["status"];

function yesNo(value: boolean, probability: number) {
  return { kind: "decided", value, probabilityOrConfidence: probability } as const;
}

/**
 * The worker's side of one decision of `key`: each action of the example the pipeline queues for it
 * (`when` and `else` resolved), run as the outbox runs it, then the events GitHub sends for what
 * the run changed on the issue (one `labeled` or `unlabeled` a label, sent by the token's own
 * login), delivered to the worker's route. Returns what those deliveries queued; they name no key,
 * so they cost not even a read of the issue.
 */
async function decide(
  w: World,
  issue: FakeIssue,
  key: string,
  status: Status,
  decisions: Decisions,
): Promise<readonly string[]> {
  const [source] = w.config.sources;
  if (source === undefined) {
    throw new Error("the config has a source");
  }
  const rows: QueuedAction[] = [];
  const record = {
    key,
    state: {},
    status,
    stateHash: "the hash the answer was asked at",
    decidedAt: new Date(NOW),
  };
  for (const step of actionSteps(source, async (row) => {
    rows.push(row);
  })) {
    await step.run(record, decisions);
  }
  const before = [...issue.labels];
  for (const row of rows) {
    const entry = w.plugin.actions[row.action];
    if (entry === undefined) {
      throw new Error(`the plugin has no ${row.action} action`);
    }
    const ctx = {
      ...w.host.contextFor("@facetdb/github", new AbortController().signal),
      source: { name: "issues", settings: w.hosted.settings },
    } as ActionContext<never>;
    await entry.run(ctx, record, decisions, entry.config.parse(row.payload.settings));
  }
  const lower = (names: readonly string[]) => new Set(names.map((name) => name.toLowerCase()));
  const [had, has] = [lower(before), lower(issue.labels)];
  const events = [
    ...issue.labels
      .filter((name) => !had.has(name.toLowerCase()))
      .map((name) => labelEvent(Number(key), "labeled", name, MAINTAINER)),
    ...before
      .filter((name) => !has.has(name.toLowerCase()))
      .map((name) => labelEvent(Number(key), "unlabeled", name, MAINTAINER)),
  ];
  const queued: string[] = [];
  w.gh.clear();
  for (const event of events) {
    const outcome = await w.adapter.receive(delivery("issues", event));
    expect(outcome.status).toBe(ACCEPTED);
    queued.push(...outcome.intake.queued);
  }
  expect(w.gh.log()).toEqual([]);
  return queued;
}

describe("managed-labels: the names a source manages", () => {
  it("are every name in add and remove of the example's three label actions, else included", async () => {
    const w = await world();
    expect(w.hosted.actions.map((one) => one.action)).toEqual(["label", "label", "label"]);
    const managed = managedLabels(w.hosted.actions);
    expect(managed.names).toEqual(["Not Priority", "Impacts only OSS", "needs-triage"]);
    for (const name of ["Not Priority", "Impacts only OSS", "needs-triage"]) {
      expect(managed.has(name), name).toBe(true);
    }
    expect(managed.has("bug")).toBe(false);
    expect(managedLabels([]).names).toEqual([]);
  });

  it("match GitHub's names in any case, as GitHub and the label action do, and in no other way", () => {
    const managed = managedLabels([{ action: "label", config: { add: ["Not Priority"] } }]);
    expect(managed.has("not priority")).toBe(true);
    expect(managed.has("NOT PRIORITY")).toBe(true);
    // GitHub's own name is never trimmed or otherwise bent to match.
    expect(managed.has("Not Priority ")).toBe(false);
    expect(managed.has("Not  Priority")).toBe(false);
    expect(managed.has("Not Priority?")).toBe(false);
  });

  it("read each name as the label action's schema does, and only the label action's", () => {
    const managed = managedLabels([
      {
        action: "label",
        config: {
          repo: REPO,
          when: { not_priority: true },
          // Trimmed as the action sends it; a name of only dots or with a line break is refused by
          // the action's schema, so never sent to GitHub: it manages nothing.
          add: ["  Not Priority  ", "..", "two\nlines"],
          else: { add: ["Maybe later"], remove: ["Not Priority", "wontfix"] },
        },
      },
      // Written as variables: the source is handed their names, never their values.
      { action: "label", config: { repo: REPO, add: [{ env: "LABEL" }], remove: { env: "LIST" } } },
      { action: "assign", config: { repo: REPO, add: ["octocat"], remove: ["hubot"] } },
      { action: "comment", config: { repo: REPO, id: "triage", body: "Not Priority" } },
      { action: "label", config: { repo: REPO, add: ["NOT PRIORITY"], else: "not an object" } },
    ]);
    expect(managed.names).toEqual(["Not Priority", "Maybe later", "wontfix"]);
    for (const name of ["octocat", "hubot", "..", "LABEL", "triage"]) {
      expect(managed.has(name), name).toBe(false);
    }
  });
});

describe("managed-labels: the state", () => {
  it("does not move when FacetDB labels an issue with one: the same state, the same hash, nothing queued", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7, {
      title: "Typo in README",
      body: "The word recieve.",
      labels: ["docs"],
    });
    expect((await w.adapter.intake(["7"])).queued).toEqual(["7"]);
    const hash = await hashOf(w, "7");

    // The worker's decision: not priority. The first action adds its label to the issue.
    const yes = { not_priority: yesNo(true, 0.93), impacts_only_oss: yesNo(false, 0.08) };
    expect(await decide(w, issue, "7", "done", yes)).toEqual([]);
    expect(issue.labels).toEqual(["docs", "Not Priority"]);
    expect(await labelsOf(w, "7")).toBe("docs");
    expect(await hashOf(w, "7")).toBe(hash);
    expect(await w.adapter.intake(["7"])).toMatchObject({ queued: [], unchanged: ["7"] });

    // Every managed label at once, one of them as the repository spells it: still no move.
    issue.labels.push("needs-triage", "impacts only oss");
    expect(await labelsOf(w, "7")).toBe("docs");
    expect(await hashOf(w, "7")).toBe(hash);
    expect(await w.adapter.intake(["7"])).toMatchObject({ queued: [], unchanged: ["7"] });
  });

  it("moves for a person's label that no action manages: `bug` changes the state and the hash, and asks again", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7, { labels: ["docs", "Not Priority"] });
    await w.adapter.intake(["7"]);
    const hash = await hashOf(w, "7");

    issue.labels.push("bug");
    expect(await keysOf(w, "issues", labelEvent(7, "labeled", "bug", "someone"))).toEqual({
      status: ACCEPTED,
      keys: ["7"],
    });
    expect(await labelsOf(w, "7")).toBe("bug\ndocs");
    expect(await hashOf(w, "7")).not.toBe(hash);
    const outcome = await w.adapter.receive(
      delivery("issues", labelEvent(7, "labeled", "bug", "someone")),
    );
    expect(outcome.intake.queued).toEqual(["7"]);
  });

  it("holds the same labels on a source whose actions manage none: there they are state, as before", async () => {
    const w = await world([]);
    const issue = w.gh.issue(REPO, 7, { labels: ["docs"] });
    await w.adapter.intake(["7"]);
    issue.labels.push("Not Priority");
    expect(await labelsOf(w, "7")).toBe("docs\nNot Priority");
    expect(await keysOf(w, "issues", labelEvent(7, "labeled", "Not Priority", "someone"))).toEqual({
      status: ACCEPTED,
      keys: ["7"],
    });
    expect((await w.adapter.intake(["7"])).queued).toEqual(["7"]);
  });

  it("builds the same state in scan as in read, for an issue and a pull request", async () => {
    const w = await world();
    w.gh.issue(REPO, 7, { labels: ["Not Priority", "docs"] });
    w.gh.issue(REPO, 8, { labels: ["needs-triage", "refactor"], files: ["src/loader.ts"] });
    // hashOf checks the scanned state against read's.
    await hashOf(w, "7");
    await hashOf(w, "8");
    expect(await labelsOf(w, "8")).toBe("refactor");
  });
});

describe("managed-labels: the webhook", () => {
  it("names no key for the label event of a managed label, added or removed, on an issue or a pull request, whoever sent it", async () => {
    const w = await world();
    const none = { status: ACCEPTED, keys: [] };
    for (const sender of [MAINTAINER, "someone"]) {
      for (const name of ["Not Priority", "Impacts only OSS", "needs-triage", "not priority"]) {
        for (const action of ["labeled", "unlabeled"] as const) {
          const what = `${sender} ${action} ${name}`;
          expect(await keysOf(w, "issues", labelEvent(7, action, name, sender)), what).toEqual(
            none,
          );
          expect(
            await keysOf(w, "pull_request", pullLabelEvent(8, action, name, sender)),
            what,
          ).toEqual(none);
        }
      }
    }
  });

  it("names the key for every other event of the issue, whoever sent it: a person's label, and the maintainer's own edits", async () => {
    const w = await world();
    const seven = { status: ACCEPTED, keys: ["7"] };
    for (const sender of [MAINTAINER, "someone"]) {
      expect(await keysOf(w, "issues", labelEvent(7, "labeled", "bug", sender))).toEqual(seven);
      expect(await keysOf(w, "issues", labelEvent(7, "unlabeled", "bug", sender))).toEqual(seven);
      expect(
        await keysOf(w, "issues", issuesEvent(7, "edited", sender, { changes: { title: {} } })),
      ).toEqual(seven);
      expect(await keysOf(w, "issues", issuesEvent(7, "opened", sender))).toEqual(seven);
      expect(await keysOf(w, "pull_request", pullLabelEvent(8, "labeled", "bug", sender))).toEqual({
        status: ACCEPTED,
        keys: ["8"],
      });
    }
    // A label event GitHub sent without its label is handled as before: its key, never a refusal.
    expect(await keysOf(w, "issues", issuesEvent(7, "labeled", "someone"))).toEqual(seven);
  });

  it("still refuses a managed label's event of another repository: the repository is judged first", async () => {
    const w = await world();
    const other = { ...REPOSITORY, id: 99, full_name: "someone/else" };
    expect(
      await keysOf(w, "issues", labelEvent(7, "labeled", "Not Priority", MAINTAINER, other)),
    ).toEqual({ status: 422, keys: [], reason: OTHER_REPOSITORY });
  });

  it("never drops the maintainer's own edit of the title: the token's login is a person", async () => {
    const w = await world();
    const issue = w.gh.issue(REPO, 7, { title: "Typo in README", labels: ["Not Priority"] });
    await w.adapter.intake(["7"]);
    issue.title = "Typo in the README's install section";
    const outcome = await w.adapter.receive(
      delivery(
        "issues",
        issuesEvent(7, "edited", MAINTAINER, { changes: { title: { from: "Typo in README" } } }),
      ),
    );
    expect(outcome).toMatchObject({ status: ACCEPTED, intake: { queued: ["7"] } });
  });
});

describe("managed-labels: the worked example running", () => {
  it("asks the model exactly once for each new issue, whatever its labels become", async () => {
    const w = await world();
    // The outcomes of the example's table: one label, both, none, and one sent to review.
    const cases: readonly {
      readonly title: string;
      readonly status: Status;
      readonly decisions: Decisions;
      readonly labels: readonly string[];
    }[] = [
      {
        title: "Typo in README",
        status: "done",
        decisions: { not_priority: yesNo(true, 0.93), impacts_only_oss: yesNo(false, 0.08) },
        labels: ["Not Priority"],
      },
      {
        title: "Dark mode for the self-hosted UI would be nice",
        status: "done",
        decisions: { not_priority: yesNo(true, 0.88), impacts_only_oss: yesNo(true, 0.86) },
        labels: ["Not Priority", "Impacts only OSS"],
      },
      {
        title: "Billing page shows the wrong currency",
        status: "done",
        decisions: { not_priority: yesNo(false, 0.05), impacts_only_oss: yesNo(false, 0.03) },
        labels: [],
      },
      {
        title: "Login loops after SSO",
        status: "needs_review",
        decisions: { not_priority: yesNo(false, 0.15), impacts_only_oss: { kind: "needs_review" } },
        labels: ["needs-triage"],
      },
    ];
    let number = 10;
    for (const one of cases) {
      number += 1;
      const key = String(number);
      const issue = w.gh.issue(REPO, number, { title: one.title, labels: ["from-template"] });
      // GitHub's `opened`: the record is new, queued once, and the worker asks the model for it.
      let asked = 0;
      const opened = await w.adapter.receive(
        delivery("issues", issuesEvent(number, "opened", "someone")),
      );
      asked += opened.intake.queued.length;
      expect(asked, one.title).toBe(1);
      const hash = await hashOf(w, key);

      // The decision's actions label the issue; GitHub's events for those labels queue nothing.
      asked += (await decide(w, issue, key, one.status, one.decisions)).length;
      expect([...issue.labels].sort(), one.title).toEqual(["from-template", ...one.labels].sort());
      // The poll then finds the issue changed on GitHub and reads it: the same state.
      asked += (await w.adapter.intake([key])).queued.length;
      // The actions run again, as the outbox may (at least once): they change nothing, and nothing
      // is queued.
      asked += (await decide(w, issue, key, one.status, one.decisions)).length;
      expect(await hashOf(w, key), one.title).toBe(hash);
      expect(asked, one.title).toBe(1);
    }
  });
});
