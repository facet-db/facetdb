import { createHmac } from "node:crypto";
import { FakeClock } from "@facetdb/core/testing";
import { type ReviewerAccount, UsersNotWritableError, type UsersStore } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { isLoopbackAddress, isLoopbackHost } from "./loopback.ts";
import { OpenSurfaceError, requireAccountToServe } from "./open-surface.ts";
import { createReviewers } from "./reviewers.ts";
import {
  createSessions,
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./sessions.ts";

/**
 * Reviewer sessions through the whole app on handwritten fakes: a users store that keeps passwords
 * as it was given them (the real scrypt is proven in the postgres package), the fake clock, and
 * the log the sessions write. A request's other end is the third argument of `app.request`, as the
 * adapter that serves the app passes it.
 */

const START = Date.UTC(2026, 10, 5, 9, 0, 0);
const SECRET = "a-long-random-secret-for-tests-only";
const PROJECT = "listings-app";
const MAYA = { name: "maya", password: "correct horse battery" };
const SAM = { name: "sam", password: "another long password" };
const HERE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const LOCAL_URL = "http://127.0.0.1:4040";
const REMOTE_URL = "https://studio.example.com";

type Account = { readonly name: string; password: string; createdAt: Date };

function fakeUsers(clock: FakeClock) {
  const accounts = new Map<string, Account>();
  const hashes = new Map<string, string>();
  const store: UsersStore = {
    add(name, passwordHash) {
      if (accounts.has(name)) {
        return Promise.resolve(false);
      }
      // A test seeds `password` directly; an add through the app keeps only the hash it was given.
      accounts.set(name, { name, password: "", createdAt: new Date(clock.now()) });
      hashes.set(name, passwordHash);
      return Promise.resolve(true);
    },
    verify(name, password) {
      return Promise.resolve(accounts.get(name)?.password === password && password !== "");
    },
    list: () =>
      Promise.resolve(
        [...accounts.values()].map(
          (one): ReviewerAccount => ({
            name: one.name,
            createdAt: one.createdAt,
          }),
        ),
      ),
    remove: (name) => Promise.resolve(accounts.delete(name)),
  };
  return {
    store,
    hashes,
    seed(account: { name: string; password: string }) {
      accounts.set(account.name, { ...account, createdAt: new Date(clock.now()) });
    },
  };
}

function rig(options: { readonly secret?: string; readonly users?: Partial<UsersStore> } = {}) {
  const clock = new FakeClock(START);
  const logs: string[] = [];
  const fake = fakeUsers(clock);
  const users: UsersStore = { ...fake.store, ...options.users };
  fake.seed(MAYA);
  fake.seed(SAM);
  const log = (line: string) => logs.push(line);
  const sessions = createSessions({
    secret: options.secret ?? SECRET,
    clock,
    users,
    osUser: () => "alex",
    log,
  });
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
    studio: { sessions, reviewers: createReviewers({ users, log }), projectId: PROJECT },
    review: NO_REVIEW,
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
      headers: response.headers,
      text,
      json: (text === "" ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
    };
  }

  /** Signs in from outside and returns the cookie value the server set. */
  async function signIn(account = MAYA, url = REMOTE_URL) {
    const response = await send("POST", `${url}/v1/session`, {
      peer: ELSEWHERE,
      body: { name: account.name, password: account.password },
    });
    const header = response.headers.get("set-cookie") ?? "";
    const value = header.split(";")[0]?.slice(`${SESSION_COOKIE}=`.length) ?? "";
    return { response, header, value };
  }

  return { clock, logs, fake, send, signIn, app };
}

