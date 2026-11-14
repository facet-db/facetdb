import type { QuestionSet, RecordDecision, RecordKey, StateValue } from "@facetdb/core";
import {
  createAlerts,
  createSpending,
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type ModelProvider,
  spendingGate,
} from "@facetdb/core";
import { FakeClock, runConnectorContract } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { pgliteClient } from "../polling/index.ts";
import { CLAIM_LEASE_MS } from "../sql/index.ts";
import { createStore } from "./store.ts";
import {
  closeAfterTest,
  newDb,
  newStore,
  SECRET,
  scalar,
  TurningClock,
  useStoreWorld,
} from "./store-world.ts";

/**
 * The store's queue and records (the store connector, its contract suite, and what one answered
 * record costs it) on PGlite. The migrations, the log, credentials, keys, TLS and usage are
 * store.test.ts (split by subject so no file passes 10 s).
 */

useStoreWorld();

const FIELDS = ["title", "body"] as const;

describe("the store connector passes the contract suite", () => {
  runConnectorContract(async () => {
    const { store, clock } = await newStore();
    const make = (workerId: string) =>
      store.connector({ sourceId: "src", fields: FIELDS, workerId, pageSize: 10, pollMs: 2000 });
    const connector = make("worker-1");
    return {
      connector,
      peer: make("worker-2"),
      fields: FIELDS,
      edit: async (key: RecordKey, state: Readonly<Record<string, StateValue>>) => {
        await connector.upsertRecord(key, state);
      },
      decisionOf: async (key: RecordKey) => (await connector.getRecord(key))?.decision ?? null,
      close: async () => {
        void clock;
      },
    };
  });
});

