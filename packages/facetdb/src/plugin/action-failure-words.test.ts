import type { ActionDecisions, Clock, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import {
  ACTION_ERROR_NOT_KEPT,
  type ActionDelivery,
  ActionFailed,
  createOutbox,
  GAVE_UP_REFUSED_DID,
  gaveUpAlert,
  REFUSED_FOR_GOOD,
  retryDelayMs,
  type WebhookGaveUp,
} from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actionCall, env, facetdb, notifyCall, noul, type ProjectConfig } from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  ACTION_WORDS_MAX,
  type ActionSource,
  action,
  channel,
  createActionRunner,
  createPluginHost,
  definePlugin,
  livePluginHost,
  type PluginHost,
  z,
} from "./index.ts";

/**
 * A first-party action plugin's own failure words: the runner keeps an error of the class the
 * channel host's table names for the plugin's package (`GithubActionError` for `@facetdb/github`)
 * in its words, unless they repeat a value the action was handed, with the wait the service asked
 * for and whether the refusal is for good; the outbox gives a refusal for good up at once, its
 * alert carrying the words and the fix. A community plugin's error is never kept, whatever it is
 * named. A notification through a first-party channel follows the same rule.
 */

const START = 1_700_000_040_000;
const TOKEN = "ghp_T0kenF0rActi0nW0rdsTest0001";
/** A value the action's own settings read from a variable. */
const OWNER = "acme-hidden-owner";
/** A value the GitHub source's settings read from a variable. */
const REPO_VALUE = "acme/hidden-repository";
/** The token a reload's settings read instead, from another variable. */
const NEXT_TOKEN = "ghp_N3xtT0kenAfterAReload000002";
const ENV = {
  GITHUB_TOKEN: TOKEN,
  GITHUB_TOKEN_NEXT: NEXT_TOKEN,
  GITHUB_OWNER: OWNER,
  GITHUB_REPO: REPO_VALUE,
};
const SUBJECT = "github label on acme/shop#7";
/** GitHub's fix for a refused token, as `@facetdb/github` writes it. */
const TOKEN_FIX =
  "the token is wrong, expired or revoked: put a valid one in the variable plugins.github.token names, then restart the worker";
/** GitHub's fix for a token not allowed to act on the repository (its 403), as `@facetdb/github` writes it. */
const FORBIDDEN_FIX =
  "the token may not do this on the repository: give a fine-grained token Issues read and write on it";
const FORBIDDEN = `${SUBJECT}: GitHub answered 403 to adding the labels: the token is not allowed to. ${FORBIDDEN_FIX}`;

type Fields = {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly temporary?: boolean;
};

/** An error as `@facetdb/github` builds its `GithubActionError`: its name, its words ending in the fix, its fields. */
function githubError(what: string, fix: string, fields: Fields = {}): Error {
  const error = new Error(`${what}. ${fix}`);
  error.name = "GithubActionError";
  return Object.assign(error, { fix, ...fields });
}

/** A refused token, GitHub's 401, as the plugin throws it. */
const refusedToken = () =>
  githubError(
    `${SUBJECT}: GitHub answered 401 to reading the issue: GitHub does not accept the token`,
    TOKEN_FIX,
    {
      status: 401,
    },
  );

/**
 * A token GitHub knows but does not let act (its 403): refused for good. A 401 is not
 * (action-unauthorized.test.ts): a rotated credential comes back.
 */
const forbidden = () =>
  githubError(
    `${SUBJECT}: GitHub answered 403 to adding the labels: the token is not allowed to`,
    FORBIDDEN_FIX,
    { status: 403 },
  );

/** What the plugins throw at their next call: the GitHub action's error, and the channel's. */
type Script = {
  action: (token: string) => unknown;
  channel: () => unknown;
};

