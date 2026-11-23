import { inspectRoutes } from "hono/dev";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.ts";
import type { Peer } from "./auth/middleware.ts";
import { SESSION_COOKIE, type Sessions } from "./auth/sessions.ts";
import { ApiError } from "./errors.ts";
import type { HookDelivery } from "./hooks/index.ts";

/**
 * Every route the app mounts that changes something takes no forged cross-site request. The routes
 * are not listed here: the test reads them off the app (`createApp(deps).routes`, through Hono's
 * `inspectRoutes`), so a route added later is walked with no edit, and one left without
 * `requireOwnPage` fails it. Each is walked as two people a page of another site can borrow:
 *  - a signed-in reviewer on another machine, whose cookie rides along with any request the
 *    browser makes: a text/plain, form or multipart body (sent with no preflight) is a 415
 *    `json_only`; a JSON body from a foreign `Origin`, from `Origin: null` (a sandboxed frame, a
 *    redirect) or with `Sec-Fetch-Site: cross-site` or `same-site` (a sibling subdomain, which
 *    SameSite=Lax still hands the cookie) is a 403 `cross_origin`;
 *  - the OS user on this machine's loopback address, who needs no cookie at all: the same bodies,
 *    and the two `Sec-Fetch-Site` values, with no `Origin` to give the page away (a foreign one
 *    already makes the request a stranger's, 401, before the guard).
 * Every refusal reaches no service and sets no cookie. Then the studio's own page sends the same
 * request and gets past the guard to the route, which proves the path was filled to a real route
 * and that the refusals were the guard's.
 * Every fake below records each call and answers nothing (`fake_reached`). The reviewer lookup is
 * recorded too: it is the authentication, run before the guard by design (a stranger is told to
 * sign in first), and the one call a refusal may make.
 */

const PROJECT = "listings-app";
const STUDIO_URL = "https://studio.example.com";
const LOCAL_URL = "http://127.0.0.1:4040";
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const COOKIE = `${SESSION_COOKIE}=maya.valid`;

/** The reviewer lookup's record: the one call a refused request may have made. */
const AUTHENTICATION = "sessions.reviewerFor";

/**
 * The two writes no cookie authorizes, so no page of another site can forge one with it; each is
 * still required to be in the table, so an entry here cannot outlive its route.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "POST /v1/check":
    "a program's bearer key (`facetdb keys add`) in the Authorization header, which a browser never adds on its own; the cookie opens nothing here",
  "POST /v1/hooks/:plugin/:source":
    "a webhook from another service's servers by design: no FacetDB login, the cookie stripped before the plugin hears, and the plugin checks the sender's signature",
};

/**
 * Entries of every method that Hono flags as middleware (a function of `(c, next)`), by path. The
 * flag cannot tell middleware from a `mount()` or a `(c, next)` handler that answers on its own,
 * so the walk skips only these, each named with what it does; any other one fails the walk.
 */
const KNOWN_MIDDLEWARE: Readonly<Record<string, string>> = {
  "/*": "the request id on every request (app.ts)",
  "/v1/check/*": "the project API key the check route takes (requireApiKey)",
  "/v1/session/*":
    "who the request is by its address (addressCheck), which the session cookie's Secure reads; it answers nothing",
  "/v1/*":
    "who the request is by its address (addressCheck), the studio group's reviewer check (requireReviewer) and the guard itself (requireOwnPage)",
  "/v1/sources/inspect": "the setup's operator-only check (requireOperator), behind the guard",
  "/v1/sources/preview": "the setup's operator-only check (requireOperator), behind the guard",
  "/v1/sources/plan": "the setup's operator-only check (requireOperator), behind the guard",
  "/v1/sources/install": "the setup's operator-only check (requireOperator), behind the guard",
  "/v1/sources/:name/migrate/*":
    "an added question's operator-only check (requireOperator), behind the guard",
};

