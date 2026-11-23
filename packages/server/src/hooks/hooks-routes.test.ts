import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import type { HookDelivery, HookOutcome, HooksDoor } from "./door.ts";
import { HOOK_BODY_MAX_BYTES, isHookUrl } from "./routes.ts";

/**
 * `POST /v1/hooks/:plugin/:source` over a door that records what it was handed and answers what the
 * test gives it: every outcome mapped to its status and fixed words; the exact bytes and the
 * headers handed on, nothing parsed, FacetDB's cookie left out; reached by a stranger with no
 * cookie, no API key and from another site; a body past 5 MB refused before the door hears; and
 * every other method or path under /v1, a route added after the app was made included, still the
 * reviewer's alone.
 */

const PROJECT = "tracker-app";
const KEY = "Bearer fdb_tracker";
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const MAYA = `${SESSION_COOKIE}=maya.valid`;

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(header === KEY ? { id: "key-1", projectId: PROJECT } : undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

/** This machine is the OS user; a cookie `maya.valid` is maya, from anywhere. */
const sessions: Sessions = {
  signIn: () => Promise.reject(new Error("these tests sign nobody in")),
  reviewerFor: ({ local, cookie }) =>
    Promise.resolve(
      cookie === "maya.valid"
        ? { kind: "reviewer", name: "maya" }
        : cookie === undefined && local
          ? { kind: "reviewer", name: "os:alex" }
          : { kind: "sign-in", why: cookie === undefined ? "no-cookie" : "invalid" },
    ),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => Promise.reject(new Error("these tests read no configuration")),
  validate: () => {
    throw new Error("these tests judge no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test no draft")),
  diff: () => Promise.reject(new Error("these tests ask for no diff")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
};

const NO_DATA: DataServices = {
  runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
  decisions: {
    search: () => Promise.reject(new Error("these tests search no decisions")),
    why: () => Promise.reject(new Error("these tests explain no record")),
  },
  home: { home: () => Promise.reject(new Error("these tests read no home")) },
  sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
  alerts: { alerts: () => Promise.reject(new Error("these tests read no alerts")) },
  access: { access: () => Promise.reject(new Error("these tests read no studio access")) },
};

type Heard = { readonly plugin: string; readonly source: string; readonly delivery: HookDelivery };

/** The CLI's door as a recorder: what it was handed, and the outcome the test gives. */
function hooksDoor(outcome: HookOutcome = { kind: "answered", status: 202, queued: 1 }) {
  const heard: Heard[] = [];
  const door: HooksDoor = {
    receive: (plugin, source, delivery) => {
      heard.push({ plugin, source, delivery });
      return Promise.resolve(outcome);
    },
  };
  return { heard, door };
}

function appWith(door: HooksDoor | undefined) {
  return createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: NO_DATA,
    review: NO_REVIEW,
    ...(door === undefined ? {} : { hooks: door }),
    studio: {
      sessions,
      reviewers: {
        list: () => Promise.reject(new Error("these tests list no reviewers")),
        add: () => Promise.reject(new Error("these tests add no reviewer")),
        canAdd: () => Promise.resolve(false),
      },
      projectId: PROJECT,
      operatorByAddress: true,
      log: () => undefined,
    },
    newRequestId: () => "req-1",
  });
}

/** A stranger's delivery: from another machine, with no cookie and no key unless the test adds one. */
async function deliver(
  app: ReturnType<typeof appWith>,
  options: {
    readonly path?: string;
    readonly method?: string;
    readonly body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
    readonly headers?: Readonly<Record<string, string>>;
    readonly peer?: { readonly remoteAddress: string };
  } = {},
) {
  const method = options.method ?? "POST";
  const response = await app.request(
    new Request(`http://worker.example.com${options.path ?? "/v1/hooks/tracker/issues"}`, {
      method,
      headers: { ...options.headers },
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: options.body === undefined ? '{"changed":["k1"]}' : options.body }),
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
    undefined,
    options.peer ?? ELSEWHERE,
  );
  const text = await response.text();
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    text,
    json: JSON.parse(text) as Record<string, unknown>,
  };
}

