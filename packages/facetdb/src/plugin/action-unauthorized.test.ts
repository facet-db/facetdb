import {
  type ActionDecisions,
  ALERT_SEVERITY,
  ALERT_TITLES,
  alertMessage,
  type Clock,
  createAlerts,
  type QuestionSet,
  resolvedMessage,
} from "@facetdb/core";
import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import {
  ACTION_ERROR_NOT_KEPT,
  type ActionCredentialRefused,
  type ActionDelivered,
  type ActionDelivery,
  ActionFailed,
  CREDENTIAL_REFUSED_DID,
  CREDENTIAL_WORDS_WITHHELD,
  createOutbox,
  credentialRefusedAlert,
  credentialRefusedKey,
  retryDelayMs,
} from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actionCall, env, facetdb, notifyCall, noul, type ProjectConfig } from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  type ActionSource,
  action,
  ChannelRefused,
  channel,
  createActionRunner,
  createPluginHost,
  definePlugin,
  firstPartyCredentialRefused,
  firstPartyFailure,
  type PluginHost,
  z,
} from "./index.ts";

/**
 * An action refused with a 401: a first-party plugin's own error whose `status` is 401 (and whose
 * `temporary` is not `false`) is not refused for good: it carries `credentialRefused`, the outbox
 * keeps the row on its backoff and its 24 hours, and the worker raises Action credential refused at
 * once, one per plugin of a source, which the plugin's next delivered try there resolves. A 403 or
 * a 404 is still refused for good, and a community plugin's 401 is still fixed words, with no hint
 * at all. No word repeats the token.
 */

const START = 1_700_000_040_000;
const TOKEN = "ghp_T0kenF0rUnauth0rizedTest00001";
const TELEGRAM_TOKEN = "7301928374:AAF-q9Zr4Wx2Lm8Tn5Vb0KdUnauth";
const ENV = { GITHUB_TOKEN: TOKEN, TELEGRAM_TOKEN };
const SUBJECT = "github label on acme/shop#7";
/** GitHub's fix for a refused token, as `@facetdb/github` writes it. */
const TOKEN_FIX =
  "the token is wrong, expired or revoked: put a valid one in the variable plugins.github.token names, then restart the worker";
const REFUSED_WHAT = `${SUBJECT}: GitHub answered 401 to adding the labels: GitHub does not accept the token`;
const REFUSED_TOKEN = `${REFUSED_WHAT}. ${TOKEN_FIX}`;

/** Every form of the token a leak could take: as it is, percent-encoded, in base64. */
const TOKEN_FORMS = [
  TOKEN,
  encodeURIComponent(`${TOKEN}/x`),
  Buffer.from(TOKEN).toString("base64"),
  TELEGRAM_TOKEN,
];

type Fields = {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly temporary?: boolean;
};

/** An error as a first-party plugin builds it: its class name, its words, its fields. */
function named(name: string, words: string, fields: Fields = {}): Error {
  const error = new Error(words);
  error.name = name;
  return Object.assign(error, fields);
}

/** GitHub's 401, as `@facetdb/github`'s `refusal` throws it. */
const refusedToken = (fields: Fields = {}) =>
  named("GithubActionError", REFUSED_TOKEN, { status: 401, ...fields });

/** What the plugins do at their next call: throw what they return, or succeed on undefined. */
type Script = {
  github: () => unknown;
  telegram: () => unknown;
};

function installed(script: Script): Readonly<Record<string, unknown>> {
  const github = definePlugin({
    name: "github",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret() }),
    actions: {
      label: action({
        config: z.object({ add: z.array(z.string()).default([]) }),
        run: async () => {
          const thrown = script.github();
          if (thrown !== undefined) {
            throw thrown;
          }
        },
      }),
    },
  });
  // A community plugin that names its error like the first-party one, a 401 and all.
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
  const telegram = definePlugin({
    name: "telegram",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret() }),
    channels: {
      telegram: channel({
        config: z.object({ where: z.string() }),
        deliver: async () => {
          const thrown = script.telegram();
          if (thrown !== undefined) {
            throw thrown;
          }
        },
      }),
    },
  });
  return { "@facetdb/github": github, "facetdb-plugin-hub": hub, "@facetdb/telegram": telegram };
}

function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: {
      github: { token: env("GITHUB_TOKEN") },
      telegram: { token: env("TELEGRAM_TOKEN") },
    },
    sources: [
      {
        name: "issues",
        api: true,
        read: ["title"],
        questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
        actions: [
          actionCall("@facetdb/github", "label", { add: ["bug"] }),
          actionCall("facetdb-plugin-hub", "label", {}),
          notifyCall("@facetdb/telegram", { channel: "-1001234567890" }),
        ],
      },
    ],
  });
}

