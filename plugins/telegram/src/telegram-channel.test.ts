import { inspect } from "node:util";
import { env, facetdb, noul, type PluginSettings, VERSION } from "facetdb";
import {
  createPluginHost,
  loadPlugin,
  type Plugin,
  type PluginContext,
  type PluginHostError,
} from "facetdb/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, {
  CUT_MARKER,
  MESSAGE_MAX,
  RETRY_AFTER_MAX_S,
  TELEGRAM_API,
  TelegramDeliveryError,
  type TelegramFetch,
  TIMEOUT_MS,
  telegram,
  telegramPlugin,
} from "./index.ts";

/**
 * The Telegram channel, on a handwritten `fetch`: the settings go through the plugin host as the
 * worker loads them, each address's `where` through the channel's own schema as the worker binds
 * it, and nothing reaches the network. The bot token sits in the request's path, so every error is
 * searched for it, its encoded form, its secret half and the URL, and an assertion that fails names
 * the place it found one, never the value.
 */

/** A token of the shape @BotFather gives; every form of it is searched for in every error. */
const TOKEN = "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const VARIABLE = "TELEGRAM_BOT_TOKEN";
const GROUP = "-1001234567890";
const signal = new AbortController().signal;

type Init = Parameters<TelegramFetch>[1];
type Call = { readonly url: string; readonly init: Init };
type Reply = (call: Call) => Promise<Awaited<ReturnType<TelegramFetch>>>;

/** A body Telegram could send back, as `fetch`'s response hands it over. */
function answer(status: number, body: unknown): Reply {
  return async () => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

const OK = answer(200, { ok: true, result: { message_id: 7 } });

/** A `fetch` that records each call and answers with `reply`. */
function fakeFetch(reply: Reply = OK) {
  const calls: Call[] = [];
  const fetch: TelegramFetch = async (url, init) => {
    calls.push({ url, init });
    return reply({ url, init });
  };
  return { calls, fetch };
}

function project(settings: PluginSettings = { token: env(VARIABLE) }) {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { telegram: settings },
    alerts: { channels: [`telegram:${GROUP}`] },
    sources: [
      { name: "tickets", api: true, read: ["body"], questions: { urgent: noul("Is it urgent?") } },
    ],
  });
}

/** Imports `@facetdb/telegram` as the given plugin; any other package is not installed. */
function importing(installed: Plugin) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/telegram") {
      return { default: installed };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

function hostFor(installed: Plugin, token: string, settings?: PluginSettings) {
  return createPluginHost({
    config: project(settings),
    env: { [VARIABLE]: token },
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: importing(installed),
    builtins: {},
  });
}

/** The channel's name: an address's kind, `telegram:<chat id>`. */
const CHANNEL = "telegram";

function channelOf(installed: Plugin) {
  const entry = installed.channels[CHANNEL];
  if (entry === undefined) {
    throw new Error("the plugin has no telegram channel");
  }
  return entry;
}

/**
 * The channel as the worker would run it: the context from the host, the address bound through
 * the channel's schema. Returns what `deliver` resolved to, or what it threw.
 */
async function bound(reply?: Reply, token = TOKEN) {
  const fake = fakeFetch(reply);
  const installed = telegramPlugin({ fetch: fake.fetch });
  const host = await hostFor(installed, token);
  const ctx = host.contextFor("telegram", signal);
  const entry = channelOf(installed);
  const send = (where: string, text = "The model failed 6 of 10 calls.", link?: string) =>
    entry.deliver(
      ctx,
      {
        kind: "system-alert",
        severity: "critical",
        text,
        ...(link === undefined ? {} : { link }),
      },
      entry.config.parse({ where }),
    );
  return { ...fake, send };
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("the delivery succeeded, and a failure was expected");
    },
    (caught: unknown) => caught,
  );
}

/**
 * The forms of a token a leak could take: itself, encoded for a path, the URL, and every
 * 8-character piece of its secret half, the same pieces bot-api.ts drops from a description, so
 * a partial leak is found as a whole one is.
 */
function formsOf(token: string): readonly string[] {
  const secretHalf = token.slice(token.indexOf(":") + 1);
  const pieces: string[] = [];
  for (let at = 0; at + 8 <= secretHalf.length; at += 1) {
    pieces.push(secretHalf.slice(at, at + 8));
  }
  return [
    token,
    encodeURIComponent(token),
    encodeURIComponent(token).replaceAll("%3A", ":"),
    secretHalf,
    ...pieces,
    `${TELEGRAM_API}/bot`,
  ];
}

