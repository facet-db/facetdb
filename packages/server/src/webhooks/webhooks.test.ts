import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  QuestionSet,
  RecordKey,
  SpendingGate,
} from "@facetdb/core";
import { configureAction, createWorker, DEFAULT_WORKER_LIMITS } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { createStore, pgliteClient } from "@facetdb/postgres";
import { freshPglite, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createApiKeys } from "../auth/api-keys.ts";
import { createCheckService } from "../check/service.ts";
import { createCheckStore } from "../check/store.ts";
import { onlyRecord } from "../check/target.ts";
import { createWebhookAction, type WebhookPayload } from "./action.ts";
import {
  CLAIM_LEASE_MS,
  createOutbox,
  GIVE_UP_AFTER_MS,
  RETRY_MAX_MS,
  retryDelayMs,
  type WebhookFetch,
  type WebhookGaveUp,
} from "./outbox.ts";
import { SIGNATURE_TOLERANCE_MS, sign, verify, WEBHOOK_SIGNATURE_HEADER } from "./sign.ts";

const PROJECT = "project-1";
const SOURCE = "support_tickets";
const SOURCE_ID = "src-support-tickets";
const FIELDS = ["subject", "body"] as const;
const ENDPOINT = "https://hooks.example.com/facetdb";
const SECRET = "whsec-test-secret";
const START = 1_700_000_000_000;

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
};

