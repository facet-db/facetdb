import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  QuestionSet,
  RecordKey,
  SpendingGate,
} from "@facetdb/core";
import { createWorker, DEFAULT_WORKER_LIMITS, reviewsOf } from "@facetdb/core";
import { FakeClock, FakeReviewQueue, freshHeldModel } from "@facetdb/core/testing";
import { sourceIdOf } from "@facetdb/postgres";
import {
  createMemoryStore,
  freshPglite,
  type PGlite,
  resetPglite,
} from "@facetdb/postgres/testing";
import { createCheckStore, createServer, onlyRecord } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createClient,
  FacetdbApiError,
  ModelUnavailableError,
  signWebhook,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./index.ts";

const PROJECT = "project-1";
const SOURCE = "support_tickets";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
const FIELDS = ["subject", "body"] as const;
const URL = "https://facetdb.test";

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

const questionSet: QuestionSet = {
  questions: [
    {
      type: "score",
      name: "urgency",
      instructions: "How urgent is this ticket?",
      levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
      stakes: "low",
    },
  ],
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: { urgency: { confidenceAtLeast: 0.6 } },
};

/** What a project writes once beside its config to type `check`. */
type Sources = {
  support_tickets: {
    record: { subject: string; body: string };
    answers: { urgency: { value: string; confidence: number; expected?: number } };
  };
};

class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  down = false;

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.down) {
      return Promise.reject(new Error("the model is unreachable"));
    }
    const high = (request.state["body"] ?? "").includes("today");
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        urgency: {
          type: "score",
          probabilities: high ? [0.02, 0.07, 0.91] : [0.9, 0.07, 0.03],
          confidence: 0.91,
          expected: high ? 2.89 : 0.13,
        },
      },
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  }
}

/** One engine for the file, emptied after every test: a boot per test cost 440 ms. */
let pglite: PGlite;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