describe("the store connector", () => {
  const state = (value: string): Record<string, StateValue> => ({ title: value, body: value });
  const decision: RecordDecision = {
    decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: 0.1 } },
    status: "done",
  };

  it("queues a record once when its state changes, and not at all when it does not", async () => {
    const { store, db } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    expect(await connector.upsertRecord("r1", state("x"))).toBe(true);
    expect(await connector.upsertRecord("r1", state("x"))).toBe(false);
    expect(await connector.upsertRecord("r1", state("y"))).toBe(true);
    expect(await scalar(db, "select count(*)::int from facetdb.jobs")).toBe(1);
  });

  it("sends a decided record back to pending when its state changes, keeping the old decision", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    await connector.upsertRecord("r1", state("x"));
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    await connector.write("r1", decision, hash);
    expect((await connector.getRecord("r1"))?.status).toBe("done");

    await connector.upsertRecord("r1", state("changed"));
    const record = await connector.getRecord("r1");
    expect(record?.status).toBe("pending");
    expect(record?.decision?.decisions).toEqual(decision.decisions);
  });

  it("keeps a job for a state that changed while a worker held the job for the old one", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const other = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await connector.upsertRecord("r1", state("x"));
    expect(await connector.claim(5)).toEqual(["r1"]);
    const staleHash = (await connector.read(["r1"])).rows[0]?.hash ?? "";

    // The state changes while the worker is asking about "x"; its answer is discarded by the hash guard.
    await connector.upsertRecord("r1", state("y"));
    expect(await connector.write("r1", decision, staleHash)).toEqual({ written: false });
    await connector.ack(["r1"]);

    expect((await connector.getRecord("r1"))?.status).toBe("pending");
    expect(await other.claim(5)).toEqual(["r1"]);
  });

  it("refuses a state that lacks a field", async () => {
    const { store } = await newStore();
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    await expect(connector.upsertRecord("r1", { title: "only" })).rejects.toThrow(/"body"/);
  });

  it("gives a claim back to the queue when its worker never settles it", async () => {
    const { store, clock } = await newStore();
    const one = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const two = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await one.enqueue(["k"]);
    expect(await one.claim(5)).toEqual(["k"]);
    expect(await two.claim(5)).toEqual([]);
    clock.advance(CLAIM_LEASE_MS + 1);
    expect(await two.claim(5)).toEqual(["k"]);
    // The first worker's late ack removes nothing: the job is the second worker's now.
    await one.ack(["k"]);
    expect(await two.claim(5)).toEqual([]);
    await two.ack(["k"]);
  });

  it("claims only the one queued key it is asked for, and leaves the rest queued", async () => {
    const { store, clock } = await newStore();
    const one = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w1" });
    const two = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w2" });
    await one.enqueue(["old1", "old2", "mine"]);
    expect(await one.claimRecord("mine")).toBe(true);
    // Held by w1 now: nobody else takes it, and a key that is not queued is not claimed.
    expect(await two.claimRecord("mine")).toBe(false);
    expect(await two.claimRecord("absent")).toBe(false);
    expect([...(await two.claim(10))].sort()).toEqual(["old1", "old2"]);
    clock.advance(CLAIM_LEASE_MS + 1);
    expect(await two.claimRecord("mine")).toBe(true);
  });

  it("keeps sources' queues apart", async () => {
    const { store } = await newStore();
    const a = store.connector({ sourceId: "a", fields: FIELDS, workerId: "w" });
    const b = store.connector({ sourceId: "b", fields: FIELDS, workerId: "w" });
    await a.enqueue(["same"]);
    await b.enqueue(["same"]);
    expect(await a.claim(10)).toEqual(["same"]);
    expect(await b.claim(10)).toEqual(["same"]);
  });

  it("keeps apart sources whose ids start alike, and returns the keys as given", async () => {
    const { store } = await newStore();
    const short = store.connector({ sourceId: "a", fields: FIELDS, workerId: "w" });
    const long = store.connector({ sourceId: "a:1:b", fields: FIELDS, workerId: "w" });
    await short.enqueue(["1:b:k", "k"]);
    await long.enqueue(["k"]);
    expect([...(await short.claim(10))].sort()).toEqual(["1:b:k", "k"]);
    expect(await long.claim(10)).toEqual(["k"]);
  });

  it("queues with the trigger's statement: record_key alone is the primary key", async () => {
    const { db } = await newStore();
    // The statement the trigger runs, word for word.
    const enqueue =
      "insert into facetdb.jobs (record_key) values ('r1') on conflict (record_key) do nothing";
    await db.exec(enqueue);
    await db.exec(enqueue);
    expect(await scalar(db, "select count(*)::int from facetdb.jobs")).toBe(1);
    const key = await db.query<{ attname: string }>(
      `select a.attname from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'facetdb.jobs'::regclass and i.indisprimary`,
    );
    expect(key.rows.map((row) => row.attname)).toEqual(["record_key"]);
  });
});

/**
 * What one answered record costs the store, counted by a recording client over PGlite with the
 * worker, the spending gate and the alerts wired as `facetdb worker` wires them. Each statement is
 * a round trip, and on Supabase one cost 139 ms. Every statement is named by what it does, so a new
 * one fails the test with its text instead of passing unseen.
 */