function installed(script: Script): Readonly<Record<string, unknown>> {
  const github = definePlugin({
    name: "github",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret() }),
    actions: {
      label: action({
        config: z.object({ add: z.array(z.string()).default([]), owner: z.string().optional() }),
        run: async (ctx) => {
          throw script.action(ctx.secrets["token"] ?? "");
        },
      }),
    },
  });
  // A community plugin that names its error like the first-party one, fields and all.
  const hub = definePlugin({
    name: "hub",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    actions: {
      label: action({
        config: z.object({}),
        run: async () => {
          throw refusedToken();
        },
      }),
    },
  });
  const slack = definePlugin({
    name: "slack",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    channels: {
      slack: channel({
        config: z.object({ where: z.string() }),
        deliver: async () => {
          throw script.channel();
        },
      }),
    },
  });
  return { "@facetdb/github": github, "facetdb-plugin-hub": hub, "@facetdb/slack": slack };
}

function project(tokenVariable = "GITHUB_TOKEN"): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { github: { token: env(tokenVariable) } },
    sources: [
      {
        name: "issues",
        api: true,
        read: ["title"],
        questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
        actions: [
          actionCall("@facetdb/github", "label", { add: ["bug"] }),
          actionCall("facetdb-plugin-hub", "label", {}),
          notifyCall("@facetdb/slack", { channel: "#ops" }),
        ],
      },
    ],
  });
}

async function hostFor(script: Script, tokenVariable?: string): Promise<PluginHost> {
  const packages = installed(script);
  return createPluginHost({
    config: project(tokenVariable),
    env: ENV,
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: (specifier) =>
      Object.hasOwn(packages, specifier)
        ? Promise.resolve({ default: packages[specifier] })
        : Promise.reject(
            Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          ),
    builtins: {},
  });
}

function questionSet(): QuestionSet {
  const config = project();
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  return {
    model: config.model,
    read: source.read,
    questions: source.questions,
    thresholds: source.thresholds,
  };
}

type Running = Extract<ActionSource, { kind: "running" }>;

/** The API source the rows name, its record 7 read at the decision's state, no newer decision logged. */
function running(plugin?: NonNullable<Running["plugin"]>): Running {
  const source: Running = {
    kind: "running",
    name: "issues",
    connector: {
      read: () =>
        Promise.resolve({
          rows: [{ key: "7", state: { title: "Typo in README" }, hash: "h1", excluded: false }],
          missing: [],
        }),
    },
    log: { history: () => Promise.resolve([]) },
    questionSet: questionSet(),
    ...(plugin === undefined ? {} : { plugin }),
  };
  return source;
}

const YES: ActionDecisions = {
  not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 },
};

function payload(settings: Readonly<Record<string, unknown>> = { add: ["bug"] }) {
  return {
    status: "done",
    decidedAt: new Date(START).toISOString(),
    stateHash: "h1",
    decisions: YES,
    settings,
  };
}

function delivery(overrides: Partial<ActionDelivery> = {}): ActionDelivery {
  return {
    deliveryId: "1",
    projectId: "shop",
    sourceId: "shop:issues",
    recordKey: "7",
    plugin: "@facetdb/github",
    action: "label",
    position: 0,
    payload: payload(),
    batchKey: undefined,
    attempt: 1,
    queuedAt: START,
    ...overrides,
  };
}

/**
 * The channel host's clock: the test's time, and a sleep that ends only when its signal aborts, so
 * the 20-second bound (proven in channel-host.test.ts) never cuts a delivery here.
 */
function patient(clock: FakeClock): Clock {
  return {
    now: () => clock.now(),
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
        } else {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }
      }),
  };
}

/** The runner over `host` (by default one whose plugins throw what `script` says), on `source`. */
async function runnerFor(
  script: Partial<Script>,
  source: ActionSource = running(),
  given?: PluginHost,
) {
  const host =
    given ??
    (await hostFor({
      action: script.action ?? (() => refusedToken()),
      channel: script.channel ?? (() => new Error("unused")),
    }));
  return createActionRunner({
    host,
    source: () => source,
    env: ENV,
    notify: {
      clock: patient(new FakeClock(START)),
      stop: () => new AbortController().signal,
      recordLink: () => undefined,
      listLink: () => undefined,
    },
  });
}