/**
 * Every place in `value` (an error and all it holds: message, stack, own properties, cause, its
 * JSON, its inspection) where a form of `token` is found, by name; empty when none is. The names
 * are all an assertion prints, so a failure never shows the token.
 */
function leaks(value: unknown, token: string): string[] {
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
 * A delivery failure that holds no form of the token and no `cause`. The search runs first and
 * every check compares a boolean or a list of places, so that a regression rethrowing what `fetch`
 * threw fails here without the received error ever being printed.
 */
function failure(error: unknown, token = TOKEN): TelegramDeliveryError {
  expect(leaks(error, token)).toEqual([]);
  expect(error instanceof TelegramDeliveryError).toBe(true);
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  return error as TelegramDeliveryError;
}

/** The request's path with the token replaced, so that a failing assertion never prints it. */
function pathOf(call: Call, token = TOKEN): string {
  const url = new URL(call.url);
  const segment = encodeURIComponent(token).replaceAll("%3A", ":");
  return `${url.origin}${url.pathname.replace(segment, "<token>")}${url.search}${url.hash}`;
}

describe("the search for the token", () => {
  it("finds each form wherever an error could carry it, and names only the place", () => {
    const url = `${TELEGRAM_API}/bot${TOKEN}/sendMessage`;
    expect(leaks(new Error(url), TOKEN)).toContain("error.message");
    expect(leaks(new Error("failed", { cause: new Error(url) }), TOKEN)).toContain(
      "error.cause.message",
    );
    expect(
      leaks(
        Object.assign(new Error("failed"), { request: { path: encodeURIComponent(TOKEN) } }),
        TOKEN,
      ),
    ).toContain("error.request.path");
    expect(leaks(Object.assign(new Error("failed"), { url: new URL(url) }), TOKEN)).toContain(
      "error inspected",
    );
    expect(leaks(new Error(`…${TOKEN.slice(10)}`), TOKEN)).toContain("error.message");
    // A partial leak: 20 characters from the middle of the secret half, then the shortest found.
    expect(leaks(new Error(`seen: ${TOKEN.slice(14, 34)}`), TOKEN)).toContain("error.message");
    expect(leaks({ code: TOKEN.slice(20, 28).toUpperCase() }, TOKEN)).toContain("error.code");
    expect(leaks(new Error(`seen: ${TOKEN.slice(20, 27)}`), TOKEN)).toEqual([]);
    expect(leaks(new Error("failed"), TOKEN)).toEqual([]);
  });
});

describe("the Telegram plugin", () => {
  it("passes loadPlugin's checks, with the token its one secret and a telegram channel", async () => {
    const loaded = await loadPlugin("telegram", {
      coreVersion: VERSION,
      importModule: importing(plugin),
    });
    expect(loaded.manifest.name).toBe("telegram");
    expect(loaded.manifest.kinds).toEqual(["channel"]);
    expect(loaded.manifest.secrets).toEqual(["token"]);
    expect(Object.keys(loaded.channels)).toEqual(["telegram"]);
  });

  it("refuses a token written into the config file: it is read from a variable", async () => {
    const error = (await thrown(hostFor(plugin, TOKEN, { token: TOKEN }))) as PluginHostError;
    expect(leaks(error, TOKEN)).toEqual([]);
    expect(error.code).toBe("plugin-secret-literal");
  });

  it("builds a notify action for a chat, with its condition", () => {
    expect(telegram.notify({ channel: "@acme_ops", when: { urgent: true } })).toEqual({
      plugin: "@facetdb/telegram",
      action: "notify",
      config: { channel: "@acme_ops", when: { urgent: true } },
    });
    expect(telegram.notify({ channel: GROUP }).config).toEqual({ channel: GROUP });
  });
});

describe("deliver sends one sendMessage to api.telegram.org", () => {
  it("to a numeric chat: the text and the link, as plain text with link previews off", async () => {
    const channel = await bound();
    await expect(
      channel.send(GROUP, "The model failed 6 of 10 calls.", "http://localhost:4400/alerts"),
    ).resolves.toBeUndefined();
    expect(channel.calls).toHaveLength(1);
    const [call] = channel.calls as [Call];
    expect(pathOf(call)).toBe("https://api.telegram.org/bot<token>/sendMessage");
    // A real token goes into the path exactly as typed, its colon not escaped (compared as a
    // boolean, so that a failure does not print it).
    expect(call.url === `${TELEGRAM_API}/bot${TOKEN}/sendMessage`).toBe(true);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    // The worker's signal and the 10-second deadline, combined; neither has fired.
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.signal.aborted).toBe(false);
    expect(call.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(call.init.body)).toEqual({
      chat_id: GROUP,
      text: "The model failed 6 of 10 calls.\n\nhttp://localhost:4400/alerts",
      link_preview_options: { is_disabled: true },
    });
    // The token travels in the path alone.
    expect(leaks(call.init, TOKEN)).toEqual([]);
  });

  it("to a public channel's @name, and a private chat's positive number", async () => {
    const channel = await bound();
    await channel.send("@acme_ops", "Backfill finished.");
    await channel.send("424242", "Backfill finished.");
    expect(channel.calls.map((call) => JSON.parse(call.init.body).chat_id)).toEqual([
      "@acme_ops",
      "424242",
    ]);
    expect(JSON.parse((channel.calls[0] as Call).init.body).text).toBe("Backfill finished.");
  });

  it("sends the same message twice when it is delivered twice: a channel does not deduplicate", async () => {
    const channel = await bound();
    await channel.send(GROUP, "same");
    await channel.send(GROUP, "same");
    expect(channel.calls).toHaveLength(2);
  });

  it("sends a record's words as they are: no parse_mode, so Markdown and HTML stay text", async () => {
    const channel = await bound();
    const words = "*urgent* <b>refund</b> [click](https://evil.example) `code`";
    await channel.send(GROUP, words);
    const body = JSON.parse((channel.calls[0] as Call).init.body);
    expect(body.text).toBe(words);
    expect(Object.keys(body)).not.toContain("parse_mode");
  });

  it("cuts a message over 4096 characters with a marker, keeps the link whole, and sends one message", async () => {
    const channel = await bound();
    const link = "http://localhost:4400/sources/tickets/review?question=urgent";
    // Emoji are two UTF-16 units each: the cut never leaves half of one.
    await channel.send(GROUP, "🔥".repeat(5000), link);
    expect(channel.calls).toHaveLength(1);
    const text: string = JSON.parse((channel.calls[0] as Call).init.body).text;
    expect(text.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(text.endsWith(`${CUT_MARKER}\n\n${link}`)).toBe(true);
    expect(text.isWellFormed()).toBe(true);
    // Exactly at the limit, nothing is cut.
    const fits = "a".repeat(MESSAGE_MAX - link.length - 2);
    await channel.send(GROUP, fits, link);
    expect(JSON.parse((channel.calls[1] as Call).init.body).text).toBe(`${fits}\n\n${link}`);
  });

  it("refuses, without sending, a link longer than a whole message", async () => {
    const channel = await bound();
    const error = failure(
      await thrown(channel.send(GROUP, "text", `http://localhost/${"a".repeat(MESSAGE_MAX)}`)),
    );
    expect(error.message).toMatch(/a link is never cut/);
    expect(channel.calls).toHaveLength(0);
  });
});

describe("an address binds only a chat id or an @channel", () => {
  const entry = channelOf(plugin);
  it.each([
    "#ops",
    "ops",
    "",
    "@ab",
    "@1channel",
    "@chan nel",
    "12ab",
    "-",
    "1.5",
    "007",
    "-0",
    "telegram:-100123",
    "12345678901234567",
  ])("refuses %j with the forms it takes", (where) => {
    const parsed = entry.config.safeParse({ where });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(
      /"telegram:<chat id>": the chat's number \(negative for a group or a channel, such as -1001234567890\) or a public channel's @name/,
    );
  });

  it.each([GROUP, "-123456", "424242", "@acme_ops", "@Acme_Ops_2026"])("binds %j", (where) => {
    expect(entry.config.parse({ where })).toEqual({ where });
  });
});

describe("the token is refused when the config loads if it could change the request", () => {
  it.each([
    ["a slash", `${TOKEN}/../getUpdates`],
    ["a question mark", `${TOKEN}?chat_id=1`],
    ["a hash", `${TOKEN}#frag`],
    ["an at sign", `evil.example@${TOKEN}`],
    ["a space", `110201543:AAHdqTcvCH1v GWJxfSeofSAs0K5PALDsaw`],
    ["a line break", `${TOKEN}\n`],
    ["two dots", `110201543:AAHdqTcvCH1v..GWJxfSeofSAs0K5PALDsaw`],
    ["a percent escape", `110201543:AAHdqTcvCH1v%2FGWJxfSeofSAs0K5PALDsaw`],
    ["no colon", "110201543AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"],
  ])("holding %s, in words that name the setting and never the value", async (_, token) => {
    const error = (await thrown(hostFor(plugin, token))) as PluginHostError;
    // Searched first: the assertions after it may print the message.
    expect(leaks(error, token)).toEqual([]);
    expect(error.code).toBe("plugin-settings");
    expect(error.message).toContain("plugins.telegram.token");
    expect(error.message).toContain(VARIABLE);
  });

  it("refuses the same tokens through the schema's own words, which quote no value either", () => {
    const parsed = plugin.manifest.config.safeParse({ token: `${TOKEN}/x` });
    expect(parsed.success).toBe(false);
    expect(leaks(parsed.error, `${TOKEN}/x`)).toEqual([]);
  });
});

describe("a failed delivery says what Telegram said and what to do, and never quotes the token", () => {
  it("ok: false, chat not found: Telegram's words and the fix", async () => {
    const channel = await bound(
      answer(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    );
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(400);
    expect(error.message).toContain(
      'Telegram refused sendMessage (status 400): "Bad Request: chat not found"',
    );
    expect(error.fix).toMatch(/check the chat id .* add the bot to that group or channel/);
    expect(error.message).toContain(error.fix);
  });

  it("ok: false to a person who never wrote to the bot: they must send it /start", async () => {
    const channel = await bound(
      answer(403, {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      }),
    );
    const error = failure(await thrown(channel.send("424242")));
    expect(error.status).toBe(403);
    expect(error.fix).toMatch(/send it \/start/);
  });

  it("ok: false from a chat the bot is not in: add the bot", async () => {
    const channel = await bound(
      answer(403, {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot is not a member of the channel chat",
      }),
    );
    expect(failure(await thrown(channel.send("@acme_ops"))).fix).toMatch(/add the bot/);
  });

  it("ok: false for a group that became a supergroup: the new chat id", async () => {
    const channel = await bound(
      answer(400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: -1009876543210 },
      }),
    );
    expect(failure(await thrown(channel.send("-123456"))).fix).toContain("telegram:-1009876543210");
  });

  it("a 401: Telegram does not know the token, which is named by its setting only", async () => {
    const channel = await bound(
      answer(401, { ok: false, error_code: 401, description: "Unauthorized" }),
    );
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(401);
    expect(error.fix).toMatch(/plugins\.telegram\.token/);
  });

  it.each([
    ["the path", `Not Found: /bot${TOKEN}/sendMessage`],
    ["the token", `token ${TOKEN} is invalid`],
    ["the encoded token", `bad ${encodeURIComponent(TOKEN)}`],
    ["the bot's number and the token's first piece", `${TOKEN.slice(0, 18)}`],
    ["a cut piece of the secret half", "Not Found: …SAs0K5PAL"],
    ["the token in upper case", TOKEN.toUpperCase()],
    ["the token split by zero-width spaces", TOKEN.split("").join(String.fromCodePoint(0x200b))],
    ["the token split by line breaks", TOKEN.match(/.{1,4}/g)?.join("\n") ?? ""],
  ])("drops a description that repeats %s", async (_, description) => {
    const channel = await bound(answer(404, { ok: false, error_code: 404, description }));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.message).toContain("Telegram refused sendMessage (status 404). ");
    expect(error.fix).toMatch(/does not know this bot token/);
  });

  it("strips control characters from a description and holds it to 200 characters", async () => {
    // An escape sequence, a right-to-left override and a line break, then far too many words.
    const override = String.fromCodePoint(0x202e);
    const description = `Bad Request:\u001b[31m chat${override} not found\r\n${"x".repeat(500)}`;
    const channel = await bound(answer(400, { ok: false, error_code: 400, description }));
    const error = failure(await thrown(channel.send(GROUP)));
    const quoted = /"([^"]*)"/.exec(error.message)?.[1] ?? "";
    expect(quoted.startsWith("Bad Request: [31m chat not found x")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(200);
    expect(quoted.endsWith("…")).toBe(true);
    expect(/[\p{Cc}\p{Cf}]/u.test(error.message)).toBe(false);
  });

  it("a 429 is thrown with status 429 and Telegram's retry_after, as the SDK reads a rate limit", async () => {
    const channel = await bound(
      answer(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 7",
        parameters: { retry_after: 7 },
      }),
    );
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
    expect(error.message).toMatch(/retry after 7 s/);
  });

  it("a 429 with no retry_after is still a 429, with no wait", async () => {
    const channel = await bound(answer(429, { ok: false, parameters: { retry_after: "soon" } }));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBeUndefined();
  });

  it.each([
    ["a day", "86400", RETRY_AFTER_MAX_S * 1000],
    ["far more than a day", "1000000000000", RETRY_AFTER_MAX_S * 1000],
    ["a fraction of a second", "0.25", 250],
    ["no wait at all", "0", 0],
    ["a negative wait", "-5", undefined],
    ["an endless wait (1e400 reads as Infinity)", "1e400", undefined],
  ])("a 429 asking for %s passes on a wait held to one hour", async (_, wait, expected) => {
    const body = `{"ok":false,"error_code":429,"parameters":{"retry_after":${wait}}}`;
    const channel = await bound(answer(429, body));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(expected);
  });

  it("a server error with ok: false says Telegram failed on its side, with the status", async () => {
    const channel = await bound(
      answer(502, { ok: false, error_code: 502, description: "Bad Gateway" }),
    );
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(502);
    expect(error.message).toContain(
      'Telegram failed on its side answering sendMessage (status 502): "Bad Gateway"',
    );
    expect(error.fix).toBe(
      "the trouble is Telegram's, not the settings' or the chat's: the delivery is tried again later",
    );
    expect(error.fix).not.toMatch(/bot is in the chat/);
  });

  it("a body that is not JSON (a proxy's page, quoting the URL) is a fixed phrase and the status", async () => {
    const page = `<html><body>502 Bad Gateway: ${TELEGRAM_API}/bot${TOKEN}/sendMessage</body></html>`;
    const channel = await bound(answer(502, page));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBe(502);
    expect(error.message).toContain(
      "sendMessage was answered with status 502 and a body that is not the Bot API's JSON",
    );
    expect(error.message).not.toContain("Bad Gateway");
  });

  it("JSON of another shape is a failed delivery too, even with status 200", async () => {
    const channel = await bound(answer(200, { result: { url: `${TELEGRAM_API}/bot${TOKEN}` } }));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.message).toContain("JSON that is not the Bot API's answer");
  });

  it("an answer whose body breaks off is a failed delivery that may have been sent", async () => {
    const channel = await bound(async ({ url }) => ({
      status: 200,
      text: async () => {
        throw new Error(`terminated while reading ${url}`);
      },
    }));
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.fix).toMatch(/may or may not have been sent/);
  });

  it("a network error whose message and cause carry the URL: only the method and the code are kept", async () => {
    const channel = await bound(async ({ url }) => {
      const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND api.telegram.org ${url}`), {
        code: "ENOTFOUND",
        url,
      });
      throw Object.assign(new TypeError(`fetch failed: ${url}`, { cause }), { url });
    });
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.status).toBeUndefined();
    expect(error.message).toMatch(/^Telegram could not be reached for sendMessage \(ENOTFOUND\)/);
    expect(error.fix).toMatch(/api\.telegram\.org/);
  });

  it("a refused redirect is a network error too, and no request follows it", async () => {
    const channel = await bound(async ({ url }) => {
      throw new TypeError(`fetch failed: redirect mode is set to error: ${url}`);
    });
    failure(await thrown(channel.send(GROUP)));
    expect(channel.calls).toHaveLength(1);
  });

  it("a code that is not a plain word is not kept", async () => {
    const channel = await bound(async ({ url }) => {
      throw Object.assign(new Error("failed"), { code: url });
    });
    const error = failure(await thrown(channel.send(GROUP)));
    expect(error.message).toMatch(/^Telegram could not be reached for sendMessage: /);
  });

  // A token whose secret half is all capitals, digits and `_`: it reads as a code such as ENOTFOUND.
  const SHOUTED = "123456789:ABCDEFGHJKLMNPQRSTUVWXYZ_23456";

  it.each([
    ["the whole secret half", SHOUTED.slice(10)],
    ["a 12-character piece of it", SHOUTED.slice(14, 26)],
  ])("a code that is %s of a code-shaped token is not kept", async (_, code) => {
    const channel = await bound(async () => {
      throw Object.assign(new Error("failed"), { cause: Object.assign(new Error("x"), { code }) });
    }, SHOUTED);
    const error = failure(await thrown(channel.send(GROUP)), SHOUTED);
    expect(error.message).toMatch(/^Telegram could not be reached for sendMessage: /);
  });

  it("a delivery stopped by the worker's signal says so", async () => {
    const fake = fakeFetch(async ({ url }) => {
      throw new DOMException(`This operation was aborted: ${url}`, "AbortError");
    });
    const installed = telegramPlugin({ fetch: fake.fetch });
    const host = await hostFor(installed, TOKEN);
    const stop = new AbortController();
    stop.abort();
    const entry = channelOf(installed);
    const error = failure(
      await thrown(
        entry.deliver(
          host.contextFor("telegram", stop.signal),
          { kind: "system-alert", severity: "warning", text: "x" },
          entry.config.parse({ where: GROUP }),
        ),
      ),
    );
    expect(error.message).toMatch(/^sendMessage was stopped before Telegram answered/);
  });
});

describe("a delivery ends after 10 seconds or when the worker stops, whichever comes first", () => {
  // The deadline is a timer: the fake clock drives it, no test waits for real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A promise's outcome once it settles, and whether it has. */
  function watched(promise: Promise<unknown>) {
    const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
    const done = promise.then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error;
      },
    );
    return { state, done };
  }

  it("@timing a Telegram that never answers (a fetch that ignores its signal) fails at 10 seconds, its timer gone", async () => {
    const channel = await bound(() => new Promise(() => undefined));
    const delivery = watched(channel.send(GROUP));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(delivery.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delivery.done;
    const error = failure(delivery.state.error);
    expect(error.message).toMatch(/^sendMessage got no answer from Telegram within 10 seconds/);
    expect(error.status).toBeUndefined();
    expect((channel.calls[0] as Call).init.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("@timing an answer whose body never ends fails at 10 seconds, with the status", async () => {
    const channel = await bound(async () => ({
      status: 200,
      text: () => new Promise<string>(() => undefined),
    }));
    const delivery = watched(channel.send(GROUP));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await delivery.done;
    const error = failure(delivery.state.error);
    expect(error.message).toMatch(
      /^Telegram's answer to sendMessage \(status 200\) did not finish within 10 seconds/,
    );
    expect(error.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("@timing the worker's signal ends a delivery before the deadline, and clears its timer", async () => {
    const fake = fakeFetch(() => new Promise(() => undefined));
    const installed = telegramPlugin({ fetch: fake.fetch });
    const host = await hostFor(installed, TOKEN);
    const stop = new AbortController();
    const entry = channelOf(installed);
    const delivery = watched(
      entry.deliver(
        host.contextFor("telegram", stop.signal),
        { kind: "system-alert", severity: "warning", text: "x" },
        entry.config.parse({ where: GROUP }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    stop.abort();
    await delivery.done;
    const error = failure(delivery.state.error);
    expect(error.message).toMatch(/^sendMessage was stopped before Telegram answered/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("@timing a delivery Telegram takes leaves no timer running", async () => {
    const channel = await bound();
    await channel.send(GROUP);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a token the schema never saw cannot move the request either", () => {
  // `deliver` trusts its settings, which the host parsed; this context skips the host on purpose,
  // to show the URL is built so that no token can leave api.telegram.org or the sendMessage path.
  const odd = "1:a/../b?c=d#e@evil.example %2F..";

  it("goes to api.telegram.org, the token one encoded path segment, and no form of it is thrown", async () => {
    const fake = fakeFetch(async ({ url }) => {
      throw new TypeError(`fetch failed: ${url}`, { cause: new Error(url) });
    });
    const installed = telegramPlugin({ fetch: fake.fetch });
    const entry = channelOf(installed);
    const ctx: PluginContext<{ token: string }> = {
      config: { token: odd },
      secrets: { token: odd },
      signal,
    };
    const error = failure(
      await thrown(
        entry.deliver(
          ctx,
          { kind: "record-notification", severity: "information", text: "x" },
          entry.config.parse({ where: GROUP }),
        ),
      ),
      odd,
    );
    expect(error.status).toBeUndefined();
    const url = new URL((fake.calls[0] as Call).url);
    expect(url.origin).toBe("https://api.telegram.org");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
    expect(url.pathname.split("/").length).toBe(3);
    expect(pathOf(fake.calls[0] as Call, odd)).toBe(
      "https://api.telegram.org/bot<token>/sendMessage",
    );
  });
});
