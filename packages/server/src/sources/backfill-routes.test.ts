import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import type {
  BackfillEstimateOutcome,
  BackfillJobStatus,
  BackfillJobsDoor,
  BackfillStartOutcome,
  BackfillStatusOutcome,
  BackfillStopOutcome,
} from "./backfill-door.ts";

/**
 * The studio's backfill routes over a door that records what it was asked and answers what the test
 * hands it: a reviewer's alone; the three POSTs, which spend model budget and write into the
 * customer's table, only from the studio's own page, as Apply; each of the door's outcomes mapped
 * to its status, code and words; a body that is not the route's shape refused before the door hears
 * of it; and a worker with no jobs to offer refusing every route.
 */

const PROJECT = "listings-app";
const KEY = "Bearer fdb_listings";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
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

/** A job of listings in `state`, as the door reports one. */
function job(
  state: BackfillJobStatus["state"],
  more: Partial<BackfillJobStatus> = {},
): BackfillJobStatus {
  return {
    source: "listings",
    state,
    questions: null,
    version: 3,
    surveyed: 1_200,
    estimate: {
      records: 1_200,
      sampled: 100,
      tokensPerRecord: 85,
      tokens: 102_000,
      dollars: 0.0043,
      calibration: { records: 100, scale: 2.7 },
    },
    pace: 50,
    token: null,
    expiresAt: null,
    counts: { records: 0, queued: 0, answered: 0, alreadyAnswered: 0, deferred: 0 },
    since: "2026-11-06T12:00:00.000Z",
    endedAt: null,
    why: null,
    words: `The backfill of listings is ${state}.`,
    ...more,
  };
}

const ESTIMATING = job("estimating", { surveyed: 0, estimate: null });
const WAITING = job("waiting", { token: "token-1", expiresAt: "2026-11-06T12:10:00.000Z" });
const RUNNING = job("running");
const STOPPING = job("stopping");

/** The CLI's door as a recorder: what each call was asked, and the outcome the test hands back. */
function jobsDoor(
  outcomes: {
    readonly estimate?: BackfillEstimateOutcome;
    readonly start?: BackfillStartOutcome;
    readonly stop?: BackfillStopOutcome;
    readonly status?: BackfillStatusOutcome;
  } = {},
) {
  const calls: unknown[][] = [];
  const door: BackfillJobsDoor = {
    available: true,
    estimate: (source, questions) => {
      calls.push(["estimate", source, questions]);
      return Promise.resolve(outcomes.estimate ?? { kind: "estimating", status: ESTIMATING });
    },
    start: (source, token) => {
      calls.push(["start", source, token]);
      return Promise.resolve(outcomes.start ?? { kind: "started", status: RUNNING });
    },
    stop: (source) => {
      calls.push(["stop", source]);
      return Promise.resolve(outcomes.stop ?? { kind: "stopping", status: STOPPING });
    },
    status: (source) => {
      calls.push(["status", source]);
      return Promise.resolve(outcomes.status ?? { kind: "status", status: WAITING });
    },
  };
  return { calls, door };
}

type Who = {
  readonly peer?: { readonly remoteAddress: string };
  readonly headers?: Readonly<Record<string, string>>;
};