/** Any answer of the app: a refusal carries the one error shape, a success anything else. */
const answer = z.looseObject({ error: z.object({ code: z.string() }).optional() });

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITES = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The app's route table: every method and path it answers that may change something, and the
 * paths of the entries of every method that Hono flags as middleware, which answer nothing alone.
 */
function tableOf(app: ReturnType<typeof createApp>) {
  const writes = new Set<string>();
  const middleware = new Set<string>();
  for (const route of inspectRoutes(app)) {
    if (READS.has(route.method)) {
      continue;
    }
    if (route.method !== "ALL") {
      writes.add(`${route.method} ${route.path}`);
    } else if (route.isMiddleware) {
      middleware.add(route.path);
    } else {
      // A handler mounted with `all()` answers every write method itself.
      for (const method of WRITES) {
        writes.add(`${method} ${route.path}`);
      }
    }
  }
  return { writes: [...writes], middleware: [...middleware] };
}

/** A route's path with each parameter and wildcard filled, so a request reaches it. */
function filled(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*(\{[^}]*\})?\??/g, "listings").replace(/\*/g, "x");
}

/** Who sends the request: where from, at which address of the studio, with which cookie. */
type Identity = {
  readonly name: string;
  readonly url: string;
  readonly peer: Peer;
  readonly cookie: Readonly<Record<string, string>>;
};

