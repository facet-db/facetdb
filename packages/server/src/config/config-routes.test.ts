import {
  createPreviewService,
  createQuestionTestService,
  createSpending,
  type KeyText,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Question,
  type QuestionSet,
  type SpendingGate,
  spendingGate,
  stateHash,
} from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase, FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import {
  createConfigService,
  type DraftCheck,
  type PreviewSource,
  type ProjectConfigDoor,
  type SourceDraft,
} from "./service.ts";

/**
 * The config routes on fakes: the studio's routes, so a reviewer (this machine, or a signed-in
 * session) and never a project API key; the CLI's door to the configuration as a handwritten
 * judge, and a running source whose preview is core's preview service over the fake database, a
 * scripted provider and the project's spending gate.
 */

const PROJECT = "listings-app";
const OTHER = "another-app";
const KEY = "Bearer fdb_listings";

/** A live key of the project: it opens the check API, and nothing of the studio. */
const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(header === KEY ? { id: "key-1", projectId: PROJECT } : undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const MAYA = "maya";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

/** The sessions as the middleware sees them: this machine is the OS user, a cookie `maya` is maya. */
const sessions: Sessions = {
  signIn: () => Promise.reject(new Error("these tests sign nobody in")),
  reviewerFor: ({ local, cookie }) =>
    Promise.resolve(
      cookie === `${MAYA}.valid`
        ? { kind: "reviewer", name: MAYA }
        : cookie === undefined && local
          ? { kind: "reviewer", name: "os:alex" }
          : { kind: "sign-in", why: cookie === undefined ? "no-cookie" : "invalid" },
    ),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
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

const scam: Question = {
  type: "noul",
  name: "is_scam",
  instructions: "Is it a scam?",
  stakes: "low",
};

const RUNNING: QuestionSet = {
  questions: [scam],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The project JSON as the loader exports it: the variable a connection string comes from, never the string. */
const PROJECT_JSON = {
  model: "jev-1.14.0",
  onCapReached: "pause",
  spendingCap: 5000,
  sources: [
    {
      name: "listings",
      api: false,
      database: { env: "DATABASE_URL" },
      table: "listings",
      read: ["title"],
      storage: "inline",
      onChange: "reset",
      onOutage: "hold",
      questions: { is_scam: { type: "noul", instructions: "Is it a scam?", stakes: "low" } },
      thresholds: {},
      actions: [],
    },
  ],
};

/**
 * The loader as the worker hands it in, reduced to what these tests need: a draft's thresholds and
 * read override the running source; a threshold above 1 is the loader's error at its path; a
 * question that counts gets the wording warning.
 */
/** What the store keeps of `listings`: version 1 asked "Is it a scam?", version 2 adds a choice. */
const CREATED = new Date(Date.UTC(2026, 10, 1, 9, 0));
const WIDENED = new Date(Date.UTC(2026, 10, 3, 9, 40));
const category: Question = {
  type: "choice",
  name: "category",
  instructions: "Which category fits this listing?",
  options: [
    { name: "electronics", description: "phones, computers" },
    { name: "other", description: "anything else" },
  ],
  stakes: "low",
  storeProbabilities: false,
};

const door: ProjectConfigDoor = {
  projectId: PROJECT,
  json: () => PROJECT_JSON,
  pending: () => [],
  history: {
    sources: () => [{ name: "listings", inForce: 2 }],
    read: (source, limit) =>
      Promise.resolve(
        source === "listings"
          ? [
              {
                version: 2,
                createdAt: WIDENED,
                questionSet: { ...RUNNING, questions: [scam, category] },
              },
              { version: 1, createdAt: CREATED, questionSet: RUNNING },
            ].slice(0, limit)
          : [],
      ),
  },
  validate: (draft: SourceDraft): DraftCheck => {
    const thresholds = (draft["thresholds"] ?? {}) as QuestionSet["thresholds"];
    const yesAbove = thresholds["is_scam"]?.yesAbove;
    if (yesAbove !== undefined && yesAbove > 1) {
      return {
        ok: false,
        issues: [
          {
            path: "sources[0].thresholds.is_scam.yesAbove",
            message: "yesAbove is a probability from 0 to 1",
          },
        ],
      };
    }
    const instructions = draft["instructions"];
    return {
      ok: true,
      questionSet: {
        ...RUNNING,
        read: (draft["read"] ?? RUNNING.read) as readonly string[],
        thresholds,
      },
      warnings:
        typeof instructions === "string" && instructions.includes("how many")
          ? [
              {
                source: draft.name,
                question: "is_scam",
                code: "counting",
                message: 'The question "is_scam" asks the model to count or compare an amount.',
                fix: "Compute the number in SQL and pass it as a state field.",
              },
            ]
          : [],
    };
  },
};

/** MongoDB's rule for a person: `oid:65f1…` is written `65f1…`. */
const tagged: KeyText = {
  toText: (key) => key.replace(/^oid:/, ""),
  fromText: (text) => `oid:${text}`,
  form: "the document's _id as you write it",
};

class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  down = false;

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.down) {
      return Promise.reject(new Error("the model answered 503"));
    }
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        is_scam: {
          type: "noul",
          probability: request.state["title"] === "Listing 3" ? 0.58 : 0.02,
        },
      },
      usage: { inputTokens: 100, outputTokens: 2 },
    });
  }
}

