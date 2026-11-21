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
  MigrateDoor,
  MigratePlanOutcome,
  MigrateRunOutcome,
  SetupDoor,
  SetupInstallOutcome,
  SetupPlanOutcome,
} from "./door.ts";
import { INSTALL_OUTCOME_UNKNOWN, INSTALL_STOPPED } from "./install-codes.ts";
import { createSetupService, PLAN_TOKEN_TTL_MS } from "./service.ts";

/**
 * An added question's install from the studio over the setup's service: `POST
 * /v1/sources/:name/migrate/plan` and `/migrate/run` are the operator's on this machine alone, from
 * the studio's own page; a run needs a token a plan of the same source and the same string
 * answered, once, within its life, and the door runs only the SQL shown; a setup's token runs no
 * migration and the reverse; the stopped and unknown outcomes say what is known; and the admin
 * connection string's marked parts are in no response body, header or log line.
 */

const PROJECT = "listings-app";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const MAYA = `${SESSION_COOKIE}=maya.valid`;

const MARKS = {
  password: "pw-MARK-91af",
  user: "adminMARKuser",
  host: "db-MARK.internal.example",
} as const;
const ADMIN = `postgres://${MARKS.user}:${MARKS.password}@${MARKS.host}:5432/app?sslmode=require`;
/** The same database under another role: another string, whose script nobody read. */
const OTHER_ADMIN = `postgres://owner:other-pw-MARK@${MARKS.host}:5432/app?sslmode=require`;

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
  name: "sellers",
  table: "sellers",
  database: { env: "SELLERS_URL" },
  read: ["bio"],
  questions: { is_fake: { type: "noul", instructions: "Is this a fake seller?", stakes: "high" } },
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

const HEADER = "-- facetdb migrate: listings (public.listings)\n";

const STATEMENTS: readonly string[] = [
  'alter table "public"."listings" add column if not exists "is_vehicle" boolean',
  'grant update ("is_vehicle") on "public"."listings" to facetdb_worker',
];

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

type Behaviour = {
  /** The door refuses the plan of a source, as the CLI's would (another change, say). */
  refuse?: { readonly code: string; readonly message: string; readonly fix: string };
  /** The door's run throws after it had the request. */
  runThrows?: boolean;
};

/**
 * A migrate door as the CLI's would be, over the fake engine: the plan rendered by the engine, the
 * run planned again and run only when it is the script shown, then a reload. A setup door beside it,
 * whose plan answers a token of its own and whose install runs the same engine. Every admin string
 * either is handed is noted.
 */