/** The app with the door given, or with none: a worker that offers no jobs. */
function rig(door: BackfillJobsDoor | undefined) {
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: NO_DATA,
    review: NO_REVIEW,
    ...(door === undefined ? {} : { backfill: door }),
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
  const answer = async (response: Response) => ({
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  });
  return {
    get: async (path: string, who: Who = {}) =>
      answer(
        await app.request(
          `/v1/sources/${path}`,
          { method: "GET", headers: { ...who.headers } },
          who.peer ?? THIS_MACHINE,
        ),
      ),
    post: async (path: string, body: unknown, who: Who = {}) =>
      answer(
        await app.request(
          `/v1/sources/${path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...who.headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
          },
          who.peer ?? THIS_MACHINE,
        ),
      ),
  };
}

const POSTS = [
  "listings/backfill/estimate",
  "listings/backfill/start",
  "listings/backfill/stop",
] as const;

describe("who may reach the backfill routes", () => {
  it("a reviewer alone: no session from elsewhere, and a project API key, are refused before the door hears", async () => {
    const t = jobsDoor();
    const app = rig(t.door);

    for (const headers of [{}, { authorization: KEY }]) {
      expect(await app.get("listings/backfill", { peer: ELSEWHERE, headers })).toMatchObject({
        status: 401,
        json: { error: { code: "sign-in" } },
      });
      for (const path of POSTS) {
        expect(await app.post(path, {}, { peer: ELSEWHERE, headers })).toMatchObject({
          status: 401,
          json: { error: { code: "sign-in" } },
        });
      }
    }
    expect(t.calls).toEqual([]);
  });

  it("the three that spend or write take only a JSON body declared as such, and never a page of another site", async () => {
    const t = jobsDoor();
    const app = rig(t.door);

    for (const path of POSTS) {
      // A form or text/plain body is what a page on another site can send without asking first.
      expect(
        await app.post(path, "{}", { headers: { "content-type": "text/plain" } }),
      ).toMatchObject({ status: 415, json: { error: { code: "json_only" } } });
      // A signed-in reviewer's browser carries the cookie to any page's request: the site decides.
      for (const headers of [
        { cookie: MAYA, origin: "https://evil.example" },
        { cookie: MAYA, "sec-fetch-site": "cross-site" },
        { cookie: MAYA, "sec-fetch-site": "same-site" },
      ]) {
        expect(await app.post(path, {}, { peer: ELSEWHERE, headers })).toMatchObject({
          status: 403,
          json: {
            error: {
              code: "cross_origin",
              message:
                "This request came from a page on another site, and the studio takes a write only from its own pages or a program.",
            },
          },
        });
      }
    }
    expect(t.calls).toEqual([]);

    // The studio's own page, signed in from another machine, is let through.
    const own = await app.post(
      "listings/backfill/stop",
      {},
      {
        peer: ELSEWHERE,
        headers: { cookie: MAYA, origin: "http://localhost", "sec-fetch-site": "same-origin" },
      },
    );
    expect(own.status).toBe(200);
    // The read writes nothing and spends nothing: any signed-in reviewer's request has it.
    const read = await app.get("listings/backfill", {
      peer: ELSEWHERE,
      headers: { cookie: MAYA, "sec-fetch-site": "cross-site" },
    });
    expect(read).toEqual({ status: 200, json: WAITING });
  });

  it("answers that this worker runs no backfill on every route when it offers none", async () => {
    const app = rig(undefined);
    const unavailable = {
      status: 409,
      json: {
        error: {
          code: "backfill_unavailable",
          message:
            "This worker runs no backfill from the studio: facetdb worker --once answers what is queued and exits.",
          fix: "Run facetdb worker, then backfill from the studio; or run facetdb backfill --source <name> on this machine.",
        },
      },
    };

    expect(await app.get("listings/backfill")).toEqual(unavailable);
    expect(await app.post("listings/backfill/estimate", {})).toEqual(unavailable);
    expect(await app.post("listings/backfill/start", { token: "token-1" })).toEqual(unavailable);
    expect(await app.post("listings/backfill/stop", {})).toEqual(unavailable);
  });
});

describe("GET /v1/sources/:name/backfill", () => {
  it("answers where the source's job stands, the estimate and the token a start takes with it", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).get("listings/backfill")).toEqual({ status: 200, json: WAITING });
    expect(t.calls).toEqual([["status", "listings"]]);
  });

  it("answers 404 for a source the worker does not run", async () => {
    const t = jobsDoor({ status: { kind: "unknown_source" } });

    expect(await rig(t.door).get("orders/backfill")).toEqual({
      status: 404,
      json: {
        error: {
          code: "unknown_source",
          message: 'This worker runs no source called "orders", so it has nothing to backfill.',
          fix: "Backfill a source listed by GET /v1/sources; a source added to facetdb.config.ts is listed once the worker has started it (the setup flow installs and starts it) or after a restart.",
        },
      },
    });
  });

  it("refuses a name no source could have before the door hears of it", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).get(`${"x".repeat(201)}/backfill`)).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_request" } },
    });
    expect(t.calls).toEqual([]);
  });
});

describe("POST /v1/sources/:name/backfill/estimate", () => {
  it("answers 202 with the job as it starts to count, for the whole set or for the questions named", async () => {
    const t = jobsDoor();
    const app = rig(t.door);

    expect(await app.post("listings/backfill/estimate", {})).toEqual({
      status: 202,
      json: ESTIMATING,
    });
    expect(
      (await app.post("listings/backfill/estimate", { questions: ["spam", "is_new"] })).status,
    ).toBe(202);
    expect(t.calls).toEqual([
      ["estimate", "listings", undefined],
      ["estimate", "listings", ["spam", "is_new"]],
    ]);
  });

  it.each([
    [
      { kind: "unknown_source" },
      404,
      "unknown_source",
      'This worker runs no source called "listings", so it has nothing to backfill.',
    ],
    [
      { kind: "not_a_table" },
      409,
      "not_a_table",
      '"listings" reads no table: an API source\'s records arrive one by one through the check API, so there is nothing to backfill.',
    ],
    [
      { kind: "busy", status: ESTIMATING },
      409,
      "backfill_busy",
      'A backfill of "listings" is being estimated; a source runs one backfill at a time.',
    ],
    [
      { kind: "busy", status: WAITING },
      409,
      "backfill_busy",
      'A backfill of "listings" is estimated and waiting to be started; a source runs one backfill at a time.',
    ],
    [
      { kind: "busy", status: RUNNING },
      409,
      "backfill_busy",
      'A backfill of "listings" is running; a source runs one backfill at a time.',
    ],
    [
      { kind: "busy", status: STOPPING },
      409,
      "backfill_busy",
      'A backfill of "listings" is stopping after the page in hand; a source runs one backfill at a time.',
    ],
    [
      { kind: "not_installed", questions: ["is_vehicle"] },
      409,
      "question_not_installed",
      '"listings" does not run "is_vehicle" yet, so a backfill cannot ask it.',
    ],
    [
      { kind: "not_installed", questions: ["is_vehicle", "is_new"] },
      409,
      "question_not_installed",
      '"listings" does not run "is_vehicle", "is_new" yet, so a backfill cannot ask them.',
    ],
  ] as const satisfies readonly (readonly [BackfillEstimateOutcome, number, string, string])[])(
    "maps the door's refusal %j to %i %s",
    async (estimate, status, code, message) => {
      const response = await rig(jobsDoor({ estimate }).door).post(
        "listings/backfill/estimate",
        {},
      );

      expect(response).toMatchObject({ status, json: { error: { code, message } } });
      expect((response.json["error"] as { fix: string }).fix).not.toBe("");
    },
  );

  it.each([
    [{ questions: [] }],
    [{ questions: "spam" }],
    [{ questions: [""] }],
    [{ question: ["spam"] }],
  ])("refuses the body %j with the shape it takes, and asks the door nothing", async (body) => {
    const t = jobsDoor();

    expect(await rig(t.door).post("listings/backfill/estimate", body)).toMatchObject({
      status: 400,
      json: {
        error: {
          code: "invalid_request",
          fix: 'Send {} for the whole question set, or {"questions": ["<question name>", …]} for questions just added.',
        },
      },
    });
    expect(t.calls).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).post("listings/backfill/estimate", "{")).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_json" } },
    });
    expect(t.calls).toEqual([]);
  });
});

describe("POST /v1/sources/:name/backfill/start", () => {
  it("starts the waiting job with the token the estimate gave, and answers the job as it runs", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).post("listings/backfill/start", { token: "token-1" })).toEqual({
      status: 200,
      json: RUNNING,
    });
    expect(t.calls).toEqual([["start", "listings", "token-1"]]);
  });

  it.each([
    [
      { kind: "unknown_source" },
      404,
      "unknown_source",
      'This worker runs no source called "listings", so it has nothing to backfill.',
    ],
    [
      { kind: "no_estimate", status: job("idle") },
      409,
      "no_estimate",
      'No estimate of a backfill of "listings" is waiting to be started, so nothing was started.',
    ],
    [
      { kind: "wrong_token", status: WAITING },
      409,
      "estimate_changed",
      'The token is not the one of the estimate waiting for "listings", so nothing was started.',
    ],
    [
      { kind: "expired", status: job("stopped") },
      409,
      "estimate_expired",
      'The estimate of "listings" was not started in time, so it was dropped; nothing was asked.',
    ],
    [
      // Caught as the start came in: the job has not ended, and has no words of its own yet.
      { kind: "restarted", status: STOPPING },
      409,
      "source_restarted",
      'A reload changed "listings" since the estimate, so the estimate no longer prices what would run; nothing was asked.',
    ],
    [
      {
        kind: "restarted",
        status: job("stopped", {
          why: "listings restarted under version 4 after a reload, so the backfill under version 3 stopped before it started; nothing was asked. Estimate again under version 4.",
        }),
      },
      409,
      "source_restarted",
      "listings restarted under version 4 after a reload, so the backfill under version 3 stopped before it started; nothing was asked. Estimate again under version 4.",
    ],
  ] as const satisfies readonly (readonly [BackfillStartOutcome, number, string, string])[])(
    "maps the door's refusal %j to %i %s",
    async (start, status, code, message) => {
      const response = await rig(jobsDoor({ start }).door).post("listings/backfill/start", {
        token: "token-1",
      });

      expect(response).toMatchObject({ status, json: { error: { code, message } } });
      expect((response.json["error"] as { fix: string }).fix).not.toBe("");
    },
  );

  it.each([[{}], [{ token: "" }], [{ token: 7 }], [{ token: "token-1", force: true }]])(
    "refuses the body %j with the shape it takes, and asks the door nothing",
    async (body) => {
      const t = jobsDoor();

      expect(await rig(t.door).post("listings/backfill/start", body)).toMatchObject({
        status: 400,
        json: {
          error: {
            code: "invalid_request",
            fix: 'Send {"token": "<the token the estimate answered with>"}.',
          },
        },
      });
      expect(t.calls).toEqual([]);
    },
  );
});

describe("POST /v1/sources/:name/backfill/stop", () => {
  it("tells the job to stop, and answers it as it stops after its page in hand", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).post("listings/backfill/stop", {})).toEqual({
      status: 200,
      json: STOPPING,
    });
    expect(t.calls).toEqual([["stop", "listings"]]);
  });

  it.each([
    [
      { kind: "unknown_source" },
      404,
      "unknown_source",
      'This worker runs no source called "listings", so it has nothing to backfill.',
    ],
    [
      { kind: "nothing_to_stop", status: job("finished") },
      409,
      "nothing_to_stop",
      'No backfill of "listings" is being estimated, waiting or running, so there is nothing to stop.',
    ],
  ] as const satisfies readonly (readonly [BackfillStopOutcome, number, string, string])[])(
    "maps the door's refusal %j to %i %s",
    async (stop, status, code, message) => {
      const response = await rig(jobsDoor({ stop }).door).post("listings/backfill/stop", {});

      expect(response).toMatchObject({ status, json: { error: { code, message } } });
      expect((response.json["error"] as { fix: string }).fix).not.toBe("");
    },
  );

  it("takes an empty object and nothing else", async () => {
    const t = jobsDoor();

    expect(await rig(t.door).post("listings/backfill/stop", { now: true })).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_request", fix: "Send {}." } },
    });
    expect(t.calls).toEqual([]);
  });
});
