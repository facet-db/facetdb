import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeRepo } from "../fake-github.ts";
import {
  type Changes,
  createChanges,
  githubOnLoopback,
  type Scripted,
  slackOnLoopback,
  systemOneOnLoopback,
} from "./loopback.ts";

/**
 * The GitHub triage example, end to end and offline. `facetdb init --example github-triage` writes
 * the example into a fresh folder under plugins/github/build/ (ignored), where `facetdb` resolves
 * to its sources; `facetdb dev --model-url` runs that file as a user gets it, in a child process,
 * as `pnpm facetdb` would. Its outside world is on loopback ports (loopback.ts): GitHub (the five
 * issues of the example's table), a stand-in System One server (the table's probabilities) and a
 * receiver of Slack's incoming webhooks. The five `issues.opened` events are posted, signed, to
 * `/v1/hooks/github/issues`, and the test then waits on state, never on a sleep: each issue's
 * labels as the example's table says, the SSO issue a card in the review queue and one message in
 * #triage, a decision on that card setting its label and taking needs-triage away, the labels
 * FacetDB set never asking again when GitHub reports them, and exactly one model request per issue,
 * counted where the requests arrive.
 *
 * The example keeps its real shape: GitHub's own API, Slack's own hooks. The project's
 * `@facetdb/github` and `@facetdb/slack` are therefore the real plugins built through their own
 * `fetch` seam (plugins/github.ts, plugins/slack.ts), each carrying a request for its service's one
 * host to the loopback server the CLI's environment names, and refusing any other host. No address
 * or signature check is loosened; nothing reaches the network; no key is needed. The worker is
 * stopped with Ctrl+C's signal (and killed if the test process ends first), every server closed,
 * and nothing is left outside plugins/github/build/.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
const BUILD = join(PLUGIN_DIR, "build");
const require = createRequire(import.meta.url);
/** The facetdb package this plugin depends on, and its CLI as `pnpm facetdb` runs it. */
const FACETDB_SRC = dirname(require.resolve("facetdb"));
const CLI = join(FACETDB_SRC, "cli", "main.ts");
const EXAMPLE = join(FACETDB_SRC, "..", "examples", "github-triage", "facetdb.config.ts");
/** What the project's node_modules hold under each plugin's name: the real plugin on loopback. */
const PLUGINS = {
  github: fileURLToPath(new URL("./plugins/github.ts", import.meta.url)),
  slack: fileURLToPath(new URL("./plugins/slack.ts", import.meta.url)),
} as const;

const REPO = "your-org/your-repo";
const REPOSITORY_ID = 7_171;
const TOKEN = "ghp_triageExampleLoopbackToken0000000000";
const LOGIN = "triage-bot";
const WEBHOOK_SECRET = "triage-example-webhook-secret";
const SLACK_PATH = "/services/T0TRIAGE/B0TRIAGE/loopbackreceiver";
const SLACK_WEBHOOK = `https://hooks.slack.com${SLACK_PATH}`;
const STEPS = "facetdb-github-triage.md";

type Issue = Scripted & {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** The labels the example's table gives it, sorted. */
  readonly labels: readonly string[];
};

/** Triaging GitHub issues, the table of illustrative outcomes. */
const ISSUES: readonly Issue[] = [
  {
    number: 1,
    title: "Typo in README",
    body: "The install section says 'pnpm instal' where it means 'pnpm install'.",
    not_priority: 0.93,
    impacts_only_oss: 0.08,
    labels: ["Not Priority"],
  },
  {
    number: 2,
    title: "Self-hosted install fails on Docker ARM",
    body: "docker compose up on a Raspberry Pi 5 stops with exec format error for the worker image.",
    not_priority: 0.12,
    impacts_only_oss: 0.91,
    labels: ["Impacts only OSS"],
  },
  {
    number: 3,
    title: "Dark mode for the self-hosted UI would be nice",
    body: "Our team runs the self-hosted UI late at night and the white pages are hard on the eyes.",
    not_priority: 0.88,
    impacts_only_oss: 0.86,
    labels: ["Impacts only OSS", "Not Priority"],
  },
  {
    number: 4,
    title: "Billing page shows the wrong currency",
    body: "Our account is billed in euros, but the billing page shows every amount in dollars.",
    not_priority: 0.05,
    impacts_only_oss: 0.03,
    labels: [],
  },
  {
    number: 5,
    title: "Login loops after SSO",
    body: "After signing in through our identity provider the page goes back to the sign-in form.",
    not_priority: 0.15,
    impacts_only_oss: 0.55,
    labels: ["needs-triage"],
  },
];

