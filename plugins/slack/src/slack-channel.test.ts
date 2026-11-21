import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { env, facetdb, noul, type PluginSettings, VERSION } from "facetdb";
import {
  createPluginHost,
  loadPlugin,
  type Plugin,
  type PluginContext,
  type PluginHostError,
} from "facetdb/plugin";
import { afterEach, describe, expect, it } from "vitest";
import defaultPlugin, {
  createSlackPlugin,
  type Fetch,
  type SlackConfig,
  SlackDeliveryError,
  slack,
} from "./index.ts";
import type { ChannelMessage } from "./message.ts";

/**
 * The Slack plugin on a handwritten `fetch`: never the network. Its context comes from the plugin
 * host, as the worker's will, so each secret is read from a variable exactly as in production.
 * Every value below is one no error, request to another host or output may ever hold.
 */

const TOKEN = "xoxb-1234-5678-s3cretT0KEN";
const OPS_HOOK = "https://hooks.slack.com/services/T0000/B0000/s3cretOPShook";
const TRIAGE_HOOK = "https://hooks.slack.com/services/T0000/B1111/s3cretTRIAGEhook";
const SECRETS = [
  TOKEN,
  "s3cretT0KEN",
  OPS_HOOK,
  "s3cretOPShook",
  TRIAGE_HOOK,
  "s3cretTRIAGEhook",
  "/services/T0000",
];
const ENV = {
  SLACK_BOT_TOKEN: TOKEN,
  SLACK_WEBHOOK_OPS: OPS_HOOK,
  SLACK_WEBHOOK_TRIAGE: TRIAGE_HOOK,
};

const API = "https://slack.com/api/chat.postMessage";

const ALERT: ChannelMessage = {
  kind: "system-alert",
  severity: "critical",
  text: "The model key was refused for the project shop.",
  link: "https://studio.example.com/alerts?event=key&source=tickets",
};
const ALERT_TEXT =
  "Critical: The model key was refused for the project shop.\n<https://studio.example.com/alerts?event=key&amp;source=tickets>";

type Call = { readonly url: string; readonly init: RequestInit };
type Reply = (call: Call) => Response | Promise<Response>;

const posted: Reply = (call) =>
  call.url === API
    ? Response.json({ ok: true, channel: "C0123ABCD", ts: "1" })
    : new Response("ok");

/**
 * Requests to any URL but the Web API's or a configured webhook, in every test. Kept aside and
 * checked after each test, as a failure thrown inside `fetch` would read as a delivery failure.
 */
const strays: string[] = [];

afterEach(() => {
  const found = [...strays];
  strays.length = 0;
  expect(found).toEqual([]);
});

/** Slack, faked: every request is recorded. Each reply is used once, in order, then `posted` answers. */
function fakeSlack(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    if (![API, OPS_HOOK, TRIAGE_HOOK].includes(url)) {
      strays.push(url);
    }
    return (replies.shift() ?? posted)(call);
  };
  return { calls, fetch };
}

/** The body FacetDB sent, as JSON. */
function sent(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

function headers(call: Call | undefined): Record<string, string> {
  return call?.init.headers as Record<string, string>;
}

function project(settings: PluginSettings | undefined) {
  return facetdb({
    model: "jev-1.14.0",
    ...(settings === undefined ? {} : { plugins: { slack: settings } }),
    alerts: { channels: ["slack:#ops"] },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
      },
    ],
  });
}

/** `importModule` with `@facetdb/slack` installed as `plugin`, and nothing else. */
function installed(plugin: Plugin) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/slack") {
      return { default: plugin };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

function hostFor(
  plugin: Plugin,
  settings: PluginSettings | undefined,
  variables: Readonly<Record<string, string>> = ENV,
) {
  return createPluginHost({
    config: project(settings),
    env: variables,
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: installed(plugin),
    builtins: {},
  });
}

/** The plugin's `slack` channel with the context the host gives it, used as the worker will. */
async function slackWith(settings: PluginSettings | undefined, fetch: Fetch) {
  const plugin = createSlackPlugin({ fetch });
  const host = await hostFor(plugin, settings);
  const ctx = host.contextFor("slack", new AbortController().signal) as PluginContext<SlackConfig>;
  const entry = plugin.channels["slack"];
  if (entry === undefined) {
    throw new Error("the plugin has no slack channel");
  }
  const bound = (where: string) => entry.config.parse({ where });
  return {
    check: (where: string) => entry.check?.(ctx, bound(where)),
    deliver: (message: ChannelMessage, where: string) => entry.deliver(ctx, message, bound(where)),
  };
}