/** The project's gate as the worker builds it, over a usage count already at `used` of a 5,000 cap. */
function projectGate(used: number): SpendingGate {
  let total = used;
  let issued = 0;
  const open = new Map<string, number>();
  const spending = createSpending({
    usageStore: {
      add: (_project, _month, tokens) => {
        total += tokens;
        return Promise.resolve(total);
      },
      total: () => Promise.resolve(total),
      reserve: (_project, _month, tokens, limit) => {
        const held = [...open.values()].reduce((sum, value) => sum + value, 0);
        if (limit !== undefined && total + held >= limit) {
          return Promise.resolve({ reservation: undefined, monthTotal: total });
        }
        issued += 1;
        open.set(`r${issued}`, tokens);
        return Promise.resolve({ reservation: `r${issued}`, monthTotal: total });
      },
      release: (_project, reservation) => {
        open.delete(reservation);
        return Promise.resolve();
      },
      finish: (_project, _month, reservation, tokens) => {
        open.delete(reservation);
        total += tokens;
        return Promise.resolve(total);
      },
      claimAlert: () => Promise.resolve(false),
      releaseAlert: () => Promise.resolve(),
    },
    clock: new FakeClock(Date.UTC(2026, 10, 5)),
    alerts: { raise: () => Promise.resolve({ status: "sent", failures: [] }) },
    capLink: () => "https://docs.facetdb.dev/fix/spending-cap",
  });
  return spendingGate(spending, PROJECT, () =>
    Promise.resolve({ inputTokens: 5000, onCapReached: "pause" }),
  );
}

