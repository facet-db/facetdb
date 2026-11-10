import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  QuestionSet,
  RecordKey,
  SpendingGate,
} from "@facetdb/core";
import { createWorker, DEFAULT_WORKER_LIMITS } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import type { ApiKeyStore } from "@facetdb/postgres";
import { createMemoryStore } from "@facetdb/postgres/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createApiKeys } from "../auth/api-keys.ts";
import { CHECK_POLL_MS, CHECK_WAIT_MS, createCheckService } from "./service.ts";
import { createCheckStore } from "./store.ts";
import { onlyRecord } from "./target.ts";

const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const SOURCE = "support_tickets";
const SOURCE_ID = "src-support-tickets";
const FIELDS = ["subject", "body"] as const;

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
};

const urgency = {
  type: "score",
  name: "urgency",
  instructions: "How urgent is this ticket?",
  levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
  stakes: "low",
} as const;

const wantsRefund = {
  type: "noul",
  name: "wants_refund",
  instructions: "Is the customer asking for their money back?",
  stakes: "high",
} as const;

function questionSet(...questions: QuestionSet["questions"]): QuestionSet {
  return {
    questions,
    read: [...FIELDS],
    model: "jev-1.14.0",
    thresholds: { urgency: { confidenceAtLeast: 0.6 } },
  };
}

/** Answers from a script, counts every request, and can be told to fail like an unreachable model. */
class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  down = false;
  /** The yes probability for `wants_refund`; 0.5 sits between the high-stakes cut-offs. */
  refundProbability = 0.5;

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.down) {
      return Promise.reject(new Error("the model is unreachable"));
    }
    const body = request.state["body"] ?? "";
    const high = body.includes("today");
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        urgency: {
          type: "score",
          probabilities: high ? [0.02, 0.07, 0.91] : [0.9, 0.07, 0.03],
          confidence: 0.91,
          expected: high ? 2.89 : 0.13,
        },
        wants_refund: { type: "noul", probability: this.refundProbability },
      },
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  }
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** The real key store, remembering which secrets `verify` was asked about. */
function recordingKeyStore(inner: ApiKeyStore): ApiKeyStore & { readonly verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    create: (projectId, name) => inner.create(projectId, name),
    verify(secret) {
      verified.push(secret);
      return inner.verify(secret);
    },
    revoke: (id) => inner.revoke(id),
  };
}

/**
 * The whole path over the real FacetDB store (PGlite): API keys, the API source's records and jobs
 * through `createCheckStore`, the decision log and the worker's claim, with only the model scripted.
 */
async function rig(questions: QuestionSet["questions"] = [urgency, wantsRefund]) {
  const clock = new FakeClock(1_700_000_000_000);
  const memory = await createMemoryStore(clock);
  closers.push(() => memory.close());
  const { store } = memory;
  await store.ensureProject({ id: PROJECT, name: "one" });
  await store.ensureProject({ id: OTHER_PROJECT, name: "two" });
  await store.ensureSource({ id: SOURCE_ID, projectId: PROJECT, name: SOURCE, kind: "api" });

  const connectorOf = (workerId: string) =>
    store.connector({ sourceId: SOURCE_ID, fields: FIELDS, workerId });
  /** The check worker's own connector, and two other workers: one to look, one to hold a job. */
  const checkConnector = connectorOf("check-api");
  const inspect = connectorOf("inspector");
  const holder = connectorOf("other-worker");

  const provider = new ScriptedProvider();
  const worker = (key: RecordKey) =>
    createWorker({
      connector: onlyRecord(checkConnector, key),
      provider,
      log: store.log(SOURCE_ID),
      reviews: { withdraw: () => Promise.resolve() },
      actions: [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: questionSet(...questions),
      version: 1,
      spending: UNLIMITED,
    });
  const keyStore = recordingKeyStore(store.apiKeys);
  const keys = createApiKeys(keyStore);
  let requestCount = 0;
  const check = createCheckService({
    store: createCheckStore(
      store,
      [{ projectId: PROJECT, name: SOURCE, sourceId: SOURCE_ID, fields: FIELDS }],
      "check-api",
    ),
    worker: { forRecord: (_projectId, _name, key) => worker(key) },
    clock,
    retryAfterSeconds: 30,
  });
  const app = createApp({
    keys,
    check,
    newRequestId: () => {
      requestCount += 1;
      return `req-${requestCount}`;
    },
  });
  const { secret } = await keys.create(PROJECT, "test");
  const other = await keys.create(OTHER_PROJECT, "test");

  async function post(body: unknown, header: string | null = `Bearer ${secret}`) {
    const response = await app.request("/v1/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header === null ? {} : { authorization: header }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      json: (await response.json()) as unknown,
    };
  }

  return {
    app,
    clock,
    store,
    inspect,
    holder,
    provider,
    keys,
    keyStore,
    secret,
    otherSecret: other.secret,
    post,
  };
}

const ticket = (body: string, id = "T-1042") => ({
  source: SOURCE,
  id,
  record: { subject: "Charged twice", body },
});

const CHARGED = "I was charged twice for my order, please fix this today";

describe("POST /v1/check authentication", () => {
  it("answers 401 without a key, with a malformed header, with an unknown key and with a revoked key", async () => {
    const t = await rig();
    const revoked = await t.keys.create(PROJECT, "old");
    await t.keys.revoke(revoked.id);

    const attempts: (string | null)[] = [
      null,
      "Basic abc",
      "Bearer",
      `Bearer ${t.secret}x`,
      `Bearer ${revoked.secret}`,
    ];
    for (const header of attempts) {
      const response = await t.post(ticket(CHARGED), header);
      expect(response.status).toBe(401);
      expect(response.json).toEqual({
        error: {
          code: "invalid_api_key",
          message: expect.stringContaining("no valid API key"),
          fix: expect.stringContaining("facetdb keys add"),
        },
      });
    }
    // Before any record is read: nothing was stored and the model was never asked.
    expect(await t.inspect.getRecord("T-1042")).toBeUndefined();
    expect(t.provider.requests).toHaveLength(0);
  });

  it("looks a key up only when the header carries one", async () => {
    const t = await rig();
    t.keyStore.verified.length = 0;
    await t.post(ticket(CHARGED), null);
    await t.post(ticket(CHARGED), "Basic abc");
    expect(t.keyStore.verified).toEqual([]);
    await t.post(ticket(CHARGED), `Bearer ${t.secret}`);
    expect(t.keyStore.verified).toEqual([t.secret]);
  });

  it("keeps a project to its own sources", async () => {
    const t = await rig();
    const response = await t.post(ticket(CHARGED), `Bearer ${t.otherSecret}`);
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "unknown_source" } });
    expect(await t.inspect.getRecord("T-1042")).toBeUndefined();
  });
});