function rig() {
  const calls: string[] = [];
  const deliveries: HookDelivery[] = [];
  /** What the app logs: the proxy line of `addressCheck`, which no request here earns. */
  const logged: string[] = [];
  /** A service method that writes down that it was reached, and answers nothing. */
  const reached = (name: string) => (): never => {
    calls.push(name);
    throw new ApiError(501, "fake_reached", `${name} was reached.`, "This is a test's fake.");
  };

  const sessions: Sessions = {
    signIn: reached("sessions.signIn"),
    reviewerFor: ({ local, cookie }) => {
      calls.push(AUTHENTICATION);
      return Promise.resolve(
        cookie === "maya.valid"
          ? { kind: "reviewer", name: "maya" }
          : cookie === undefined && local
            ? { kind: "reviewer", name: "os:alex" }
            : { kind: "sign-in", why: cookie === undefined ? "no-cookie" : "invalid" },
      );
    },
  };

  const app = createApp({
    keys: {
      create: reached("keys.create"),
      verify: () => Promise.resolve(undefined),
      revoke: reached("keys.revoke"),
    },
    check: { check: reached("check.check") },
    config: {
      json: reached("config.json"),
      validate: reached("config.validate"),
      preview: reached("config.preview"),
      test: reached("config.test"),
      diff: reached("config.diff"),
      apply: reached("config.apply"),
      reload: reached("config.reload"),
    },
    data: {
      runs: { list: reached("runs.list") },
      decisions: { search: reached("decisions.search"), why: reached("decisions.why") },
      home: { home: reached("home.home") },
      sources: { sources: reached("sources.sources") },
      alerts: { alerts: reached("alerts.alerts") },
      access: { access: reached("access.access") },
      alertTest: { available: true, send: reached("alertTest.send") },
    },
    review: {
      queue: reached("review.queue"),
      open: reached("review.open"),
      renew: reached("review.renew"),
      decide: reached("review.decide"),
      skip: reached("review.skip"),
      release: reached("review.release"),
      undo: reached("review.undo"),
    },
    setup: {
      access: reached("setup.access"),
      inspect: reached("setup.inspect"),
      preview: reached("setup.preview"),
      plan: reached("setup.plan"),
      install: reached("setup.install"),
      migratePlan: reached("setup.migratePlan"),
      migrateRun: reached("setup.migrateRun"),
    },
    backfill: {
      available: true,
      estimate: reached("backfill.estimate"),
      start: reached("backfill.start"),
      stop: reached("backfill.stop"),
      status: reached("backfill.status"),
    },
    plugins: {
      facetdb: "0.0.0",
      installed: reached("plugins.installed"),
      gallery: reached("plugins.gallery"),
      packs: reached("plugins.packs"),
    },
    hooks: {
      receive: (_plugin, _source, delivery) => {
        deliveries.push(delivery);
        return reached("hooks.receive")();
      },
    },
    studio: {
      sessions,
      reviewers: {
        list: reached("reviewers.list"),
        canAdd: reached("reviewers.canAdd"),
        add: reached("reviewers.add"),
      },
      projectId: PROJECT,
      // No studioUrl on another host: the loopback identity is the OS user.
      operatorByAddress: true,
      log: (line) => {
        logged.push(line);
      },
    },
    // Mounted, so a write ever added beside the built app's pages is walked too. `[[]]` is the
    // smallest build, the one page `/`: a build's routes say which GET paths answer index.html,
    // never which methods the app answers, so no other list would add a route to walk.
    studioApp: { files: { read: reached("studioApp.read") }, routes: [[]] },
    newRequestId: () => "req-1",
  });

  /** One request to the route `write` (`POST /v1/apply`), as `who`'s browser sends it. */
  async function send(
    who: Identity,
    write: string,
    headers: Readonly<Record<string, string>>,
    body: string,
  ) {
    const [method = "", path = ""] = write.split(" ");
    const response = await app.request(
      `${who.url}${filled(path)}`,
      { method, headers: { ...who.cookie, ...headers }, body },
      who.peer,
    );
    // Read as text first, so a route that answers no body, or one that is not JSON, is named.
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new Error(`${write} answered ${response.status} with a body that is not JSON: ${text}`);
    }
    const parsed = answer.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${write} answered ${response.status} with an error not in the one shape`);
    }
    return {
      status: response.status,
      code: parsed.data.error?.code,
      setCookie: response.headers.get("set-cookie"),
    };
  }

  return { app, calls, deliveries, logged, send };
}

const MULTIPART_BOUNDARY = "forged";

/** A body a page of another site can send with no preflight, and how the guard refuses each. */
const BODIES = [
  {
    name: "a text/plain body",
    headers: { "content-type": "text/plain" },
    body: '{"name":"mallory"}',
    status: 415,
    code: "json_only",
  },
  {
    name: "a form body",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "name=mallory",
    status: 415,
    code: "json_only",
  },
  {
    name: "a multipart form body",
    headers: { "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
    body: `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\nmallory\r\n--${MULTIPART_BOUNDARY}--\r\n`,
    status: 415,
    code: "json_only",
  },
] as const;

/** A JSON body whose `Sec-Fetch-Site` says another site's page sent it. */
const FETCH_SITES = [
  {
    name: "a JSON body with Sec-Fetch-Site: cross-site",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: "{}",
    status: 403,
    code: "cross_origin",
  },
  {
    name: "a JSON body with Sec-Fetch-Site: same-site",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-site" },
    body: "{}",
    status: 403,
    code: "cross_origin",
  },
] as const;

/** A JSON body whose `Origin`, with no `Sec-Fetch-Site`, is not the studio's. */
const ORIGINS = [
  {
    name: "a JSON body from a foreign Origin",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
    status: 403,
    code: "cross_origin",
  },
  {
    name: "a JSON body from Origin: null",
    headers: { "content-type": "application/json", origin: "null" },
    body: "{}",
    status: 403,
    code: "cross_origin",
  },
] as const;

const REVIEWER: Identity = {
  name: "a signed-in reviewer on another machine",
  url: STUDIO_URL,
  peer: ELSEWHERE,
  cookie: { cookie: COOKIE },
};

const OS_USER: Identity = {
  name: "the OS user on this machine's loopback address",
  url: LOCAL_URL,
  peer: THIS_MACHINE,
  cookie: {},
};

/** Each person a page of another site can borrow, and what that page can make their browser send. */
const IDENTITIES = [
  { who: REVIEWER, forged: [...BODIES, ...ORIGINS, ...FETCH_SITES] },
  { who: OS_USER, forged: [...BODIES, ...FETCH_SITES] },
];

/** The codes of a request turned away before its route: the guard's two, and the sign-in's. */
const REFUSED_BEFORE_THE_ROUTE = new Set<string | undefined>([
  "json_only",
  "cross_origin",
  "sign-in",
]);

/** What a failing route is told to do. */
function fixFor(write: string): string {
  return `mount ${write} behind requireOwnPage (request.ts; app.ts's studio group has it) and keep its four rules whole, or, if no cookie and no address authorizes it, add it to EXEMPT with that reason`;
}

describe("every route that changes something, read off the app", () => {
  const { app } = rig();
  const table = tableOf(app);
  const walked = table.writes.filter((write) => EXEMPT[write] === undefined);

  it("holds writes to walk, the exempt two among them, so an empty walk never passes", () => {
    expect(walked.length).toBeGreaterThan(0);
    for (const write of Object.keys(EXEMPT)) {
      expect(table.writes, `${write} is exempt here but the app no longer mounts it`).toContain(
        write,
      );
    }
  });

  it("skips only the middleware it names, so a mount() or a (c, next) handler is never passed over", () => {
    const unknown = table.middleware.filter((path) => KNOWN_MIDDLEWARE[path] === undefined);
    expect(
      unknown.map((path) => `ALL ${path}`),
      "Hono flags these as middleware, which the walk cannot tell from a mount() or a (c, next) handler: for one that answers requests, mount it behind requireOwnPage (request.ts; app.ts's studio group has it), or, if no cookie and no address authorizes it, add it to EXEMPT with that reason; for middleware, add its path to KNOWN_MIDDLEWARE with what it does",
    ).toEqual([]);
    for (const path of Object.keys(KNOWN_MIDDLEWARE)) {
      expect(
        table.middleware,
        `${path} is named in KNOWN_MIDDLEWARE but the app no longer mounts it`,
      ).toContain(path);
    }
  });

  describe.each(IDENTITIES)("as $who.name", ({ who, forged }) => {
    it.each(walked)("%s refuses each forged request before any service hears", async (write) => {
      const t = rig();
      for (const attempt of forged) {
        const response = await t.send(who, write, attempt.headers, attempt.body);
        const what = `${write} took ${attempt.name} from ${who.name}`;
        expect(
          { status: response.status, code: response.code },
          `${what}: ${fixFor(write)}`,
        ).toEqual({ status: attempt.status, code: attempt.code });
        expect(
          t.calls.filter((call) => call !== AUTHENTICATION),
          `${what} to a service: ${fixFor(write)}`,
        ).toEqual([]);
        expect(response.setCookie, `${what} and set a cookie: ${fixFor(write)}`).toBeNull();
        // No forged request here comes through a loopback socket with a foreign Origin, so none is
        // taken for a proxy without a forwarding header.
        expect(t.logged, `${what} and printed a line`).toEqual([]);
      }
      // The studio's own page gets past the guard to the route: the path is real, the guard let it by.
      const own = await t.send(
        who,
        write,
        { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: who.url },
        "{}",
      );
      expect(own.code, `${write} from the studio's own page`).not.toBe("not_found");
      expect(
        REFUSED_BEFORE_THE_ROUTE.has(own.code),
        `${write} from the studio's own page, as ${who.name}: ${own.code}`,
      ).toBe(false);
    });
  });

  it("POST /v1/check: the reviewer's cookie with no key is refused before the check is asked", async () => {
    const t = rig();
    const response = await t.send(
      REVIEWER,
      "POST /v1/check",
      { "content-type": "application/json" },
      "{}",
    );
    expect(response.status).toBe(401);
    expect(t.calls).toEqual([]);
  });

  it("POST /v1/hooks/:plugin/:source: the plugin is handed no cookie to trust", async () => {
    const t = rig();
    const response = await t.send(
      REVIEWER,
      "POST /v1/hooks/:plugin/:source",
      { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      "{}",
    );
    expect(response.code).toBe("fake_reached");
    expect(t.calls).toEqual(["hooks.receive"]);
    expect(t.deliveries.map((delivery) => delivery.headers.get("cookie"))).toEqual([null]);
  });
});