const SSO = ISSUES[4] as Issue;

/** The SSO issue's labels once a person decided it impacts only the open-source version. */
const DECIDED = ["Impacts only OSS"];

/** The label actions of the example: each reads the issue once, then writes only what differs. */
const LABEL_ACTIONS = 3;

let changes: Changes;
let github: Awaited<ReturnType<typeof githubOnLoopback>>;
let model: Awaited<ReturnType<typeof systemOneOnLoopback>>;
let slack: Awaited<ReturnType<typeof slackOnLoopback>>;
let repo: FakeRepo;
/** The run's own project folder under build/, fresh each run. */
let project = "";
/** What afterAll undoes, each added as it is made: a beforeAll that failed partway undoes its part. */
const undo: (() => Promise<void>)[] = [];
/** For each title, how many requests GitHub had taken when the model was asked about it. */
const askedAt = new Map<string, number>();
let dev: ChildProcess | undefined;
let devExit: Promise<number | null> | undefined;
let output = "";
let worker = "";

/** The worker, killed if this process ends while it runs (a crash, a timeout, Ctrl+C on vitest). */
function killDev(): void {
  if (dev !== undefined && dev.exitCode === null && dev.signalCode === null) {
    dev.kill("SIGKILL");
  }
}

beforeAll(async () => {
  changes = createChanges();
  github = await githubOnLoopback({ token: TOKEN, login: LOGIN }, changes);
  undo.push(() => github.close());
  model = await systemOneOnLoopback(
    new Map(ISSUES.map((issue) => [issue.title, issue])),
    (title) => askedAt.set(title, github.fake.requests.length),
    changes,
  );
  undo.push(() => model.close());
  slack = await slackOnLoopback(changes);
  undo.push(() => slack.close());
  repo = github.fake.repo(REPO);
  for (const issue of ISSUES) {
    // Opened long before the worker starts: its poll lists what changed since it started, so each
    // issue reaches the worker by its webhook alone.
    github.fake.issue(REPO, issue.number, { title: issue.title, body: issue.body });
  }
  await mkdir(BUILD, { recursive: true });
  project = await mkdtemp(join(BUILD, "triage-"));
  undo.push(() => rm(project, { recursive: true, force: true }));
});

afterAll(async () => {
  if (dev !== undefined) {
    killDev();
    await devExit;
    process.off("exit", killDev);
  }
  for (const step of undo.reverse()) {
    await step();
  }
});

/** The CLI's environment: where programs are, the variables the example names, and the loopbacks. */
function cliEnv(): Record<string, string> {
  const kept = ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return {
    ...Object.fromEntries(kept),
    GITHUB_TOKEN: TOKEN,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SLACK_WEBHOOK_TRIAGE: SLACK_WEBHOOK,
    // Read by the project's plugins alone (plugins/github.ts, plugins/slack.ts).
    TRIAGE_E2E_GITHUB: github.origin,
    TRIAGE_E2E_SLACK: slack.origin,
  };
}