describe("a request from this machine's loopback address", () => {
  it("needs no cookie: the reviewer on record is the OS user", async () => {
    const t = rig();

    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const response = await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
        peer: { remoteAddress },
      });
      expect(response.status).toBe(200);
    }
    const added = await t.send("POST", `${LOCAL_URL}/v1/reviewers`, {
      body: { name: "lee", password: "a long enough password" },
    });
    expect(added.status).toBe(201);
    expect(t.logs).toContain("reviewers: os:alex added the account lee");
  });

  it("is not trusted when a proxy, another host name or another web page is in the way", async () => {
    const t = rig();
    const refused = [
      // A reverse proxy on this machine: every visitor's socket is local.
      { headers: { "x-forwarded-for": "198.51.100.9" } },
      { headers: { forwarded: "for=198.51.100.9" } },
      // DNS rebinding: a page's own name resolved to 127.0.0.1.
      { url: "http://studio.attacker.example:4040/v1/reviewers" },
      // A web page open in this browser posting to the studio.
      { headers: { origin: "https://evil.example" } },
      { headers: { origin: "null" } },
    ];
    for (const attempt of refused) {
      const response = await t.send("GET", attempt.url ?? `${LOCAL_URL}/v1/reviewers`, {
        ...(attempt.headers === undefined ? {} : { headers: attempt.headers }),
      });
      expect(response.status).toBe(401);
      expect(response.json).toMatchObject({ error: { code: "sign-in" } });
    }
    const sameOrigin = await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
      headers: { origin: LOCAL_URL },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("with a cookie that does not hold is asked to sign in, not turned into the OS user", async () => {
    const t = rig();

    const response = await t.send("GET", `${LOCAL_URL}/v1/reviewers`, { cookie: "maya.1.forged" });

    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ error: { code: "sign-in" } });
    // The browser is told to drop it, so the next request is a plain loopback one.
    expect(response.headers.get("set-cookie")).toMatch(/^facetdb_session=; .*Max-Age=0/);
  });
});