/** Everything a thrown value shows, whoever prints it: message, stack, own fields, cause, inspect. */
function exposed(value: unknown): string {
  const parts = [inspect(value, { depth: 20, showHidden: true, getters: true })];
  if (value instanceof Error) {
    parts.push(
      value.message,
      String(value.stack),
      JSON.stringify(value, Object.getOwnPropertyNames(value)),
      JSON.stringify({ ...value }),
      inspect(value.cause, { depth: 20, showHidden: true }),
    );
  }
  return parts.join("\n");
}

function expectNoSecret(value: unknown): void {
  const text = exposed(value);
  expect(SECRETS.filter((secret) => text.includes(secret))).toEqual([]);
}

/** The delivery's failure: a `SlackDeliveryError` with no cause and no secret anywhere in it. */
async function failure(delivery: Promise<unknown>): Promise<SlackDeliveryError> {
  const error = await delivery.then(
    () => {
      throw new Error("the delivery succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SlackDeliveryError);
  expect((error as Error).cause).toBeUndefined();
  expectNoSecret(error);
  return error as SlackDeliveryError;
}

async function refusal(built: Promise<unknown>): Promise<PluginHostError> {
  const error = await built.then(
    () => {
      throw new Error("the host was built, and a refusal was expected");
    },
    (caught: unknown) => caught,
  );
  expect((error as Error).name).toBe("PluginHostError");
  expectNoSecret(error);
  return error as PluginHostError;
}

const WITH_TOKEN = { token: env("SLACK_BOT_TOKEN") };
const WITH_HOOKS = {
  webhooks: { "#ops": env("SLACK_WEBHOOK_OPS"), "#triage": env("SLACK_WEBHOOK_TRIAGE") },
};

describe("the plugin as the loader and the host see it", () => {
  it("passes loadPlugin's checks, its nested webhook secrets found, and matches its registry entry", async () => {
    const { fetch } = fakeSlack();
    for (const plugin of [defaultPlugin, createSlackPlugin({ fetch })]) {
      const loaded = await loadPlugin("slack", {
        coreVersion: VERSION,
        importModule: installed(plugin),
      });
      expect(loaded.manifest.name).toBe("slack");
      expect(loaded.manifest.kinds).toEqual(["channel"]);
      expect([...loaded.manifest.secrets].sort()).toEqual(["token", "webhooks.*"]);
      expect(Object.keys(loaded.channels)).toEqual(["slack"]);
    }
    const entry = JSON.parse(
      await readFile(new URL("../../../registry/plugins/slack.json", import.meta.url), "utf8"),
    ) as { kinds: string[]; facetdb: string; package: string };
    expect(entry.package).toBe("@facetdb/slack");
    expect(entry.kinds).toEqual(defaultPlugin.manifest.kinds);
    expect(entry.facetdb).toBe(defaultPlugin.manifest.coreVersions);
  });

  it("is refused by the host when a channel's webhook URL is written into the file", async () => {
    const refused = await refusal(
      hostFor(createSlackPlugin(fakeSlack()), {
        webhooks: { "#ops": "pasted-into-the-file" },
      }),
    );
    expect(refused.code).toBe("plugin-secret-literal");
    expect(refused.message).toContain("plugins.slack.webhooks.#ops is a secret of the plugin");
  });

  it("refuses at load a webhook URL that is not an https Slack incoming webhook, never printing it", async () => {
    const outside = [
      "http://hooks.slack.com/services/T0000/B0000/s3cretOPShook",
      "https://hooks.slack.com.evil.example/services/T0000/B0000/s3cretOPShook",
      "https://evil.example/services/T0000/B0000/s3cretOPShook",
      "https://user:pass@hooks.slack.com/services/T0000/B0000/s3cretOPShook",
      "https://hooks.slack.com:8443/services/T0000/B0000/s3cretOPShook",
      "https://HOOKS.slack.com/services/T0000/B0000/s3cretOPShook",
      "https://hooks.slack.com/workflows/T0000/B0000/s3cretOPShook",
      "https://hooks.slack.com/services/T0000/B0000/s3cretOPShook?to=evil",
      "https://hooks.slack.com\\@evil.example/services/T0000/s3cretOPShook",
      " https://hooks.slack.com/services/T0000/B0000/s3cretOPShook",
      "not a url /services/T0000 s3cretOPShook",
    ];
    for (const url of outside) {
      const refused = await refusal(
        hostFor(
          createSlackPlugin(fakeSlack()),
          { webhooks: { "#ops": env("SLACK_WEBHOOK_OPS") } },
          { SLACK_WEBHOOK_OPS: url },
        ),
      );
      expect(refused.code).toBe("plugin-settings");
      expect(refused.message).toContain(
        "plugins.slack.webhooks.#ops: the value of SLACK_WEBHOOK_OPS",
      );
      expect(refused.message).not.toContain(url);
    }
    await expect(hostFor(createSlackPlugin(fakeSlack()), WITH_HOOKS)).resolves.toBeDefined();
  });

  it("refuses at load a token that is not a Slack token or would break a header, never printing it", async () => {
    for (const token of ["s3cretT0KEN", "xoxb-1234 s3cretT0KEN", "xoxb-1234\ns3cretT0KEN"]) {
      const refused = await refusal(
        hostFor(createSlackPlugin(fakeSlack()), WITH_TOKEN, { SLACK_BOT_TOKEN: token }),
      );
      expect(refused.code).toBe("plugin-settings");
      expect(refused.message).toContain("plugins.slack.token: the value of SLACK_BOT_TOKEN");
    }
  });

  it("takes a channel as #name or a channel ID, in the address and as a webhook's key", async () => {
    const entry = defaultPlugin.channels["slack"];
    for (const where of [
      "#ops",
      "#support-urgent",
      "#team_2",
      "#サポート",
      "C0123ABCD",
      "G0123ABCDEF",
    ]) {
      expect(entry?.config.safeParse({ where }).success, where).toBe(true);
    }
    for (const where of ["ops", "#Ops", "#a b", "#", "<!channel>", "#ops>", "c0123abcd", ""]) {
      const parsed = entry?.config.safeParse({ where });
      expect(parsed?.success, where).toBe(false);
      expect(parsed?.error?.issues[0]?.message).toContain("#name, in lowercase");
    }
    const refused = await refusal(
      hostFor(createSlackPlugin(fakeSlack()), { webhooks: { ops: env("SLACK_WEBHOOK_OPS") } }),
    );
    expect(refused.code).toBe("plugin-settings");
  });
});

describe("with a bot token", () => {
  it("posts the message to chat.postMessage for the channel, once per delivery", async () => {
    const slackApi = fakeSlack();
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    expect(channel.check("#ops")).toBeUndefined();
    await expect(channel.deliver(ALERT, "#ops")).resolves.toBeUndefined();
    await expect(channel.deliver(ALERT, "#ops")).resolves.toBeUndefined();

    // The same message twice posts twice: deduplicating is the alert's rule and the outbox's.
    expect(slackApi.calls).toHaveLength(2);
    const [call] = slackApi.calls;
    expect(call?.url).toBe(API);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(headers(call)).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    });
    expect(sent(call)).toEqual({
      channel: "#ops",
      text: ALERT_TEXT,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(sent(slackApi.calls[1])).toEqual(sent(call));
  });

  it("reaches any channel, by name or ID, and is preferred to a channel's webhook", async () => {
    const slackApi = fakeSlack();
    const channel = await slackWith({ ...WITH_TOKEN, ...WITH_HOOKS }, slackApi.fetch);
    await channel.deliver(ALERT, "#ops");
    await channel.deliver(ALERT, "C0123ABCD");
    expect(slackApi.calls.map((call) => call.url)).toEqual([API, API]);
    expect(sent(slackApi.calls[1])["channel"]).toBe("C0123ABCD");
  });
});

describe("without a token, through each channel's incoming webhook", () => {
  it("posts to the webhook named for the channel, with no token and no channel in the body", async () => {
    const hooks = fakeSlack();
    const channel = await slackWith(WITH_HOOKS, hooks.fetch);
    expect(channel.check("#ops")).toBeUndefined();
    await channel.deliver(ALERT, "#ops");
    await channel.deliver({ ...ALERT, severity: "warning" }, "#triage");
    await channel.deliver(ALERT, "#ops");

    expect(hooks.calls.map((call) => call.url)).toEqual([OPS_HOOK, TRIAGE_HOOK, OPS_HOOK]);
    const [call] = hooks.calls;
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(headers(call)).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(sent(call)).toEqual({
      text: ALERT_TEXT,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(String(sent(hooks.calls[1])["text"])).toMatch(/^Warning: /);
  });

  it("refuses a channel with neither a token nor its webhook, naming it and the two ways to give it", async () => {
    const none = fakeSlack();
    for (const settings of [WITH_HOOKS, {}, undefined]) {
      const channel = await slackWith(settings, none.fetch);
      const words = channel.check("#support-urgent");
      expect(words).toBe(
        'slack:#support-urgent has no way to reach Slack: give the plugin a bot token, plugins: { slack: { token: env("SLACK_BOT_TOKEN") } }, or the incoming-webhook URL of #support-urgent, plugins: { slack: { webhooks: { "#support-urgent": env("SLACK_WEBHOOK_SUPPORT_URGENT") } } }, and set the variable where the worker runs',
      );
      const error = await failure(channel.deliver(ALERT, "#support-urgent"));
      expect(error.message).toContain(String(words));
      expect(error.status).toBeUndefined();
    }
    expect(none.calls).toEqual([]);
  });
});

describe("Slack's refusals", () => {
  const known: readonly (readonly [string, string])[] = [
    ["channel_not_found", "Slack finds no channel #ops the app can see"],
    ["not_in_channel", "the app is not a member of #ops: invite it"],
    ["invalid_auth", "Slack does not accept the bot token"],
    ["account_inactive", "deactivated or uninstalled: reinstall the app"],
    ["token_revoked", "the token was revoked"],
    ["missing_scope", "the chat:write scope"],
    ["is_archived", "#ops is archived"],
  ];

  it("reads an answer of 200 with ok: false as a failed delivery with Slack's reason and its fix", async () => {
    for (const [code, fix] of known) {
      const slackApi = fakeSlack(() => Response.json({ ok: false, error: code }));
      const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.slackCode).toBe(code);
      expect(error.message).toBe(
        `slack:#ops was not delivered: Slack answered ${code}; ${error.fix}`,
      );
      expect(error.fix).toContain(fix);
      expect(error.status).toBeUndefined();
    }
  });

  it("names a reason it does not know as Slack wrote it, and nothing else from the body", async () => {
    const slackApi = fakeSlack(() =>
      Response.json({ ok: false, error: "brand_new_reason", warning: TOKEN, detail: OPS_HOOK }),
    );
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    const error = await failure(channel.deliver(ALERT, "#ops"));
    expect(error.slackCode).toBe("brand_new_reason");
    expect(error.message).toContain(
      'a reason FacetDB does not know yet: look up "brand_new_reason"',
    );
  });

  it("never repeats a body that is not Slack's answer or whose reason is not a code", async () => {
    const bodies: Reply[] = [
      () => Response.json({ ok: false, error: `<!channel> ${TOKEN}` }),
      () => Response.json({ ok: false, error: OPS_HOOK }),
      () => Response.json({ ok: false }),
      () => Response.json({ ok: "yes", echo: TOKEN }),
      () => new Response(`<html>proxy says ${TOKEN} ${OPS_HOOK}</html>`, { status: 200 }),
      () => new Response("", { status: 200 }),
    ];
    for (const reply of bodies) {
      const slackApi = fakeSlack(reply);
      const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.slackCode).toBeUndefined();
      expect(error.message).not.toContain("<");
      expect(error.message).toMatch(/without a reason FacetDB can read|not one FacetDB can read/);
    }
  });

  it("reads a webhook's refusal from its status and plain-text reason", async () => {
    const cases: readonly (readonly [number, string, string])[] = [
      [404, "channel_not_found", "Slack finds no channel #ops"],
      [410, "no_service", "the incoming webhook for #ops was removed or disabled"],
      [403, "invalid_token", "Slack does not accept the incoming webhook for #ops"],
      [410, "channel_is_archived", "#ops is archived"],
      [403, "action_prohibited", "a Slack admin has restricted this webhook"],
    ];
    for (const [status, code, fix] of cases) {
      const hooks = fakeSlack(() => new Response(code, { status }));
      const channel = await slackWith(WITH_HOOKS, hooks.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.slackCode).toBe(code);
      expect(error.status).toBe(status);
      expect(error.fix).toContain(fix);
    }
  });

  it("gives the status alone when a refusal's body is not a reason code", async () => {
    for (const [status, body] of [
      [400, `<html>bad request for ${OPS_HOOK}</html>`],
      [502, `upstream ${TOKEN} failed`],
      [500, ""],
    ] as const) {
      const hooks = fakeSlack(() => new Response(body, { status }));
      const channel = await slackWith(WITH_HOOKS, hooks.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.status).toBe(status);
      expect(error.slackCode).toBeUndefined();
      expect(error.message).toContain(`Slack answered HTTP ${status}`);
    }
  });

  it("takes from a webhook's plain-text refusal only a reason it knows, never any other word", async () => {
    for (const body of ["true", "null", "ok", "some_lowercase_word", " false\n"]) {
      const hooks = fakeSlack(() => new Response(body, { status: 400 }));
      const channel = await slackWith(WITH_HOOKS, hooks.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.slackCode).toBeUndefined();
      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "slack:#ops was not delivered: Slack answered HTTP 400; Slack refused the request without a reason FacetDB can read: check the plugin's token or the channel's webhook",
      );
    }
  });

  it("names the Web API's own reason on a refusal that is not a 200, by the code's shape", async () => {
    for (const code of ["invalid_arguments", "brand_new_reason"]) {
      const slackApi = fakeSlack(() => Response.json({ ok: false, error: code }, { status: 400 }));
      const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.slackCode).toBe(code);
      expect(error.status).toBe(400);
    }
  });
});

describe("a body the delivery does not read", () => {
  /** A response whose body is a stream that says whether it was cancelled; it never ends by itself. */
  function watched(init: ResponseInit, failToCancel = false) {
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ok"));
      },
      cancel() {
        state.cancelled = true;
        if (failToCancel) {
          throw new Error(`cannot cancel the body of ${OPS_HOOK}`);
        }
      },
    });
    return { state, reply: () => new Response(stream, init) };
  }

  it("is cancelled after a webhook's 2xx and after a 429, from either route", async () => {
    const delivered = watched({ status: 200 });
    const hooks = fakeSlack(delivered.reply);
    await (await slackWith(WITH_HOOKS, hooks.fetch)).deliver(ALERT, "#ops");
    expect(delivered.state.cancelled).toBe(true);

    for (const settings of [WITH_HOOKS, WITH_TOKEN]) {
      const limited = watched({ status: 429, headers: { "retry-after": "5" } });
      const slackFake = fakeSlack(limited.reply);
      const error = await failure(
        (await slackWith(settings, slackFake.fetch)).deliver(ALERT, "#ops"),
      );
      expect(error.status).toBe(429);
      expect(error.retryAfterMs).toBe(5000);
      expect(limited.state.cancelled).toBe(true);
    }
  });

  it("changes nothing about the delivery when it cannot be cancelled, and keeps none of that failure", async () => {
    const delivered = watched({ status: 200 }, true);
    const hooks = fakeSlack(delivered.reply);
    const channel = await slackWith(WITH_HOOKS, hooks.fetch);
    await expect(channel.deliver(ALERT, "#ops")).resolves.toBeUndefined();
    expect(delivered.state.cancelled).toBe(true);

    const limited = watched({ status: 429 }, true);
    const slackApi = fakeSlack(limited.reply);
    const error = await failure(
      (await slackWith(WITH_TOKEN, slackApi.fetch)).deliver(ALERT, "#ops"),
    );
    expect(error.status).toBe(429);
    expect(error.message).not.toContain("cannot cancel");
  });
});

