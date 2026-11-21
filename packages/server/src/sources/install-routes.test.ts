import type { EngineTarget, PlanResult } from "@facetdb/core";
import { FakeClock, FakeEngine } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import { createConfigService, type SourceDraft } from "../config/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import type {
  InspectOutcome,
  SetupDoor,
  SetupInstallOutcome,
  SetupPlanOutcome,
  ShownPlan,
} from "./door.ts";
import { INSTALL_NOTHING_RAN, INSTALL_OUTCOME_UNKNOWN, INSTALL_STOPPED } from "./install-codes.ts";
import { hideSecrets, secretParts } from "./redact.ts";
import { createSetupService, PLAN_TOKEN_TTL_MS } from "./service.ts";

/**
 * The setup flow's routes over a door that plans and runs through the fake engine: the operator on
 * this machine alone, and only from the studio's own page; inspect, plan and a refused plan; an
 * install only with a token from a plan, once, within its life, for that draft; and the admin
 * connection string's marked password, user and host absent from every response and every log line,
 * on success and on each failure.
 */

const PROJECT = "listings-app";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const MAYA = `${SESSION_COOKIE}=maya.valid`;

const MARKS = {
  password: "pw-MARK-7c1e",
  user: "adminMARKuser",
  host: "db-MARK.internal.example",
} as const;
const ADMIN = `postgres://${MARKS.user}:${MARKS.password}@${MARKS.host}:5432/app?sslmode=require`;

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: () => Promise.resolve(undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

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

const NO_DATA: DataServices = {
  runs: { list: () => Promise.reject(new Error("no runs")) },
  decisions: {
    search: () => Promise.reject(new Error("no decisions")),
    why: () => Promise.reject(new Error("no record")),
  },
  home: { home: () => Promise.reject(new Error("no home")) },
  sources: { sources: () => Promise.reject(new Error("no sources")) },
  alerts: { alerts: () => Promise.reject(new Error("no alerts")) },
  access: { access: () => Promise.reject(new Error("no studio access")) },
};

const DRAFT: SourceDraft = {
  name: "listings",
  table: "listings",
  database: { env: "LISTINGS_URL" },
  read: ["title"],
  questions: { is_scam: { type: "noul", instructions: "Is this a scam?", stakes: "high" } },
  thresholds: {},
};

const TARGET: EngineTarget = {
  project: { id: PROJECT, name: PROJECT },
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "reset",
  questionSet: { questions: [], read: ["title"], model: "jev-1.14.0", thresholds: {} },
};

const DIFF =
  '--- a/facetdb.config.ts\n+++ b/facetdb.config.ts\n@@ -3,0 +4,1 @@\n+    { name: "listings" },\n';

function plan(statements: readonly string[], transactional = true): PlanResult {
  return {
    ok: true,
    plan: {
      statements: statements.map((text) => ({
        database: "source" as const,
        purpose: "columns" as const,
        text,
      })),
      transactional,
      removes: [],
      keeps: [],
      notes: [],
    },
  };
}

/** What a test makes the door do, beyond the fake engine's plan and run. */
type Behaviour = {
  inspectThrows?: unknown;
  planThrows?: unknown;
  /** The engine's install plan: a script, or a refusal. */
  install?: PlanResult;
  transactional?: boolean;
  /** What the door's install answers after a run that finished, in place of `installed`. */
  installOutcome?: SetupInstallOutcome | "throw";
};

/**
 * A door as the CLI's would be, its database half the fake engine's: the inspection and the plan
 * from fixtures, the script rendered by the engine, the install planned again and run only when it
 * is the script shown. Every admin string it is handed is noted, to prove it is used and dropped.
 */
function doorOf(engine: FakeEngine, behaviour: Behaviour) {
  const admins: string[] = [];
  const shownFrom = async (admin: string) => {
    const planned = await engine.planInstall(TARGET, admin, {
      clock: new FakeClock(0),
      allowInsecure: false,
      storeShared: false,
    });
    return planned;
  };
  const door: SetupDoor = {
    available: true,
    async inspect(admin, table): Promise<InspectOutcome> {
      admins.push(admin);
      if (behaviour.inspectThrows !== undefined) {
        throw behaviour.inspectThrows;
      }
      if (engine.inspect === undefined) {
        throw new Error("the fake engine has no inspect");
      }
      const result = await engine.inspect(admin, {
        allowInsecure: false,
        ...(table === undefined ? {} : { table }),
      });
      return result.ok
        ? {
            kind: "inspected",
            database: "Postgres",
            tables: result.inspection.tables,
            table: result.inspection.table ?? null,
          }
        : { kind: "refused", ...result.refusal };
    },
    preview: () => Promise.reject(new Error("these tests preview nothing")),
    async plan(admin): Promise<SetupPlanOutcome> {
      admins.push(admin);
      if (behaviour.planThrows !== undefined) {
        throw behaviour.planThrows;
      }
      const planned = await shownFrom(admin);
      if (!planned.ok) {
        return { kind: "refused", ...planned.refusal };
      }
      return {
        kind: "planned",
        engine: engine.name,
        table: "public.listings",
        sql: `-- facetdb migrate: listings (public.listings)\n${engine.render(planned.plan)}`,
        transactional: planned.plan.transactional,
        path: "facetdb.config.ts",
        diff: DIFF,
        diffPlan: "diff-1",
        uncommitted: null,
        warnings: [],
        estimate: {
          records: 50_000,
          sampled: 100,
          tokensPerRecord: 40,
          tokens: 2e6,
          dollars: 0.084,
        },
        pace: 50,
        counted: "statistics",
        storeElsewhere: false,
      };
    },
    async install(admin, _draft, shown: ShownPlan): Promise<SetupInstallOutcome> {
      admins.push(admin);
      const planned = await shownFrom(admin);
      if (!planned.ok) {
        return { kind: "refused", ...planned.refusal };
      }
      if (
        `-- facetdb migrate: listings (public.listings)\n${engine.render(planned.plan)}` !==
          shown.sql ||
        shown.diffPlan !== "diff-1" ||
        shown.engine !== engine.name
      ) {
        return { kind: "plan_changed" };
      }
      const result = await engine.run(TARGET, planned.plan, admin, {
        clock: new FakeClock(0),
        allowInsecure: false,
        storeShared: false,
      });
      if (result.stopped !== undefined) {
        const kept = result.ran.length;
        return {
          kind: "stopped",
          table: "public.listings",
          path: "facetdb.config.ts",
          at: result.stopped.at,
          purpose: "columns",
          why:
            "refusal" in result.stopped
              ? { kind: "refusal", refusal: result.stopped.refusal }
              : { kind: "error", error: result.stopped.error },
          known: true,
          kept,
          transactional: planned.plan.transactional,
          file: kept === 0 ? "restored" : "kept",
        };
      }
      if (behaviour.installOutcome !== undefined) {
        if (behaviour.installOutcome === "throw") {
          throw Object.assign(new Error(`connection to ${admin} reset`), { code: "ECONNRESET" });
        }
        return behaviour.installOutcome;
      }
      return {
        kind: "installed",
        table: "public.listings",
        path: "facetdb.config.ts",
        reload: { loaded: true, sources: [], notes: [] },
      };
    },
  };
  return { door, admins };
}

function rig(behaviour: Behaviour = {}) {
  const clock = new FakeClock(Date.parse("2026-11-06T12:00:00Z"));
  const engine = new FakeEngine({
    name: "postgres",
    schemes: ["postgres", "postgresql"],
    plans: {
      install: () =>
        behaviour.install ??
        plan(["alter table public.listings add column is_scam boolean"], behaviour.transactional),
    },
    inspect: (options) =>
      options.table === "events"
        ? {
            ok: false,
            refusal: {
              code: "no-table",
              message: `there is no table events on ${MARKS.host} for ${MARKS.user}`,
              fix: `pick a table ${ADMIN} lists`,
            },
          }
        : {
            ok: true,
            inspection: {
              tables: ["listings", "orders"],
              ...(options.table === undefined
                ? {}
                : {
                    table: {
                      name: options.table,
                      key: "id",
                      columns: [{ name: "title", type: "text" }],
                      rows: [{ title: "Oak table" }],
                    },
                  }),
            },
          },
  });
  const { door, admins } = doorOf(engine, behaviour);
  const logged: string[] = [];
  let tokens = 0;
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: createConfigService({
      config: {
        projectId: PROJECT,
        json: () => ({}),
        validate: () => {
          throw new Error("the setup judges through its own door");
        },
        pending: () => [],
        history: {
          sources: () => [],
          read: () => Promise.reject(new Error("no history")),
        },
      },
      preview: () => undefined,
      log: () => undefined,
    }),
    data: NO_DATA,
    review: NO_REVIEW,
    setup: createSetupService({
      door,
      clock,
      log: (line) => {
        logged.push(line);
      },
      newToken: () => {
        tokens += 1;
        return `token-${tokens}`;
      },
    }),
    studio: {
      sessions,
      reviewers: {
        list: () => Promise.reject(new Error("no reviewers")),
        add: () => Promise.reject(new Error("no reviewer")),
      },
      projectId: PROJECT,
    },
    newRequestId: () => "req-1",
  });
  const bodies: string[] = [];
  const call = async (
    path: string,
    body: unknown,
    who: {
      readonly peer?: { readonly remoteAddress: string };
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/sources/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who.headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      who.peer ?? THIS_MACHINE,
    );
    const text = await response.text();
    bodies.push(text, JSON.stringify([...response.headers.entries()]));
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  };
  const access = async (who: { peer?: { remoteAddress: string }; cookie?: string } = {}) => {
    const response = await app.request(
      "/v1/sources/setup",
      { headers: who.cookie === undefined ? {} : { cookie: who.cookie } },
      who.peer ?? THIS_MACHINE,
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { call, access, engine, admins, logged, bodies, clock };
}

/** Every response body and header, and every log line: none holds a marked part of the string. */
function expectNothingLeaked(t: ReturnType<typeof rig>): void {
  for (const text of [...t.bodies, ...t.logged]) {
    for (const mark of [ADMIN, MARKS.password, MARKS.user, MARKS.host]) {
      expect(text).not.toContain(mark);
    }
  }
}

describe("GET /v1/sources/setup", () => {
  it("is open to the operator on this machine, and says why to anyone else", async () => {
    const t = rig();
    expect(await t.access()).toEqual({ status: 200, json: { open: true } });
    for (const who of [{ cookie: MAYA }, { cookie: MAYA, peer: ELSEWHERE }]) {
      const answer = await t.access(who);
      expect(answer).toMatchObject({ status: 200, json: { open: false, code: "operator_only" } });
      expect(String(answer.json["fix"])).toContain("facetdb init and facetdb migrate");
    }
  });
});

describe("the setup's routes are the operator's on this machine alone", () => {
  it("refuses a signed-in reviewer, another machine, a proxy, a foreign origin, and a body not sent as JSON", async () => {
    const t = rig();
    const body = { admin: ADMIN };
    const refusals = [
      await t.call("inspect", body, { headers: { cookie: MAYA } }),
      await t.call("inspect", body, { peer: ELSEWHERE, headers: { cookie: MAYA } }),
      await t.call("inspect", body, {
        headers: { "x-forwarded-for": "203.0.113.7", cookie: MAYA },
      }),
      await t.call("plan", { admin: ADMIN, source: DRAFT }, { headers: { cookie: MAYA } }),
      await t.call(
        "install",
        { admin: ADMIN, source: DRAFT, token: "token-1" },
        { headers: { cookie: MAYA } },
      ),
    ];
    for (const refused of refusals) {
      expect(refused).toMatchObject({ status: 403, json: { error: { code: "operator_only" } } });
    }
    // A foreign Origin is not this machine's operator; a cross-site fetch is not the page's own.
    expect(
      await t.call("inspect", body, { headers: { origin: "https://evil.example" } }),
    ).toMatchObject({ status: 401 });
    expect(
      await t.call("inspect", body, { headers: { "sec-fetch-site": "cross-site" } }),
    ).toMatchObject({ status: 403, json: { error: { code: "cross_origin" } } });
    expect(
      await t.call("inspect", body, { headers: { "content-type": "text/plain" } }),
    ).toMatchObject({ status: 415, json: { error: { code: "json_only" } } });
    // From another machine, or through a proxy, with no session the reviewer check answers first.
    expect(await t.call("inspect", body, { peer: ELSEWHERE })).toMatchObject({ status: 401 });
    expect(
      await t.call("inspect", body, { headers: { "x-forwarded-for": "203.0.113.7" } }),
    ).toMatchObject({ status: 401 });
    expect(t.admins).toEqual([]);
    expectNothingLeaked(t);
  });

  it("answers a body that fails its schema with its fields named, never what they held", async () => {
    const t = rig();
    const wrong = await t.call("inspect", { admin: ADMIN, table: 42, extra: ADMIN });
    expect(wrong.status).toBe(400);
    expect(t.admins).toEqual([]);
    expectNothingLeaked(t);
  });
});

describe("POST /v1/sources/inspect", () => {
  it("lists the tables, and for one its columns and five rows", async () => {
    const t = rig();
    expect(await t.call("inspect", { admin: ADMIN })).toEqual({
      status: 200,
      json: { database: "Postgres", tables: ["listings", "orders"], table: null },
    });
    expect(await t.call("inspect", { admin: ADMIN, table: "listings" })).toMatchObject({
      status: 200,
      json: { table: { name: "listings", key: "id", rows: [{ title: "Oak table" }] } },
    });
    expect(t.admins).toEqual([ADMIN, ADMIN]);
    expectNothingLeaked(t);
  });
});

describe("POST /v1/sources/plan", () => {
  it("answers the script as shown, the diff, the estimate, and a token that holds no part of the string", async () => {
    const t = rig();
    const planned = await t.call("plan", { admin: ADMIN, source: DRAFT });
    expect(planned).toMatchObject({
      status: 200,
      json: {
        token: "token-1",
        table: "public.listings",
        sql: "-- facetdb migrate: listings (public.listings)\nbegin;\nalter table public.listings add column is_scam boolean;\ncommit;\n",
        diff: DIFF,
        backfill: {
          records: 50_000,
          pace: 50,
          seconds: 1_000,
          command: "facetdb backfill --source listings",
        },
      },
    });
    expect(t.engine.runs).toEqual([]);
    expectNothingLeaked(t);
  });

  it("refuses a plan in the engine's words, with no token", async () => {
    const t = rig({
      install: {
        ok: false,
        refusal: {
          code: "another-project",
          message: `public.listings on ${MARKS.host} is claimed by another project`,
          fix: "uninstall it there first",
        },
      },
    });
    const refused = await t.call("plan", { admin: ADMIN, source: DRAFT });
    expect(refused).toMatchObject({
      status: 409,
      json: {
        error: {
          code: "another-project",
          message: "public.listings on [hidden] is claimed by another project",
        },
      },
    });
    expect(refused.json).not.toHaveProperty("token");
    expectNothingLeaked(t);
  });
});

describe("POST /v1/sources/install", () => {
  it("runs only with a token a plan answered, once, for the draft it was made for", async () => {
    const t = rig();
    expect(
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "never-issued" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    expect(t.engine.runs).toEqual([]);

    await t.call("plan", { admin: ADMIN, source: DRAFT });
    const other = { ...DRAFT, read: ["title", "price"] };
    expect(
      await t.call("install", { admin: ADMIN, source: other, token: "token-1" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    // The attempt spent the token.
    expect(
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    expect(t.engine.runs).toEqual([]);

    await t.call("plan", { admin: ADMIN, source: DRAFT });
    const installed = await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-2" });
    expect(installed).toMatchObject({
      status: 200,
      json: { installed: true, table: "public.listings", path: "facetdb.config.ts" },
    });
    // The rig's reload says nothing of the source: not running, with the words to restart.
    expect(installed.json["worker"]).toEqual({
      running: false,
      why: "the worker read facetdb.config.ts again and did not say what it did with listings.",
      restart: expect.stringContaining("stop facetdb worker (Ctrl+C) and start it again"),
    });
    expect(t.engine.runs).toHaveLength(1);
    expect(
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-2" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    expect(t.engine.runs).toHaveLength(1);
    expectNothingLeaked(t);
  });

  it("refuses a token past its life", async () => {
    const t = rig();
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    t.clock.advance(PLAN_TOKEN_TTL_MS);
    expect(
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    expect(t.engine.runs).toEqual([]);
  });

  it("says what a run that stopped part way left, and what to run, with nothing of the string", async () => {
    const t = rig({ transactional: false });
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    t.engine.stopNextRunAt(0, {
      error: `permission denied for ${MARKS.user} at ${MARKS.host} (${ADMIN})`,
    });
    const stopped = await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" });
    expect(stopped).toMatchObject({ status: 409, json: { error: { code: "install_stopped" } } });
    expect(JSON.stringify(stopped.json)).toContain("Nothing changed in the database");
    expectNothingLeaked(t);
  });

  it("says a non-transactional run that kept statements is finished by facetdb migrate", async () => {
    const t = rig({
      install: plan(["alter table public.listings add column a int", "grant x"], false),
    });
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    t.engine.stopNextRunAt(1, { error: `role ${MARKS.user} may not grant` });
    const stopped = await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" });
    const words = JSON.stringify(stopped.json);
    expect(words).toContain("1 statement(s) before it ran and stay in the database");
    expect(words).toContain("facetdb migrate --source listings");
    expect(words).toContain("facetdb uninstall --source listings");
    expectNothingLeaked(t);
  });
});

describe("the admin connection string reaches no response and no log line", () => {
  const failure = (message: string, code: string) => Object.assign(new Error(message), { code });

  it.each([
    [
      "an unreachable host",
      failure(`getaddrinfo ENOTFOUND ${MARKS.host}`, "ENOTFOUND"),
      "database_unreachable",
    ],
    [
      "a refused login",
      failure(`password authentication failed for user "${MARKS.user}"`, "28P01"),
      "login_refused",
    ],
    ["an error with no code", new Error(`could not parse ${ADMIN}`), "setup_failed"],
  ])("on inspect, for %s: plain words in place of the driver's", async (_name, thrown, code) => {
    const t = rig({ inspectThrows: thrown });
    const answer = await t.call("inspect", { admin: ADMIN });
    expect(answer).toMatchObject({ json: { error: { code } } });
    expect(t.logged.some((line) => line.startsWith("setup: inspect failed"))).toBe(true);
    expectNothingLeaked(t);
  });

  it("on a refused table, the engine's words with the parts hidden", async () => {
    const t = rig();
    const refused = await t.call("inspect", { admin: ADMIN, table: "events" });
    expect(refused).toMatchObject({
      status: 409,
      json: {
        error: {
          code: "no-table",
          message: "there is no table events on [hidden] for [hidden]",
          fix: "pick a table [hidden] lists",
        },
      },
    });
    expectNothingLeaked(t);
  });

  it("on a bad scheme and on a plan that throws", async () => {
    const t = rig({ planThrows: failure(`connect to ${ADMIN} reset`, "ECONNRESET") });
    expect(await t.call("plan", { admin: ADMIN, source: DRAFT })).toMatchObject({
      status: 502,
      json: { error: { code: "database_unreachable" } },
    });
    const scheme = rig({ inspectThrows: failure(`no engine reads ${ADMIN}`, "unknown") });
    expect(await scheme.call("inspect", { admin: ADMIN })).toMatchObject({ status: 500 });
    expectNothingLeaked(t);
    expectNothingLeaked(scheme);
  });
});

describe("a table facetdb.config.ts already names", () => {
  const TAKEN = {
    code: "table-taken",
    message:
      'public.listings is already the table of the source "listings" in facetdb.config.ts, so it is not set up again under another name',
    fix: "that source is listings; finish or check its install with facetdb migrate --source listings, or take it out with facetdb uninstall --source listings",
  };

  it("is refused by the plan in the door's words, with no token, among the codes that ran nothing", async () => {
    const t = rig({ install: { ok: false, refusal: TAKEN } });
    const refused = await t.call("plan", {
      admin: ADMIN,
      source: { ...DRAFT, name: "listings_two" },
    });
    expect(refused).toEqual({ status: 409, json: { error: TAKEN } });
    expect(INSTALL_NOTHING_RAN).toContain("table-taken");
    expect(t.engine.runs).toEqual([]);
    expectNothingLeaked(t);
  });

  it("is refused by an install as one that ran nothing", async () => {
    const t = rig({ installOutcome: { kind: "refused", ...TAKEN } });
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    const refused = await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" });
    expect(refused).toMatchObject({
      status: 409,
      json: { error: { code: "install_refused", message: TAKEN.message, fix: TAKEN.fix } },
    });
    expect(INSTALL_NOTHING_RAN).toContain("install_refused");
  });
});

describe("an install's plan is bound to the connection string it was made with", () => {
  it("refuses an install with another string than the plan's, and runs nothing", async () => {
    const t = rig();
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    const other = "postgres://intruder:other-pw@db-other.example:5432/app?sslmode=require";
    const refused = await t.call("install", { admin: other, source: DRAFT, token: "token-1" });
    expect(refused).toMatchObject({ status: 409, json: { error: { code: "plan_changed" } } });
    expect(JSON.stringify(refused.json)).toContain("another connection string");
    expect(t.engine.runs).toEqual([]);
  });
});

describe("every install failure says whether anything ran", () => {
  const stopped = (known: boolean): SetupInstallOutcome => ({
    kind: "stopped",
    table: "public.listings",
    path: "facetdb.config.ts",
    at: known ? 1 : null,
    purpose: known ? "grants" : null,
    why: known
      ? { kind: "error", error: "role cannot grant" }
      : { kind: "thrown", error: new Error("reset") },
    known,
    kept: known ? 1 : 0,
    transactional: !known,
    file: "kept",
  });
  const cases: readonly [string, SetupInstallOutcome | "throw", string][] = [
    ["a draft or file changed", { kind: "stale" }, "plan_changed"],
    ["a database changed", { kind: "plan_changed" }, "database_changed"],
    [
      "a file git keeps no copy of",
      { kind: "uncommitted", message: "m", fix: "f" },
      "uncommitted_changes",
    ],
    [
      "a draft refused",
      { kind: "invalid", issues: [{ path: "name", message: "taken" }] },
      "invalid_draft",
    ],
    [
      "an engine refusal",
      { kind: "refused", code: "another-project", message: "m", fix: "f" },
      "install_refused",
    ],
    ["a run that stopped", stopped(true), INSTALL_STOPPED],
    ["a run that threw", stopped(false), INSTALL_OUTCOME_UNKNOWN],
    ["a door that threw", "throw", INSTALL_OUTCOME_UNKNOWN],
  ];

  it.each(cases)("%s", async (_name, outcome, code) => {
    const t = rig({ installOutcome: outcome });
    await t.call("plan", { admin: ADMIN, source: DRAFT });
    const answer = await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-1" });
    expect(answer.json).toMatchObject({ error: { code } });
    const nothingRan = (INSTALL_NOTHING_RAN as readonly string[]).includes(code);
    expect(nothingRan || code === INSTALL_STOPPED || code === INSTALL_OUTCOME_UNKNOWN).toBe(true);
    if (code === INSTALL_OUTCOME_UNKNOWN) {
      expect(JSON.stringify(answer.json)).toContain("facetdb migrate --source listings --dry-run");
    }
    expectNothingLeaked(t);
  });

  it("lists every refusal the surface gives before the service among those that ran nothing", async () => {
    const t = rig();
    const answers = [
      await t.call(
        "install",
        { admin: ADMIN, source: DRAFT, token: "x" },
        { headers: { cookie: MAYA } },
      ),
      await t.call("install", { admin: ADMIN }),
      await t.call("install", "not json"),
      await t.call("install", {}, { headers: { "content-type": "text/plain" } }),
      await t.call("install", {}, { headers: { "sec-fetch-site": "cross-site" } }),
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "x" }),
    ];
    const codes = answers.map((answer) => (answer.json["error"] as { code: string }).code);
    expect(codes).toEqual([
      "operator_only",
      "invalid_request",
      "invalid_json",
      "json_only",
      "cross_origin",
      "plan_not_shown",
    ]);
    for (const code of codes) {
      expect(INSTALL_NOTHING_RAN).toContain(code);
    }
    expect(t.engine.runs).toEqual([]);
  });
});

describe("hiding the parts of a connection string", () => {
  it("hides a one-character password where it stands as a word, and leaves other words whole", () => {
    const parts = secretParts("postgres://ann:p@db.example.com/app");
    expect(hideSecrets("login p refused; please retry", parts)).toBe(
      "login [hidden] refused; please retry",
    );
  });

  it("hides a password given in the query string, as written and decoded", () => {
    const parts = secretParts(
      "postgres://ann@db.example.com/app?sslmode=require&password=s3cret%2Bquery&sslpassword=key-pass-77",
    );
    expect(hideSecrets("bad password s3cret+query, key key-pass-77", parts)).toBe(
      "bad password [hidden], key [hidden]",
    );
  });

  it("hides a percent-encoded password where a driver prints it decoded", () => {
    const parts = secretParts("postgres://ann:p%40ss%2Fw0rd-long@db.example.com/app");
    expect(hideSecrets("auth failed with p@ss/w0rd-long", parts)).toBe("auth failed with [hidden]");
  });

  it("hides a user named postgres where it is the user, never in the fix's postgres:// words", () => {
    const parts = secretParts("postgres://postgres:longer-password@localhost:5432/app");
    expect(
      hideSecrets(
        'password authentication failed for user "postgres" at localhost:5432; set it to postgres://facetdb_worker:<a long random password>@<host>/<database> on Postgres',
        parts,
      ),
    ).toBe(
      'password authentication failed for user "[hidden]" at [hidden]; set it to postgres://facetdb_worker:<a long random password>@<host>/<database> on Postgres',
    );
  });
});