describe("POST /v1/check answers", () => {
  it("returns the answers and the status in the documented shape", async () => {
    const t = await rig([urgency]);
    const response = await t.post(ticket(CHARGED));
    expect(response.status).toBe(200);
    // result.answers.urgency -> { value: "high", confidence: 0.91 }; result.status -> "done"
    expect(response.json).toEqual({
      id: "T-1042",
      status: "done",
      answers: { urgency: { value: "high", confidence: 0.91, expected: 2.89 } },
    });
    expect(t.provider.requests).toHaveLength(1);
  });

  it("returns the stored answer without a model call when the record is unchanged", async () => {
    const t = await rig();
    t.provider.refundProbability = 0.02;
    const first = await t.post(ticket(CHARGED));
    expect(t.provider.requests).toHaveLength(1);

    const second = await t.post(ticket(CHARGED));
    expect(second).toMatchObject({ status: 200, json: first.json });
    expect(t.provider.requests).toHaveLength(1);
    expect(first.json).toMatchObject({
      status: "done",
      answers: { wants_refund: { value: false, probability: 0.02 } },
    });
  });

  it("asks again when the record changed, and returns the new answers", async () => {
    const t = await rig([urgency]);
    await t.post(ticket(CHARGED));
    const changed = await t.post(ticket("Just saying thanks for the quick delivery"));
    expect(t.provider.requests).toHaveLength(2);
    expect(changed.json).toMatchObject({
      status: "done",
      answers: { urgency: { value: "low" } },
    });
  });

  it("returns the partial answers and needs_review when a question is left to a person", async () => {
    const t = await rig();
    const response = await t.post(ticket(CHARGED));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      id: "T-1042",
      status: "needs_review",
      answers: { urgency: { value: "high", confidence: 0.91, expected: 2.89 } },
    });
  });

  it("asks a record that was stored but never answered, instead of serving nothing", async () => {
    const t = await rig([urgency]);
    await t.inspect.upsertRecord("T-1", { subject: "s", body: CHARGED });
    const response = await t.post(ticket(CHARGED, "T-1"));
    expect(response.json).toMatchObject({ status: "done" });
    expect(t.provider.requests).toHaveLength(1);
  });

  it("keeps the answer in the store: the decision, its status and an empty queue", async () => {
    const t = await rig([urgency]);
    await t.post(ticket(CHARGED));
    const stored = await t.inspect.getRecord("T-1042");
    expect(stored?.status).toBe("done");
    expect(stored?.decision?.decisions["urgency"]).toMatchObject({ value: "high" });
    // The job was acknowledged: nothing is left queued for this key.
    expect(await t.holder.claimRecord("T-1042")).toBe(false);
  });
});