describe("webhook signatures", () => {
  const body = '{"id":"T-1","answer":"café"}';

  it("is t=<unix>,v1=<hex hmac-sha256 of '<t>.<body>'>", () => {
    const expected = createHmac("sha256", SECRET).update(`1700000000.${body}`).digest("hex");
    expect(sign(SECRET, 1_700_000_000, body)).toBe(`t=1700000000,v1=${expected}`);
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("facetdb-signature");
  });

  it("@timing verifies a fresh signature, up to 5 minutes either side of now", () => {
    const header = sign(SECRET, 1_700_000_000, body);
    const at = 1_700_000_000_000;
    expect(verify(SECRET, header, body, at)).toEqual({ ok: true });
    expect(verify(SECRET, header, body, at + SIGNATURE_TOLERANCE_MS)).toEqual({ ok: true });
    expect(verify(SECRET, header, body, at - SIGNATURE_TOLERANCE_MS)).toEqual({ ok: true });
  });

  it("@timing rejects a signature older than 5 minutes, or from the future", () => {
    const header = sign(SECRET, 1_700_000_000, body);
    const at = 1_700_000_000_000;
    expect(verify(SECRET, header, body, at + SIGNATURE_TOLERANCE_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verify(SECRET, header, body, at - SIGNATURE_TOLERANCE_MS - 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a tampered body, another secret, and a timestamp swapped under the same hash", () => {
    const header = sign(SECRET, 1_700_000_000, body);
    const at = 1_700_000_000_000;
    expect(verify(SECRET, header, `${body} `, at)).toEqual({ ok: false, reason: "mismatch" });
    expect(verify("another-secret", header, body, at)).toEqual({ ok: false, reason: "mismatch" });
    const swapped = header.replace("t=1700000000", "t=1700000001");
    expect(verify(SECRET, swapped, body, at)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a missing or malformed header", () => {
    const at = 1_700_000_000_000;
    const hex = "0".repeat(64);
    for (const header of [
      null,
      undefined,
      "",
      "garbage",
      `v1=${hex}`,
      `t=1700000000`,
      `t=1700000000,v1=${hex.slice(1)}`,
      `t=1700000000,v1=${"G".repeat(64)}`,
      `t=-1,v1=${hex}`,
      `${sign(SECRET, 1_700_000_000, body)},v1=${hex}`,
    ]) {
      expect(verify(SECRET, header, body, at)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("the retry schedule", () => {
  it("doubles from 10 seconds and stops growing at 1 hour", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000]);
    expect(retryDelayMs(10)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(500)).toBe(RETRY_MAX_MS);
    expect(RETRY_MAX_MS).toBe(3_600_000);
    expect(GIVE_UP_AFTER_MS).toBe(86_400_000);
  });
});

type Call = { url: string; headers: Record<string, string>; body: string; at: number };

/** The receiver: answers from a script, and remembers every request with the time it came. */
class Receiver {
  readonly calls: Call[] = [];
  /** The status of the next answer; `throw` simulates an unreachable host. */
  respond: () => number | "throw" = () => 204;

  readonly #clock: FakeClock;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  readonly fetch: WebhookFetch = (url, init) => {
    this.calls.push({
      url,
      headers: { ...init.headers },
      body: init.body,
      at: this.#clock.now(),
    });
    const answer = this.respond();
    return answer === "throw"
      ? Promise.reject(new Error("connect ECONNREFUSED"))
      : Promise.resolve({ status: answer });
  };
}

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

const QUESTIONS: QuestionSet = {
  questions: [urgency, wantsRefund],
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: { urgency: { confidenceAtLeast: 0.6 } },
};

class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  down = false;
  refundProbability = 0.02;

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.down) {
      return Promise.reject(new Error("the model is unreachable"));
    }
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        urgency: {
          type: "score",
          probabilities: [0.02, 0.07, 0.91],
          confidence: 0.91,
          expected: 2.89,
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

async function rig() {
  const clock = new FakeClock(START);
  const pglite = await freshPglite();
  const store = await createStore({ pglite, secret: TEST_SECRET, clock });
  closers.push(async () => {
    await store.close();
    await pglite.close();
  });
  const client = pgliteClient(pglite);
  await store.ensureProject({ id: PROJECT, name: "one" });
  await store.ensureSource({ id: SOURCE_ID, projectId: PROJECT, name: SOURCE, kind: "api" });

  const receiver = new Receiver(clock);
  const gaveUp: WebhookGaveUp[] = [];
  const secretLookups: string[] = [];
  const outbox = createOutbox({
    client,
    clock,
    fetch: receiver.fetch,
    secretFor: (projectId, endpoint) => {
      secretLookups.push(`${projectId} ${endpoint}`);
      return Promise.resolve(SECRET);
    },
    onGiveUp: (event) => {
      gaveUp.push(event);
      return Promise.resolve();
    },
  });
  await outbox.install();
  // Installing twice changes nothing.
  await outbox.install();

  const provider = new ScriptedProvider();
  const connectorOf = (workerId: string) =>
    store.connector({ sourceId: SOURCE_ID, fields: FIELDS, workerId });
  const webhook = configureAction(
    "webhook",
    createWebhookAction({ outbox, projectId: PROJECT, source: SOURCE }),
    { url: ENDPOINT },
  );
  const workerOver = (connector: ReturnType<typeof connectorOf> | ReturnType<typeof onlyRecord>) =>
    createWorker({
      connector,
      provider,
      log: store.log(SOURCE_ID),
      reviews: { withdraw: () => Promise.resolve() },
      actions: [webhook],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: QUESTIONS,
      version: 1,
      spending: UNLIMITED,
    });

  /** The check API's worker takes its caller's record only; the loop's worker takes the whole queue. */
  const checkConnector = connectorOf("check-api");
  const loopWorker = workerOver(connectorOf("loop"));
  const inspect = connectorOf("inspector");

  const keys = createApiKeys(store.apiKeys);
  const app = createApp({
    keys,
    check: createCheckService({
      store: createCheckStore(
        store,
        [{ projectId: PROJECT, name: SOURCE, sourceId: SOURCE_ID, fields: FIELDS }],
        "check-api",
      ),
      worker: {
        forRecord: (_projectId, _name, key: RecordKey) =>
          workerOver(onlyRecord(checkConnector, key)),
      },
      clock,
      retryAfterSeconds: 30,
    }),
    newRequestId: () => "req-1",
  });
  const { secret } = await keys.create(PROJECT, "test");

  async function post(record: { subject: string; body: string }, id = "T-1042") {
    const response = await app.request("/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ source: SOURCE, id, record }),
    });
    return { status: response.status, headers: response.headers, json: await response.json() };
  }

  async function row(id: string) {
    const [found] = await client.query(
      `select attempts, next_attempt_at::text as next_attempt_at, created_at::text as created_at,
              delivered_at::text as delivered_at, gave_up_at::text as gave_up_at, last_error
         from facetdb.webhook_outbox where id = $1::bigint`,
      [id],
    );
    if (found === undefined) {
      throw new Error(`no outbox row ${id}`);
    }
    return found;
  }

  return {
    clock,
    receiver,
    outbox,
    gaveUp,
    secretLookups,
    provider,
    loopWorker,
    inspect,
    post,
    row,
    client,
  };
}

const CHARGED = { subject: "Charged twice", body: "I was charged twice, please fix this today" };

describe("outbox delivery", () => {
  it("@timing sends a signed request over the exact stored bytes and marks the row delivered", async () => {
    const t = await rig();
    const id = await t.outbox.enqueue({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      payload: { id: "T-1", note: "café ✓" },
    });

    const report = await t.outbox.deliverDue(t.clock.now());

    expect(report).toMatchObject({ delivered: [id], retrying: [], gaveUp: [] });
    expect(t.receiver.calls).toHaveLength(1);
    const [call] = t.receiver.calls;
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.body).toBe(JSON.stringify({ id: "T-1", note: "café ✓" }));
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["facetdb-delivery"]).toBe(id);
    // The receiver's snippet accepts it, with the bytes it received.
    expect(
      verify(SECRET, call?.headers[WEBHOOK_SIGNATURE_HEADER], call?.body ?? "", t.clock.now()),
    ).toEqual({ ok: true });
    expect(
      verify(SECRET, call?.headers[WEBHOOK_SIGNATURE_HEADER], `${call?.body} `, t.clock.now()),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(Number((await t.row(id))["delivered_at"])).toBe(START);

    // Delivered once: a later pass sends nothing.
    t.clock.advance(60 * 60_000);
    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ delivered: [] });
    expect(t.receiver.calls).toHaveLength(1);
  });

  it("@timing waits for next_attempt_at: nothing is sent before a webhook is due", async () => {
    const t = await rig();
    t.receiver.respond = () => 500;
    const id = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    await t.outbox.deliverDue(START);
    expect(Number((await t.row(id))["next_attempt_at"])).toBe(START + 10_000);

    expect(await t.outbox.deliverDue(START + 9_999)).toMatchObject({
      delivered: [],
      retrying: [],
    });
    expect(t.receiver.calls).toHaveLength(1);
    expect(await t.outbox.deliverDue(START + 10_000)).toMatchObject({ retrying: [id] });
    expect(t.receiver.calls).toHaveLength(2);
  });

  it("@timing backs off 10 s, 20 s, 40 s … up to 1 h, signs each attempt afresh, and stops after the first success", async () => {
    const t = await rig();
    t.receiver.respond = () => 503;
    const id = await t.outbox.enqueue({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      payload: { n: 1 },
    });

    let now = START;
    const times: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      times.push(now);
      t.clock.advance(now - t.clock.now());
      const report = await t.outbox.deliverDue(now);
      expect(report.retrying).toEqual([id]);
      now = Number((await t.row(id))["next_attempt_at"]);
    }
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    expect(gaps).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000, 3_600_000,
      3_600_000,
    ]);
    // Every attempt carries the same body and delivery id, and a signature that verifies at its time.
    expect(new Set(t.receiver.calls.map((call) => call.body)).size).toBe(1);
    expect(new Set(t.receiver.calls.map((call) => call.headers["facetdb-delivery"]))).toEqual(
      new Set([id]),
    );
    for (const call of t.receiver.calls) {
      expect(verify(SECRET, call.headers[WEBHOOK_SIGNATURE_HEADER], call.body, call.at)).toEqual({
        ok: true,
      });
    }
    expect(
      new Set(t.receiver.calls.map((call) => call.headers[WEBHOOK_SIGNATURE_HEADER])).size,
    ).toBe(12);

    // The receiver comes back: the next attempt delivers, and none follows.
    t.receiver.respond = () => 200;
    t.clock.advance(now - t.clock.now());
    expect(await t.outbox.deliverDue(now)).toMatchObject({ delivered: [id] });
    const sent = t.receiver.calls.length;
    expect(await t.outbox.deliverDue(now + 24 * 60 * 60_000)).toMatchObject({ delivered: [] });
    expect(t.receiver.calls).toHaveLength(sent);
    expect((await t.row(id))["last_error"]).toBeNull();
  });

  it("@timing gives up exactly 24 hours after it was queued, with one alert event and no later attempt", async () => {
    const t = await rig();
    t.receiver.respond = () => 500;
    const id = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    const deadline = START + GIVE_UP_AFTER_MS;

    let now = START;
    let last = START;
    for (let pass = 0; pass < 200; pass += 1) {
      const report = await t.outbox.deliverDue(now);
      last = now;
      if (report.gaveUp.length > 0) {
        expect(report.gaveUp).toEqual([id]);
        break;
      }
      expect(report.retrying).toEqual([id]);
      now = Number((await t.row(id))["next_attempt_at"]);
      expect(now).toBeLessThanOrEqual(deadline);
    }

    expect(last).toBe(deadline);
    expect(t.gaveUp).toEqual([
      {
        projectId: PROJECT,
        deliveryId: id,
        host: "hooks.example.com",
        attempts: t.receiver.calls.length,
        queuedAt: START,
      },
    ]);
    // The alert carries the host, never the path (a URL can be a secret by itself).
    expect(JSON.stringify(t.gaveUp)).not.toContain("/facetdb");
    const stored = await t.row(id);
    expect(Number(stored["gave_up_at"])).toBe(deadline);
    expect(stored["delivered_at"]).toBeNull();
    expect(stored["last_error"]).toBe("the receiver answered 500");

    const sent = t.receiver.calls.length;
    expect(await t.outbox.deliverDue(deadline + 7 * 24 * 60 * 60_000)).toMatchObject({
      delivered: [],
      retrying: [],
      gaveUp: [],
    });
    expect(t.receiver.calls).toHaveLength(sent);
    expect(t.gaveUp).toHaveLength(1);
  });

  it("@timing counts a redirect, a refused connection and an unreadable secret as failed attempts", async () => {
    const t = await rig();
    const id = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });

    t.receiver.respond = () => 302;
    await t.outbox.deliverDue(START);
    expect((await t.row(id))["last_error"]).toBe("the receiver answered 302");

    t.receiver.respond = () => "throw";
    await t.outbox.deliverDue(START + 10_000);
    expect((await t.row(id))["last_error"]).toBe("the receiver could not be reached");
    // The error text of the driver (which may name the URL) is not kept.
    expect(JSON.stringify(await t.row(id))).not.toContain("ECONNREFUSED");

    const broken = createOutbox({
      client: t.client,
      clock: t.clock,
      fetch: t.receiver.fetch,
      secretFor: () => Promise.reject(new Error("decryption failed for whsec-test-secret")),
      onGiveUp: () => Promise.resolve(),
    });
    const calls = t.receiver.calls.length;
    await broken.deliverDue(START + 30_000);
    expect(t.receiver.calls).toHaveLength(calls);
    expect((await t.row(id))["last_error"]).toBe("the signing secret could not be read");
  });

  it("@timing hands a due webhook to one loop only, and retries it after the lease if the loop died", async () => {
    const t = await rig();
    const id = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    await Promise.all([t.outbox.deliverDue(START), t.outbox.deliverDue(START)]);
    expect(t.receiver.calls).toHaveLength(1);

    // A claim whose loop died before it recorded the outcome comes due again after the lease.
    await t.client.query(
      "update facetdb.webhook_outbox set delivered_at = null, next_attempt_at = $2::bigint where id = $1::bigint",
      [id, START + CLAIM_LEASE_MS],
    );
    expect(await t.outbox.deliverDue(START + CLAIM_LEASE_MS - 1)).toMatchObject({ delivered: [] });
    expect(await t.outbox.deliverDue(START + CLAIM_LEASE_MS)).toMatchObject({ delivered: [id] });
  });

  it("refuses an endpoint that is not an http or https URL, and arms no timer", async () => {
    const t = await rig();
    await expect(
      t.outbox.enqueue({ projectId: PROJECT, endpoint: "file:///etc/passwd", payload: {} }),
    ).rejects.toThrow(/http or https/);
    await expect(
      t.outbox.enqueue({ projectId: PROJECT, endpoint: "not a url", payload: {} }),
    ).rejects.toThrow();

    // Acceptance: the outbox row and the loop decide when to send, never a timer.
    const source = readFileSync(new URL("./outbox.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });
});

describe("the check API with the model down", () => {
  it("@timing answers 503 with retry-after, keeps the record queued, and the webhook delivers the answer when it lands", async () => {
    const t = await rig();
    t.provider.down = true;

    const response = await t.post(CHARGED);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.json).toMatchObject({
      error: { code: "model_unavailable", fix: expect.stringContaining("30 seconds") },
    });
    expect(await t.inspect.getRecord("T-1042")).toMatchObject({
      status: "pending",
      decision: null,
    });
    // No answer exists, so there is nothing to deliver yet.
    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ delivered: [] });
    expect(t.receiver.calls).toHaveLength(0);

    // The model returns; the worker loop answers the queued record and the webhook action queues.
    t.provider.down = false;
    const pass = await t.loopWorker.runOnce();
    expect(pass.written).toEqual(["T-1042"]);
    expect(pass.failures).toEqual([]);
    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ retrying: [] });

    expect(t.receiver.calls).toHaveLength(1);
    const [call] = t.receiver.calls;
    expect(
      verify(SECRET, call?.headers[WEBHOOK_SIGNATURE_HEADER], call?.body ?? "", t.clock.now()),
    ).toEqual({ ok: true });
    expect(JSON.parse(call?.body ?? "null")).toEqual({
      event: "record.decided",
      source: SOURCE,
      id: "T-1042",
      status: "done",
      answers: {
        urgency: { value: "high", confidence: 0.91, expected: 2.89 },
        wants_refund: { value: false, probability: 0.02 },
      },
    } satisfies WebhookPayload);

    // The caller, asking again, gets the stored answer and no second model call.
    const again = await t.post(CHARGED);
    expect(again.status).toBe(200);
    expect(t.provider.requests).toHaveLength(2);
  });

  it("a retry-after is not sent when the answer is merely slow", async () => {
    const t = await rig();
    await t.inspect.upsertRecord("T-1042", CHARGED);
    expect(await t.inspect.claimRecord("T-1042")).toBe(true);
    const response = await t.post(CHARGED);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.json).toMatchObject({ error: { code: "answer_pending" } });
  });
});