function doors(engine: FakeEngine, behaviour: Behaviour) {
  const admins: string[] = [];
  const reloads: string[] = [];
  const deps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
  const migrate: MigrateDoor = {
    available: true,
    async plan(name, admin): Promise<MigratePlanOutcome> {
      admins.push(admin);
      if (behaviour.refuse !== undefined) {
        return { kind: "refused", ...behaviour.refuse };
      }
      const planned = await engine.planInstall({ ...TARGET, source: name }, admin, deps);
      if (!planned.ok) {
        return { kind: "refused", ...planned.refusal };
      }
      return {
        kind: "planned",
        engine: engine.name,
        table: "public.listings",
        sql: `${HEADER}${engine.render(planned.plan)}`,
        transactional: planned.plan.transactional,
        questions: ["is_vehicle"],
        storeElsewhere: false,
      };
    },
    async run(name, admin, shown): Promise<MigrateRunOutcome> {
      admins.push(admin);
      if (behaviour.runThrows === true) {
        throw Object.assign(new Error(`connection to ${admin} reset`), { code: "ECONNRESET" });
      }
      const planned = await engine.planInstall({ ...TARGET, source: name }, admin, deps);
      if (!planned.ok) {
        return { kind: "refused", ...planned.refusal };
      }
      if (`${HEADER}${engine.render(planned.plan)}` !== shown.sql || shown.engine !== engine.name) {
        return { kind: "plan_changed" };
      }
      const result = await engine.run({ ...TARGET, source: name }, planned.plan, admin, deps);
      if (result.stopped !== undefined) {
        return {
          kind: "stopped",
          table: "public.listings",
          at: result.stopped.at,
          purpose: "columns",
          why:
            "refusal" in result.stopped
              ? { kind: "refusal", refusal: result.stopped.refusal }
              : { kind: "error", error: result.stopped.error },
          known: true,
          kept: result.ran.length,
          transactional: planned.plan.transactional,
        };
      }
      reloads.push(name);
      return {
        kind: "migrated",
        table: "public.listings",
        reload: {
          loaded: true,
          sources: [
            {
              source: name,
              outcome: "restarted",
              version: 4,
              message:
                "the columns of the question is_vehicle are in its database and the worker login may write them: it finishes the batch in hand, then answers with version 4; nothing already answered is asked again.",
            },
          ],
          notes: [],
        },
      };
    },
  };
  const setup: SetupDoor = {
    available: true,
    inspect: () => Promise.reject(new Error("these tests inspect nothing")),
    preview: () => Promise.reject(new Error("these tests preview nothing")),
    async plan(admin): Promise<SetupPlanOutcome> {
      admins.push(admin);
      return {
        kind: "planned",
        engine: engine.name,
        table: "public.sellers",
        sql: "-- facetdb migrate: sellers (public.sellers)\n",
        transactional: true,
        path: "facetdb.config.ts",
        diff: "",
        diffPlan: "diff-1",
        uncommitted: null,
        warnings: [],
        estimate: { records: 0, sampled: 0, tokensPerRecord: 0, tokens: 0, dollars: 0 },
        pace: 50,
        counted: "statistics",
        storeElsewhere: false,
      };
    },
    install(admin): Promise<SetupInstallOutcome> {
      admins.push(admin);
      return Promise.resolve({
        kind: "installed",
        table: "public.sellers",
        path: "facetdb.config.ts",
        reload: { loaded: true, sources: [], notes: [] },
      });
    },
  };
  return { migrate, setup, admins, reloads };
}

function rig(
  behaviour: Behaviour = {},
  offered: { readonly migrate: boolean } = { migrate: true },
) {
  const clock = new FakeClock(Date.parse("2026-11-10T12:00:00Z"));
  const state = { statements: STATEMENTS };
  const engine = new FakeEngine({
    name: "postgres",
    schemes: ["postgres", "postgresql"],
    plans: { install: () => plan(state.statements) },
  });
  const { migrate, setup, admins, reloads } = doors(engine, behaviour);
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
          throw new Error("nothing is judged here");
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
      door: setup,
      ...(offered.migrate ? { migrate } : {}),
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
        canAdd: () => Promise.resolve(false),
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
  return { call, engine, state, admins, reloads, logged, bodies, clock };
}

/** Every response body and header, and every log line: none holds a marked part of the strings. */
function expectNothingLeaked(t: ReturnType<typeof rig>): void {
  for (const text of [...t.bodies, ...t.logged]) {
    for (const mark of [
      ADMIN,
      OTHER_ADMIN,
      MARKS.password,
      MARKS.user,
      MARKS.host,
      "other-pw-MARK",
    ]) {
      expect(text).not.toContain(mark);
    }
  }
}