async function hostFor(script: Script): Promise<PluginHost> {
  const packages = installed(script);
  return createPluginHost({
    config: project(),
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
  const [source] = project().sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  return {
    model: "jev-1.14.0",
    read: source.read,
    questions: source.questions,
    thresholds: source.thresholds,
  };
}

/** The API source the rows name, its record 7 read at the decision's state, no newer decision. */
function running(): ActionSource {
  return {
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
  };
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

/** The channel host's clock: a sleep that ends only on its signal, so its bound never cuts here. */
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

async function runnerFor(script: Partial<Script>) {
  const host = await hostFor({
    github: script.github ?? (() => refusedToken()),
    telegram: script.telegram ?? (() => undefined),
  });
  return createActionRunner({
    host,
    source: () => running(),
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

describe("a first-party plugin's 401", () => {
  it("is not refused for good: GitHub's 401 keeps its words and says the credential was refused", async () => {
    const failed = await failureOf(await runnerFor({}));
    expect(failed).toBeInstanceOf(ActionFailed);
    const { message, permanent, credentialRefused, retryAfterMs } = failed as ActionFailed;
    expect({ message, permanent, credentialRefused, retryAfterMs }).toEqual({
      message: REFUSED_TOKEN,
      permanent: false,
      credentialRefused: true,
      retryAfterMs: undefined,
    });
  });

  it("keeps a 403 and a 404 refused for good, with no hint", async () => {
    for (const status of [403, 404]) {
      const run = await runnerFor({
        github: () => named("GithubActionError", `${SUBJECT}: answered ${status}`, { status }),
      });
      const failed = (await failureOf(run)) as ActionFailed;
      expect(failed, String(status)).toBeInstanceOf(ActionFailed);
      expect([failed.permanent, failed.credentialRefused], String(status)).toEqual([true, false]);
    }
  });

  it("keeps a 401 the plugin marks temporary: false refused for good, with no hint", async () => {
    const failed = (await failureOf(
      await runnerFor({ github: () => refusedToken({ temporary: false }) }),
    )) as ActionFailed;
    expect([failed.permanent, failed.credentialRefused]).toEqual([true, false]);
  });

  it("reads the hint from the error's own fields: a 401 marked temporary, or with a wait, still says it", () => {
    const of = (fields: Fields) =>
      firstPartyFailure("@facetdb/github", refusedToken(fields), [TOKEN], 600);
    expect(of({})).toEqual({ words: REFUSED_TOKEN, permanent: false, credentialRefused: true });
    expect(of({ temporary: true })).toEqual({
      words: REFUSED_TOKEN,
      permanent: false,
      credentialRefused: true,
    });
    expect(of({ retryAfterMs: 5_000 })).toEqual({
      words: REFUSED_TOKEN,
      retryAfterMs: 5_000,
      permanent: false,
      credentialRefused: true,
    });
    expect(of({ temporary: false })).toEqual({ words: REFUSED_TOKEN, permanent: true });
    // A 401 that is not a number, or another 4xx, says nothing of a credential.
    expect(
      firstPartyFailure(
        "@facetdb/github",
        named("GithubActionError", "x", { status: "401" as unknown as number }),
        [],
        600,
      ),
    ).toEqual({ words: "x", permanent: false });
    // Words that repeat the token are not kept; the status still says the credential was refused.
    const echoing = named("GithubActionError", `the token ${TOKEN} is refused`, { status: 401 });
    expect(firstPartyFailure("@facetdb/github", echoing, [TOKEN], 600)).toBeUndefined();
    expect(firstPartyCredentialRefused("@facetdb/github", echoing)).toBe(true);
    expect(firstPartyCredentialRefused("@facetdb/github", refusedToken({ temporary: false }))).toBe(
      false,
    );
    expect(firstPartyCredentialRefused("facetdb-plugin-hub", echoing)).toBe(false);
  });

  it("keeps the hint of a 401 whose words repeat the token, in fixed words that hold none of it", async () => {
    const run = await runnerFor({
      github: () =>
        named("GithubActionError", `the token ${TOKEN} is refused`, {
          status: 401,
        }),
    });
    const failed = (await failureOf(run)) as ActionFailed;
    expect(failed).toBeInstanceOf(ActionFailed);
    expect([failed.message, failed.permanent, failed.credentialRefused]).toEqual([
      CREDENTIAL_WORDS_WITHHELD,
      false,
      true,
    ]);

    // A notification's channel: the same.
    const notified = (await failureOf(
      await runnerFor({
        telegram: () =>
          named("TelegramDeliveryError", `refused bot${TELEGRAM_TOKEN}`, { status: 401 }),
      }),
      delivery({
        plugin: "@facetdb/telegram",
        action: "notify",
        position: 2,
        batchKey: JSON.stringify(["issues", 2, "telegram:-1001234567890"]),
        payload: { ...payload({ channel: "-1001234567890" }), condition: {} },
      }),
    )) as ActionFailed;
    expect([notified.message, notified.credentialRefused]).toEqual([
      CREDENTIAL_WORDS_WITHHELD,
      true,
    ]);
  });

  it("keeps a community plugin's 401 in today's fixed words, with no hint", async () => {
    const failed = await failureOf(
      await runnerFor({}),
      delivery({ plugin: "facetdb-plugin-hub", payload: payload({}) }),
    );
    // The plugin's own error is handed on untouched: the outbox keeps only its fixed words.
    expect(failed).not.toBeInstanceOf(ActionFailed);
    expect((failed as { credentialRefused?: unknown }).credentialRefused).toBeUndefined();
  });

  it("says it for a notification whose first-party channel answered 401 (Telegram's unknown token)", async () => {
    const words =
      "telegram:-1001234567890 was not delivered: Telegram answered 401 Unauthorized. Telegram does not know this bot token";
    const run = await runnerFor({
      telegram: () => named("TelegramDeliveryError", words, { status: 401 }),
    });
    const failed = (await failureOf(
      run,
      delivery({
        plugin: "@facetdb/telegram",
        action: "notify",
        position: 2,
        batchKey: JSON.stringify(["issues", 2, "telegram:-1001234567890"]),
        payload: { ...payload({ channel: "-1001234567890" }), condition: {} },
      }),
    )) as ActionFailed;
    expect(failed).toBeInstanceOf(ActionFailed);
    expect([failed.message, failed.permanent, failed.credentialRefused]).toEqual([
      words,
      false,
      true,
    ]);
    // The channel host's own error carries it the same way to an alert channel's delivery.
    const refused = new ChannelRefused({ words, permanent: false, credentialRefused: true });
    expect(refused.credentialRefused).toBe(true);
  });
});

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

/**
 * The real outbox on PGlite, the runner over the test's plugins and core's alerts on a fake store,
 * wired as `facetdb worker` wires them (worker.ts): a refused credential raises
 * `credentialRefusedAlert` with the Alerts page's link, a delivered try resolves its key.
 */
async function worker(script: { github: () => unknown }) {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const clock = new FakeClock(START);
  const store = new FakeAlertStore(clock);
  const alerts = createAlerts({ store, clock, channels: [] });
  // The worker's `links.credential` (proven with the worker itself in studio-url.test.ts).
  const links = { credential: () => "https://facetdb.example.com/alerts" };
  const raised: { readonly event: ActionCredentialRefused; readonly lastError: string }[] = [];
  const told: ActionDelivered[] = [];
  const run = await runnerFor({ github: () => script.github() });
  const outbox = createOutbox({
    client,
    clock,
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: () => Promise.resolve(),
    onCredentialRefused: async (event, _signal, lastError) => {
      raised.push({ event, lastError });
      await alerts.raise(credentialRefusedAlert(event, lastError, links.credential));
    },
    onActionDelivered: async (event) => {
      told.push(event);
      await alerts.resolveOpen(credentialRefusedKey(event));
    },
    runAction: run,
  });
  const id = await outbox.enqueue({
    projectId: "shop",
    sourceId: "shop:issues",
    recordKey: "7",
    plugin: "@facetdb/github",
    action: "label",
    position: 0,
    payload: payload(),
  });
  async function stored() {
    const [row] = await client.query(
      `select attempts, next_attempt_at::text as next_attempt_at, delivered_at::text as delivered_at,
              gave_up_at::text as gave_up_at, last_error
         from facetdb.webhook_outbox where id = $1::bigint`,
      [id],
    );
    return row;
  }
  return { client, clock, store, outbox, raised, told, id, stored };
}

describe("a 401 through the outbox and the worker's alerts", () => {
  it("keeps the row on its backoff, raises Action credential refused at once, and the next delivered try resolves it", async () => {
    const script = { refused: true };
    const w = await worker({ github: () => (script.refused ? refusedToken() : undefined) });

    const first = await w.outbox.deliverDue(START);
    expect(first).toMatchObject({ retrying: [w.id], gaveUp: [], credentialAlertFailures: [] });
    expect(await w.stored()).toMatchObject({
      attempts: 1,
      gave_up_at: null,
      next_attempt_at: String(START + retryDelayMs(1)),
      last_error: REFUSED_TOKEN,
    });
    const [raise] = w.store.history;
    expect(w.store.history).toHaveLength(1);
    const event = raise?.event;
    expect(event).toMatchObject({
      kind: "action_credential_refused",
      project: "shop",
      source: "issues",
      question: null,
      plugin: "@facetdb/github",
      link: "https://facetdb.example.com/alerts",
      did: CREDENTIAL_REFUSED_DID,
    });
    expect(event?.what).toBe(
      `@facetdb/github was refused its credential (source issues, action label): ${REFUSED_TOKEN}.`,
    );
    expect(event?.what).toContain(TOKEN_FIX);
    expect(ALERT_TITLES.action_credential_refused).toBe("Action credential refused");
    expect(ALERT_SEVERITY.action_credential_refused).toBe("warning");

    // The second refusal, its backoff later, is the same alert inside its 30 minutes.
    w.clock.advance(retryDelayMs(1));
    await w.outbox.deliverDue(w.clock.now());
    expect(w.raised).toHaveLength(2);
    expect(w.store.history).toHaveLength(1);

    // The token works again: the next try is delivered, and the alert resolves.
    script.refused = false;
    w.clock.advance(retryDelayMs(2));
    const delivered = await w.outbox.deliverDue(w.clock.now());
    expect(delivered).toMatchObject({ delivered: [w.id], credentialAlertFailures: [] });
    expect(w.told).toEqual([
      { projectId: "shop", sourceId: "shop:issues", plugin: "@facetdb/github" },
    ]);
    expect(w.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect(w.store.active.has(credentialRefusedKey(w.told[0] as ActionDelivered))).toBe(false);
    expect(raise?.key).toBe(credentialRefusedKey(w.told[0] as ActionDelivered));

    // No word anywhere repeats the token, in any form.
    const said = JSON.stringify([
      await w.stored(),
      w.raised,
      w.store.history,
      event === undefined ? null : [alertMessage(event), resolvedMessage(event)],
    ]);
    for (const form of TOKEN_FORMS) {
      expect(said).not.toContain(form);
    }
  });

  it("raises the alert for a 401 whose words repeat the token, without the plugin's words", async () => {
    const w = await worker({
      github: () => named("GithubActionError", `the token ${TOKEN} is refused`, { status: 401 }),
    });

    expect(await w.outbox.deliverDue(START)).toMatchObject({ retrying: [w.id] });
    expect(await w.stored()).toMatchObject({
      gave_up_at: null,
      last_error: CREDENTIAL_WORDS_WITHHELD,
    });
    const [raise] = w.store.history;
    expect(raise?.event.what).toBe(
      "@facetdb/github was refused its credential (source issues, action label).",
    );
    const said = JSON.stringify([await w.stored(), w.raised, w.store.history]);
    for (const form of TOKEN_FORMS) {
      expect(said).not.toContain(form);
    }
  });

  it("raises nothing for a community plugin's 401: its fixed words, on the backoff, as before", async () => {
    const client = pgliteClient(pglite);
    await migrateStore(client);
    const raised: unknown[] = [];
    const outbox = createOutbox({
      client,
      clock: new FakeClock(START),
      fetch: () => Promise.resolve({ status: 204 }),
      abortAfter: () => new AbortController().signal,
      secretFor: () => Promise.resolve("whsec-test-secret"),
      onGiveUp: () => Promise.resolve(),
      onCredentialRefused: (event) => {
        raised.push(event);
        return Promise.resolve();
      },
      runAction: await runnerFor({}),
    });
    const id = await outbox.enqueue({
      projectId: "shop",
      sourceId: "shop:issues",
      recordKey: "7",
      plugin: "facetdb-plugin-hub",
      action: "label",
      position: 1,
      payload: payload({}),
    });
    expect(await outbox.deliverDue(START)).toMatchObject({ retrying: [id] });
    const [row] = await client.query(
      "select last_error, gave_up_at from facetdb.webhook_outbox where id = $1::bigint",
      [id],
    );
    expect(row).toMatchObject({ last_error: ACTION_ERROR_NOT_KEPT, gave_up_at: null });
    expect(raised).toEqual([]);
  });
});
