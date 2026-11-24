import { FakeClock } from "@facetdb/core/testing";
import type { ReviewerAccount, UsersStore } from "@facetdb/postgres";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ApiError } from "../errors.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import type { MigrateDoor, SetupDoor } from "../sources/door.ts";
import {
  createSetupService,
  MIGRATE_NO_OPERATOR,
  MIGRATE_OPERATOR_ONLY,
  NO_OPERATOR,
  OPERATOR_ONLY,
} from "../sources/service.ts";
import type { AppEnv } from "./middleware.ts";
import { OpenSurfaceError, requireAccountToServe } from "./open-surface.ts";
import { isOperator, operatorKnownByAddress, PROXY_WITHOUT_HEADER_LINE } from "./operator.ts";
import { createReviewers } from "./reviewers.ts";
import { createSessions, requireReviewer, SESSION_COOKIE, sessionRoutes } from "./sessions.ts";

/**
 * With a `studioUrl` on another host nobody is the operator by address. The whole app on
 * handwritten fakes, the real sessions and the real setup service over a door that counts its
 * calls; a request's other end is `app.request`'s third argument, as the adapter passes it.
 */

const START = Date.UTC(2026, 10, 18, 9, 0, 0);
const PROJECT = "listings-app";
const MAYA = { name: "maya", password: "correct horse battery" };
const HERE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const LOCAL_URL = "http://127.0.0.1:4040";
const PUBLIC_URL = "https://studio.example.com";
const ADMIN = "postgres://admin:hunter2@db.internal:5432/app";