describe("a request from any other address", () => {
  it("without a cookie gets 401 sign-in in the stable error shape, with the fix", async () => {
    const t = rig();

    const response = await t.send("GET", `${REMOTE_URL}/v1/reviewers`, { peer: ELSEWHERE });

    expect(response.status).toBe(401);
    expect(response.json).toEqual({
      error: {
        code: "sign-in",
        message: expect.stringContaining("not signed in"),
        fix: expect.stringContaining("POST /v1/session"),
      },
    });
  });

  it("is also refused when the socket's address is unknown", async () => {
    const t = rig();
    const response = await t.send("GET", `${LOCAL_URL}/v1/reviewers`, {
      peer: { remoteAddress: undefined },
    });
    expect(response.status).toBe(401);
  });

  it("with a valid cookie is the account it names", async () => {
    const t = rig();
    const { response, value } = await t.signIn();
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      reviewer: "maya",
      expiresAt: new Date(START + SESSION_TTL_MS).toISOString(),
    });

    const listed = await t.send("GET", `${REMOTE_URL}/v1/reviewers`, {
      peer: ELSEWHERE,
      cookie: value,
    });
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({
      reviewers: [
        { name: "maya", createdAt: new Date(START).toISOString() },
        { name: "sam", createdAt: new Date(START).toISOString() },
      ],
    });
    const added = await t.send("POST", `${REMOTE_URL}/v1/reviewers`, {
      peer: ELSEWHERE,
      cookie: value,
      body: { name: "lee", password: "a long enough password" },
    });
    expect(added.status).toBe(201);
    expect(t.logs).toContain("reviewers: maya added the account lee");
  });

  it("with a forged cookie is refused: a made-up signature, another secret, another name or another expiry", async () => {
    const t = rig();
    const { value } = await t.signIn();
    const [name = "", expiry = "", signature = ""] = value.split(".");
    const other = rig({ secret: "a-different-secret-on-another-installation" });
    const elsewhereValue = (await other.signIn()).value;
    const forged = [
      `${name}.${expiry}.${Buffer.alloc(32, 1).toString("base64url")}`,
      `${name}.${expiry}.`,
      `${name}.${expiry}`,
      `${name}.${expiry}.${signature}.extra`,
      "",
      "garbage",
      // Signed under another installation's secret, for the same name and expiry.
      elsewhereValue,
      // The signature of maya's cookie carried to sam's name, or to a later expiry.
      `sam.${expiry}.${signature}`,
      `${name}.${Number(expiry) + 1}.${signature}`,
      `${name}.${Number(expiry) * 10}.${signature}`,
      // A signature made with the secret itself, without the cookie key derived from it.
      `${name}.${expiry}.${createHmac("sha256", SECRET).update(`${name}\n${START}\n${expiry}`).digest("base64url")}`,
    ];
    for (const cookie of forged) {
      const response = await t.send("GET", `${REMOTE_URL}/v1/reviewers`, {
        peer: ELSEWHERE,
        cookie,
      });
      expect(response.status, cookie).toBe(401);
      expect(response.json, cookie).toMatchObject({ error: { code: "sign-in" } });
    }
  });

  it("with an expired cookie is asked to sign in again, and the cookie is cleared", async () => {
    const t = rig();
    const { value } = await t.signIn();

    t.clock.advance(SESSION_TTL_MS - 1);
    expect(
      (await t.send("GET", `${REMOTE_URL}/v1/reviewers`, { peer: ELSEWHERE, cookie: value }))
        .status,
    ).toBe(200);

    t.clock.advance(1);
    const response = await t.send("GET", `${REMOTE_URL}/v1/reviewers`, {
      peer: ELSEWHERE,
      cookie: value,
    });
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({
      error: { code: "sign-in", message: "Your session has ended." },
    });
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("stops holding a cookie the moment its account is removed, or removed and made again", async () => {
    const t = rig();
    const { value } = await t.signIn();
    const listed = () =>
      t.send("GET", `${REMOTE_URL}/v1/reviewers`, { peer: ELSEWHERE, cookie: value });
    expect((await listed()).status).toBe(200);

    await t.fake.store.remove("maya");
    expect((await listed()).status).toBe(401);

    t.clock.advance(1_000);
    t.fake.seed({ name: "maya", password: "a new password entirely" });
    expect((await listed()).status).toBe(401);
  });

  it("keeps the project keys out of the studio, and the studio out of the check API", async () => {
    const t = rig();

    const unknown = await t.send("GET", `${REMOTE_URL}/v1/not-a-route`, { peer: ELSEWHERE });
    expect(unknown.json).toMatchObject({ error: { code: "sign-in" } });

    // The check API answers to a key, not to a session: no cookie is asked for.
    const { value } = await t.signIn();
    const check = await t.send("POST", `${REMOTE_URL}/v1/check`, {
      peer: ELSEWHERE,
      cookie: value,
      body: {},
    });
    expect(check.status).toBe(401);
    expect(check.json).toMatchObject({ error: { code: "invalid_api_key" } });
  });
});