describe("POST /v1/check takes only its own record from the queue", () => {
  it("does not ask or claim the other queued records of the source", async () => {
    const t = await rig([urgency]);
    for (const id of ["Q-1", "Q-2", "Q-3"]) {
      await t.inspect.upsertRecord(id, {
        subject: "waiting",
        body: "an older ticket in the queue",
      });
    }

    const response = await t.post(ticket(CHARGED));

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id: "T-1042", status: "done" });
    // One request, about our record; the older jobs are still queued, unclaimed and unanswered.
    expect(t.provider.requests).toHaveLength(1);
    expect(t.provider.requests[0]?.state["body"]).toBe(CHARGED);
    for (const id of ["Q-1", "Q-2", "Q-3"]) {
      expect(await t.inspect.getRecord(id)).toMatchObject({ status: "pending", decision: null });
      // Still unclaimed: another worker can take it now.
      expect(await t.holder.claimRecord(id)).toBe(true);
    }
    expect(await t.holder.claimRecord("T-1042")).toBe(false);
  });
});

describe("POST /v1/check when the answer does not come", () => {
  it("is an error, never an answer, when the model call fails; the record stays stored and queued", async () => {
    const t = await rig();
    t.provider.down = true;
    const response = await t.post(ticket(CHARGED));
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({ error: { code: "model_unavailable" } });
    expect(t.provider.requests).toHaveLength(1);
    expect(await t.inspect.getRecord("T-1042")).toMatchObject({
      status: "pending",
      decision: null,
    });
    // Queued again, not lost: the next worker can take it.
    expect(await t.holder.claimRecord("T-1042")).toBe(true);
  });

  it("waits for a worker that holds the job, then says the answer is pending", async () => {
    const t = await rig();
    await t.inspect.upsertRecord("T-1042", ticket(CHARGED).record);
    expect(await t.holder.claimRecord("T-1042")).toBe(true);

    const response = await t.post(ticket(CHARGED));
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({ error: { code: "answer_pending" } });
    expect(t.provider.requests).toHaveLength(0);
    expect(t.clock.sleeps).toContain(CHECK_POLL_MS);
    expect(t.clock.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(
      CHECK_WAIT_MS,
    );
  });
});

describe("the check store", () => {
  it("serves a declared source to its own project only, and refuses a duplicate declaration", async () => {
    const t = await rig();
    const declared = { projectId: PROJECT, name: SOURCE, sourceId: SOURCE_ID, fields: FIELDS };
    const checkStore = createCheckStore(t.store, [declared], "w");
    expect(checkStore.apiSource(PROJECT, SOURCE)?.fields).toEqual(FIELDS);
    expect(checkStore.apiSource(OTHER_PROJECT, SOURCE)).toBeUndefined();
    expect(checkStore.apiSource(PROJECT, "other")).toBeUndefined();
    expect(() => createCheckStore(t.store, [declared, declared], "w")).toThrow(/twice/);
  });
});

describe("the error shape", () => {
  it("is { error: { code, message, fix } } for every failure", async () => {
    const t = await rig();
    const cases: { name: string; body: unknown; status: number; code: string }[] = [
      { name: "not JSON", body: "{nope", status: 400, code: "invalid_json" },
      { name: "no source", body: { id: "x", record: {} }, status: 400, code: "invalid_request" },
      {
        name: "extra key",
        body: { ...ticket(CHARGED), extra: 1 },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "number value",
        body: { ...ticket(CHARGED), record: { subject: 1, body: "b" } },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "unknown source",
        body: { ...ticket(CHARGED), source: "nope" },
        status: 404,
        code: "unknown_source",
      },
      {
        name: "missing field",
        body: { ...ticket(CHARGED), record: { subject: "s" } },
        status: 400,
        code: "invalid_record",
      },
      {
        name: "extra field",
        body: { ...ticket(CHARGED), record: { subject: "s", body: "b", tag: "x" } },
        status: 400,
        code: "invalid_record",
      },
    ];
    for (const { name, body, status, code } of cases) {
      const response = await t.post(body);
      expect({ name, status: response.status, json: response.json }).toEqual({
        name,
        status,
        json: { error: { code, message: expect.any(String), fix: expect.any(String) } },
      });
    }
    expect(await t.inspect.getRecord("T-1042")).toBeUndefined();
    expect(t.provider.requests).toHaveLength(0);
  });

  it("answers an unknown path in the same shape", async () => {
    const t = await rig();
    const response = await t.app.request("/nowhere");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers a failure inside the service as 500 without echoing the record", async () => {
    const t = await rig();
    const broken = createApp({
      keys: t.keys,
      check: {
        check: () => Promise.reject(new Error(`boom: ${CHARGED}`)),
      },
      newRequestId: () => "req-x",
    });
    const response = await broken.request("/v1/check", {
      method: "POST",
      headers: { authorization: `Bearer ${t.secret}`, "content-type": "application/json" },
      body: JSON.stringify(ticket(CHARGED)),
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("charged twice");
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "internal_error", fix: expect.stringContaining("req-x") },
    });
  });

  it("gives every response a request id", async () => {
    const t = await rig();
    const first = await t.post(ticket(CHARGED), null);
    const second = await t.post(ticket(CHARGED), null);
    expect(first.headers.get("x-request-id")).toBe("req-1");
    expect(second.headers.get("x-request-id")).toBe("req-2");
  });
});