describe("the migrate routes are the operator's on this machine alone", () => {
  it("refuses a cookie, a foreign origin and a peer that is not loopback before the body is read", async () => {
    const t = rig();
    for (const path of ["listings/migrate/plan", "listings/migrate/run"]) {
      const body = { admin: ADMIN, token: "token-1" };
      // Signed in, here or from elsewhere: the operator has no account.
      for (const who of [
        { headers: { cookie: MAYA } },
        { peer: ELSEWHERE, headers: { cookie: MAYA } },
        { headers: { "x-forwarded-for": "203.0.113.7", cookie: MAYA } },
      ]) {
        const refused = await t.call(path, path.endsWith("plan") ? { admin: ADMIN } : body, who);
        expect(refused).toMatchObject({ status: 403, json: { error: { code: "operator_only" } } });
        expect(String((refused.json["error"] as { message: string }).message)).toContain(
          "Installing a question connects to your database with an admin connection string",
        );
        expect(String((refused.json["error"] as { fix: string }).fix)).toContain(
          "facetdb migrate --source",
        );
      }
      // Another machine with no session: the reviewer check answers first.
      expect(await t.call(path, body, { peer: ELSEWHERE })).toMatchObject({ status: 401 });
      // A foreign Origin is not this machine's operator; a cross-site fetch is not the page's own.
      expect(
        await t.call(path, body, { headers: { origin: "https://evil.example" } }),
      ).toMatchObject({ status: 401 });
      expect(
        await t.call(path, body, { headers: { "sec-fetch-site": "cross-site" } }),
      ).toMatchObject({ status: 403, json: { error: { code: "cross_origin" } } });
      expect(await t.call(path, body, { headers: { "content-type": "text/plain" } })).toMatchObject(
        { status: 415, json: { error: { code: "json_only" } } },
      );
    }
    expect(t.admins).toEqual([]);
    expect(t.engine.runs).toEqual([]);
    expectNothingLeaked(t);
  });

  it("answers a body that fails its schema with its fields named, never what they held", async () => {
    const t = rig();
    const wrong = await t.call("listings/migrate/plan", { admin: ADMIN, extra: ADMIN });
    expect(wrong).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    const noToken = await t.call("listings/migrate/run", { admin: ADMIN });
    expect(noToken).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    expect(t.admins).toEqual([]);
    expectNothingLeaked(t);
  });

  it("says this worker installs no question where it offers none", async () => {
    const t = rig({}, { migrate: false });
    expect(await t.call("listings/migrate/plan", { admin: ADMIN })).toMatchObject({
      status: 409,
      json: { error: { code: "setup_unavailable" } },
    });
    expect(t.admins).toEqual([]);
  });
});