async function rig(
  options: {
    readonly used?: number;
    /** The source's `where` as its SQL would judge a row: true leaves it out. */
    readonly excludes?: (state: Readonly<Record<string, string | null>>) => boolean;
    /** The project the studio believes it serves; the configuration door's own is `PROJECT`. */
    readonly studioProject?: string;
    /** The store's side of the version history, in place of the door's own. */
    readonly history?: ProjectConfigDoor["history"];
    /** The sources whose loop does not run the file, in place of the door's none. */
    readonly pending?: ProjectConfigDoor["pending"];
  } = {},
) {
  const database = new FakeDatabase({
    fields: ["title"],
    ...(options.excludes === undefined ? {} : { excludes: options.excludes }),
  });
  for (let n = 1; n <= 3; n += 1) {
    database.edit(`oid:${n}`, { title: `Listing ${n}` });
  }
  const provider = new ScriptedProvider();
  // What the version in force answered, and the one record a person decided (oid:1: not a scam).
  const log = new FakeDecisionLog();
  for (const [key, probability] of [
    ["oid:1", 0.02],
    ["oid:2", 0.02],
    ["oid:3", 0.5],
  ] as const) {
    await log.appendAnswer({
      kind: "answer",
      key,
      version: 1,
      model: "jev-1.14.0",
      stateHash: stateHash(["title"], { title: `Listing ${key.slice(4)}` }),
      answers: { is_scam: { type: "noul", probability } },
      usage: { inputTokens: 100, outputTokens: 2 },
      at: new Date(Date.UTC(2026, 10, 5)),
    });
  }
  await log.appendHuman({
    kind: "human",
    key: "oid:1",
    question: "is_scam",
    value: false,
    reviewer: "maya",
    stateHash: stateHash(["title"], { title: "Listing 1" }),
    version: 1,
    at: new Date(Date.UTC(2026, 10, 5)),
  });
  const gate = projectGate(options.used ?? 0);
  const clock = new FakeClock(Date.UTC(2026, 10, 5));
  const connector = new FakeConnector(database);
  const running: PreviewSource = {
    read: RUNNING.read,
    where: undefined,
    keyText: tagged,
    preview: createPreviewService({
      connector,
      provider,
      spending: gate,
      log: () => undefined,
      clock,
    }).preview,
    current: RUNNING,
    testQuestionSet: createQuestionTestService({
      connector,
      decisions: log,
      provider,
      spending: gate,
      note: () => undefined,
      clock,
    }).testQuestionSet,
  };
  /** The worker's log: what the server writes there and never tells the browser. */
  const logged: string[] = [];
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: createConfigService({
      config: {
        ...door,
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.pending === undefined ? {} : { pending: options.pending }),
      },
      preview: (source) => (source === "listings" ? running : undefined),
      log: (line) => {
        logged.push(line);
      },
    }),
    data: NO_DATA,
    studio: {
      sessions,
      reviewers: {
        list: () => Promise.reject(new Error("these tests list no reviewers")),
        add: () => Promise.reject(new Error("these tests add no reviewer")),
        canAdd: () => Promise.resolve(false),
      },
      projectId: options.studioProject ?? PROJECT,
    },
    review: NO_REVIEW,
    newRequestId: () => "req-1",
  });

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    who: {
      readonly peer?: { readonly remoteAddress: string };
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const response = await app.request(
      path,
      {
        method,
        headers: { "content-type": "application/json", ...who.headers },
        // A GET carries no body.
        ...(body === undefined || method === "GET"
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
      who.peer ?? THIS_MACHINE,
    );
    return {
      status: response.status,
      headers: response.headers,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  return { call, provider, database, logged };
}

describe("the config routes", () => {
  it("refuse every request that is not a reviewer's, in the one error shape, and a project API key is not one", async () => {
    const t = await rig();
    for (const [method, path] of [
      ["GET", "/v1/config"],
      ["POST", "/v1/config/validate"],
      ["POST", "/v1/preview"],
      ["POST", "/v1/test"],
    ] as const) {
      for (const who of [{}, { headers: { authorization: KEY } }].map((extra) => ({
        peer: ELSEWHERE,
        ...extra,
      }))) {
        const response = await t.call(method, path, { source: { name: "listings" } }, who);
        expect(response.status).toBe(401);
        expect(response.json).toMatchObject({
          error: { code: "sign-in", message: expect.any(String), fix: expect.any(String) },
        });
      }
    }
    expect(t.provider.requests).toHaveLength(0);
  });

  it("GET /v1/config returns the project JSON of the loader's export, and each source's version history beside its sources", async () => {
    const t = await rig();
    const response = await t.call("GET", "/v1/config");

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      ...PROJECT_JSON,
      pending: [],
      versions: {
        listings: {
          inForce: 2,
          earlier: false,
          versions: [
            { version: 2, createdAt: "2026-11-03T09:40:00.000Z", changes: "category added" },
            { version: 1, createdAt: "2026-11-01T09:00:00.000Z", changes: "Created, with is_scam" },
          ],
          note: null,
        },
      },
    });
    // The sources stay as the exporter writes them: a draft built from one carries no history.
    expect(response.json["sources"]).toEqual(PROJECT_JSON.sources);
    expect(t.provider.requests).toHaveLength(0);
  });

  it("GET /v1/config still answers the config when the store's history cannot be read, the history empty with a note", async () => {
    const t = await rig({
      history: {
        sources: () => [{ name: "listings", inForce: 2 }],
        // The store's own words name its host and role: they reach the worker's log, never the page.
        read: () =>
          Promise.reject(
            new Error('connect ECONNREFUSED db.internal.example:5432 (role "facetdb_worker")'),
          ),
      },
    });
    const response = await t.call("GET", "/v1/config");

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      ...PROJECT_JSON,
      pending: [],
      versions: {
        listings: {
          inForce: 2,
          earlier: false,
          versions: [],
          note: "The version history of listings could not be read from the store. The questions shown are the worker's own, as it runs them; the worker's output says why.",
        },
      },
    });
    const sentText = JSON.stringify(response.json);
    expect(sentText).not.toContain("db.internal.example");
    expect(sentText).not.toContain("facetdb_worker");
    expect(t.logged).toEqual([
      'the version history of listings could not be read from the store: connect ECONNREFUSED db.internal.example:5432 (role "facetdb_worker")',
    ]);
  });

  it("GET /v1/config leaves out a stored set this worker cannot read, and says so", async () => {
    const t = await rig({
      history: {
        sources: () => [{ name: "listings", inForce: 3 }],
        read: () =>
          Promise.resolve([
            {
              version: 3,
              createdAt: WIDENED,
              questionSet: { ...RUNNING, questions: [scam, category] },
            },
            { version: 2, createdAt: WIDENED, questionSet: null },
            { version: 1, createdAt: CREATED, questionSet: RUNNING },
          ]),
      },
    });
    const response = await t.call("GET", "/v1/config");

    expect(response.status).toBe(200);
    expect(response.json["versions"]).toEqual({
      listings: {
        inForce: 3,
        earlier: false,
        versions: [
          {
            version: 3,
            createdAt: "2026-11-03T09:40:00.000Z",
            changes: "What changed from version 2 cannot be said: that version cannot be read",
          },
          { version: 1, createdAt: "2026-11-01T09:00:00.000Z", changes: "Created, with is_scam" },
        ],
        note: "Version 2 is kept in a form this worker cannot read, so it is left out.",
      },
    });
  });

  it("GET /v1/config lists the sources whose loop does not run the file, asked of the worker on every read", async () => {
    let pending: ReturnType<ProjectConfigDoor["pending"]> = [
      {
        source: "listings",
        outcome: "kept",
        message: "it keeps answering with version 2 until you run facetdb migrate and restart.",
        migrate: true,
        checkAgain: false,
        added: ["is_vehicle"],
        removed: [],
      },
    ];
    const t = await rig({ pending: () => pending });

    expect((await t.call("GET", "/v1/config")).json["pending"]).toEqual(pending);
    pending = [];
    expect((await t.call("GET", "/v1/config")).json["pending"]).toEqual([]);
  });

  it("answers a studio wired to another project than the configuration's with nothing of the project", async () => {
    const t = await rig({ studioProject: OTHER });
    for (const [method, path] of [
      ["GET", "/v1/config"],
      ["POST", "/v1/config/validate"],
      ["POST", "/v1/preview"],
      ["POST", "/v1/test"],
    ] as const) {
      const response = await t.call(method, path, { source: { name: "listings" } });
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({ error: { code: "unknown_project" } });
    }
    expect(t.provider.requests).toHaveLength(0);
  });

  it("POST /v1/config/validate answers a valid draft with its wording warnings in the CLI's shape", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/config/validate", {
      source: { name: "listings", instructions: "how many scams are there?" },
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      valid: true,
      issues: [],
      warnings: [
        {
          source: "listings",
          question: "is_scam",
          code: "counting",
          message: 'The question "is_scam" asks the model to count or compare an amount.',
          fix: "Compute the number in SQL and pass it as a state field.",
        },
      ],
    });
  });

  it("POST /v1/config/validate answers a broken draft with the loader's errors at their field paths", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/config/validate", {
      source: { name: "listings", thresholds: { is_scam: { yesAbove: 1.5 } } },
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      valid: false,
      issues: [
        {
          path: "sources[0].thresholds.is_scam.yesAbove",
          message: "yesAbove is a probability from 0 to 1",
        },
      ],
      warnings: [],
    });
  });

  it("refuses a body that is not JSON or not a draft, saying what to send", async () => {
    const t = await rig();
    const notJson = await t.call("POST", "/v1/config/validate", "{not json");
    expect(notJson.status).toBe(400);
    expect(notJson.json).toMatchObject({ error: { code: "invalid_json" } });

    const noName = await t.call("POST", "/v1/config/validate", { source: { questions: {} } });
    expect(noName.status).toBe(400);
    expect(noName.json).toMatchObject({
      error: { code: "invalid_request", fix: expect.stringContaining('"source"') },
    });

    const tooMany = await t.call("POST", "/v1/preview", {
      source: { name: "listings" },
      limit: 101,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toMatchObject({ error: { code: "invalid_request" } });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("POST /v1/preview answers the newest rows of the draft with every probability, the decisions and the cost", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/preview", { source: { name: "listings" } });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      // Keys as the user writes them: never `oid:3`.
      rows: [
        {
          key: "3",
          kind: "answered",
          state: { title: "Listing 3" },
          model: "jev-1.14.0",
          answers: { is_scam: { type: "noul", probability: 0.58 } },
          decisions: { is_scam: { kind: "needs_review" } },
          status: "needs_review",
          usage: { inputTokens: 100, outputTokens: 2 },
        },
        expect.objectContaining({ key: "2", status: "done" }),
        expect.objectContaining({ key: "1", status: "done" }),
      ],
      decided: 2,
      review: 1,
      cost: { inputTokens: 300, dollars: (300 * 0.042) / 1_000_000 },
      warnings: [],
    });
    expect(t.provider.requests).toHaveLength(3);
    // Nothing was written: no decision on any row.
    for (const [key] of t.database.rows.entries()) {
      expect(t.database.decisionOf(key)).toBeNull();
    }
  });

  it("previews the draft's thresholds, not the running ones, and honours the limit", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/preview", {
      source: { name: "listings", thresholds: { is_scam: { yesAbove: 0.5 } } },
      limit: 1,
    });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      rows: [{ key: "3", decisions: { is_scam: { kind: "decided", value: true } } }],
      decided: 1,
      review: 0,
    });
    expect(t.provider.requests).toHaveLength(1);
  });

  it("refuses a broken draft, a source the worker does not run and other fields, without a model call", async () => {
    const t = await rig();
    const broken = await t.call("POST", "/v1/preview", {
      source: { name: "listings", thresholds: { is_scam: { yesAbove: 1.5 } } },
    });
    expect(broken.status).toBe(400);
    expect(broken.json).toMatchObject({
      error: {
        code: "invalid_draft",
        message: expect.stringContaining("sources[0].thresholds.is_scam.yesAbove"),
      },
    });

    const unknown = await t.call("POST", "/v1/preview", { source: { name: "orders" } });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { code: "unknown_source" } });

    const other = await t.call("POST", "/v1/preview", {
      source: { name: "listings", read: ["title", "body"] },
    });
    expect(other.status).toBe(400);
    expect(other.json).toMatchObject({ error: { code: "fields_differ" } });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers a row the where filter leaves out with its key and reason only, never its state", async () => {
    const t = await rig({ excludes: (state) => state["title"] === "Listing 3" });
    const response = await t.call("POST", "/v1/preview", { source: { name: "listings" } });

    expect(response.status).toBe(200);
    expect((response.json["rows"] as unknown[])[0]).toEqual({
      key: "3",
      kind: "skipped",
      reason: "filtered-out",
    });
    expect(JSON.stringify(response.json)).not.toContain("Listing 3");
    expect(t.provider.requests).toHaveLength(2);
  });

  it("returns the cap's words when the project's cap is already reached, without calling the model", async () => {
    const t = await rig({ used: 5000 });
    const response = await t.call("POST", "/v1/preview", { source: { name: "listings" } });

    expect(response.status).toBe(429);
    // Until the month resets: November 5, 00:00 UTC to December 1 is 26 days.
    expect(response.headers.get("retry-after")).toBe(String(26 * 24 * 60 * 60));
    expect(response.json).toEqual({
      error: {
        code: "spending_cap_reached",
        message:
          "This month's usage reached the project's spending cap, so the preview asked the model nothing.",
        // The worker reads the cap at its start: raising it in the file takes a restart too.
        fix: expect.stringContaining(
          "Raise spendingCap in facetdb.config.ts (Settings can change it) and restart facetdb worker",
        ),
      },
    });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers a failed model call with 503, naming the row as the user writes it", async () => {
    const t = await rig();
    t.provider.down = true;
    const response = await t.call("POST", "/v1/preview", { source: { name: "listings" } });

    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({
      error: {
        code: "model_unavailable",
        message: expect.stringContaining("for row 3: the model answered 503"),
        fix: expect.stringContaining("facetdb doctor"),
      },
    });
    expect(JSON.stringify(response.json)).not.toContain("oid:");
  });
});