describe("store statements per answered record", () => {
  const STATEMENTS: readonly (readonly [string, RegExp])[] = [
    [
      "usage total",
      /^select coalesce\(sum\(input_tokens\), 0\)::text as total from facetdb\.usage/,
    ],
    ["claim", /^update "facetdb"\."jobs"\s+set claimed_at/],
    ["heartbeat", /^insert into facetdb\.heartbeats/],
    ["alert state", /^select state::text as state from facetdb\.alerts/],
    ["read", /^select record_key, state::text as state, hash from facetdb\.records/],
    ["latest answers", /^select distinct on \(record_key\)/],
    [
      "reserve",
      /^select reservation_id, month_total::text as month_total\s+from facetdb\.reserve_usage\(/,
    ],
    ["finish", /^with counted as \(\s+insert into facetdb\.usage/],
    ["log answer", /^insert into facetdb\.decisions/],
    ["write", /^update facetdb\.records/],
    ["ack", /^delete from "facetdb"\."jobs"\s+where record_key in \(/],
  ];

  function nameOf(text: string): string {
    const trimmed = text.trim();
    return STATEMENTS.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? trimmed;
  }

  const questionSet: QuestionSet = {
    questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
    read: [...FIELDS],
    model: "jev-1.14.0",
    thresholds: {},
  };

  /** Answers every question, as the scripted fake provider does; the model is not what is counted. */
  const provider: ModelProvider = {
    ask: (request) =>
      Promise.resolve({
        model: request.model,
        answers: Object.fromEntries(
          request.questions.map((question) => [
            question.name,
            { type: "noul", probability: 0.1 } as const,
          ]),
        ),
        usage: { inputTokens: 100, outputTokens: 4 },
      }),
  };

  async function worldOf() {
    const db = await newDb();
    const inner = pgliteClient(db);
    const sent: string[] = [];
    const store = await createStore({
      url: "postgres://localhost/facetdb",
      pgHost: undefined,
      secret: SECRET,
      clock: new TurningClock(1_700_000_000_000),
      connect: () => ({
        ...inner,
        query: (text, params) => {
          sent.push(text);
          return inner.query(text, params);
        },
        transaction: (work) =>
          inner.transaction((query) =>
            work((text, params) => {
              sent.push(text);
              return query(text, params);
            }),
          ),
        pipeline: (text, paramSets) => {
          sent.push(...paramSets.map(() => text));
          return inner.pipeline(text, paramSets);
        },
      }),
    });
    closeAfterTest(store);
    const clock = new FakeClock(1_700_000_000_000);
    const alerts = createAlerts({ store: store.alerts, clock, channels: [] });
    const spending = createSpending({
      usageStore: store.usage,
      clock,
      alerts,
      capLink: () => "https://app.facetdb.test/settings#spending",
    });
    const connector = store.connector({ sourceId: "src", fields: FIELDS, workerId: "w" });
    const worker = createWorker({
      connector,
      provider,
      log: store.log("src"),
      reviews: { withdraw: () => Promise.resolve() },
      actions: [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet,
      version: 1,
      alerts: alerts.signals({ project: "p", source: "src", link: "https://docs.facetdb.dev" }),
      // A cap far away, so the status stays "ok" and the count of a normal pass is what is measured.
      spending: spendingGate(spending, "p", () =>
        Promise.resolve({ inputTokens: 1_000_000_000, onCapReached: "pause" }),
      ),
    });
    const queue = async (keys: readonly string[]) => {
      for (const key of keys) {
        await connector.upsertRecord(key, { title: `listing ${key}`, body: "body" });
      }
      sent.length = 0;
    };
    return { worker, queue, sent };
  }

  it("20 answered records cost 4 statements each, plus 8 for the pass: 88 in all", async () => {
    const { worker, queue, sent } = await worldOf();
    await queue(Array.from({ length: 20 }, (_, n) => `r${String(n).padStart(2, "0")}`));

    const report = await worker.runOnce();

    expect(report.written).toHaveLength(20);
    expect(report.failures).toEqual([]);
    const counts = new Map<string, number>();
    for (const name of sent.map(nameOf)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      // The pass: the spending check, the claim, the heartbeat and its alert, the batch's read and
      // its prior answers, the first healthy model call's alert, and the batch's ack.
      "usage total": 1,
      claim: 1,
      heartbeat: 1,
      "alert state": 2,
      read: 1,
      "latest answers": 1,
      ack: 1,
      // Each record: admitted, counted, logged and written, one statement each.
      reserve: 20,
      finish: 20,
      "log answer": 20,
      write: 20,
    });
    // Within the bound of 5 per record, with the pass's own statements on top: 4 × 20 + 8.
    expect(sent).toHaveLength(88);
  });

  it("one answered record, in the order the store sees them", async () => {
    const { worker, queue, sent } = await worldOf();
    await queue(["only"]);

    expect((await worker.runOnce()).written).toEqual(["only"]);

    expect(sent.map(nameOf)).toEqual([
      "usage total",
      "claim",
      "heartbeat",
      "alert state",
      "read",
      "latest answers",
      "reserve",
      "finish",
      "alert state",
      "log answer",
      "write",
      "ack",
    ]);
  });
});