describe("POST /v1/sources/:name/migrate/plan and /run", () => {
  it("shows the SQL with a token, runs it once with that token, and answers the reload", async () => {
    const t = rig();
    const planned = await t.call("listings/migrate/plan", { admin: ADMIN });
    expect(planned).toEqual({
      status: 200,
      json: {
        token: "token-1",
        expiresInSeconds: PLAN_TOKEN_TTL_MS / 1000,
        table: "public.listings",
        sql: `${HEADER}begin;\nalter table "public"."listings" add column if not exists "is_vehicle" boolean;\ngrant update ("is_vehicle") on "public"."listings" to facetdb_worker;\ncommit;\n`,
        transactional: true,
        questions: ["is_vehicle"],
        storeElsewhere: false,
      },
    });
    expect(t.engine.runs).toEqual([]);

    const ran = await t.call("listings/migrate/run", { admin: ADMIN, token: "token-1" });
    expect(ran).toMatchObject({
      status: 200,
      json: {
        migrated: true,
        table: "public.listings",
        reload: {
          loaded: true,
          sources: [{ source: "listings", outcome: "restarted", version: 4 }],
        },
      },
    });
    expect(t.engine.runs).toHaveLength(1);
    expect(t.reloads).toEqual(["listings"]);
    // Spent: the same token runs nothing again.
    expect(await t.call("listings/migrate/run", { admin: ADMIN, token: "token-1" })).toMatchObject({
      status: 409,
      json: { error: { code: "plan_not_shown" } },
    });
    expect(t.engine.runs).toHaveLength(1);
    expect(t.admins).toEqual([ADMIN, ADMIN]);
    expectNothingLeaked(t);
  });

  it("runs only with a token from a plan of the same source, the same string and the same SQL", async () => {
    const t = rig();
    expect(
      await t.call("listings/migrate/run", { admin: ADMIN, token: "never-issued" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });

    // Another source's run with this source's token.
    await t.call("listings/migrate/plan", { admin: ADMIN });
    expect(await t.call("orders/migrate/run", { admin: ADMIN, token: "token-1" })).toMatchObject({
      status: 409,
      json: { error: { code: "plan_not_shown" } },
    });

    // Another connection string than the plan's.
    await t.call("listings/migrate/plan", { admin: ADMIN });
    expect(
      await t.call("listings/migrate/run", { admin: OTHER_ADMIN, token: "token-2" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_changed" } } });

    // The database moved since the plan: planned again, the SQL is not the one shown.
    await t.call("listings/migrate/plan", { admin: ADMIN });
    t.state.statements = [...STATEMENTS, "create index on public.listings (is_vehicle)"];
    expect(await t.call("listings/migrate/run", { admin: ADMIN, token: "token-3" })).toMatchObject({
      status: 409,
      json: { error: { code: "database_changed" } },
    });
    t.state.statements = STATEMENTS;

    // A token past its life.
    await t.call("listings/migrate/plan", { admin: ADMIN });
    t.clock.advance(PLAN_TOKEN_TTL_MS);
    expect(await t.call("listings/migrate/run", { admin: ADMIN, token: "token-4" })).toMatchObject({
      status: 409,
      json: { error: { code: "plan_not_shown" } },
    });
    expect(t.engine.runs).toEqual([]);
    expect(t.reloads).toEqual([]);
    expectNothingLeaked(t);
  });

  it("refuses a setup's token for a migration, and a migration's token for a setup", async () => {
    const t = rig();
    const setupPlan = await t.call("plan", { admin: ADMIN, source: DRAFT });
    expect(setupPlan.json["token"]).toBe("token-1");
    expect(await t.call("listings/migrate/run", { admin: ADMIN, token: "token-1" })).toMatchObject({
      status: 409,
      json: { error: { code: "plan_not_shown" } },
    });

    await t.call("listings/migrate/plan", { admin: ADMIN });
    expect(
      await t.call("install", { admin: ADMIN, source: DRAFT, token: "token-2" }),
    ).toMatchObject({ status: 409, json: { error: { code: "plan_not_shown" } } });
    expect(t.engine.runs).toEqual([]);
    expect(t.reloads).toEqual([]);
    expectNothingLeaked(t);
  });

  it("refuses a plan in the door's words, the string hidden, with no token", async () => {
    const t = rig({
      refuse: {
        code: "migrate-by-hand",
        message: `facetdb.config.ts changes more of "listings" than questions added, on ${MARKS.host}`,
        fix: "run facetdb migrate --source listings on this machine (it prints the SQL first), then restart facetdb worker",
      },
    });
    const refused = await t.call("listings/migrate/plan", { admin: ADMIN });
    expect(refused).toMatchObject({
      status: 409,
      json: {
        error: {
          code: "migrate-by-hand",
          message: 'facetdb.config.ts changes more of "listings" than questions added, on [hidden]',
        },
      },
    });
    expect(refused.json).not.toHaveProperty("token");
    expectNothingLeaked(t);
  });
});

describe("a run that does not finish", () => {
  it("says what a stopped run left and that the source keeps the version it ran, in the setup's words", async () => {
    const t = rig();
    await t.call("listings/migrate/plan", { admin: ADMIN });
    t.engine.stopNextRunAt(1, {
      error: `permission denied for ${MARKS.user} at ${MARKS.host} (${ADMIN})`,
    });
    const stopped = await t.call("listings/migrate/run", { admin: ADMIN, token: "token-1" });
    expect(stopped).toMatchObject({ status: 409, json: { error: { code: INSTALL_STOPPED } } });
    const words = JSON.stringify(stopped.json);
    expect(words).toContain("The install stopped at statement 2 (columns)");
    expect(words).toContain(
      "Nothing changed in the database: the install runs as one transaction, and it was rolled back.",
    );
    expect(words).toContain("listings keeps answering with the version it ran.");
    expect(t.reloads).toEqual([]);
    expectNothingLeaked(t);
  });

  it("calls a run whose end is not known unknown, and never says nothing changed", async () => {
    const t = rig({ runThrows: true });
    await t.call("listings/migrate/plan", { admin: ADMIN });
    const unknown = await t.call("listings/migrate/run", { admin: ADMIN, token: "token-1" });
    expect(unknown).toMatchObject({
      status: 502,
      json: { error: { code: INSTALL_OUTCOME_UNKNOWN } },
    });
    const words = JSON.stringify(unknown.json);
    expect(words).toContain("it may have run, in whole or not at all");
    expect(words).toContain("facetdb migrate --source listings --dry-run");
    expect(words).not.toContain("Nothing changed");
    expect(t.logged.some((line) => line.includes("outcome unknown (ECONNRESET)"))).toBe(true);
    expectNothingLeaked(t);
  });
});