describe("POST /v1/test", () => {
  const LOOSER = { name: "listings", thresholds: { is_scam: { yesAbove: 0.5 } } };

  it("prices the test first and calls the model only when told to run", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/test", { source: LOOSER, estimate: true });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      estimate: {
        sampleRecords: 3,
        reviewedRecords: 1,
        requests: 3,
        inputTokens: expect.any(Number),
        dollars: expect.any(Number),
      },
      warnings: [],
    });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers per question what would change and how agreement with reviewers moves", async () => {
    const t = await rig();
    const response = await t.call("POST", "/v1/test", { source: LOOSER });

    expect(response.status).toBe(200);
    // Listing 3 was unsure at 50% under 70% / 30% and is a yes at 58% over the draft's 50%;
    // Listing 1 is a person's (no), which the draft agrees with, as the version in force did.
    expect(response.json).toMatchObject({
      sample: { records: 3, asked: 3 },
      reviewed: { records: 1, asked: 1 },
      removed: [],
      questions: [
        {
          question: "is_scam",
          comparison: "compared",
          compared: 2,
          changed: 1,
          toDecided: 1,
          toReview: 0,
          toAnotherValue: 0,
          keptForPeople: 1,
          agreement: {
            kind: "measured",
            records: 1,
            now: { agreed: 1, disagreed: 0, unsure: 0, rate: 1 },
            draft: { agreed: 1, disagreed: 0, unsure: 0, rate: 1 },
          },
        },
      ],
      cost: { inputTokens: 300 },
      estimate: { requests: 3 },
      warnings: [],
    });
    expect(response.json).not.toHaveProperty("kind");
    // No key and no state in the result: counts only.
    expect(JSON.stringify(response.json)).not.toContain("Listing");
    expect(JSON.stringify(response.json)).not.toContain("oid:");
    for (const [key] of t.database.rows.entries()) {
      expect(t.database.decisionOf(key)).toBeNull();
    }
  });

  it("refuses a sample outside 1 to 1,000, a broken draft, an unknown source and other fields without a model call", async () => {
    const t = await rig();
    const tooMany = await t.call("POST", "/v1/test", { source: LOOSER, sample: 1001 });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toMatchObject({ error: { code: "invalid_request" } });

    const broken = await t.call("POST", "/v1/test", {
      source: { name: "listings", thresholds: { is_scam: { yesAbove: 1.5 } } },
    });
    expect(broken.status).toBe(400);
    expect(broken.json).toMatchObject({ error: { code: "invalid_draft" } });

    const unknown = await t.call("POST", "/v1/test", { source: { name: "orders" } });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { code: "unknown_source" } });

    const other = await t.call("POST", "/v1/test", {
      source: { name: "listings", read: ["title", "body"] },
    });
    expect(other.status).toBe(400);
    expect(other.json).toMatchObject({ error: { code: "fields_differ" } });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("returns the cap's words when the cap is already reached, and 503 naming the record when the model fails", async () => {
    const capped = await rig({ used: 5000 });
    const refused = await capped.call("POST", "/v1/test", { source: LOOSER });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(26 * 24 * 60 * 60));
    expect(refused.json).toMatchObject({ error: { code: "spending_cap_reached" } });
    expect(capped.provider.requests).toHaveLength(0);

    const down = await rig();
    down.provider.down = true;
    const failed = await down.call("POST", "/v1/test", { source: LOOSER });
    expect(failed.status).toBe(503);
    expect(failed.json).toMatchObject({
      error: {
        code: "model_unavailable",
        message: expect.stringContaining("the model answered 503"),
      },
    });
    expect(JSON.stringify(failed.json)).not.toContain("oid:");
  });
});