describe("POST /v1/session and DELETE /v1/session", () => {
  it("sets a facetdb_session cookie that is HttpOnly, SameSite=Lax and lasts 12 hours, Secure off loopback only", async () => {
    const t = rig();

    const remote = await t.signIn(MAYA, REMOTE_URL);
    expect(remote.header).toMatch(/^facetdb_session=maya\.\d+\./);
    expect(remote.header).toContain("HttpOnly");
    expect(remote.header).toContain("SameSite=Lax");
    expect(remote.header).toContain("Max-Age=43200");
    expect(remote.header).toContain("Path=/");
    expect(remote.header).toContain("Secure");

    const here = await t.send("POST", `${LOCAL_URL}/v1/session`, {
      body: { name: MAYA.name, password: MAYA.password },
    });
    const header = here.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Secure");
  });

  it("answers a wrong password and an unknown name with the same 401, and never says which", async () => {
    const t = rig();
    const wrong = await t.send("POST", `${REMOTE_URL}/v1/session`, {
      peer: ELSEWHERE,
      body: { name: "maya", password: "not the password" },
    });
    const unknown = await t.send("POST", `${REMOTE_URL}/v1/session`, {
      peer: ELSEWHERE,
      body: { name: "nobody", password: "not the password" },
    });
    const malformed = await t.send("POST", `${REMOTE_URL}/v1/session`, {
      peer: ELSEWHERE,
      body: { name: "Not A Name!", password: "not the password" },
    });

    for (const response of [wrong, unknown, malformed]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(unknown.json).toEqual(wrong.json);
    expect(malformed.json).toEqual(wrong.json);
    expect(wrong.json).toMatchObject({ error: { code: "invalid-credentials" } });
  });

  it("refuses a body that is not a name and a password, in the stable shape", async () => {
    const t = rig();
    const response = await t.send("POST", `${REMOTE_URL}/v1/session`, {
      peer: ELSEWHERE,
      body: { name: "maya" },
    });
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("stops answering a name after five wrong passwords until the window ends, even to the right one", async () => {
    const t = rig();
    const attempt = (password: string) =>
      t.send("POST", `${REMOTE_URL}/v1/session`, {
        peer: ELSEWHERE,
        body: { name: "maya", password },
      });

    for (let n = 0; n < MAX_FAILURES; n += 1) {
      expect((await attempt("wrong password")).status).toBe(401);
    }
    const locked = await attempt(MAYA.password);
    expect(locked.status).toBe(429);
    expect(locked.json).toMatchObject({ error: { code: "too-many-attempts" } });
    expect(locked.headers.get("retry-after")).toBe(String(FAILURE_WINDOW_MS / 1000));
    // Another account is not locked out by it.
    expect((await t.signIn(SAM)).response.status).toBe(200);

    t.clock.advance(FAILURE_WINDOW_MS);
    expect((await attempt(MAYA.password)).status).toBe(200);
  });

  it("forgets the wrong passwords of a name once the right one is given", async () => {
    const t = rig();
    const attempt = (password: string) =>
      t.send("POST", `${REMOTE_URL}/v1/session`, {
        peer: ELSEWHERE,
        body: { name: "maya", password },
      });
    for (let n = 0; n < MAX_FAILURES - 1; n += 1) {
      await attempt("wrong password");
    }
    expect((await attempt(MAYA.password)).status).toBe(200);
    for (let n = 0; n < MAX_FAILURES - 1; n += 1) {
      expect((await attempt("wrong password")).status).toBe(401);
    }
  });

  it("does not hash a name that cannot be an account, nor one that is locked", async () => {
    let hashed = 0;
    const t = rig({
      users: {
        verify: () => {
          hashed += 1;
          return Promise.resolve(false);
        },
      },
    });
    const attempt = (name: string) =>
      t.send("POST", `${REMOTE_URL}/v1/session`, {
        peer: ELSEWHERE,
        body: { name, password: "whatever it is" },
      });

    await attempt("NOT-A-NAME");
    expect(hashed).toBe(0);
    for (let n = 0; n < MAX_FAILURES + 3; n += 1) {
      await attempt("maya");
    }
    expect(hashed).toBe(MAX_FAILURES);
  });

  it("DELETE clears the cookie", async () => {
    const t = rig();
    const response = await t.send("DELETE", `${REMOTE_URL}/v1/session`, { peer: ELSEWHERE });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ signedOut: true });
    expect(response.headers.get("set-cookie")).toMatch(/^facetdb_session=; .*Max-Age=0/);
  });
});

describe("GET and POST /v1/reviewers", () => {
  it("list accounts without a hash, and make one with the words of `facetdb users add`", async () => {
    const t = rig();
    const post = (body: unknown) => t.send("POST", `${LOCAL_URL}/v1/reviewers`, { body });

    const added = await post({ name: "lee", password: "a long enough password" });
    expect(added.status).toBe(201);
    expect(added.json).toEqual({ name: "lee", added: true });
    // Only a scrypt hash was handed to the store, never the password.
    const hash = t.fake.hashes.get("lee") ?? "";
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain("a long enough password");
    const listed = await t.send("GET", `${LOCAL_URL}/v1/reviewers`);
    expect(JSON.stringify(listed.json)).not.toContain("scrypt");

    const badName = await post({ name: "Lee Smith", password: "a long enough password" });
    expect(badName.status).toBe(400);
    expect(badName.json).toMatchObject({
      error: {
        code: "invalid-name",
        message: expect.stringContaining("is not a name an account can have"),
        fix: "Choose a name like maya or review-team, and send it again.",
      },
    });
    const weak = await post({ name: "kim", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.json).toMatchObject({
      error: {
        code: "weak-password",
        message: "The password is shorter than 8 characters; nothing was changed.",
      },
    });
    const taken = await post({ name: "maya", password: "a long enough password" });
    expect(taken.status).toBe(409);
    expect(taken.json).toMatchObject({
      error: {
        code: "user-exists",
        message: 'A reviewer account named "maya" already exists; nothing was changed.',
        fix: expect.stringContaining("facetdb users remove maya"),
      },
    });
  });

  it("say what to do when the login may read the accounts but not change them", async () => {
    const t = rig({
      users: {
        add: () => Promise.reject(new UsersNotWritableError()),
      },
    });

    const response = await t.send("POST", `${LOCAL_URL}/v1/reviewers`, {
      body: { name: "lee", password: "a long enough password" },
    });

    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({
      error: {
        code: "users-not-writable",
        fix: expect.stringContaining("facetdb users add <name>"),
      },
    });
  });
});

describe("the log", () => {
  it("never holds a password, in a sign-in, a refusal, a lockout, an account made or a failure", async () => {
    const secrets = [MAYA.password, SAM.password, "a long enough password", "wrong password one"];
    const t = rig();
    await t.signIn(MAYA);
    for (let n = 0; n < MAX_FAILURES + 1; n += 1) {
      await t.send("POST", `${REMOTE_URL}/v1/session`, {
        peer: ELSEWHERE,
        body: { name: "sam", password: "wrong password one" },
      });
    }
    await t.send("POST", `${LOCAL_URL}/v1/reviewers`, {
      body: { name: "lee", password: "a long enough password" },
    });
    const broken = rig({
      users: {
        verify: () => Promise.reject(new Error(`the database said no to ${SAM.password}`)),
      },
    });
    const failure = await broken.signIn(SAM);

    expect(t.logs.length).toBeGreaterThan(3);
    expect(t.logs.some((line) => line.includes("sam"))).toBe(true);
    for (const line of [...t.logs, ...broken.logs]) {
      for (const secret of secrets) {
        expect(line).not.toContain(secret);
      }
    }
    // The 500 answers with the request id and no cause.
    expect(failure.response.status).toBe(500);
    for (const secret of secrets) {
      expect(failure.response.text).not.toContain(secret);
    }
  });
});

describe("a surface open to other machines", () => {
  const none: Pick<UsersStore, "list"> = { list: () => Promise.resolve([]) };
  const some: Pick<UsersStore, "list"> = {
    list: () => Promise.resolve([{ name: "maya", createdAt: new Date(START) }]),
  };

  it("refuses to start without an account, with the fix, before anything starts", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "studio.example.com"]) {
      const refusal = await requireAccountToServe(host, none).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OpenSurfaceError);
      expect((refusal as OpenSurfaceError).message).toContain(`--host ${host}`);
      expect((refusal as OpenSurfaceError).fix).toContain("facetdb users add <name>");
    }
  });

  it("starts once an account exists, and a loopback host never needs one", async () => {
    await expect(requireAccountToServe("0.0.0.0", some)).resolves.toBeUndefined();
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST", "127.0.0.2"]) {
      await expect(requireAccountToServe(host, none)).resolves.toBeUndefined();
    }
  });

  it("knows a loopback address from one that only looks like it", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.255.0.1"].every(isLoopbackAddress)).toBe(
      true,
    );
    for (const address of ["128.0.0.1", "10.0.0.1", "::", "::2", "127.0.0.1.evil", undefined]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });
});