describe("a rate limit", () => {
  it("is thrown with status 429 and the wait retry-after asked for, as the SDK reads a plugin's error", async () => {
    const slackApi = fakeSlack(
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    const error = await failure(channel.deliver(ALERT, "#ops"));
    // The fields plugin/provider.ts reads from what a plugin throws.
    const { status, retryAfterMs } = error as { status?: unknown; retryAfterMs?: unknown };
    expect(status).toBe(429);
    expect(retryAfterMs).toBe(30_000);
    expect(error.message).toContain("Slack answered HTTP 429");
  });

  it("from a webhook too, with no wait when retry-after is absent or unreadable", async () => {
    for (const header of [undefined, "soon", "-1"]) {
      const hooks = fakeSlack(
        () =>
          new Response("rate_limited", {
            status: 429,
            ...(header === undefined ? {} : { headers: { "retry-after": header } }),
          }),
      );
      const channel = await slackWith(WITH_HOOKS, hooks.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.status).toBe(429);
      expect(error.retryAfterMs).toBeUndefined();
    }
  });

  it("and Slack's own ratelimited reason is a 429 as well", async () => {
    const slackApi = fakeSlack(() => Response.json({ ok: false, error: "ratelimited" }));
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    const error = await failure(channel.deliver(ALERT, "#ops"));
    expect(error.status).toBe(429);
    expect(error.slackCode).toBe("ratelimited");
  });
});

describe("a request that never gets an answer", () => {
  it("is a failure in fixed words: nothing fetch threw is kept, whatever it quoted", async () => {
    const thrown: unknown[] = [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${OPS_HOOK}`), {
          code: "ECONNREFUSED",
          url: OPS_HOOK,
        }),
      }),
      new TypeError("fetch failed", { cause: new Error(`unexpected redirect from ${OPS_HOOK}`) }),
      new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`),
      Object.assign(new Error(`request to ${OPS_HOOK} failed`), {
        request: { url: OPS_HOOK, headers: { authorization: `Bearer ${TOKEN}` } },
      }),
      `a plain string with ${TOKEN}`,
    ];
    for (const value of thrown) {
      for (const settings of [WITH_TOKEN, WITH_HOOKS]) {
        const down = fakeSlack(() => Promise.reject(value));
        const channel = await slackWith(settings, down.fetch);
        const error = await failure(channel.deliver(ALERT, "#ops"));
        expect(error.message).toContain("FacetDB could not reach Slack");
        expect(error.status).toBeUndefined();
      }
    }
  });

  it("says the request was stopped when it timed out or the worker stopped it", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const slow = fakeSlack(() => Promise.reject(new DOMException(`stopped ${OPS_HOOK}`, name)));
      const channel = await slackWith(WITH_HOOKS, slow.fetch);
      const error = await failure(channel.deliver(ALERT, "#ops"));
      expect(error.message).toContain("the request to Slack was stopped");
    }
  });
});

