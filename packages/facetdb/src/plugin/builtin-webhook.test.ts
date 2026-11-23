import type {
  ChannelMessage,
  Clock,
  HumanEntry,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  QuestionSet,
  SpendingGate,
} from "@facetdb/core";
import { ActionNotQueued, createWorker, DEFAULT_WORKER_LIMITS, reviewsOf } from "@facetdb/core";
import { FakeReviewQueue, freshHeldModel } from "@facetdb/core/testing";
import { createStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite, TEST_SECRET } from "@facetdb/postgres/testing";
import {
  createOutbox,
  type OutboxDatabase,
  outboxQueue,
  sign,
  verify,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookFetch,
  type WebhookPayload,
} from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActionCall,
  type AlertChannel,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  webhook,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import { verifyWebhook } from "../sdk/index.ts";
import {
  actionSteps,
  BUILTIN_PLUGINS,
  bindChannels,
  checkActions,
  checkChannels,
  createPluginHost,
  deliveryFailedWords,
  PluginHostError,
  WEBHOOK_ENDPOINT_GONE,
  WEBHOOK_PLUGIN,
  type WebhookAlertPayload,
  webhookRefusal,
  webhookSecret,
  withOutbox,
} from "./index.ts";

/**
 * The built-in webhook: registered in the plugin host under `@facetdb/webhook` with nothing
 * installed, its action `send` queues each decision as an endpoint row in the outbox (never an
 * action row, never superseded, one row per decision however often it is queued), its channel
 * `webhook:<name>` queues each alert the same way, and the outbox signs every attempt with the
 * secret read from the variable the config names. Wired here as `facetdb worker` wires it (its own
 * test, builtin-webhook-worker.test.ts, runs the command): the store on PGlite, core's worker over
 * an API source, the server's outbox, a fake endpoint.
 */

const PROJECT = "project-1";
const SOURCE = "tickets";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
const HOOK = "https://hooks.example.com/facetdb";
const SECOND_HOOK = "https://audit.example.com/facetdb";
const OPS = "https://ops.example.com/alerts";
const SECRET = "whsec_9f8e7d6c5b4a3210-SIGNINGVALUE";
const ENV = { FACETDB_WEBHOOK_SECRET: SECRET };
const START = 1_700_000_000_000;

/** Why an address is written in the file, as the refusals of `url` and `endpoints` say it. */
const ADDRESS_WORDS =
  "a webhook's address is written in the file as text: it is where deliveries are sent, not a secret (the signing secret is plugins.webhook.secret), and the outbox row stores it as written";

/** The secret, each 8 characters of it, and its JSON-escaped form: none may be written anywhere. */
const FORBIDDEN = [
  SECRET,
  JSON.stringify(SECRET).slice(1, -1),
  ...Array.from({ length: SECRET.length - 7 }, (_, at) => SECRET.slice(at, at + 8)),
];

function printsNoSecret(...texts: readonly string[]): void {
  for (const text of texts) {
    for (const piece of FORBIDDEN) {
      expect(text).not.toContain(piece);
    }
  }
}

const PLUGINS: NonNullable<ProjectConfig["plugins"]> = {
  webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { ops: OPS } },
};

function project(
  options: {
    readonly actions?: readonly ActionCall[];
    readonly plugins?: NonNullable<ProjectConfig["plugins"]>;
    readonly channels?: readonly AlertChannel[];
  } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: options.plugins ?? PLUGINS,
    ...(options.channels === undefined ? {} : { alerts: { channels: options.channels } }),
    sources: [
      {
        name: SOURCE,
        api: true,
        read: ["subject", "body"],
        questions: {
          urgent: noul("Is this ticket urgent?"),
          wants_refund: noul("Is the customer asking for their money back?", { stakes: "high" }),
        },
        actions: options.actions ?? [webhook({ url: HOOK })],
      },
    ],
  });
}

/** The modules the host imports: none is installed, so the built-in must come from facetdb itself. */
const imported: string[] = [];