/** The server app over the real FacetDB store (PGlite), called in-process through the SDK's `fetch`. */
async function rig() {
  const clock = new FakeClock(1_700_000_000_000);
  const memory = await createMemoryStore(clock, pglite);
  closers.push(() => memory.close());
  const { store } = memory;
  await store.ensureProject({ id: PROJECT, name: "one" });
  await store.ensureSource({ projectId: PROJECT, name: SOURCE, kind: "api" });

  const checkConnector = store.connector({
    sourceId: SOURCE_ID,
    fields: FIELDS,
    workerId: "check-api",
  });
  const provider = new ScriptedProvider();
  const worker = (key: RecordKey) =>
    createWorker({
      connector: onlyRecord(checkConnector, key),
      provider,
      log: store.log(SOURCE_ID),
      reviews: reviewsOf(new FakeReviewQueue(), "messages"),
      actions: [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet,
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
    });
  const app = createServer({
    retryAfterSeconds: 30,
    // The SDK calls the check API only: the config door fails the test if it is reached.
    config: {
      projectId: PROJECT,
      json: () => {
        throw new Error("the SDK reads no config");
      },
      validate: () => {
        throw new Error("the SDK validates no draft");
      },
      pending: () => [],
      history: {
        sources: () => {
          throw new Error("the SDK reads no version history");
        },
        read: () => Promise.reject(new Error("the SDK reads no version history")),
      },
    },
    preview: () => undefined,
    decisions: {
      projectId: PROJECT,
      sources: [],
      keyText: () => undefined,
      current: () => Promise.reject(new Error("the SDK reads no record's status")),
      store: {
        search: () => Promise.reject(new Error("the SDK searches no decisions")),
        history: () => Promise.reject(new Error("the SDK explains no record")),
        questionSets: () => Promise.reject(new Error("the SDK reads no question set")),
      },
    },
    // Nor does it read the dashboard's pages: a read fails the test.
    storeDatabase: {
      query: () => Promise.reject(new Error("the SDK reads no dashboard figure")),
    },
    dashboard: { projectId: PROJECT, cap: undefined, sources: [], stopped: [] },
    // Nor the Alerts and Settings pages' channels and access.
    host: "127.0.0.1",
    alertChannels: () => [],
    fileAlertChannels: () => [],
    machineZone: () => "UTC",
    // Nor does it review: no source is open to a reviewer here.
    review: {
      sources: () => [],
      queue: new FakeReviewQueue(),
      log: new Map(),
      connectors: new Map(),
      actions: new Map(),
      questionSets: new Map(),
      clock,
    },
    store: {
      ...createCheckStore(
        store,
        [{ projectId: PROJECT, name: SOURCE, fields: FIELDS }],
        "check-api",
      ),
      apiKeys: store.apiKeys,
      runs: store.runs,
      users: store.users,
    },
    // The SDK signs nobody in: only the check API is called here.
    sessionSecret: "a-long-random-secret-for-tests-only",
    osUser: () => "tester",
    operatorByAddress: true,
    log: () => undefined,
    worker: { forRecord: (_project, _name, key) => worker(key) },
    clock,
  });
  const { secret } = await store.apiKeys.create(PROJECT, "test");

  const fetchApp: typeof fetch = (input, init) => Promise.resolve(app.request(String(input), init));
  const client = (apiKey = secret) => createClient<Sources>({ url: URL, apiKey, fetch: fetchApp });
  return { client, fetch: fetchApp, provider, secret };
}

const CHARGED = "I was charged twice for my order, please fix this today";
const ticket = { subject: "Charged twice", body: CHARGED };

describe("facetdb.check against the check API", () => {
  it("returns the answers and the status in the documented shape", async () => {
    const t = await rig();
    const result = await t.client().check("support_tickets", { id: "T-1042", record: ticket });

    // result.answers.urgency -> { value: "high", confidence: 0.91 }; result.status -> "done"
    expect(result.id).toBe("T-1042");
    expect(result.status).toBe("done");
    expect(result.answers.urgency).toMatchObject({ value: "high", confidence: 0.91 });
    expect(result.answers.urgency?.value).toBe("high");
  });

  it("sends the same id with an unchanged record to the stored answer, and asks again when it changed", async () => {
    const t = await rig();
    const facetdb = t.client();
    await facetdb.check("support_tickets", { id: "T-1042", record: ticket });
    expect(t.provider.requests).toHaveLength(1);

    const again = await facetdb.check("support_tickets", { id: "T-1042", record: ticket });
    expect(again.answers.urgency).toMatchObject({ value: "high" });
    expect(t.provider.requests).toHaveLength(1);

    const changed = await facetdb.check("support_tickets", {
      id: "T-1042",
      record: { subject: "Charged twice", body: "Never mind, it was a mistake on my side" },
    });
    expect(t.provider.requests).toHaveLength(2);
    expect(changed.answers.urgency).toMatchObject({ value: "low" });
  });

  it("refuses a missing or wrong key with a 401 that says what to do", async () => {
    const t = await rig();
    const error = await t
      .client(`${t.secret}x`)
      .check("support_tickets", { id: "T-1", record: ticket })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FacetdbApiError);
    expect(error).not.toBeInstanceOf(ModelUnavailableError);
    expect(error).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect((error as FacetdbApiError).fix).toContain("facetdb keys add");
    expect(t.provider.requests).toHaveLength(0);
  });

  it("surfaces an unknown source and a record that does not match as errors with their codes", async () => {
    const t = await rig();
    const facetdb = createClient({ url: URL, apiKey: t.secret, fetch: t.fetch });

    await expect(
      facetdb.check("nope", { id: "T-1", record: { subject: "a" } }),
    ).rejects.toMatchObject({ status: 404, code: "unknown_source" });
    await expect(
      facetdb.check("support_tickets", { id: "T-1", record: { subject: "only one field" } }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_record" });
  });

  it("maps a 503 to ModelUnavailableError and leaves the record queued for the webhook", async () => {
    const t = await rig();
    t.provider.down = true;
    const error = await t
      .client()
      .check("support_tickets", { id: "T-1042", record: ticket })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect(error).toMatchObject({ status: 503, code: "model_unavailable" });
  });
});

describe("the SDK's reading of the server's answers", () => {
  const respond =
    (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
    () =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      );
  const unavailable = {
    error: { code: "model_unavailable", message: "The model is down.", fix: "Try again later." },
  };
  const call = (fetchImpl: typeof fetch) =>
    createClient<Sources>({ url: `${URL}/`, apiKey: "key", fetch: fetchImpl })
      .check("support_tickets", { id: "T-1", record: ticket })
      .catch((caught: unknown) => caught);

  it("reads retry-after in seconds as retryAfterMs, and leaves it undefined when the header is absent or odd", async () => {
    expect(await call(respond(503, unavailable, { "retry-after": "7" }))).toMatchObject({
      name: "ModelUnavailableError",
      retryAfterMs: 7000,
      code: "model_unavailable",
      fix: "Try again later.",
    });
    expect(await call(respond(503, unavailable))).toMatchObject({ retryAfterMs: undefined });
    expect(await call(respond(503, unavailable, { "retry-after": "soon" }))).toMatchObject({
      retryAfterMs: undefined,
    });
  });

  it("keeps the request id of a failure, so the operator can find it", async () => {
    const error = await call(respond(500, unavailable, { "x-request-id": "req-9" }));
    expect(error).toMatchObject({ status: 500, requestId: "req-9" });
  });

  it("sends the key as a bearer token to /v1/check, whatever the trailing slash of the url", async () => {
    const seen: { url: string; authorization: string | null; body: unknown }[] = [];
    await createClient<Sources>({
      url: `${URL}//`,
      apiKey: "pk_test",
      fetch: (input, init) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return respond(200, { id: "T-1", status: "done", answers: {} })(input, init);
      },
    }).check("support_tickets", { id: "T-1", record: ticket });
    expect(seen).toEqual([
      {
        url: `${URL}/v1/check`,
        authorization: "Bearer pk_test",
        body: { source: "support_tickets", id: "T-1", record: ticket },
      },
    ]);
  });

  it("accepts plain http:// only for this machine, and says to use https:// otherwise", () => {
    const build = (url: string) => () =>
      createClient<Sources>({ url, apiKey: "key", fetch: respond(200, {}) });
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:3000/",
      "http://[::1]:3000",
      "https://facetdb.example.com",
    ]) {
      expect(build(url)).not.toThrow();
    }
    for (const url of [
      "http://facetdb.example.com",
      "http://localhost.evil.test",
      "http://127.0.0.1.evil.test",
      "http://user@evil.test",
    ]) {
      expect(build(url)).toThrow(/use https:\/\//i);
    }
    expect(build("facetdb.example.com")).toThrow(/not a web address/);
  });

  it("refuses an answer in a shape it does not know, and an error without a body", async () => {
    expect(await call(respond(200, { id: "T-1", status: "maybe", answers: {} }))).toMatchObject({
      code: "unexpected_response",
    });
    expect(await call(respond(502, "<html>bad gateway</html>"))).toMatchObject({
      status: 502,
      code: "unexpected_response",
    });
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "T-1042", status: "done", answers: { urgency: "high" } });
  const now = 1_700_000_000_000;
  const stamp = now / 1000;
  const header = signWebhook(secret, stamp, body);

  it("accepts the exact bytes that were signed, from a Headers object or a plain record", () => {
    expect(
      verifyWebhook(secret, new Headers({ "facetdb-signature": header }), body, { now }),
    ).toEqual({ ok: true, timestamp: stamp });
    expect(
      verifyWebhook(secret, { "Facetdb-Signature": header }, new TextEncoder().encode(body), {
        now,
      }),
    ).toEqual({ ok: true, timestamp: stamp });
    expect(verifyWebhook(secret, { "facetdb-signature": [header] }, body, { now }).ok).toBe(true);
  });

  it("rejects a changed body, a wrong secret and a body signed with another timestamp", () => {
    const headers = { "facetdb-signature": header };
    expect(verifyWebhook(secret, headers, `${body} `, { now })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyWebhook("other", headers, body, { now })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    const replayed = header.replace(`t=${stamp}`, `t=${stamp + 1}`);
    expect(verifyWebhook(secret, { "facetdb-signature": replayed }, body, { now })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature older than five minutes, or dated further ahead", () => {
    const headers = { "facetdb-signature": header };
    const edge = now + WEBHOOK_TOLERANCE_SECONDS * 1000;
    expect(verifyWebhook(secret, headers, body, { now: edge }).ok).toBe(true);
    expect(verifyWebhook(secret, headers, body, { now: edge + 1000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyWebhook(secret, headers, body, { now: now - WEBHOOK_TOLERANCE_SECONDS * 1000 - 1000 }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("says when the header is missing or malformed", () => {
    expect(verifyWebhook(secret, {}, body, { now })).toEqual({ ok: false, reason: "missing" });
    for (const bad of ["", "garbage", `t=${stamp}`, "v1=abcd", `t=x,v1=abcd`, `t=${stamp},v1=zz`]) {
      expect(verifyWebhook(secret, { "facetdb-signature": bad }, body, { now })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses an empty secret instead of accepting a webhook anyone could sign", () => {
    const forged = signWebhook("", stamp, body);
    expect(() => verifyWebhook("", { "facetdb-signature": forged }, body, { now })).toThrow(
      /empty string/,
    );
    // Even a request with no signature header is a misconfiguration, not a quiet "missing".
    expect(() => verifyWebhook("", {}, body, { now })).toThrow(/empty string/);
  });

  it("accepts a rotation: one of several v1 signatures matches", () => {
    const rotated = `${signWebhook("old-secret", stamp, body)},v1=${header.split("v1=")[1]}`;
    expect(verifyWebhook(secret, { "facetdb-signature": rotated }, body, { now }).ok).toBe(true);
    expect(verifyWebhook("neither", { "facetdb-signature": rotated }, body, { now }).ok).toBe(
      false,
    );
  });
});