describe("the message", () => {
  it("is plain text: its severity in a word, the alert's words and its link, with Slack's markup escaped", async () => {
    const slackApi = fakeSlack();
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    await channel.deliver(
      {
        kind: "record-notification",
        severity: "information",
        text: "Refund asked by <!channel> & <https://evil.example|your invoice> <@U012> <!here>",
        link: "https://studio.example.com/records?source=tickets&q=<x>",
      },
      "#ops",
    );
    await channel.deliver(
      { kind: "system-alert", severity: "warning", text: "The worker is behind." },
      "#ops",
    );
    expect(sent(slackApi.calls[0])["text"]).toBe(
      "Information: Refund asked by &lt;!channel&gt; &amp; &lt;https://evil.example|your invoice&gt; &lt;@U012&gt; &lt;!here&gt;\n<https://studio.example.com/records?source=tickets&amp;q=%3Cx%3E>",
    );
    expect(sent(slackApi.calls[1])["text"]).toBe("Warning: The worker is behind.");
  });

  it("wraps an http or https link as <url> that nothing in it can close or label, and leaves any other bare", async () => {
    const slackApi = fakeSlack();
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    const linked = async (link: string) => {
      await channel.deliver({ ...ALERT, text: "x", link }, "#ops");
      return String(sent(slackApi.calls.at(-1))["text"]).split("\n")[1];
    };
    // A `|` would add a label, a `>` or a space would close the link early: none stays raw.
    expect(await linked("https://studio.example.com/a|b?q=one two>|<!channel>&x=1")).toBe(
      "<https://studio.example.com/a%7Cb?q=one%20two%3E%7C%3C!channel%3E&amp;x=1>",
    );
    expect(await linked("http://127.0.0.1:4040/records/T-1042")).toBe(
      "<http://127.0.0.1:4040/records/T-1042>",
    );
    expect(await linked("https://studio.example.com/x#a|b>c")).toBe(
      "<https://studio.example.com/x#a%7Cb%3Ec>",
    );
    // Not an http or https URL: escaped, and never wrapped into a link.
    expect(await linked("javascript:alert(1)|<!channel>")).toBe(
      "javascript:alert(1)|&lt;!channel&gt;",
    );
    expect(await linked("mailto:ops@example.com")).toBe("mailto:ops@example.com");
    expect(await linked("not a url <!here>")).toBe("not a url &lt;!here&gt;");
    for (const call of slackApi.calls) {
      const link = String(sent(call)["text"]).split("\n")[1] ?? "";
      if (link.startsWith("<")) {
        // Inside the brackets: nothing that closes them, labels the link or ends it early.
        expect(link.endsWith(">")).toBe(true);
        expect(link.slice(1, -1)).not.toMatch(/[<>|\s]/);
      } else {
        expect(link).not.toMatch(/[<>]/);
      }
    }
  });

  it("cuts a long text to 4,000 units with a marker, keeping the link whole", async () => {
    const slackApi = fakeSlack();
    const channel = await slackWith(WITH_TOKEN, slackApi.fetch);
    const textOf = async (message: ChannelMessage) => {
      await channel.deliver(message, "#ops");
      return String(sent(slackApi.calls.at(-1))["text"]);
    };
    const link = "<https://studio.example.com/alerts?event=key&amp;source=tickets>";
    const marker = " … (cut to fit Slack; the link has the rest)";

    const plain = await textOf({ ...ALERT, text: "a".repeat(10_000) });
    expect(plain).toHaveLength(4000);
    expect(plain.endsWith(`a${marker}\n${link}`)).toBe(true);

    // Just at the bound: sent whole, no marker.
    const head = "Critical: ";
    const exact = "b".repeat(4000 - head.length - `\n${link}`.length);
    expect(await textOf({ ...ALERT, text: exact })).toBe(`${head}${exact}\n${link}`);

    // Counted after escaping, and never cut inside an escape.
    const escaped = await textOf({
      kind: "system-alert",
      severity: "critical",
      text: "&".repeat(2000),
    });
    expect(escaped.length).toBeLessThanOrEqual(4000);
    expect(escaped.length).toBeGreaterThan(4000 - "&amp;".length - marker.length);
    expect(escaped.startsWith(head)).toBe(true);
    expect(escaped.endsWith(marker)).toBe(true);
    expect(escaped.slice(head.length, -marker.length)).toMatch(/^(&amp;)+$/);

    // Never a lone half of a surrogate pair, wherever the cut falls.
    for (const lead of ["", "a"]) {
      const emoji = await textOf({ ...ALERT, text: `${lead}${"😀".repeat(3000)}` });
      expect(emoji.length).toBeLessThanOrEqual(4000);
      expect(emoji.endsWith(`${marker}\n${link}`)).toBe(true);
      expect(emoji).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });
});

describe("slack.notify", () => {
  it("builds the action call a config file holds, which the config accepts", () => {
    expect(slack.notify({ channel: "#support-urgent", when: { urgent: true } })).toEqual({
      plugin: "@facetdb/slack",
      action: "notify",
      config: { channel: "#support-urgent", when: { urgent: true } },
    });
    expect(slack.notify({ channel: "#ops" })).toEqual({
      plugin: "@facetdb/slack",
      action: "notify",
      config: { channel: "#ops" },
    });
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "tickets",
          api: true,
          read: ["body"],
          questions: { urgent: noul("Is this urgent?") },
          actions: [slack.notify({ channel: "#support-urgent", when: { urgent: true } })],
        },
      ],
    });
    expect(config.sources[0]?.actions).toEqual([
      slack.notify({ channel: "#support-urgent", when: { urgent: true } }),
    ]);
  });
});