describe("POST /v1/hooks/:plugin/:source maps what became of a delivery (hooks-routes)", () => {
  it("answers a delivery taken 202 with how many records it queued, and nothing else", async () => {
    const t = hooksDoor({ kind: "answered", status: 202, queued: 1 });
    expect(await deliver(appWith(t.door))).toMatchObject({ status: 202, json: { queued: 1 } });
    expect(t.heard.map(({ plugin, source }) => [plugin, source])).toEqual([["tracker", "issues"]]);

    // Any 2xx the plugin answers is a delivery taken; an event with no key queues nothing.
    for (const status of [200, 204]) {
      const none = await deliver(appWith(hooksDoor({ kind: "answered", status, queued: 0 }).door));
      expect(none).toMatchObject({ status: 202 });
      expect(none.json).toEqual({ queued: 0 });
    }
  });

  it("maps each status a plugin answers, GitHub's among them, to fixed words in the one error shape", async () => {
    const cases: readonly (readonly [HookOutcome, number, string])[] = [
      [{ kind: "answered", status: 400, queued: 0 }, 400, "bad_event"],
      [{ kind: "answered", status: 401, queued: 0 }, 401, "bad_signature"],
      [{ kind: "answered", status: 404, queued: 0 }, 404, "unknown_hook"],
      [{ kind: "answered", status: 413, queued: 0 }, 413, "body_too_large"],
      [{ kind: "answered", status: 422, queued: 0 }, 422, "not_this_source"],
      // Any other 4xx is the plugin refusing it, said as a 400.
      [{ kind: "answered", status: 403, queued: 0 }, 400, "event_refused"],
      [{ kind: "answered", status: 429, queued: 0 }, 400, "event_refused"],
      // A 503 is a source that cannot take events now; anything else is the plugin failing.
      [{ kind: "answered", status: 503, queued: 0 }, 503, "source_not_running"],
      [{ kind: "answered", status: 500, queued: 0 }, 500, "hook_failed"],
      [{ kind: "answered", status: 302, queued: 0 }, 500, "hook_failed"],
      [{ kind: "answered", status: 101, queued: 0 }, 500, "hook_failed"],
      [{ kind: "unknown" }, 404, "unknown_hook"],
      [{ kind: "not_running", retryAfterSeconds: 45 }, 503, "source_not_running"],
      [{ kind: "failed" }, 500, "hook_failed"],
      // The plugin had not taken it within 10 seconds: the source runs, its plugin was slow.
      [{ kind: "timed_out" }, 504, "hook_timeout"],
    ];
    for (const [outcome, status, code] of cases) {
      const answer = await deliver(appWith(hooksDoor(outcome).door));
      expect(answer.status, JSON.stringify(outcome)).toBe(status);
      const { error } = answer.json as { error: Record<string, unknown> };
      expect(Object.keys(error).sort()).toEqual(["code", "fix", "message"]);
      expect(error["code"]).toBe(code);
      expect(answer.json).not.toHaveProperty("queued");
    }
  });

  it("says when to send again: the door's wait for a stopped source, 30 seconds for a plugin's own 503", async () => {
    expect(
      await deliver(appWith(hooksDoor({ kind: "not_running", retryAfterSeconds: 45 }).door)),
    ).toMatchObject({ status: 503, retryAfter: "45" });
    expect(
      await deliver(appWith(hooksDoor({ kind: "answered", status: 503, queued: 0 }).door)),
    ).toMatchObject({ status: 503, retryAfter: "30" });
  });

  it("answers 404 for a surface with no door, and for a name of no plugin source's shape, the door never asked", async () => {
    expect(await deliver(appWith(undefined))).toMatchObject({
      status: 404,
      json: { error: { code: "unknown_hook" } },
    });
    const t = hooksDoor();
    for (const path of [
      "/v1/hooks/Tracker/issues",
      "/v1/hooks/tracker/is%20sues",
      "/v1/hooks/tracker/issues%0Aforged",
      "/v1/hooks/tracker/1issues",
    ]) {
      expect(await deliver(appWith(t.door), { path })).toMatchObject({
        status: 404,
        json: { error: { code: "unknown_hook" } },
      });
    }
    expect(t.heard).toEqual([]);
  });

  it("reaches the door for a source of any name the config allows, however long", async () => {
    // A config's source name has no length limit: none the config accepts is unreachable here.
    const long = `issues_${"x".repeat(500)}`;
    const t = hooksDoor();
    expect((await deliver(appWith(t.door), { path: `/v1/hooks/tracker/${long}` })).status).toBe(
      202,
    );
    expect(t.heard.map(({ source }) => source)).toEqual([long]);
  });
});

describe("the route reads nothing of a delivery before its plugin's check", () => {
  it("hands the door the exact bytes received, undecoded, and every header but FacetDB's cookie", async () => {
    // Not UTF-8, not JSON, declared as JSON: a parse of any kind would change or refuse it.
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0x22, 0xc3, 0x28, 0x0a, 0x7d]);
    const t = hooksDoor();
    const answer = await deliver(appWith(t.door), {
      body: bytes,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
        "x-github-event": "issues",
        cookie: MAYA,
      },
    });

    expect(answer.status).toBe(202);
    const delivery = t.heard[0]?.delivery;
    expect(delivery?.body).toEqual(bytes);
    expect(delivery?.headers.get("x-hub-signature-256")).toBe(`sha256=${"a".repeat(64)}`);
    expect(delivery?.headers.get("x-github-event")).toBe("issues");
    expect(delivery?.headers.get("content-type")).toBe("application/json");
    expect(delivery?.headers.get("cookie")).toBeNull();
    expect(delivery?.url).toBe("http://worker.example.com/v1/hooks/tracker/issues");
  });

  it("hands an empty body on as no bytes", async () => {
    const t = hooksDoor();
    expect((await deliver(appWith(t.door), { body: null })).status).toBe(202);
    expect(t.heard[0]?.delivery.body).toEqual(new Uint8Array(0));
  });
});