describe("validate, preview and test from a page of another site", () => {
  // A signed-in reviewer's browser carries the cookie to any page's request; preview and test
  // spend model budget (a test up to 1,000 requests), so the site decides before the body is read.
  const SIGNED_IN = { cookie: `${SESSION_COOKIE}=${MAYA}.valid` };
  const ROUTES = [
    ["/v1/config/validate", { source: { name: "listings" } }],
    ["/v1/preview", { source: { name: "listings" } }],
    ["/v1/test", { source: { name: "listings" }, estimate: true }],
  ] as const;

  it("answers none of them, and never calls the model", async () => {
    const t = await rig();
    const forged = [
      { headers: { ...SIGNED_IN, "content-type": "text/plain" }, status: 415, code: "json_only" },
      {
        headers: { ...SIGNED_IN, origin: "https://evil.example" },
        status: 403,
        code: "cross_origin",
      },
      {
        headers: { ...SIGNED_IN, "sec-fetch-site": "same-site" },
        status: 403,
        code: "cross_origin",
      },
      {
        headers: { ...SIGNED_IN, "sec-fetch-site": "cross-site" },
        status: 403,
        code: "cross_origin",
      },
    ];
    for (const [path, body] of ROUTES) {
      for (const attempt of forged) {
        const response = await t.call("POST", path, body, {
          peer: ELSEWHERE,
          headers: attempt.headers,
        });
        expect(response.status, `${path} ${JSON.stringify(attempt.headers)}`).toBe(attempt.status);
        expect(response.json).toMatchObject({ error: { code: attempt.code } });
      }
    }
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers the studio's own page", async () => {
    const t = await rig();
    for (const [path, body] of ROUTES) {
      const response = await t.call("POST", path, body, {
        peer: ELSEWHERE,
        headers: { ...SIGNED_IN, origin: "http://localhost", "sec-fetch-site": "same-origin" },
      });
      expect(response.status, path).toBe(200);
    }
  });
});