/** What one attempt of `row` threw. */
async function failureOf(
  run: Awaited<ReturnType<typeof runnerFor>>,
  row: ActionDelivery = delivery(),
): Promise<unknown> {
  return run(row, new AbortController().signal).then(
    () => {
      throw new Error("the attempt succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
}

/** Every form of the token a leak could take: as it is, percent-encoded, in base64. */
const TOKEN_FORMS = [
  TOKEN,
  encodeURIComponent(`${TOKEN}/x`),
  Buffer.from(TOKEN).toString("base64"),
];

let pglite: PGlite;

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

/** One action row of the GitHub label through the real outbox on PGlite, its runner `run`, one pass. */
async function throughOutbox(
  run: Awaited<ReturnType<typeof runnerFor>>,
  row: { readonly plugin: string; readonly settings?: Readonly<Record<string, unknown>> } = {
    plugin: "@facetdb/github",
  },
) {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const gaveUp: { readonly event: WebhookGaveUp; readonly lastError: string }[] = [];
  const outbox = createOutbox({
    client,
    clock: new FakeClock(START),
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: (event, _signal, lastError) => {
      gaveUp.push({ event, lastError });
      return Promise.resolve();
    },
    runAction: run,
  });
  const id = await outbox.enqueue({
    projectId: "shop",
    sourceId: "shop:issues",
    recordKey: "7",
    plugin: row.plugin,
    action: "label",
    position: 0,
    payload: payload(row.settings),
  });
  const report = await outbox.deliverDue(START);
  const [stored] = await client.query(
    `select attempts, next_attempt_at::text as next_attempt_at, gave_up_at::text as gave_up_at, last_error
       from facetdb.webhook_outbox where id = $1::bigint`,
    [id],
  );
  return { id, report, stored, gaveUp };
}

describe("a first-party action's own failure words", () => {
  it("gives GitHub's refusal for good (a token not allowed to) up at once, in its words with its fix, the alert raised now", async () => {
    const run = await runnerFor({ action: forbidden });
    const t = await throughOutbox(run);

    expect(t.report.gaveUp).toEqual([t.id]);
    expect(t.stored).toMatchObject({
      attempts: 1,
      gave_up_at: String(START),
      last_error: `${FORBIDDEN}; ${REFUSED_FOR_GOOD}`,
    });
    expect(t.gaveUp).toEqual([
      {
        event: expect.objectContaining({ attempts: 1, refused: true, plugin: "@facetdb/github" }),
        lastError: FORBIDDEN,
      },
    ]);
    const [given] = t.gaveUp;
    const alert = gaveUpAlert(
      given?.event as WebhookGaveUp,
      given?.lastError ?? "",
      () => "studio",
    );
    expect(alert.what).toContain("was given up at once, refused for good after 1 attempt");
    expect(alert.what).toContain(FORBIDDEN_FIX);
    expect(alert.did).toBe(GAVE_UP_REFUSED_DID);
    for (const form of TOKEN_FORMS) {
      expect(JSON.stringify([t.stored, t.gaveUp, alert])).not.toContain(form);
    }
  });

  it("reads a refusal for good from the error's own word, else from a 4xx other than 408, 425 and 429", async () => {
    const cases: readonly [string, Fields, boolean][] = [
      ["a 404: the repository is not there", { status: 404 }, true],
      ["a 422: the request is not valid", { status: 422 }, true],
      ["a key that is not an issue number, no status", { temporary: false }, true],
      [
        "a 403 GitHub marks as a rate limit, no wait given",
        { status: 403, temporary: true },
        false,
      ],
      ["a 408", { status: 408 }, false],
      ["a 425", { status: 425 }, false],
      ["a 429 without a wait", { status: 429 }, false],
      ["no answer at all", {}, false],
      ["a 502", { status: 502 }, false],
    ];
    for (const [what, fields, permanent] of cases) {
      const run = await runnerFor({
        action: () => githubError(`${SUBJECT}: ${what}`, "the fix", fields),
      });
      const failed = await failureOf(run);
      expect(failed, what).toBeInstanceOf(ActionFailed);
      expect((failed as ActionFailed).message, what).toBe(`${SUBJECT}: ${what}. the fix`);
      expect((failed as ActionFailed).permanent, what).toBe(permanent);
      expect((failed as ActionFailed).retryAfterMs, what).toBeUndefined();
    }
  });

  it("carries the wait a rate limit asked for, which is never a refusal for good", async () => {
    const run = await runnerFor({
      action: () =>
        githubError(
          `${SUBJECT}: GitHub's rate limit stopped adding the labels`,
          "it is tried again later",
          {
            status: 403,
            retryAfterMs: 90_000,
          },
        ),
    });
    const failed = (await failureOf(run)) as ActionFailed;
    expect(failed).toBeInstanceOf(ActionFailed);
    expect([failed.retryAfterMs, failed.permanent]).toEqual([90_000, false]);
  });

  it("cleans the words it keeps and holds them to a length", async () => {
    const run = await runnerFor({
      action: () =>
        githubError(`${SUBJECT}:\nline two​`, "x".repeat(ACTION_WORDS_MAX), { status: 502 }),
    });
    const failed = (await failureOf(run)) as ActionFailed;
    expect(failed.message).toHaveLength(ACTION_WORDS_MAX);
    expect(failed.message.startsWith(`${SUBJECT}: line two `)).toBe(true);
    expect(failed.message.endsWith("…")).toBe(true);
  });

  it("keeps the backoff for a 5xx, in GitHub's words", async () => {
    const words = `${SUBJECT}: GitHub answered 502 to adding the labels: GitHub failed on its side`;
    const run = await runnerFor({
      action: () => githubError(words, "the action is tried again later", { status: 502 }),
    });
    const t = await throughOutbox(run);

    expect(t.report.retrying).toEqual([t.id]);
    expect(t.stored).toMatchObject({
      attempts: 1,
      gave_up_at: null,
      next_attempt_at: String(START + retryDelayMs(1)),
      last_error: `${words}. the action is tried again later`,
    });
    expect(t.gaveUp).toEqual([]);
  });
});

describe("words that are not kept", () => {
  // A 403 here: a 401 whose words are withheld still says its credential was refused
  // (action-unauthorized.test.ts); these are about the words alone.
  it("falls back to the fixed words when GitHub's words repeat the token, raw or encoded", async () => {
    const echoes: readonly ((token: string) => string)[] = [
      (token) => `the token ${token} is refused`,
      (token) => `GET /user?access_token=${encodeURIComponent(`${token}/x`)}`,
      (token) =>
        `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      (token) => `the token ends in ${token.slice(-10)}`,
    ];
    for (const echo of echoes) {
      const run = await runnerFor({
        action: (token) => githubError(`${SUBJECT}: ${echo(token)}`, TOKEN_FIX, { status: 403 }),
      });
      const failed = await failureOf(run);
      // The plugin's own error is handed on untouched, never as words the outbox keeps.
      expect(failed).not.toBeInstanceOf(ActionFailed);
    }

    const run = await runnerFor({
      action: (token) =>
        githubError(`${SUBJECT}: the token ${token} is refused`, TOKEN_FIX, { status: 403 }),
    });
    const t = await throughOutbox(run);
    // Not kept, so not read either: the backoff and the 24 hours, as in an earlier version.
    expect(t.report.retrying).toEqual([t.id]);
    expect(t.stored).toMatchObject({ last_error: ACTION_ERROR_NOT_KEPT, gave_up_at: null });
    expect(JSON.stringify(t.stored)).not.toContain(TOKEN);
  });

  it("falls back when the words repeat a value the action's settings, or its GitHub source's, read", async () => {
    const naming = (value: string) => () =>
      githubError(`${SUBJECT}: ${value} has no such repository`, "check the repository", {
        status: 404,
      });

    const settings = await runnerFor({ action: naming(OWNER) });
    const fromAction = await failureOf(
      settings,
      delivery({ payload: payload({ add: ["bug"], owner: { env: "GITHUB_OWNER" } }) }),
    );
    expect(fromAction).not.toBeInstanceOf(ActionFailed);

    const source = await runnerFor(
      { action: naming(REPO_VALUE) },
      running({
        packageName: "@facetdb/github",
        settings: { repo: REPO_VALUE },
        variables: ["GITHUB_TOKEN", "GITHUB_REPO"],
      }),
    );
    expect(await failureOf(source)).not.toBeInstanceOf(ActionFailed);
  });

  it("checks the words against what the action was handed, though reloads put other settings in force around it", async () => {
    // The worker's live host: a reload swaps the settings in force for every call from then on.
    const script: Script = {
      action: (token) => {
        // A reload while the action runs puts the first settings back in force.
        live.swap(first);
        return githubError(`${SUBJECT}: the token ${token} is refused`, TOKEN_FIX, { status: 403 });
      },
      channel: () => new Error("unused"),
    };
    const first = await hostFor(script);
    const next = await hostFor(script, "GITHUB_TOKEN_NEXT");
    const live = livePluginHost(first);
    const base = running();
    // A reload while the record is read: the action is handed the token GITHUB_TOKEN_NEXT names.
    const source: ActionSource = {
      ...base,
      connector: {
        read: (keys) => {
          live.swap(next);
          return base.connector.read(keys);
        },
      },
    };

    const failed = await failureOf(await runnerFor({}, source, live));
    // Its words repeat the token it was handed, though the settings in force at the throw read
    // another: they are not kept.
    expect(failed).not.toBeInstanceOf(ActionFailed);
    expect(String((failed as Error).message)).toContain(NEXT_TOKEN);
  });

  it("never keeps a community plugin's error, even under a first-party class name with its fields", async () => {
    const run = await runnerFor({});
    const failed = await failureOf(run, delivery({ plugin: "facetdb-plugin-hub" }));
    expect(failed).not.toBeInstanceOf(ActionFailed);

    const t = await throughOutbox(run, { plugin: "facetdb-plugin-hub", settings: {} });
    expect(t.report.retrying).toEqual([t.id]);
    expect(t.stored).toMatchObject({
      attempts: 1,
      gave_up_at: null,
      next_attempt_at: String(START + retryDelayMs(1)),
      last_error: ACTION_ERROR_NOT_KEPT,
    });
    expect(t.gaveUp).toEqual([]);
  });
});

describe("a notification through a first-party channel", () => {
  const notifyRow = delivery({
    plugin: "@facetdb/slack",
    action: "notify",
    position: 2,
    batchKey: JSON.stringify(["issues", 2, "slack:#ops"]),
    payload: { ...payload({ channel: "#ops" }), condition: {} },
  });
  const slackError = (words: string, fields: Fields) =>
    Object.assign(new Error(words), { name: "SlackDeliveryError", ...fields });

  it("is refused for good on Slack's 404, in Slack's words", async () => {
    const words =
      "slack:#ops was not delivered: Slack answered channel_not_found; invite the app to #ops";
    const run = await runnerFor({ channel: () => slackError(words, { status: 404 }) });
    const failed = (await failureOf(run, notifyRow)) as ActionFailed;
    expect(failed).toBeInstanceOf(ActionFailed);
    expect([failed.message, failed.permanent]).toEqual([words, true]);
  });

  it("carries the wait Slack asked for on a 429", async () => {
    const words =
      "slack:#ops was not delivered: Slack answered HTTP 429; a later delivery may go through";
    const run = await runnerFor({
      channel: () => slackError(words, { status: 429, retryAfterMs: 30_000 }),
    });
    const failed = (await failureOf(run, notifyRow)) as ActionFailed;
    expect([failed.message, failed.retryAfterMs, failed.permanent]).toEqual([words, 30_000, false]);
  });
});