function hostFor(config: ProjectConfig, environment: Readonly<Record<string, string>> = ENV) {
  return createPluginHost({
    config,
    env: environment,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: (specifier) => {
      imported.push(specifier);
      return Promise.reject(
        Object.assign(new Error(`Cannot find package '${specifier}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      );
    },
    builtins: BUILTIN_PLUGINS,
  });
}

/** The refusal a config meets at load, as `facetdb worker`, studio, dev and doctor meet it. */
async function refusal(
  config: ProjectConfig,
  environment: Readonly<Record<string, string>> = ENV,
): Promise<PluginHostError> {
  try {
    const host = await hostFor(config, environment);
    checkActions(config, host, environment);
    checkChannels(config, host, environment);
  } catch (error) {
    if (error instanceof PluginHostError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the config to be refused at load");
}

/** The fake clock the channel host's bound waits on: a sleep ends when time reaches it or its signal aborts. */
class TestClock implements Clock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];
  constructor(start: number) {
    this.#time = start;
  }
  now(): number {
    return this.#time;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((wake) => {
      if (signal?.aborted === true) {
        wake();
        return;
      }
      const sleeper = { due: this.#time + ms, wake };
      this.#sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
          wake();
        },
        { once: true },
      );
    });
  }
  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

type Call = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly at: number;
};

/** The model: each question's probability as the test sets it. */
class ScriptedProvider implements ModelProvider {
  calls = 0;
  urgent = 0.95;
  refund = 0.02;
  ask(_request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: {
        urgent: { type: "noul", probability: this.urgent },
        wants_refund: { type: "noul", probability: this.refund },
      },
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  }
}

const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

let pglite: PGlite;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  imported.length = 0;
  for (const close of closers.splice(0)) {
    await close();
  }
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

/**
 * Everything one worker wires, as `facetdb worker` does: the host at load (actions and channels
 * checked), the steps queueing through the outbox's queue, the outbox claiming this project's rows
 * and signing with the host's secret, the channels bound with the outbox. `refuse` makes the store
 * refuse an outbox insert whose parameters hold it, `times` times, as a dropped connection would.
 */
async function rig(config = project(), refuse?: { readonly holding: string; times: number }) {
  const clock = new TestClock(START);
  const store = await createStore({ pglite, secret: TEST_SECRET, clock });
  closers.push(() => store.close());
  const real = pgliteClient(pglite);
  const client: OutboxDatabase = {
    query: (text, params) => {
      if (
        refuse !== undefined &&
        refuse.times > 0 &&
        text.includes("insert into facetdb.webhook_outbox") &&
        (params ?? []).includes(refuse.holding)
      ) {
        refuse.times -= 1;
        return Promise.reject(new Error("Connection terminated unexpectedly"));
      }
      return real.query(text, params);
    },
  };
  await store.ensureProject({ id: PROJECT, name: "one" });
  await store.ensureSource({ projectId: PROJECT, name: SOURCE, kind: "api" });

  const host = await hostFor(config);
  checkActions(config, host, ENV);
  checkChannels(config, host, ENV);
  const webhooks = { projectId: PROJECT, outbox: outboxQueue(client, clock) };
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const questionSet: QuestionSet = {
    questions: source.questions,
    read: source.read,
    model: config.model,
    thresholds: source.thresholds,
  };
  const provider = new ScriptedProvider();
  const connector = store.connector({ sourceId: SOURCE_ID, fields: source.read, workerId: "loop" });
  /** The source's worker under other thresholds: an operator's change, no new version. */
  const workerWith = (thresholds: QuestionSet["thresholds"]) =>
    createWorker({
      connector,
      provider,
      log: store.log(SOURCE_ID),
      reviews: reviewsOf(new FakeReviewQueue(), SOURCE_ID),
      actions: actionSteps(
        source,
        () => Promise.reject(new Error("these configs queue no plugin action")),
        { ...webhooks, sourceId: SOURCE_ID },
      ),
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: { ...questionSet, thresholds },
      version: 1,
      heldModel: freshHeldModel(),
      spending: UNLIMITED,
    });
  const worker = workerWith(questionSet.thresholds);
  /** The config the outbox's loop runs under now: a test changes it as a reload would. */
  const inForce = { config };

  const calls: Call[] = [];
  const respond = { status: 204 };
  const fetch: WebhookFetch = (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: init.body, at: clock.now() });
    return Promise.resolve({ status: respond.status });
  };
  const outbox = createOutbox({
    client,
    clock,
    fetch,
    abortAfter: () => new AbortController().signal,
    // As the worker answers it: its own project's rows, with the secret the host read.
    secretFor: (projectId) => {
      const secret = projectId === PROJECT ? webhookSecret(host) : undefined;
      return secret === undefined
        ? Promise.reject(new Error("no signing secret for that webhook"))
        : Promise.resolve(secret);
    },
    onGiveUp: () => Promise.resolve(),
    runAction: () => Promise.reject(new Error("these configs queue no plugin action")),
    actionProject: PROJECT,
    // As the worker answers it: only an endpoint the config in force still names.
    refuseWebhook: (row) => webhookRefusal(inForce.config, host, row),
  });
  const stop = new AbortController();
  const channels = bindChannels({
    config,
    host: withOutbox(host, webhooks),
    env: ENV,
    clock,
    stop: () => stop.signal,
  });

  async function rows() {
    return real.query(
      `select id::text as id, project_id, endpoint, payload, plugin, action, source_id, record_key,
              position, attempts, delivered_at::text as delivered_at, gave_up_at::text as gave_up_at,
              last_error
         from facetdb.webhook_outbox order by id`,
    );
  }

  return {
    clock,
    store,
    connector,
    worker,
    workerWith,
    inForce,
    provider,
    host,
    outbox,
    channels,
    calls,
    respond,
    rows,
  };
}

/** A threshold under which the refund answer the provider gives (0.02) is left to a person. */
const CAUTIOUS = { wants_refund: { yesAbove: 0.99, noBelow: 0.01 } };

const CHARGED = { subject: "Charged twice", body: "I was charged twice, please fix this today" };

function payloadOf(call: Call | undefined): WebhookPayload {
  return JSON.parse(call?.body ?? "null") as WebhookPayload;
}

describe("the built-in webhook (builtin-webhook)", () => {
  it("is the plugin @facetdb/webhook of the host, with nothing installed and nothing imported", async () => {
    const host = await hostFor(project({ channels: ["webhook:ops"] }));

    expect(host.plugin("webhook")?.packageName).toBe(WEBHOOK_PLUGIN);
    expect(host.plugin(WEBHOOK_PLUGIN)?.plugin.manifest).toMatchObject({
      name: WEBHOOK_PLUGIN,
      version: VERSION,
      kinds: ["action", "channel"],
      secrets: ["secret"],
    });
    // Its settings as the file wrote them, the secret a variable's name.
    expect(host.plugin("webhook")?.variables).toEqual([
      { path: "secret", variable: "FACETDB_WEBHOOK_SECRET", secret: true },
    ]);
    expect(imported).toEqual([]);
  });

  it("a decision on an API source reaches the endpoint as a signed POST that verify accepts", async () => {
    const t = await rig();
    await t.connector.upsertRecord("T-1042", CHARGED);

    expect((await t.worker.runOnce()).written).toEqual(["T-1042"]);
    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ retrying: [], gaveUp: [] });

    expect(t.calls).toHaveLength(1);
    const [call] = t.calls;
    expect(call?.url).toBe(HOOK);
    const [row] = await t.rows();
    // The headers the outbox has always sent, and nothing else: the type, the signature, the id.
    expect(call?.headers).toEqual({
      "content-type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: sign(SECRET, Math.floor(START / 1000), call?.body ?? ""),
      "facetdb-delivery": row?.["id"],
    });
    expect(
      verify(SECRET, call?.headers[WEBHOOK_SIGNATURE_HEADER], call?.body ?? "", START),
    ).toEqual({ ok: true });
    expect(verifyWebhook(SECRET, call?.headers ?? {}, call?.body ?? "", { now: START })).toEqual({
      ok: true,
      timestamp: Math.floor(START / 1000),
    });
    // Another secret does not verify it.
    expect(
      verify("whsec_another", call?.headers[WEBHOOK_SIGNATURE_HEADER], call?.body ?? "", START),
    ).toEqual({ ok: false, reason: "mismatch" });
    // Today's `record.decided` payload, byte for byte the stored row's, its fields in their order.
    expect(call?.body).toBe(row?.["payload"]);
    expect(call?.body).toBe(
      JSON.stringify({
        event: "record.decided",
        delivery: String(row?.["id"]),
        source: SOURCE,
        id: "T-1042",
        status: "done",
        decidedAt: new Date(START).toISOString(),
        answers: {
          urgent: { value: true, probability: 0.95 },
          wants_refund: { value: false, probability: 0.02 },
        },
      } satisfies WebhookPayload),
    );
    // An endpoint row the built-in queued: it names the decision's record and the action's place.
    expect(row).toMatchObject({
      project_id: PROJECT,
      endpoint: HOOK,
      plugin: WEBHOOK_PLUGIN,
      action: "send",
      source_id: SOURCE_ID,
      record_key: "T-1042",
      position: 0,
      attempts: 1,
      gave_up_at: null,
      last_error: null,
    });
    expect(row?.["delivered_at"]).toBe(String(START));
  });

  it("a person's decision sends a second delivery, with the later decidedAt the receiver orders by", async () => {
    const t = await rig();
    t.provider.refund = 0.5; // between the high-stakes cut-offs: left to a person
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.outbox.deliverDue(t.clock.now());
    expect(payloadOf(t.calls[0])).toMatchObject({ status: "needs_review" });

    const stored = await t.connector.getRecord("T-1042");
    if (stored?.decision == null) {
      throw new Error("the record has no decision");
    }
    t.clock.advance(1_000);
    const decided: HumanEntry = {
      kind: "human",
      key: "T-1042",
      question: "wants_refund",
      value: true,
      reviewer: "maya",
      stateHash: stored.hash,
      version: 1,
      at: new Date(t.clock.now()),
    };
    await t.store.log(SOURCE_ID).appendHuman(decided);
    t.clock.advance(5_000);
    const outcome = await t.worker.onHumanDecision({
      key: "T-1042",
      stateHash: stored.hash,
      status: "done",
      decisions: {
        ...stored.decision.decisions,
        wants_refund: { kind: "decided", value: true, probabilityOrConfidence: 1 },
      },
      decidedAt: decided.at,
    });
    expect(outcome).toEqual({ ran: true, failures: [] });
    await t.outbox.deliverDue(t.clock.now());

    expect(t.calls).toHaveLength(2);
    const [automatic, human] = t.calls;
    expect(human?.headers["facetdb-delivery"]).not.toBe(automatic?.headers["facetdb-delivery"]);
    expect(
      verify(SECRET, human?.headers[WEBHOOK_SIGNATURE_HEADER], human?.body ?? "", t.clock.now()),
    ).toEqual({ ok: true });
    expect(payloadOf(human)).toMatchObject({
      status: "done",
      decidedAt: decided.at.toISOString(),
      answers: { urgent: { value: true }, wants_refund: { value: true, probability: 1 } },
    });
    expect(payloadOf(human).decidedAt > payloadOf(automatic).decidedAt).toBe(true);
  });

  it("two decisions on one record are two deliveries, each signed with its own decidedAt", async () => {
    const t = await rig();
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    // The record changes before the first delivery went out: both decisions are queued, and both
    // go out in the same pass, in no promised order; the signed decidedAt orders them.
    t.clock.advance(60_000);
    t.provider.urgent = 0.05;
    await t.connector.upsertRecord("T-1042", { ...CHARGED, body: "Sorted, thank you" });
    expect((await t.worker.runOnce()).written).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());

    expect(t.calls).toHaveLength(2);
    const ordered = t.calls
      .map(payloadOf)
      .toSorted((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    expect(ordered.map((body) => [body.decidedAt, body.answers["urgent"]])).toEqual([
      [new Date(START).toISOString(), { value: true, probability: 0.95 }],
      [new Date(START + 60_000).toISOString(), { value: false, probability: 0.05 }],
    ]);
    expect(new Set(ordered.map((body) => body.delivery)).size).toBe(2);
    for (const call of t.calls) {
      expect(
        verify(SECRET, call.headers[WEBHOOK_SIGNATURE_HEADER], call.body, t.clock.now()),
      ).toEqual({ ok: true });
    }
  });

  it("the same decision queued again is the one delivery it has: a lost ack, a row waiting or sent", async () => {
    const t = await rig();
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    // Handed out again before its delivery went out, then again after: written again from the
    // log with no model call, the actions run again, and the decision is the one already queued.
    t.clock.advance(10 * 60_000);
    await t.connector.enqueue(["T-1042"]);
    expect((await t.worker.runOnce()).alreadyAnswered).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());
    t.clock.advance(10 * 60_000);
    await t.connector.enqueue(["T-1042"]);
    expect((await t.worker.runOnce()).alreadyAnswered).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());

    expect(t.provider.calls).toBe(1);
    expect(t.calls).toHaveLength(1);
    expect(await t.rows()).toHaveLength(1);
  });

  it("a job released because another step's row was refused queues its webhook once, and the refused one on the next pass", async () => {
    const refuse = { holding: SECOND_HOOK, times: 1 };
    const t = await rig(
      project({ actions: [webhook({ url: HOOK }), webhook({ url: SECOND_HOOK })] }),
      refuse,
    );
    await t.connector.upsertRecord("T-1042", CHARGED);

    const first = await t.worker.runOnce();
    expect(first.failures.map((failure) => [failure.stage, failure.action])).toEqual([
      ["action", "webhook.send"],
    ]);
    expect(String(first.failures[0]?.error)).toContain(
      "the webhook was not queued, as the store did not take it (Connection terminated unexpectedly)",
    );
    // Released, not acked: the next pass writes the logged decision again and runs both steps.
    expect((await t.worker.runOnce()).alreadyAnswered).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());

    expect(t.provider.calls).toBe(1);
    expect(t.calls.map((call) => call.url).toSorted()).toEqual([SECOND_HOOK, HOOK].toSorted());
    expect(new Set(t.calls.map((call) => payloadOf(call).decidedAt)).size).toBe(1);
    expect((await t.rows()).map((row) => [row["endpoint"], row["position"]])).toEqual([
      [HOOK, 0],
      [SECOND_HOOK, 1],
    ]);
  });

  it("a delivery given up on does not hold back the same decision queued again", async () => {
    const t = await rig();
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    const [given] = await t.rows();
    await pgliteClient(pglite).query(
      "update facetdb.webhook_outbox set gave_up_at = $2::bigint where id = $1::bigint",
      [given?.["id"], START],
    );
    await t.connector.enqueue(["T-1042"]);
    await t.worker.runOnce();

    expect((await t.rows()).map((row) => row["gave_up_at"] === null)).toEqual([false, true]);
  });

  it("a threshold moved and moved back re-decides one answer three times: three deliveries, the last the record's", async () => {
    const t = await rig();
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.outbox.deliverDue(t.clock.now());
    // The operator raises the refund threshold (no new version); the app saves the record
    // unchanged, the worker re-decides it from the same answer, and it now waits for a person.
    t.clock.advance(60_000);
    await t.connector.enqueue(["T-1042"]);
    expect((await t.workerWith(CAUTIOUS).runOnce()).alreadyAnswered).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());
    // The threshold goes back and the record is saved again: done, the first payload once more,
    // which is no longer the record's latest delivery, so it is queued.
    t.clock.advance(60_000);
    await t.connector.enqueue(["T-1042"]);
    expect((await t.worker.runOnce()).alreadyAnswered).toEqual(["T-1042"]);
    await t.outbox.deliverDue(t.clock.now());

    expect(t.provider.calls).toBe(1);
    const bodies = t.calls.map(payloadOf);
    expect(bodies.map((body) => body.status)).toEqual(["done", "needs_review", "done"]);
    const { delivery: _first, ...first } = bodies[0] ?? ({} as WebhookPayload);
    const { delivery: _third, ...third } = bodies[2] ?? ({} as WebhookPayload);
    expect(third).toEqual(first);
    // One answer behind all three, so one decidedAt: the delivery ids, queued in order, order them.
    expect(new Set(bodies.map((body) => body.decidedAt)).size).toBe(1);
    const ids = bodies.map((body) => BigInt(body.delivery));
    expect(ids[0] !== undefined && ids[1] !== undefined && ids[0] < ids[1]).toBe(true);
    expect(ids[1] !== undefined && ids[2] !== undefined && ids[1] < ids[2]).toBe(true);
    // The receiver's rule, latest decidedAt then the larger delivery, keeps the record's decision.
    const kept = bodies.reduce((held, body) =>
      body.decidedAt > held.decidedAt ||
      (body.decidedAt === held.decidedAt && BigInt(body.delivery) > BigInt(held.delivery))
        ? body
        : held,
    );
    expect(kept).toBe(bodies[2]);
    const stored = await t.connector.getRecord("T-1042");
    expect(stored?.status).toBe(kept.status);
  });

  it("a flip that sends the middle decision elsewhere (else) still ends the first endpoint on the record's decision", async () => {
    const t = await rig(
      project({
        actions: [webhook({ url: HOOK, when: { status: "done" }, else: { url: SECOND_HOOK } })],
      }),
    );
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.connector.enqueue(["T-1042"]);
    await t.workerWith(CAUTIOUS).runOnce();
    await t.connector.enqueue(["T-1042"]);
    await t.worker.runOnce();
    await t.outbox.deliverDue(t.clock.now());

    expect(
      (await t.rows()).map((row) => [
        row["endpoint"],
        (JSON.parse(String(row["payload"])) as WebhookPayload).status,
      ]),
    ).toEqual([
      [HOOK, "done"],
      [SECOND_HOOK, "needs_review"],
      [HOOK, "done"],
    ]);
  });

  it("A, then B, then A again at three times are three deliveries", async () => {
    const t = await rig();
    for (const body of [CHARGED.body, "Sorted, thank you", CHARGED.body]) {
      await t.connector.upsertRecord("T-1042", { ...CHARGED, body });
      expect((await t.worker.runOnce()).written).toEqual(["T-1042"]);
      t.clock.advance(60_000);
    }
    await t.outbox.deliverDue(t.clock.now());

    expect(t.provider.calls).toBe(3);
    expect(t.calls.map((call) => payloadOf(call).decidedAt)).toEqual(
      [0, 60_000, 120_000].map((at) => new Date(START + at).toISOString()),
    );
  });

  it("a step whose url the load-time rule refuses queues nothing: what facetdb review runs, with no plugin loaded", async () => {
    const enqueued: unknown[] = [];
    const record = {
      key: "T-1",
      state: {},
      status: "done" as const,
      stateHash: "h1",
      decidedAt: new Date(START),
    };
    const call = webhook({ url: HOOK });
    const cases: readonly (readonly [ActionCall, string])[] = [
      [
        webhook({ url: "http://hooks.example.com/facetdb" }),
        'an endpoint is sent signed decisions and alerts over HTTPS: write it as "https://hooks.example.com/facetdb"; http:// is for a receiver on this machine only (localhost, 127.0.0.1 or [::1])',
      ],
      [
        webhook({ url: "https://maya:pa55word@hooks.example.com/facetdb" }),
        'an endpoint never carries a username or password, which this file and its JSON export never hold: remove the "user:password@" part; the receiver checks the facetdb-signature header instead',
      ],
      [
        { ...call, config: { ...call.config, url: env("HOOK_URL") } },
        "url is not written as an address in the config file",
      ],
    ];
    for (const [action, words] of cases) {
      const [source] = project({ actions: [action] }).sources;
      if (source === undefined) {
        throw new Error("the test config has a source");
      }
      const [step] = actionSteps(source, () => Promise.reject(new Error("no plugin action")), {
        projectId: PROJECT,
        sourceId: SOURCE_ID,
        outbox: {
          enqueue: (entry) => {
            enqueued.push(entry);
            return Promise.resolve("1");
          },
        },
      });
      const run = step?.run(record, {});
      await expect(run).rejects.toThrow(
        `the webhook was not queued, as its url is refused: ${words}`,
      );
      // Not a row the store refused: retrying would never take it, so the job is not held back.
      await expect(run).rejects.not.toBeInstanceOf(ActionNotQueued);
    }
    expect(enqueued).toEqual([]);
  });

  it("a queued delivery whose endpoint the config in force no longer names is closed unsent, in fixed words", async () => {
    const t = await rig(project({ channels: ["webhook:ops"] }));
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.channels[0]?.deliver({ kind: "system-alert", severity: "critical", text: "Down." });
    // A reload moved the action to another address before the outbox's loop came to the row.
    t.inForce.config = project({
      actions: [webhook({ url: SECOND_HOOK })],
      channels: ["webhook:ops"],
    });
    const [decision, alert] = await t.rows();

    const report = await t.outbox.deliverDue(t.clock.now());

    expect(report).toMatchObject({ closed: [decision?.["id"]], delivered: [alert?.["id"]] });
    expect(t.calls.map((call) => call.url)).toEqual([OPS]);
    expect((await t.rows())[0]).toMatchObject({
      endpoint: HOOK,
      attempts: 1,
      delivered_at: null,
      gave_up_at: String(START),
      last_error: WEBHOOK_ENDPOINT_GONE,
    });
    expect(WEBHOOK_ENDPOINT_GONE).not.toContain(HOOK);
    // A webhook another plugin queued is not this worker's to send either.
    expect(
      webhookRefusal(t.inForce.config, t.host, { plugin: "facetdb-plugin-other", endpoint: OPS }),
    ).toBe(
      "the webhook was queued by a plugin other than the built-in webhook, so this worker does not send it",
    );
  });

  it("an alert through webhook:ops arrives signed, as an alert event with its link", async () => {
    const t = await rig(project({ channels: ["webhook:ops"] }));
    const [ops] = t.channels;
    const message: ChannelMessage = {
      kind: "system-alert",
      severity: "critical",
      text: "The model has not answered for 10 minutes in project one.",
      link: "http://127.0.0.1:4040/",
    };

    await ops?.deliver(message);
    await ops?.deliver({ kind: "system-alert", severity: "warning", text: "No link here." });
    await t.outbox.deliverDue(t.clock.now());

    expect(ops?.name).toBe("webhook:ops");
    expect(t.calls.map((call) => call.url)).toEqual([OPS, OPS]);
    const rows = await t.rows();
    for (const [index, call] of t.calls.entries()) {
      expect(
        verify(SECRET, call.headers[WEBHOOK_SIGNATURE_HEADER], call.body, t.clock.now()),
      ).toEqual({ ok: true });
      expect(call.headers["facetdb-delivery"]).toBe(rows[index]?.["id"]);
    }
    expect(t.calls.map((call) => JSON.parse(call.body) as WebhookAlertPayload)).toEqual([
      {
        event: "alert",
        delivery: String(rows[0]?.["id"]),
        severity: "critical",
        text: message.text,
        link: message.link ?? null,
      },
      {
        event: "alert",
        delivery: String(rows[1]?.["id"]),
        severity: "warning",
        text: "No link here.",
        link: null,
      },
    ] satisfies WebhookAlertPayload[]);
    // A webhook the built-in queued: its project's, and no record's.
    expect(rows[0]).toMatchObject({
      endpoint: OPS,
      plugin: WEBHOOK_PLUGIN,
      action: "webhook",
      source_id: null,
      record_key: null,
    });
  });

  it("a channel bound with no outbox delivers nothing, in the channel host's fixed words", async () => {
    const config = project({ channels: ["webhook:ops"] });
    const host = await hostFor(config);
    const [ops] = bindChannels({
      config,
      host,
      env: ENV,
      clock: new TestClock(START),
      stop: () => new AbortController().signal,
    });

    await expect(
      ops?.deliver({ kind: "system-alert", severity: "critical", text: "x" }),
    ).rejects.toThrow(deliveryFailedWords(WEBHOOK_PLUGIN));
  });

  it("a step built with no outbox queues nothing and says so, as a row not queued", async () => {
    const [source] = project().sources;
    if (source === undefined) {
      throw new Error("the test config has a source");
    }
    const [step] = actionSteps(source, () => Promise.reject(new Error("no plugin action")));
    const run = step?.run(
      { key: "T-1", state: {}, status: "done", stateHash: "h1", decidedAt: new Date(START) },
      {},
    );
    await expect(run).rejects.toBeInstanceOf(ActionNotQueued);
    await expect(run).rejects.toThrow(
      "the webhook was not queued: this process was given no outbox to queue it in",
    );
  });

  it("a row of another project is left to that project's worker, never signed with this one's secret", async () => {
    const t = await rig();
    const other = outboxQueue(pgliteClient(pglite), t.clock);
    await other.enqueue({
      projectId: "project-2",
      endpoint: HOOK,
      origin: { plugin: WEBHOOK_PLUGIN, entry: "webhook" },
      payload: { event: "alert" },
    });

    expect(await t.outbox.deliverDue(t.clock.now())).toMatchObject({ delivered: [], retrying: [] });
    expect(t.calls).toEqual([]);
    expect(await t.rows()).toMatchObject([{ project_id: "project-2", attempts: 0 }]);
  });

  it("a failed delivery is retried on the outbox's schedule, signed afresh with the same bytes", async () => {
    const t = await rig();
    t.respond.status = 302; // a redirect is not followed: a failed attempt
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.outbox.deliverDue(t.clock.now());
    t.respond.status = 204;
    t.clock.advance(10_000);
    await t.outbox.deliverDue(t.clock.now());

    const [first, second] = t.calls;
    expect(second?.body).toBe(first?.body);
    expect(second?.headers["facetdb-delivery"]).toBe(first?.headers["facetdb-delivery"]);
    expect(second?.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      sign(SECRET, Math.floor((START + 10_000) / 1000), second?.body ?? ""),
    );
    expect(await t.rows()).toMatchObject([{ attempts: 2, last_error: null }]);
  });

  describe("refusals at load", () => {
    it("an unset secret, naming the variable", async () => {
      const error = await refusal(project(), {});
      expect(error.code).toBe("plugin-variable-unset");
      expect(error.message).toBe(
        'the plugin "@facetdb/webhook" cannot start: FACETDB_WEBHOOK_SECRET is not set (plugins.webhook.secret reads it)',
      );
      expect(error.fix).toBe(
        "set FACETDB_WEBHOOK_SECRET where the worker runs, then start it again",
      );
    });

    it("a webhook with no secret written, naming the variable to write", async () => {
      for (const config of [
        project({ plugins: {} }),
        project({ plugins: { webhook: { endpoints: { ops: OPS } } } }),
      ]) {
        const error = await refusal(config);
        expect(error.code).toBe("plugin-settings");
        expect(error.message).toBe(
          [
            'the settings of the plugin "@facetdb/webhook" are refused by its schema:',
            `  - plugins.webhook.secret: the webhook's signing secret is read from an environment variable: write secret: env("FACETDB_WEBHOOK_SECRET") under plugins.webhook and set FACETDB_WEBHOOK_SECRET where the worker runs (your receiver verifies each delivery with the same value)`,
          ].join("\n"),
        );
      }
    });

    it("a channel's endpoint name the settings do not have", async () => {
      const error = await refusal(project({ channels: ["webhook:ops", "webhook:pager"] }));
      expect(error.code).toBe("channel-where");
      expect(error.message).toBe(
        'alerts.channels[1] (webhook:pager) cannot be delivered to: plugins.webhook.endpoints has no endpoint named pager: add pager: "https://…" to it, or name one of ops',
      );
      const none = await refusal(
        project({
          plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET") } },
          channels: ["webhook:ops"],
        }),
      );
      expect(none.message).toBe(
        'alerts.channels[0] (webhook:ops) cannot be delivered to: plugins.webhook.endpoints has no endpoint named ops: add ops: "https://…" to it',
      );
    });

    it("an endpoint over plain HTTP to another machine, with a login or a fragment, saying what to write", async () => {
      const https =
        'an endpoint is sent signed decisions and alerts over HTTPS: write it as "https://hooks.example.com/facetdb"; http:// is for a receiver on this machine only (localhost, 127.0.0.1 or [::1])';
      const login =
        'an endpoint never carries a username or password, which this file and its JSON export never hold: remove the "user:password@" part; the receiver checks the facetdb-signature header instead';
      const fragment =
        'an endpoint has no "#" part, which is never sent to the receiver: remove everything from the "#" on';
      const cases: readonly (readonly [string, string])[] = [
        ["http://hooks.example.com/facetdb", https],
        ["ftp://hooks.example.com/facetdb", https],
        ["https://maya:pa55word@hooks.example.com/facetdb", login],
        ["https://hooks.example.com/facetdb#top", fragment],
        [
          "https://hooks.example.com/face db",
          'an endpoint is a full address written as plain text, such as "https://hooks.example.com/facetdb": remove any space, backslash, control or invisible character',
        ],
      ];
      for (const [url, words] of cases) {
        const action = await refusal(project({ actions: [webhook({ url })] }));
        expect(action.code).toBe("action-settings");
        expect(action.message).toContain(`  - sources[0].actions[0].url: ${words}`);
        expect(action.message).not.toContain(url);

        const channel = await refusal(
          project({
            plugins: {
              webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { ops: url } },
            },
          }),
        );
        expect(channel.message).toContain(`  - plugins.webhook.endpoints.ops: ${words}`);
        expect(channel.message).not.toContain(url);
      }
      // A receiver on this machine may be reached over plain HTTP.
      for (const url of [
        "http://localhost:8080/hook",
        "http://127.0.0.1/hook",
        "http://[::1]/hook",
      ]) {
        const host = await hostFor(project({ actions: [webhook({ url })] }));
        expect(() =>
          checkActions(project({ actions: [webhook({ url })] }), host, ENV),
        ).not.toThrow();
      }
    });

    it("an endpoint name that is not a short name", async () => {
      const error = await refusal(
        project({
          plugins: {
            webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { "Ops Team": OPS } },
          },
        }),
      );
      expect(error.code).toBe("plugin-settings");
      expect(error.message).toBe(
        [
          'the settings of the plugin "@facetdb/webhook" are refused by its schema:',
          '  - plugins.webhook.endpoints.Ops Team: an endpoint is named in lowercase letters, digits, "-" and "_", starting with a letter, such as ops or billing-alerts',
        ].join("\n"),
      );
    });

    it("a url read from a variable, the address being written in the file", async () => {
      const call = webhook({ url: HOOK });
      const fed: ActionCall = { ...call, config: { ...call.config, url: env("HOOK_URL") } };
      const error = await refusal(project({ actions: [fed] }), { ...ENV, HOOK_URL: HOOK });
      expect(error.code).toBe("action-settings");
      expect(error.message).toBe(
        `sources[0].actions[0] (@facetdb/webhook send) reads HOOK_URL from the environment, but ${ADDRESS_WORDS}`,
      );
      expect(error.fix).toBe(
        'write the address in sources[0].actions[0]: webhook({ url: "https://hooks.example.com/facetdb" })',
      );
    });

    it("an endpoint read from a variable, in the same words: the outbox row stores the address", async () => {
      const error = await refusal(
        project({
          plugins: {
            webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { ops: env("OPS_URL") } },
          },
          channels: ["webhook:ops"],
        }),
        { ...ENV, OPS_URL: OPS },
      );
      expect(error.code).toBe("plugin-settings");
      expect(error.message).toBe(
        `plugins.webhook.endpoints.ops reads OPS_URL from the environment, but ${ADDRESS_WORDS}`,
      );
      expect(error.fix).toBe(
        'write the address in plugins.webhook.endpoints.ops: ops: "https://hooks.example.com/facetdb"',
      );
      expect(error.message).not.toContain(OPS);
    });

    it("a secret written into the file, without repeating it", async () => {
      const error = await refusal(project({ plugins: { webhook: { secret: SECRET } } }));
      expect(error.code).toBe("plugin-secret-literal");
      printsNoSecret(error.message, error.fix);
    });
  });

  it("the secret's value is in no refusal, row, payload or word the plugin answers", async () => {
    const t = await rig(project({ channels: ["webhook:ops"] }));
    await t.connector.upsertRecord("T-1042", CHARGED);
    await t.worker.runOnce();
    await t.channels[0]?.deliver({ kind: "system-alert", severity: "critical", text: "Down." });
    t.respond.status = 500;
    await t.outbox.deliverDue(t.clock.now());

    const refusals = await Promise.all([
      refusal(project(), {}),
      refusal(project({ plugins: {} })),
      refusal(project({ channels: ["webhook:pager"] })),
    ]);
    const hosted = t.host.plugin("webhook");
    printsNoSecret(
      JSON.stringify(await t.rows()),
      ...t.calls.map((call) => call.body),
      ...refusals.flatMap((error) => [error.message, error.fix]),
      JSON.stringify(hosted?.settings),
      JSON.stringify(hosted?.variables),
    );
  });
});
