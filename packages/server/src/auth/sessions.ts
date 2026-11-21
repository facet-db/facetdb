import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "@facetdb/core";
import { isUserName, type UsersStore } from "@facetdb/postgres";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { bodyProblems, readJson, requireOwnPage } from "../request.ts";
import { fromThisMachine } from "./loopback.ts";
import type { AppEnv } from "./middleware.ts";

/**
 * Reviewer sessions. On this machine's loopback address the reviewer is the OS user and nobody
 * signs in; from any other address a reviewer signs in with a `facetdb users add` account and
 * carries a signed cookie. The cookie is `<name>.<expiry>.<signature>`: the signature is an
 * HMAC-SHA256, under a key derived from `FACETDB_SECRET`, of the name, the expiry (milliseconds
 * since the epoch) and the moment the account was made. Binding the account's own creation time
 * means removing an account, or removing it and adding it again with another password, ends every
 * cookie it had.
 */

export const SESSION_COOKIE = "facetdb_session";

/** A session lasts 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** The prefix of a reviewer who did not sign in: the operating system's user on this machine. */
export const OS_REVIEWER_PREFIX = "os:";

/**
 * A password longer than this is refused before any hashing: a body is a boundary, and scrypt's
 * time does not grow with a password this size, but an unbounded one would be read and held.
 */
export const MAX_PASSWORD_LENGTH = 10_000;

// Sign-in is the one endpoint a stranger can make spend 32 MiB and 70 ms per call, and the only one
// that can be guessed at. The limits below are this module's own.
/** Wrong passwords one name takes in a window before it stops answering until the window ends. */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** Sign-ins held waiting for their turn at the hash; more than this are sent away at once. */
const MAX_WAITING = 8;
/** Names remembered with a failure; the oldest are forgotten past this, so strangers cannot fill memory. */
const MAX_TRACKED_NAMES = 1_000;

export type SessionUsers = Pick<UsersStore, "verify" | "list">;

export type SessionsDeps = {
  /** `FACETDB_SECRET`, read once by the composition root and refused there when unset. */
  readonly secret: string;
  readonly clock: Clock;
  readonly users: SessionUsers;
  /** The operating system's user name, for a request that needs no sign-in. */
  readonly osUser: () => string;
  /** One line per sign-in, refusal and lockout: names and counts, never a password. */
  readonly log: (line: string) => void;
};

export type SignIn =
  | {
      readonly kind: "signed-in";
      readonly name: string;
      readonly cookie: string;
      readonly expiresAtMs: number;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "slow-down"; readonly retryAfterSeconds: number };

export type ReviewerLookup =
  | { readonly kind: "reviewer"; readonly name: string }
  | { readonly kind: "sign-in"; readonly why: "no-cookie" | "expired" | "invalid" };

export type Sessions = {
  /** Checks a name and password; a right pair gets a cookie value that lasts `SESSION_TTL_MS`. */
  signIn(name: string, password: string): Promise<SignIn>;
  /** The reviewer behind a request: this machine's OS user with no cookie, else the cookie's. */
  reviewerFor(request: {
    readonly local: boolean;
    readonly cookie: string | undefined;
  }): Promise<ReviewerLookup>;
};

/** A sign-in that did not get a cookie. */
type Turned = Exclude<SignIn, { readonly kind: "signed-in" }>;

type Failures = { count: number; sinceMs: number };

export function createSessions(deps: SessionsDeps): Sessions {
  const { clock, users, log } = deps;
  // A key of its own, so the secret that encrypts the store's credentials never signs a cookie.
  const key = createHmac("sha256", deps.secret).update("facetdb:session-cookie:v1").digest();
  const failures = new Map<string, Failures>();
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  const signature = (name: string, createdMs: number, expiresMs: number) =>
    createHmac("sha256", key).update(`${name}\n${createdMs}\n${expiresMs}`).digest();

  /** One hash at a time: scrypt holds 32 MiB, so a burst of sign-ins must queue rather than add up. */
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    waiting += 1;
    const run = tail.then(work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      waiting -= 1;
    }
  }

  /** Seconds until a name takes another attempt, or undefined when it takes one now. */
  function lockedFor(name: string, now: number): number | undefined {
    const entry = failures.get(name);
    if (entry === undefined) {
      return undefined;
    }
    if (now - entry.sinceMs >= FAILURE_WINDOW_MS) {
      failures.delete(name);
      return undefined;
    }
    return entry.count >= MAX_FAILURES
      ? Math.ceil((entry.sinceMs + FAILURE_WINDOW_MS - now) / 1000)
      : undefined;
  }

  function noteFailure(name: string, now: number): number {
    const entry = failures.get(name);
    const fresh = entry === undefined || now - entry.sinceMs >= FAILURE_WINDOW_MS;
    const next = fresh
      ? { count: 1, sinceMs: now }
      : { count: entry.count + 1, sinceMs: entry.sinceMs };
    failures.delete(name);
    failures.set(name, next);
    for (const oldest of failures.keys()) {
      if (failures.size <= MAX_TRACKED_NAMES) {
        break;
      }
      failures.delete(oldest);
    }
    return next.count;
  }

  /** The name a cookie vouches for, or why it does not. The signature is checked before the expiry. */
  async function reviewerOfCookie(cookie: string): Promise<ReviewerLookup> {
    const invalid = { kind: "sign-in", why: "invalid" } as const;
    const [name, expiry, given, ...rest] = cookie.split(".");
    if (
      name === undefined ||
      expiry === undefined ||
      given === undefined ||
      rest.length > 0 ||
      !isUserName(name) ||
      !/^\d{1,15}$/.test(expiry)
    ) {
      return invalid;
    }
    const account = (await users.list()).find((candidate) => candidate.name === name);
    if (account === undefined) {
      return invalid;
    }
    const expected = signature(name, account.createdAt.getTime(), Number(expiry));
    const presented = Buffer.from(given, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return invalid;
    }
    return Number(expiry) > clock.now()
      ? { kind: "reviewer", name }
      : { kind: "sign-in", why: "expired" };
  }

  return {
    async signIn(name, password) {
      // No account can have this name: nothing to hash, nothing to remember about the caller.
      if (!isUserName(name)) {
        return { kind: "refused" };
      }
      if (waiting >= MAX_WAITING) {
        return { kind: "slow-down", retryAfterSeconds: 1 };
      }
      const checked = await exclusively(async (): Promise<Turned | "right"> => {
        // Inside the turn, so attempts that queued behind the fifth wrong one are not hashed.
        const locked = lockedFor(name, clock.now());
        if (locked !== undefined) {
          return { kind: "slow-down", retryAfterSeconds: locked };
        }
        return (await users.verify(name, password)) ? "right" : { kind: "refused" };
      });
      if (checked !== "right") {
        if (checked.kind === "refused") {
          log(`sign-in refused for ${name} (${noteFailure(name, clock.now())} wrong in a row)`);
        } else {
          log(
            `sign-in not tried for ${name}: too many wrong passwords, ${checked.retryAfterSeconds} s to wait`,
          );
        }
        return checked;
      }
      failures.delete(name);
      const account = (await users.list()).find((candidate) => candidate.name === name);
      if (account === undefined) {
        // Removed between the check and the cookie: there is no account to sign in to.
        return { kind: "refused" };
      }
      const expiresAtMs = clock.now() + SESSION_TTL_MS;
      const proof = signature(name, account.createdAt.getTime(), expiresAtMs).toString("base64url");
      log(`sign-in: ${name} signed in`);
      return { kind: "signed-in", name, cookie: `${name}.${expiresAtMs}.${proof}`, expiresAtMs };
    },

    async reviewerFor({ local, cookie }) {
      if (cookie === undefined) {
        return local
          ? { kind: "reviewer", name: `${OS_REVIEWER_PREFIX}${deps.osUser()}` }
          : { kind: "sign-in", why: "no-cookie" };
      }
      // A cookie that is sent must be good, on this machine too: an ended session asks to sign in
      // again (the response clears it) rather than quietly turning into the OS user.
      return reviewerOfCookie(cookie);
    },
  };
}