describe("who may reach a hook", () => {
  it("a stranger with no cookie and no API key, from another site, with a body no studio write takes", async () => {
    const t = hooksDoor();
    const answer = await deliver(appWith(t.door), {
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
    });

    expect(answer).toMatchObject({ status: 202, json: { queued: 1 } });
    expect(t.heard).toHaveLength(1);
    // A project API key and a session change nothing: the plugin's check is the only one.
    for (const headers of [{ authorization: KEY }, { cookie: MAYA }]) {
      expect((await deliver(appWith(t.door), { headers })).status).toBe(202);
    }
    expect((await deliver(appWith(t.door), { peer: THIS_MACHINE })).status).toBe(202);
  });

  it("leaves every other method and path under /v1, and a route added after it, to the reviewer", async () => {
    const t = hooksDoor();
    const app = appWith(t.door);
    // A route added to the app after it was made sits behind the studio's guard, mounted earlier.
    app.post("/v1/later", (c) => c.json({ reached: true }));

    const signIn = { status: 401, json: { error: { code: "sign-in" } } };
    for (const [method, path] of [
      ["GET", "/v1/hooks/tracker/issues"],
      ["PUT", "/v1/hooks/tracker/issues"],
      ["POST", "/v1/hooks/tracker"],
      ["POST", "/v1/hooks/tracker/issues/more"],
      ["POST", "/v1/hooks"],
      ["POST", "/v1/later"],
      ["POST", "/v1/reload"],
      ["GET", "/v1/plugins"],
    ] as const) {
      expect(
        await deliver(app, { method, path, headers: { "content-type": "application/json" } }),
        `${method} ${path}`,
      ).toMatchObject(signIn);
    }
    expect(t.heard).toEqual([]);

    // The reviewer still reaches the route added later, through the studio's own checks.
    expect(
      await deliver(app, {
        path: "/v1/later",
        headers: { cookie: MAYA, "content-type": "application/json" },
      }),
    ).toMatchObject({ status: 200, json: { reached: true } });
  });
});

describe("a body past 5 MB", () => {
  it("is refused 413 by its declared length, unread, and the door never hears", async () => {
    const t = hooksDoor();
    const answer = await deliver(appWith(t.door), {
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("the body of a declared length past the cap is never read");
        },
      }),
      headers: { "content-length": String(HOOK_BODY_MAX_BYTES + 1) },
    });

    expect(answer).toMatchObject({ status: 413, json: { error: { code: "body_too_large" } } });
    expect(t.heard).toEqual([]);
  });

  it("is refused 413 as it grows past the cap with no length declared, and one at the cap is taken", async () => {
    const t = hooksDoor();
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    expect(await deliver(appWith(t.door), { body: endless })).toMatchObject({
      status: 413,
      json: { error: { code: "body_too_large" } },
    });
    // It stopped reading one chunk past the cap: the rest was never held.
    expect(pulled).toBeLessThanOrEqual(7);
    expect(t.heard).toEqual([]);

    const atCap = new Uint8Array(HOOK_BODY_MAX_BYTES).fill(0x62);
    expect((await deliver(appWith(t.door), { body: atCap })).status).toBe(202);
    expect(t.heard[0]?.delivery.body.byteLength).toBe(HOOK_BODY_MAX_BYTES);
  });
});

describe("isHookUrl, which the HTTP adapter caps a body by", () => {
  it("covers every URL the router could take to a hook, and is never narrower", () => {
    for (const url of [
      "http://w/v1/hooks/github/issues",
      "http://w/v1/hooks/github/issues?x=1",
      "http://w/v1/%68ooks/github/issues",
      "http://w/V1/HOOKS/github/issues",
      "http://w/v1/./hooks/github/issues",
      "http://w/v1/x/../hooks/github/issues",
      "http://w/v1/hooks/",
    ]) {
      expect(isHookUrl(url), url).toBe(true);
    }
    for (const url of [
      "http://w/v1/check",
      "http://w/v1/hooksx/github/issues",
      "http://w/v1/hooks",
      "http://w/v2/hooks/github/issues",
      "not a url",
    ]) {
      expect(isHookUrl(url), url).toBe(false);
    }
  });
});