function rig(operatorByAddress: boolean) {
  const clock = new FakeClock(START);
  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
  };
  const users: UsersStore = {
    add: () => Promise.reject(new Error("these tests add no account")),
    verify: (name, password) => Promise.resolve(name === MAYA.name && password === MAYA.password),
    list: () =>
      Promise.resolve([{ name: MAYA.name, createdAt: new Date(START) } satisfies ReviewerAccount]),
    remove: () => Promise.reject(new Error("these tests remove no account")),
    writable: () => Promise.resolve(false),
  };
  const reached: string[] = [];
  const door: SetupDoor = {
    available: true,
    inspect: () => {
      reached.push("inspect");
      return Promise.resolve({
        kind: "inspected",
        database: "Postgres",
        tables: ["listings"],
        table: null,
        sharedWith: null,
      });
    },
    preview: () => Promise.reject(new Error("these tests preview nothing")),
    plan: () => Promise.reject(new Error("these tests plan nothing")),
    install: () => Promise.reject(new Error("these tests install nothing")),
  };
  const migrate: MigrateDoor = {
    available: true,
    plan: () => {
      reached.push("migrate plan");
      return Promise.resolve({
        kind: "refused",
        code: "not_running",
        message: "listings is not running.",
        fix: "Start it.",
      });
    },
    run: () => Promise.reject(new Error("these tests run nothing")),
  };
  const app = createApp({
    keys: {
      create: () => Promise.reject(new Error("no keys here")),
      verify: () => Promise.resolve(undefined),
      revoke: () => Promise.reject(new Error("no keys here")),
    },
    check: { check: () => Promise.reject(new Error("no check here")) },
    config: {
      json: () => {
        throw new Error("no config here");
      },
      validate: () => {
        throw new Error("no config here");
      },
      preview: () => Promise.reject(new Error("no preview here")),
      test: () => Promise.reject(new Error("no test here")),
      diff: () => Promise.reject(new Error("no apply here")),
      reload: () => Promise.reject(new Error("no reload here")),
      apply: () => Promise.reject(new Error("no apply here")),
    },
    data: {
      runs: { list: () => Promise.reject(new Error("no runs here")) },
      decisions: {
        search: () => Promise.reject(new Error("no decisions here")),
        why: () => Promise.reject(new Error("no history here")),
      },
      home: { home: () => Promise.reject(new Error("no home here")) },
      sources: { sources: () => Promise.reject(new Error("no sources here")) },
      alerts: { alerts: () => Promise.reject(new Error("no alerts here")) },
      access: { access: () => Promise.reject(new Error("no studio access here")) },
    },
    review: NO_REVIEW,
    setup: createSetupService({ door, migrate, clock, log }),
    studio: {
      sessions: createSessions({
        secret: "a-long-random-secret-for-tests-only",
        clock,
        users,
        osUser: () => "alex",
        log,
      }),
      reviewers: createReviewers({ users, log }),
      projectId: PROJECT,
      operatorByAddress,
      log,
    },
    newRequestId: () => "req-1",
  });

  async function send(
    method: string,
    url: string,
    options: {
      readonly peer?: { readonly remoteAddress: string | undefined };
      readonly cookie?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    } = {},
  ) {
    const response = await app.request(
      url,
      {
        method,
        headers: {
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...(options.cookie === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      options.peer ?? HERE,
    );
    const text = await response.text();
    return {
      status: response.status,
      setCookie: response.headers.get("set-cookie") ?? "",
      json: (text === "" ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
    };
  }

  /** Signs maya in from `peer` at `url`; the cookie's value and the whole header the server set. */
  async function signIn(peer = HERE, url = LOCAL_URL) {
    const response = await send("POST", `${url}/v1/session`, { peer, body: MAYA });
    expect(response.status).toBe(200);
    return {
      header: response.setCookie,
      value: response.setCookie.split(";")[0]?.slice(`${SESSION_COOKIE}=`.length) ?? "",
    };
  }

  return { send, signIn, logs, reached };
}

/** Every socket, `Host` and header a request on this machine, or one that claims to be, can carry. */
const PEERS = [
  "127.0.0.1",
  "127.0.0.2",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::1%1",
  "fe80::1%lo0",
  "203.0.113.7",
  undefined,
];
const URLS = [LOCAL_URL, "http://localhost:4040", "http://[::1]:4040", PUBLIC_URL];
const HEADERS: readonly Readonly<Record<string, string>>[] = [
  {},
  { origin: LOCAL_URL },
  { origin: PUBLIC_URL },
  { "x-forwarded-for": "127.0.0.1" },
  { forwarded: "for=127.0.0.1" },
  { "x-real-ip": "127.0.0.1" },
  { "sec-fetch-site": "same-origin" },
];

describe("operator-by-address: a studioUrl on another host", () => {
  it("makes no request the OS user, whatever its socket, Host or headers", async () => {
    const t = rig(false);
    for (const remoteAddress of PEERS) {
      for (const url of URLS) {
        for (const headers of HEADERS) {
          const response = await t.send("GET", `${url}/v1/reviewers`, {
            peer: { remoteAddress },
            headers,
          });
          const at = `${String(remoteAddress)} ${url} ${JSON.stringify(headers)}`;
          expect(response.status, at).toBe(401);
          expect(response.json, at).toEqual({
            error: {
              code: "sign-in",
              message: "This request is not signed in.",
              // No word of a sign-in-free address that does not exist here.
              fix: 'Sign in with POST /v1/session and a body of {"name", "password"}, using an account made by `facetdb users add <name>`.',
            },
          });
        }
      }
    }
  });

  it("lets a signed-in reviewer in, on this machine too, and its cookie is always Secure", async () => {
    const t = rig(false);
    for (const [peer, url] of [
      [HERE, LOCAL_URL],
      [ELSEWHERE, PUBLIC_URL],
    ] as const) {
      const { header, value } = await t.signIn(peer, url);
      expect(header).toMatch(/; Secure/);
      const listed = await t.send("GET", `${url}/v1/reviewers`, { peer, cookie: value });
      expect(listed.status).toBe(200);
      const out = await t.send("DELETE", `${url}/v1/session`, { peer, cookie: value });
      expect(out.setCookie).toMatch(/; Secure/);
    }
  });

  it("answers the setup and the question install operator_only, pointing to the commands", async () => {
    const t = rig(false);
    const { value } = await t.signIn();

    const access = await t.send("GET", `${LOCAL_URL}/v1/sources/setup`, { cookie: value });
    expect(access.status).toBe(200);
    expect(access.json).toEqual({ open: false, ...NO_OPERATOR });
    expect(NO_OPERATOR.fix).toBe(
      "On the machine that runs facetdb worker, add the source to facetdb.config.ts (or start one with facetdb init), then run facetdb migrate --source <name>.",
    );

    const inspect = await t.send("POST", `${LOCAL_URL}/v1/sources/inspect`, {
      cookie: value,
      body: { admin: ADMIN },
    });
    expect(inspect.status).toBe(403);
    expect(inspect.json).toEqual({
      error: { code: "operator_only", message: NO_OPERATOR.message, fix: NO_OPERATOR.fix },
    });

    const plan = await t.send("POST", `${LOCAL_URL}/v1/sources/listings/migrate/plan`, {
      cookie: value,
      body: { admin: ADMIN },
    });
    expect(plan.status).toBe(403);
    expect(plan.json).toEqual({
      error: {
        code: "operator_only",
        message: MIGRATE_NO_OPERATOR.message,
        fix: MIGRATE_NO_OPERATOR.fix,
      },
    });
    expect(MIGRATE_NO_OPERATOR.fix).toContain("facetdb migrate --source <name>");
    // Neither door was reached, and no admin string was read into a log.
    expect(t.reached).toEqual([]);
    expect(t.logs.join("\n")).not.toContain("hunter2");
  });

  it("starts only once an account exists, whatever the bind", async () => {
    const none: Pick<UsersStore, "list"> = { list: () => Promise.resolve([]) };
    const some: Pick<UsersStore, "list"> = {
      list: () => Promise.resolve([{ name: "maya", createdAt: new Date(START) }]),
    };
    const refusal = await requireAccountToServe(
      { host: "127.0.0.1", studioUrl: "https://studio.example.com:8443" },
      none,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OpenSurfaceError);
    expect((refusal as OpenSurfaceError).message).toBe(
      "studioUrl is studio.example.com:8443, so everyone must sign in, and no reviewer account exists; nothing was started",
    );
    expect((refusal as OpenSurfaceError).fix).toBe(
      "run facetdb users add <name> to make an account, then start again",
    );
    await expect(
      requireAccountToServe({ host: "127.0.0.1", studioUrl: PUBLIC_URL }, some),
    ).resolves.toBeUndefined();
    await expect(
      requireAccountToServe({ host: "127.0.0.1", studioUrl: "http://localhost:4040" }, none),
    ).resolves.toBeUndefined();
  });

  it("reads the studioUrl's host as a browser does, and anything else as another host", () => {
    for (const url of [
      undefined,
      "http://127.0.0.1:4040",
      "http://127.0.0.9",
      "http://localhost:4040",
      "http://LOCALHOST:4040",
      "http://[::1]:4040",
      "http://127.1:4040",
      "http://2130706433",
    ]) {
      expect(operatorKnownByAddress(url), String(url)).toBe(true);
    }
    for (const url of [
      PUBLIC_URL,
      "http://192.168.1.20:4040",
      "http://0.0.0.0:4040",
      "http://[::]:4040",
      "http://localhost.:4040",
      "http://localhost.evil.example",
      "http://127.0.0.1.nip.io",
      "http://[::ffff:127.0.0.1]:4040",
      "not an address",
    ]) {
      expect(operatorKnownByAddress(url), url).toBe(false);
    }
  });
});

describe("operator-by-address: no studioUrl, or one on this machine", () => {
  it("behaves as before: this machine is the OS user, anyone else signs in", async () => {
    const t = rig(true);

    const here = await t.send("GET", `${LOCAL_URL}/v1/reviewers`);
    expect(here.status).toBe(200);

    const elsewhere = await t.send("GET", `${PUBLIC_URL}/v1/reviewers`, { peer: ELSEWHERE });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.json).toMatchObject({
      error: {
        code: "sign-in",
        fix: expect.stringContaining("open http://127.0.0.1 and no sign-in is needed"),
      },
    });
    const proxied = await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    expect(proxied.status).toBe(401);
  });

  it("keeps the cookie's Secure off on this machine alone", async () => {
    const t = rig(true);
    expect((await t.signIn(HERE, LOCAL_URL)).header).not.toMatch(/Secure/);
    expect((await t.signIn(ELSEWHERE, PUBLIC_URL)).header).toMatch(/; Secure/);
  });

  it("opens the setup and the question install to the operator, and refuses anyone else in the old words", async () => {
    const t = rig(true);

    const access = await t.send("GET", `${LOCAL_URL}/v1/sources/setup`);
    expect(access.json).toEqual({ open: true });
    const inspect = await t.send("POST", `${LOCAL_URL}/v1/sources/inspect`, {
      body: { admin: ADMIN },
    });
    expect(inspect.status).toBe(200);
    await t.send("POST", `${LOCAL_URL}/v1/sources/listings/migrate/plan`, {
      body: { admin: ADMIN },
    });
    expect(t.reached).toEqual(["inspect", "migrate plan"]);

    const { value } = await t.signIn(ELSEWHERE, PUBLIC_URL);
    const signedIn = await t.send("GET", `${PUBLIC_URL}/v1/sources/setup`, {
      peer: ELSEWHERE,
      cookie: value,
    });
    expect(signedIn.json).toEqual({ open: false, ...OPERATOR_ONLY });
    const plan = await t.send("POST", `${PUBLIC_URL}/v1/sources/listings/migrate/plan`, {
      peer: ELSEWHERE,
      cookie: value,
      body: { admin: ADMIN },
    });
    expect(plan.json).toEqual({
      error: {
        code: "operator_only",
        message: MIGRATE_OPERATOR_ONLY.message,
        fix: MIGRATE_OPERATOR_ONLY.fix,
      },
    });
    expect(t.reached).toEqual(["inspect", "migrate plan"]);
  });

  it("prints the proxy line once, for a loopback request whose Origin names another host", async () => {
    const t = rig(true);
    const proxyLines = () => t.logs.filter((line) => line === PROXY_WITHOUT_HEADER_LINE);

    // None of these is a proxy in front without a forwarding header.
    await t.send("GET", `${LOCAL_URL}/v1/reviewers`, { headers: { origin: LOCAL_URL } });
    await t.send("GET", `${LOCAL_URL}/v1/reviewers`, { headers: { origin: "null" } });
    await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
      headers: { origin: PUBLIC_URL, "x-forwarded-for": "198.51.100.9" },
    });
    await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
      peer: ELSEWHERE,
      headers: { origin: PUBLIC_URL },
    });
    await t.send("GET", `${PUBLIC_URL}/v1/reviewers`, { headers: { origin: LOCAL_URL } });
    expect(proxyLines()).toEqual([]);

    // nginx's proxy_pass: Host rewritten to the upstream's, the page's own Origin, no header.
    for (const url of [LOCAL_URL, "http://localhost:4040", "http://[::1]:4040"]) {
      const response = await t.send("POST", `${url}/v1/reviewers`, {
        peer: { remoteAddress: "::ffff:127.0.0.1" },
        headers: { origin: PUBLIC_URL },
        body: { name: "lee", password: "a long enough password" },
      });
      // Never trusted for it: the Origin alone already made it a stranger.
      expect(response.status).toBe(401);
    }
    expect(proxyLines()).toEqual([PROXY_WITHOUT_HEADER_LINE]);
    expect(PROXY_WITHOUT_HEADER_LINE).toBe(
      "A request from another site reached the studio with no forwarding header. If a proxy sends visitors here, they get in as you: set studioUrl in facetdb.config.ts to the address people open, then restart the worker.",
    );
  });

  it("never prints it where no address makes the operator", async () => {
    const t = rig(false);
    await t.send("GET", `${LOCAL_URL}/v1/reviewers`, { headers: { origin: PUBLIC_URL } });
    expect(t.logs).not.toContain(PROXY_WITHOUT_HEADER_LINE);
  });
});