const signInBody = z.strictObject({
  name: z.string().min(1).max(200),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const SIGN_IN_FIX =
  'Sign in with POST /v1/session and a body of {"name", "password"}, using an account made by `facetdb users add <name>`; on the machine that runs facetdb worker, open http://127.0.0.1 and no sign-in is needed.';

const ENDED = {
  "no-cookie": "This request is not signed in.",
  expired: "Your session has ended.",
  invalid: "This session is not valid.",
} as const;

/** Set-Cookie attributes shared by sign-in and sign-out; `Secure` follows the request. */
function cookieAttributes(local: boolean) {
  return { path: "/", httpOnly: true, sameSite: "Lax", secure: !local } as const;
}

/**
 * Who may use the studio's routes. Everything mounted behind this is reviewer-only: it sets
 * `reviewer` and `projectId` (the one project this open-source worker serves). A route for the
 * SDK or another machine uses `requireApiKey` instead, mounted before this one (app.ts).
 */
export function requireReviewer(sessions: Sessions, projectId: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const found = await sessions.reviewerFor({
      local: fromThisMachine(c.req.raw, c.env),
      cookie,
    });
    if (found.kind === "sign-in") {
      throw new ApiError(
        401,
        "sign-in",
        ENDED[found.why],
        SIGN_IN_FIX,
        // A cookie that did not hold is cleared, so the browser stops sending it.
        cookie === undefined
          ? {}
          : { "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` },
      );
    }
    c.set("reviewer", found.name);
    c.set("projectId", projectId);
    await next();
  });
}

/**
 * `POST /v1/session` signs in and sets the cookie; `DELETE /v1/session` clears it. Public routes.
 * Sign-in still takes only the studio's own page or a program (`requireOwnPage`): a page of another
 * site must not be able to sign this browser in to an account it chose (login CSRF).
 */
export function sessionRoutes(sessions: Sessions): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/", requireOwnPage(), async (c) => {
    const body = signInBody.safeParse(await readJson(c.req));
    if (!body.success) {
      throw new ApiError(
        400,
        "invalid_request",
        bodyProblems(body.error),
        'Send {"name": "<account name>", "password": "<password>"}.',
      );
    }
    const result = await sessions.signIn(body.data.name, body.data.password);
    switch (result.kind) {
      case "signed-in":
        setCookie(c, SESSION_COOKIE, result.cookie, {
          ...cookieAttributes(fromThisMachine(c.req.raw, c.env)),
          maxAge: SESSION_TTL_MS / 1000,
        });
        return c.json({
          reviewer: result.name,
          expiresAt: new Date(result.expiresAtMs).toISOString(),
        });
      case "slow-down":
        throw new ApiError(
          429,
          "too-many-attempts",
          "Too many sign-in attempts were wrong or are waiting.",
          `Wait ${result.retryAfterSeconds} seconds and sign in again.`,
          { "retry-after": String(result.retryAfterSeconds) },
        );
      case "refused":
        // The same words for an unknown name and a wrong password, so a caller learns nothing.
        throw new ApiError(
          401,
          "invalid-credentials",
          "That name and password do not match a reviewer account.",
          "Check both, or ask whoever runs this studio to run `facetdb users add <name>` for you.",
        );
    }
  });

  route.delete("/", (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieAttributes(fromThisMachine(c.req.raw, c.env)));
    return c.json({ signedOut: true });
  });

  return route;
}
