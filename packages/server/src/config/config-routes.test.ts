import {
  createPreviewService,
  createSpending,
  type KeyText,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Question,
  type QuestionSet,
  type SpendingGate,
  spendingGate,
} from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { DataServices } from "../data/routes.ts";
import {
  createConfigService,
  type DraftCheck,
  type PreviewSource,
  type ProjectConfigDoor,
  type SourceDraft,
} from "./service.ts";

/**
 * The config routes on fakes: API keys for two projects, the CLI's door to the configuration as a
 * handwritten judge, and a running source whose preview is core's preview service over the fake
 * database, a scripted provider and the project's spending gate.
 */

const PROJECT = "listings-app";
const OTHER = "another-app";
const KEY = "Bearer fdb_listings";
const OTHER_KEY = "Bearer fdb_another";

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(
      header === KEY
        ? { id: "key-1", projectId: PROJECT }
        : header === OTHER_KEY
          ? { id: "key-2", projectId: OTHER }
          : undefined,
    ),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_DATA: DataServices = {
  runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
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
const door: ProjectConfigDoor = {
  projectId: PROJECT,
  json: () => PROJECT_JSON,
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

function rig(
  options: {
    readonly used?: number;
    /** The source's `where` as its SQL would judge a row: true leaves it out. */
    readonly excludes?: (state: Readonly<Record<string, string | null>>) => boolean;
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
  const running: PreviewSource = {
    read: RUNNING.read,
    where: undefined,
    keyText: tagged,
    preview: createPreviewService({
      connector: new FakeConnector(database),
      provider,
      spending: projectGate(options.used ?? 0),
      log: () => undefined,
      clock: new FakeClock(Date.UTC(2026, 10, 5)),
    }).preview,
  };
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: createConfigService({
      config: door,
      preview: (source) => (source === "listings" ? running : undefined),
    }),
    data: NO_DATA,
    newRequestId: () => "req-1",
  });

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authorization: string | null = KEY,
  ) {
    const response = await app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      // A GET carries no body.
      ...(body === undefined || method === "GET"
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  return { call, provider, database };
}

describe("the config routes", () => {
  it("refuse every request without a valid API key, in the one error shape", async () => {
    const t = rig();
    for (const [method, path] of [
      ["GET", "/v1/config"],
      ["POST", "/v1/config/validate"],
      ["POST", "/v1/preview"],
    ] as const) {
      const response = await t.call(method, path, { source: { name: "listings" } }, null);
      expect(response.status).toBe(401);
      expect(response.json).toMatchObject({
        error: { code: "invalid_api_key", message: expect.any(String), fix: expect.any(String) },
      });
    }
    expect(t.provider.requests).toHaveLength(0);
  });

  it("GET /v1/config returns the project JSON of the loader's export", async () => {
    const t = rig();
    const response = await t.call("GET", "/v1/config");

    expect(response.status).toBe(200);
    expect(response.json).toEqual(PROJECT_JSON);
  });

  it("shows nothing of the project to a key of another project in the same store", async () => {
    const t = rig();
    for (const [method, path] of [
      ["GET", "/v1/config"],
      ["POST", "/v1/config/validate"],
      ["POST", "/v1/preview"],
    ] as const) {
      const response = await t.call(method, path, { source: { name: "listings" } }, OTHER_KEY);
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({ error: { code: "unknown_project" } });
    }
    expect(t.provider.requests).toHaveLength(0);
  });

  it("POST /v1/config/validate answers a valid draft with its wording warnings in the CLI's shape", async () => {
    const t = rig();
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
    const t = rig();
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
    const t = rig();
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
    const t = rig();
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
    const t = rig();
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
    const t = rig();
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
    const t = rig({ excludes: (state) => state["title"] === "Listing 3" });
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
    const t = rig({ used: 5000 });
    const response = await t.call("POST", "/v1/preview", { source: { name: "listings" } });

    expect(response.status).toBe(429);
    // Until the month resets: November 5, 00:00 UTC to December 1 is 26 days.
    expect(response.headers.get("retry-after")).toBe(String(26 * 24 * 60 * 60));
    expect(response.json).toEqual({
      error: {
        code: "spending_cap_reached",
        message:
          "This month's usage reached the project's spending cap, so the preview asked the model nothing.",
        fix: expect.stringContaining("spendingCap"),
      },
    });
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers a failed model call with 503, naming the row as the user writes it", async () => {
    const t = rig();
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