describe("operator-by-address: a route mounted where addressCheck never ran", () => {
  it("fails closed: nobody is the operator, a reviewer signs in, and the cookie is Secure", async () => {
    const clock = new FakeClock(START);
    const users: UsersStore = {
      add: () => Promise.reject(new Error("these tests add no account")),
      verify: (name, password) => Promise.resolve(name === MAYA.name && password === MAYA.password),
      list: () => Promise.resolve([{ name: MAYA.name, createdAt: new Date(START) }]),
      remove: () => Promise.reject(new Error("these tests remove no account")),
      writable: () => Promise.resolve(false),
    };
    const sessions = createSessions({
      secret: "a-long-random-secret-for-tests-only",
      clock,
      users,
      osUser: () => "alex",
      log: () => undefined,
    });
    // `byAddress` is never set: no `addressCheck` in front of either route.
    const app = new Hono<AppEnv>();
    app.route(
      "/v1/session",
      sessionRoutes(sessions, () => undefined),
    );
    app.get("/open/operator", (c) => c.json({ operator: isOperator(c) }));
    app.use("/v1/*", requireReviewer(sessions, PROJECT));
    app.get("/v1/reviewer", (c) => c.json({ reviewer: c.get("reviewer") }));
    // The app's own mapping of a refusal to its response (app.ts).
    app.onError((error, c) =>
      error instanceof ApiError ? c.json(error.toBody(), error.status) : c.text("failed", 500),
    );

    // The most local request there is: loopback socket, loopback Host, no header, no cookie.
    const operator = await app.request(`${LOCAL_URL}/open/operator`, {}, HERE);
    expect(await operator.json()).toEqual({ operator: false });

    const reviewer = await app.request(`${LOCAL_URL}/v1/reviewer`, {}, HERE);
    expect(reviewer.status).toBe(401);
    expect(await reviewer.json()).toMatchObject({ error: { code: "sign-in" } });

    const signedIn = await app.request(
      `${LOCAL_URL}/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(MAYA),
      },
      HERE,
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toMatch(/; Secure/);
  });
});