/** `pnpm facetdb <args>` in the project: the CLI from source, in its own process. */
function facetdb(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    cwd: project,
    env: cliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

/** An `issues` delivery as GitHub signs and sends it to the source's webhook. */
function delivery(
  issue: Issue,
  event: {
    readonly action: "opened" | "labeled" | "unlabeled";
    readonly labels: readonly string[];
    readonly label?: string;
    readonly sender: string;
  },
): { readonly headers: Record<string, string>; readonly body: string } {
  const body = JSON.stringify({
    action: event.action,
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "open",
      labels: event.labels.map((name) => ({ name, color: "ededed" })),
      user: { login: "a-reporter", type: "User" },
    },
    ...(event.label === undefined ? {} : { label: { name: event.label, color: "ededed" } }),
    repository: { id: REPOSITORY_ID, full_name: REPO, private: false },
    sender: { login: event.sender, type: "User" },
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return {
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  };
}

/** Posts one delivery to the source's webhook: its status and its body. */
async function deliver(
  sent: ReturnType<typeof delivery>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${worker}/v1/hooks/github/issues`, {
    method: "POST",
    headers: sent.headers,
    body: sent.body,
  });
  return { status: response.status, json: await response.json() };
}

/** The issue's labels as the scripted GitHub holds them now, sorted. */
function labelsOf(issue: Issue): readonly string[] {
  return [...(repo.issues.get(issue.number)?.labels ?? [])].sort();
}

/** The labels every issue ends with: the table's, the SSO issue's as the person decided it. */
function finalLabels(issue: Issue): readonly string[] {
  return issue === SSO ? DECIDED : issue.labels;
}

/** The reads of the issue GitHub took from its `from`th request on: one per label action run. */
function readsSince(issue: Issue, from: number): number {
  const path = `/repos/${REPO}/issues/${issue.number}`;
  return github.fake.requests
    .slice(from)
    .filter((seen) => seen.method === "GET" && seen.url.pathname === path).length;
}

/** Whether every label action has run on the issue since the model was asked about it. */
function triaged(issue: Issue): boolean {
  const from = askedAt.get(issue.title);
  return from !== undefined && readsSince(issue, from) >= LABEL_ACTIONS;
}

function seenNow(): string {
  const labels = ISSUES.map((issue) => `#${issue.number} [${labelsOf(issue).join(", ")}]`);
  const asked = model.asked.map((one) => one.title).join(" | ");
  return `labels ${labels.join(" ")}; the model was asked about ${asked === "" ? "nothing" : asked}; ${slack.messages.length} Slack message(s); the worker said: ${output.slice(-3000)}`;
}

/** The worker's API from this machine: no sign-in, as the operator's own terminal. */
async function api(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${worker}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

describe("the GitHub triage example, offline end to end", () => {
  it("facetdb init --example github-triage writes the example as the package ships it", async () => {
    const init = facetdb(["init", "--example", "github-triage"]);
    let said = "";
    const hear = (chunk: Buffer) => {
      said += chunk.toString("utf8");
    };
    init.stdout?.on("data", hear);
    init.stderr?.on("data", hear);
    expect(await exitOf(init), said).toBe(0);
    expect(said).toContain(`Copied the github-triage example: facetdb.config.ts, ${STEPS}.`);
    expect(said).toContain("facetdb add github and facetdb add slack");
    expect(await readFile(join(project, "facetdb.config.ts"), "utf8")).toBe(
      await readFile(EXAMPLE, "utf8"),
    );
    // What `facetdb add github` and `facetdb add slack` give the project here: each real plugin,
    // on loopback, under its own package name.
    for (const [name, file] of Object.entries(PLUGINS)) {
      const at = join(project, "node_modules", "@facetdb", name);
      await mkdir(at, { recursive: true });
      await writeFile(
        join(at, "package.json"),
        JSON.stringify({ name: `@facetdb/${name}`, type: "module", exports: "./index.ts" }),
      );
      await symlink(file, join(at, "index.ts"));
    }
  });

  it("facetdb dev --model-url runs the issues source and serves its webhook", async () => {
    const child = facetdb(["dev", "--model-url", model.url, "--port", "0"]);
    dev = child;
    devExit = exitOf(child);
    process.once("exit", killDev);
    const hear = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      changes.changed();
    };
    child.stdout?.on("data", hear);
    child.stderr?.on("data", hear);
    void devExit.then((code) => changes.end(`facetdb dev exited with ${String(code)}`));
    await changes.until(
      "the worker running for the issues source",
      () => output.includes("Worker running for issues."),
      seenNow,
    );
    const served = /on (http:\/\/127\.0\.0\.1:\d+)\./.exec(output);
    expect(served, output).not.toBeNull();
    worker = served?.[1] ?? "";
    expect(output).toContain(`Asking the model server at ${model.url}.`);
  });

  it("takes the five signed issues.opened events, each queueing its issue", async () => {
    for (const issue of ISSUES) {
      const taken = await deliver(
        delivery(issue, { action: "opened", labels: [], sender: "a-reporter" }),
      );
      expect(taken.status, `#${issue.number}`).toBe(202);
      expect(taken.json).toEqual({ queued: 1 });
    }
  });

  it("labels each issue as the example's table says, asking the model once per issue", async () => {
    await changes.until(
      "every issue triaged: its labels set and every label action run",
      () =>
        ISSUES.every((issue) => triaged(issue) && labelsOf(issue).join() === issue.labels.join()),
      seenNow,
    );
    for (const issue of ISSUES) {
      expect(labelsOf(issue), `#${issue.number} ${issue.title}`).toEqual(issue.labels);
    }
    // One request per issue, both questions in it, the state the example reads and nothing else.
    expect(model.unexpected).toEqual([]);
    expect(model.asked.map((one) => one.title).sort()).toEqual(
      ISSUES.map((issue) => issue.title).sort(),
    );
    for (const asked of model.asked) {
      const issue = ISSUES.find((one) => one.title === asked.title) as Issue;
      expect(asked.state).toEqual({
        title: issue.title,
        body: issue.body,
        labels: "",
        changed_files: "",
      });
    }
  });

  it("takes GitHub's labeled events for the labels it set without queueing or asking again", async () => {
    // GitHub reports each label FacetDB's actions added; a managed label is not state, so the
    // delivery is taken and names no issue.
    for (const issue of ISSUES) {
      for (const label of issue.labels) {
        const taken = await deliver(
          delivery(issue, { action: "labeled", labels: issue.labels, label, sender: LOGIN }),
        );
        expect(taken.status, `#${issue.number} ${label}`).toBe(202);
        expect(taken.json, `#${issue.number} ${label}`).toEqual({ queued: 0 });
      }
    }
    expect(model.asked).toHaveLength(ISSUES.length);
  });

  it("leaves the SSO issue to a person: a card in the review queue and one message in #triage", async () => {
    await changes.until("the message in #triage", () => slack.messages.length >= 1, seenNow);
    expect(slack.messages).toEqual([
      {
        path: `POST ${SLACK_PATH}`,
        contentType: "application/json; charset=utf-8",
        text: expect.stringContaining(
          `Record ${SSO.number} on issues matched: its status is needs_review.`,
        ),
      },
    ]);
    const queue = await api("/v1/review/queue?source=issues");
    expect(queue.status).toBe(200);
    const listed = queue.json as {
      count: number;
      cards: { key: string; open: { name: string }[] }[];
    };
    expect(listed.count).toBe(1);
    expect(listed.cards.map((card) => card.key)).toEqual([String(SSO.number)]);
    expect(listed.cards[0]?.open.map((question) => question.name)).toEqual(["impacts_only_oss"]);
  });

  it("a decision on the card sets the label it decides and takes needs-triage away", async () => {
    const held = await api("/v1/review/open", { source: "issues", key: String(SSO.number) });
    expect(held.status, JSON.stringify(held.json)).toBe(200);
    const card = (held.json as { card: { stateHash: string; decided: { name: string }[] } }).card;
    expect(card.decided.map((question) => question.name)).toEqual(["not_priority"]);
    const before = github.fake.requests.length;
    const decided = await api(`/v1/review/${SSO.number}/decide`, {
      source: "issues",
      stateHash: card.stateHash,
      question: "impacts_only_oss",
      value: true,
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    await changes.until(
      "the SSO issue's labels after the decision",
      () => readsSince(SSO, before) >= LABEL_ACTIONS && labelsOf(SSO).join() === DECIDED.join(),
      seenNow,
    );
    expect(labelsOf(SSO)).toEqual(DECIDED);
    const queue = await api("/v1/review/queue?source=issues");
    expect((queue.json as { count: number }).count).toBe(0);
    // GitHub reports both changes; neither is state, so neither queues the issue again.
    for (const [action, label] of [
      ["labeled", "Impacts only OSS"],
      ["unlabeled", "needs-triage"],
    ] as const) {
      const taken = await deliver(delivery(SSO, { action, labels: DECIDED, label, sender: LOGIN }));
      expect(taken.status, `${action} ${label}`).toBe(202);
      expect(taken.json, `${action} ${label}`).toEqual({ queued: 0 });
    }
  });

  it("stops on Ctrl+C's signal: each issue labelled, the model asked once per issue, one message", async () => {
    dev?.kill("SIGINT");
    expect(await devExit, output).toBe(0);
    process.off("exit", killDev);
    expect(output).toContain("Stopped: every claim was settled.");
    // The labels as they stand once the worker has stopped: nothing undid them after the waits.
    for (const issue of ISSUES) {
      expect(labelsOf(issue), `#${issue.number} ${issue.title}`).toEqual(finalLabels(issue));
    }
    // Counted where the requests arrived, after the person's decision and GitHub's label events
    // too: neither asked anything, and no request the example does not make reached the model.
    const perIssue = ISSUES.map(
      (issue) => model.asked.filter((one) => one.title === issue.title).length,
    );
    expect(perIssue).toEqual([1, 1, 1, 1, 1]);
    expect(model.unexpected).toEqual([]);
    expect(slack.messages).toHaveLength(1);
    expect(github.fake.unexpected.map((seen) => `${seen.method} ${seen.url.pathname}`)).toEqual([]);
    // Every change GitHub took was a label on one of the five issues.
    for (const write of github.fake.writes()) {
      expect(write).toMatch(/^(POST|DELETE) \/repos\/your-org\/your-repo\/issues\/[1-5]\/labels/);
    }
  });
});