describe("a person's decision reaches the same endpoint", () => {
  it("@timing queues a second webhook for the reviewer's decision, with the status and the decided answers", async () => {
    const t = await rig();
    t.provider.refundProbability = 0.5; // between the high-stakes cut-offs: left to a person

    const first = await t.post(CHARGED);
    expect(first.json).toMatchObject({ status: "needs_review" });
    await t.outbox.deliverDue(t.clock.now());
    expect(t.receiver.calls).toHaveLength(1);
    const automatic = JSON.parse(t.receiver.calls[0]?.body ?? "null") as WebhookPayload;
    expect(automatic).toMatchObject({ status: "needs_review" });
    expect(Object.keys(automatic.answers)).toEqual(["urgency"]);

    const stored = await t.inspect.getRecord("T-1042");
    if (stored?.decision == null) {
      throw new Error("the record has no decision");
    }
    const outcome = await t.loopWorker.onHumanDecision({
      key: "T-1042",
      stateHash: stored.hash,
      status: "done",
      decisions: {
        ...stored.decision.decisions,
        wants_refund: { kind: "decided", value: true, probabilityOrConfidence: 1 },
      },
    });
    expect(outcome).toEqual({ ran: true, failures: [] });
    t.clock.advance(1_000);
    await t.outbox.deliverDue(t.clock.now());

    expect(t.receiver.calls).toHaveLength(2);
    const [, human] = t.receiver.calls;
    expect(human?.url).toBe(ENDPOINT);
    expect(human?.headers["facetdb-delivery"]).not.toBe(
      t.receiver.calls[0]?.headers["facetdb-delivery"],
    );
    expect(
      verify(SECRET, human?.headers[WEBHOOK_SIGNATURE_HEADER], human?.body ?? "", t.clock.now()),
    ).toEqual({ ok: true });
    expect(JSON.parse(human?.body ?? "null")).toMatchObject({
      id: "T-1042",
      status: "done",
      answers: {
        urgency: { value: "high" },
        wants_refund: { value: true, probability: 1 },
      },
    });
  });

  it("queues nothing for a decision on a record that changed since", async () => {
    const t = await rig();
    await t.post(CHARGED);
    await t.outbox.deliverDue(t.clock.now());
    const outcome = await t.loopWorker.onHumanDecision({
      key: "T-1042",
      stateHash: "an-old-hash",
      status: "done",
      decisions: {},
    });
    expect(outcome.ran).toBe(false);
    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ delivered: [] });
    expect(t.receiver.calls).toHaveLength(1);
  });
});
