import {
  FakeAction,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { AlertSignals } from "../alerts/index.ts";
import type {
  ActionRecord,
  Clock,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  RecordKey,
} from "../contracts/index.ts";
import {
  type AnswerEntry,
  applyHumanDecision,
  type HumanEntry,
  type LogEntry,
  type ReviewedRecord,
} from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { stateHash } from "../records/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { conditionHolds, configureAction } from "./action-pipeline.ts";
import {
  createWorker,
  DEFAULT_WORKER_LIMITS,
  type OutagePolicy,
  type ReviewQueue,
  type WorkerDeps,
  type WorkerLimits,
} from "./worker.ts";

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};

// The low-stakes noul defaults: yes at or above 0.70, no at or below 0.30.
const SURE_YES = 0.95;
const UNSURE = 0.5;

// The explicit no-cap gate: every request may go and nothing is counted. Tests that are not about
// spending pass it, so no worker is built without a gate.
const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

const questionSet: QuestionSet = {
  questions: [scam],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

function response(probability: number): ProviderResponse {
  return {
    model: "jev-1.14.0",
    answers: { scam: { type: "noul", probability } },
    usage: { inputTokens: 120, outputTokens: 8 },
  };
}

/** A provider that answers from a script and remembers every request it was given. */
class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #script: (request: ProviderRequest, call: number) => Promise<ProviderResponse>;

  constructor(script: (request: ProviderRequest, call: number) => Promise<ProviderResponse>) {
    this.#script = script;
  }

  static always(probability: number): ScriptedProvider {
    return new ScriptedProvider(() => Promise.resolve(response(probability)));
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return this.#script(request, this.requests.length);
  }
}

class FakeReviews implements ReviewQueue {
  readonly withdrawals: { key: RecordKey; stateHash: string }[] = [];

  withdraw(key: RecordKey, hash: string): Promise<void> {
    this.withdrawals.push({ key, stateHash: hash });
    return Promise.resolve();
  }
}

/** A connector that notes each write in a journal shared with the log, to prove the order. */
class JournalConnector extends FakeConnector {
  readonly #journal: string[];

  constructor(database: FakeDatabase, journal: string[]) {
    super(database);
    this.#journal = journal;
  }

  override async write(
    ...args: Parameters<FakeConnector["write"]>
  ): ReturnType<FakeConnector["write"]> {
    this.#journal.push(`write ${args[0]}`);
    return super.write(...args);
  }
}

/** A connector whose queue hands every claimed key out twice, as an at-least-once queue may. */
class RepeatingConnector extends FakeConnector {
  override async claim(limit: number): Promise<readonly RecordKey[]> {
    const keys = await super.claim(limit);
    return [...keys, ...keys];
  }
}

/** A clock whose sleeps stay open until the test ticks, so a wait cannot spin. */
class ManualClock implements Clock {
  readonly requested: number[] = [];
  readonly #open: (() => void)[] = [];

  now(): number {
    return 0;
  }

  sleep(ms: number): Promise<void> {
    this.requested.push(ms);
    return new Promise((resolve) => {
      this.#open.push(resolve);
    });
  }

  tick(): void {
    for (const resolve of this.#open.splice(0)) {
      resolve();
    }
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) {
    await Promise.resolve();
  }
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
    await flush();
  }
  expect(done()).toBe(true);
}

type Rig = {
  db: FakeDatabase;
  journal: string[];
  log: FakeDecisionLog;
  reviews: FakeReviews;
  provider: ScriptedProvider;
  deps: WorkerDeps;
};

async function rig(
  options: {
    provider?: ScriptedProvider;
    actions?: WorkerDeps["actions"];
    clock?: Clock;
    limits?: WorkerLimits;
    connector?: (db: FakeDatabase, journal: string[]) => FakeConnector;
    excludes?: ConstructorParameters<typeof FakeDatabase>[0]["excludes"];
  } = {},
): Promise<Rig> {
  const db = new FakeDatabase({
    fields: ["body"],
    ...(options.excludes === undefined ? {} : { excludes: options.excludes }),
  });
  const journal: string[] = [];
  const connector = options.connector?.(db, journal) ?? new JournalConnector(db, journal);
  await connector.install();
  const log = new FakeDecisionLog(journal);
  const reviews = new FakeReviews();
  const provider = options.provider ?? ScriptedProvider.always(SURE_YES);
  return {
    db,
    journal,
    log,
    reviews,
    provider,
    deps: {
      connector,
      provider,
      log,
      reviews,
      actions: options.actions ?? [],
      clock: options.clock ?? new FakeClock(),
      limits: options.limits ?? DEFAULT_WORKER_LIMITS,
      questionSet,
      version: 3,
      spending: UNLIMITED,
    },
  };
}

function journalStep(journal: string[]): WorkerDeps["actions"][number] {
  return {
    name: "journal",
    run: (record) => {
      journal.push(`action ${record.key}`);
      return Promise.resolve();
    },
  };
}

describe("the worker loop", () => {
  it("refuses to compile a worker with no spending gate, since it would run uncapped", async () => {
    const test = await rig();
    const { spending: _gate, ...withoutGate } = test.deps;
    // @ts-expect-error without a gate the worker would run uncapped, so the compiler refuses it
    const bare = createWorker(withoutGate);
    expect(bare).toBeDefined();
  });

  it("walks the eight-step happy path: read, ask, decide, log, write, then the actions, then ack", async () => {
    const journal: string[] = [];
    const slack = new FakeAction<{ channel: string }>();
    const test = await rig({
      connector: (db) => new JournalConnector(db, journal),
    });
    const worker = createWorker({
      ...test.deps,
      log: new FakeDecisionLog(journal),
      actions: [journalStep(journal), configureAction("slack.notify", slack, { channel: "#all" })],
    });
    test.db.edit("a", { body: "Cheap phone, pay by gift card" });

    const report = await worker.runOnce();

    expect(test.provider.requests).toEqual([
      { model: "jev-1.14.0", state: { body: "Cheap phone, pay by gift card" }, questions: [scam] },
    ]);
    expect(report.written).toEqual(["a"]);
    expect(report.failures).toEqual([]);
    expect(test.db.decisionOf("a")).toEqual({
      decisions: {
        scam: { kind: "decided", value: true, probabilityOrConfidence: SURE_YES },
      },
      status: "done",
    });
    // The log first, the row second, the actions last.
    expect(journal).toEqual(["append answer a", "write a", "action a"]);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.record.status).toBe("done");
    expect(test.db.jobs.size).toBe(0);
  });

  it("logs the answer with the version, the model, the hash it was shown and the usage", async () => {
    const test = await rig();
    test.db.edit("a", { body: "hello" });

    await createWorker(test.deps).runOnce();

    const entry = await test.log.latestAnswer("a");
    expect(entry).toMatchObject({
      key: "a",
      version: 3,
      model: "jev-1.14.0",
      stateHash: stateHash(["body"], { body: "hello" }),
      usage: { inputTokens: 120, outputTokens: 8 },
    });
  });

  it("logs the model the response names, not the one the set asked for", async () => {
    // A compatible provider or a gateway may answer with another served version.
    const provider = new ScriptedProvider(() =>
      Promise.resolve({ ...response(SURE_YES), model: "jev-1.13.0" }),
    );
    const test = await rig({ provider });
    test.db.edit("a", { body: "hello" });

    await createWorker(test.deps).runOnce();

    expect(test.provider.requests[0]?.model).toBe("jev-1.14.0");
    expect((await test.log.latestAnswer("a"))?.model).toBe("jev-1.13.0");
  });

  it("discards the answer of a record that changed in flight and queues it again", async () => {
    const test = await rig({
      provider: new ScriptedProvider((_request, call) => {
        if (call === 1) {
          test.db.edit("a", { body: "second version" });
        }
        return Promise.resolve(response(SURE_YES));
      }),
    });
    const calls: ActionRecord[] = [];
    const worker = createWorker({
      ...test.deps,
      actions: [
        {
          name: "collect",
          run: (record) => {
            calls.push(record);
            return Promise.resolve();
          },
        },
      ],
    });
    test.db.edit("a", { body: "first version" });

    const first = await worker.runOnce();

    expect(first.discarded).toEqual(["a"]);
    expect(first.written).toEqual([]);
    expect(test.db.decisionOf("a")).toBeNull();
    expect(calls).toEqual([]);
    // Queued again: the job is back in the queue, free for the next claim.
    expect(test.db.jobs.get("a")).toEqual({ claimedBy: null });

    const second = await worker.runOnce();

    expect(second.written).toEqual(["a"]);
    expect(test.provider.requests.map((request) => request.state)).toEqual([
      { body: "first version" },
      { body: "second version" },
    ]);
    expect(test.db.decisionOf("a")?.status).toBe("done");
    expect(test.db.jobs.size).toBe(0);
    // Both calls are in the log: the first was paid for even though its answer was not used.
    expect((await test.log.history("a")).map((entry) => entry.kind)).toEqual(["answer", "answer"]);
  });

  it("asks once, with the latest state, when a record changed several times before the worker came", async () => {
    const test = await rig({ connector: (db) => new RepeatingConnector(db) });
    test.db.edit("a", { body: "one" });
    test.db.edit("a", { body: "two" });
    test.db.edit("a", { body: "three" });

    const report = await createWorker(test.deps).runOnce();

    expect(report.claimed).toBe(1);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.provider.requests[0]?.state).toEqual({ body: "three" });
    expect(test.db.jobs.size).toBe(0);
  });

  it("acks a deleted record without a model call and keeps its history", async () => {
    const test = await rig();
    const worker = createWorker(test.deps);
    test.db.edit("a", { body: "kept" });
    await worker.runOnce();
    test.db.edit("a", { body: "changed, then deleted" });
    test.db.rows.delete("a");

    const report = await worker.runOnce();

    expect(report.gone).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.db.jobs.size).toBe(0);
    expect(await test.log.history("a")).toHaveLength(1);
  });

  describe("a record waiting for review", () => {
    it("is withdrawn and asked again when its state changes", async () => {
      const answers = [UNSURE, SURE_YES];
      const test = await rig({
        provider: new ScriptedProvider(() => Promise.resolve(response(answers.shift() ?? 0))),
      });
      const worker = createWorker(test.deps);
      test.db.edit("a", { body: "old" });
      await worker.runOnce();
      expect(test.db.decisionOf("a")?.status).toBe("needs_review");

      test.db.edit("a", { body: "new" });
      const report = await worker.runOnce();

      expect(report.withdrawn).toEqual(["a"]);
      expect(test.reviews.withdrawals).toEqual([
        { key: "a", stateHash: stateHash(["body"], { body: "old" }) },
      ]);
      expect(test.provider.requests.map((request) => request.state)).toEqual([
        { body: "old" },
        { body: "new" },
      ]);
      expect(test.db.decisionOf("a")?.status).toBe("done");
    });

    it("is not withdrawn when the record was already decided", async () => {
      const test = await rig();
      const worker = createWorker(test.deps);
      test.db.edit("a", { body: "old" });
      await worker.runOnce();
      test.db.edit("a", { body: "new" });

      const report = await worker.runOnce();

      expect(report.withdrawn).toEqual([]);
      expect(test.reviews.withdrawals).toEqual([]);
    });
  });

  it("runs the actions again after a person decides, with the person's decision", async () => {
    const slack = new FakeAction<{ channel: string }>();
    const test = await rig({ provider: ScriptedProvider.always(UNSURE) });
    const worker = createWorker({
      ...test.deps,
      actions: [
        configureAction("slack.notify", slack, {
          channel: "#triage",
          when: { status: "needs_review" },
          else: { channel: "#done" },
        }),
      ],
    });
    test.db.edit("a", { body: "borderline" });
    await worker.runOnce();
    expect(slack.calls.map((call) => [call.record.status, call.config.channel])).toEqual([
      ["needs_review", "#triage"],
    ]);

    const hash = stateHash(["body"], { body: "borderline" });
    const stored = test.db.decisionOf("a");
    const answer = (await test.log.latestAnswer("a"))?.answers;
    if (stored === null || answer === undefined) {
      throw new Error("the first pass should have written and logged the record");
    }
    const entry: HumanEntry = {
      kind: "human",
      key: "a",
      question: "scam",
      value: true,
      reviewer: "maya",
      stateHash: hash,
      version: 3,
      at: new Date("2026-10-31T12:00:00Z"),
    };
    const reviewed: ReviewedRecord = {
      key: "a",
      hash,
      status: "needs_review",
      questions: [scam],
      decisions: stored.decisions,
      answers: answer,
    };
    const human = await applyHumanDecision(entry, reviewed, test.log, (key, decision, expected) =>
      test.deps.connector.write(key, decision, expected),
    );
    const decided = test.db.decisionOf("a");
    if (decided === null) {
      throw new Error("the human decision should have been written");
    }

    const outcome = await worker.onHumanDecision({
      key: "a",
      stateHash: hash,
      status: human.status,
      decisions: decided.decisions,
    });

    expect(outcome).toEqual({ ran: true, failures: [] });
    expect(slack.calls.map((call) => [call.record.status, call.config.channel])).toEqual([
      ["needs_review", "#triage"],
      ["done", "#done"],
    ]);
    expect(slack.calls[1]?.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
  });

  it("does not run the actions for a decision on a record that changed since", async () => {
    const slack = new FakeAction<{ channel: string }>();
    const test = await rig();
    const worker = createWorker({
      ...test.deps,
      actions: [configureAction("slack.notify", slack, { channel: "#all" })],
    });
    test.db.edit("a", { body: "now" });

    const outcome = await worker.onHumanDecision({
      key: "a",
      stateHash: stateHash(["body"], { body: "before" }),
      status: "done",
      decisions: {},
    });

    expect(outcome).toEqual({ ran: false, failures: [] });
    expect(slack.calls).toEqual([]);
  });

  describe("when the model call fails", () => {
    it("never becomes a decision: the record stays pending and the error goes back to the caller", async () => {
      const outage = new Error("529: overloaded");
      const test = await rig({
        provider: new ScriptedProvider(() => Promise.reject(outage)),
      });
      const worker = createWorker(test.deps);
      test.db.edit("a", { body: "hello" });

      const report = await worker.runOnce();

      expect(report.failures).toEqual([{ key: "a", stage: "ask", error: outage }]);
      expect(report.written).toEqual([]);
      expect(test.db.decisionOf("a")).toBeNull();
      expect(await test.log.history("a")).toEqual([]);
      expect(test.db.jobs.get("a")).toEqual({ claimedBy: null });
    });

    it("settles the other records of the batch", async () => {
      const outage = new Error("529: overloaded");
      const test = await rig({
        provider: new ScriptedProvider((request) =>
          request.state["body"] === "bad"
            ? Promise.reject(outage)
            : Promise.resolve(response(SURE_YES)),
        ),
      });
      test.db.edit("a", { body: "bad" });
      test.db.edit("b", { body: "good" });

      const report = await createWorker(test.deps).runOnce();

      expect(report.written).toEqual(["b"]);
      expect(report.failures.map((failure) => failure.key)).toEqual(["a"]);
      expect(test.db.jobs.size).toBe(1);
    });
  });

  it("reports an action that fails, keeps the decision and still runs the other actions", async () => {
    const boom = new Error("slack is down");
    const after = new FakeAction<{ channel: string }>();
    const test = await rig();
    const worker = createWorker({
      ...test.deps,
      actions: [
        {
          name: "slack.notify",
          run: () => Promise.reject(boom),
        },
        configureAction("github.label", after, { channel: "#x" }),
      ],
    });
    test.db.edit("a", { body: "hello" });

    const report = await worker.runOnce();

    expect(report.failures).toEqual([
      { key: "a", stage: "action", action: "slack.notify", error: boom },
    ]);
    expect(test.db.decisionOf("a")?.status).toBe("done");
    expect(after.calls).toHaveLength(1);
    expect(test.db.jobs.size).toBe(0);
  });

  it("marks a record with blank state as skipped without asking the model", async () => {
    const test = await rig();
    test.db.edit("a", { body: "   " });

    const report = await createWorker(test.deps).runOnce();

    expect(report.skipped).toEqual(["a"]);
    expect(test.provider.requests).toEqual([]);
    expect(test.db.decisionOf("a")).toEqual({ decisions: {}, status: "skipped" });
    expect(test.db.jobs.size).toBe(0);
  });

  it("skips a record the source's where filter excludes, without asking the model", async () => {
    const test = await rig({ excludes: (state) => state["body"] === "internal note" });
    test.db.edit("a", { body: "internal note" });
    test.db.edit("b", { body: "Where is my parcel?" });

    const report = await createWorker(test.deps).runOnce();

    expect(report.skipped).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.db.decisionOf("a")).toEqual({ decisions: {}, status: "skipped" });
  });

  describe("the state size guard", () => {
    it("refuses a state above 32,000 tokens: no model call, the record is marked error", async () => {
      const test = await rig();
      test.db.edit("a", { body: "x".repeat(130_000) });

      const report = await createWorker(test.deps).runOnce();

      expect(test.provider.requests).toEqual([]);
      expect(report.refused).toHaveLength(1);
      expect(report.refused[0]?.key).toBe("a");
      expect(test.db.decisionOf("a")).toEqual({ decisions: {}, status: "error" });
    });

    it("honors the source's own limit", async () => {
      const test = await rig({ limits: { ...DEFAULT_WORKER_LIMITS, maxStateTokens: 100 } });
      test.db.edit("a", { body: "x".repeat(1_000) });

      const report = await createWorker(test.deps).runOnce();

      expect(report.refused.map((refusal) => refusal.key)).toEqual(["a"]);
    });

    it("sends a state above 8,000 tokens and says so", async () => {
      const test = await rig();
      test.db.edit("a", { body: "x".repeat(40_000) });

      const report = await createWorker(test.deps).runOnce();

      expect(report.warned.map((warning) => warning.key)).toEqual(["a"]);
      expect(report.written).toEqual(["a"]);
    });
  });

  describe("the batch and the in-flight cap", () => {
    it("takes at most 20 jobs in a pass", async () => {
      const test = await rig();
      for (let index = 0; index < 25; index += 1) {
        test.db.edit(`k${index}`, { body: `body ${index}` });
      }
      const worker = createWorker(test.deps);

      expect((await worker.runOnce()).claimed).toBe(20);
      expect((await worker.runOnce()).claimed).toBe(5);
      expect(test.provider.requests).toHaveLength(25);
    });

    it("@timing keeps at most 8 requests in flight and starts the next as one finishes", async () => {
      const gates: (() => void)[] = [];
      let inFlight = 0;
      let peak = 0;
      const test = await rig({
        provider: new ScriptedProvider(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
          inFlight -= 1;
          return response(SURE_YES);
        }),
      });
      for (let index = 0; index < 20; index += 1) {
        test.db.edit(`k${index}`, { body: `body ${index}` });
      }
      let report: Awaited<ReturnType<ReturnType<typeof createWorker>["runOnce"]>> | undefined;
      const pass = createWorker(test.deps)
        .runOnce()
        .then((result) => {
          report = result;
        });

      await until(() => gates.length === 8);
      expect(inFlight).toBe(8);
      // One finishing frees one lane, and only one.
      gates.shift()?.();
      await until(() => test.provider.requests.length === 9);
      expect(inFlight).toBe(8);

      while (report === undefined) {
        for (const open of gates.splice(0)) {
          open();
        }
        await flush();
      }
      await pass;

      expect(peak).toBe(8);
      expect(report.written).toHaveLength(20);
      expect(test.provider.requests).toHaveLength(20);
    });
  });

  describe("run", () => {
    it("wakes on a change from the connector and stops when aborted", async () => {
      const clock = new ManualClock();
      const test = await rig({ clock });
      const reports: number[] = [];
      const stop = new AbortController();
      const running = createWorker(test.deps).run(stop.signal, (report) => {
        reports.push(report.written.length);
      });
      await until(() => reports.length === 1);
      expect(reports).toEqual([0]);

      test.db.edit("a", { body: "hello" });
      await until(() => test.db.decisionOf("a") !== null);
      stop.abort();
      await running;

      expect(test.db.decisionOf("a")?.status).toBe("done");
    });

    it("polls every 2 seconds, so a job whose notification was lost is still taken", async () => {
      const clock = new ManualClock();
      const test = await rig({ clock });
      test.db.edit("a", { body: "hello" });
      // The job exists but no change was announced: the notification was lost.
      test.db.jobs.set("a", { claimedBy: null });
      test.db.jobs.set("b", { claimedBy: "someone else" });
      const stop = new AbortController();
      const reports: number[] = [];
      const running = createWorker(test.deps).run(stop.signal, (report) => {
        reports.push(report.claimed);
      });

      await until(() => test.db.decisionOf("a") !== null);
      await until(() => reports.length >= 2);
      expect(clock.requested).toEqual([2000]);
      stop.abort();
      await running;
    });

    it("waits out the poll after a failed pass instead of asking the model in a tight loop", async () => {
      const clock = new ManualClock();
      const outage = new Error("529");
      const test = await rig({
        clock,
        provider: new ScriptedProvider(() => Promise.reject(outage)),
      });
      test.db.edit("a", { body: "hello" });
      const stop = new AbortController();
      const failures: unknown[] = [];
      const running = createWorker(test.deps).run(stop.signal, (report) => {
        failures.push(...report.failures.map((failure) => failure.error));
      });

      await until(() => failures.length === 1);
      await flush();
      expect(test.provider.requests).toHaveLength(1);
      expect(failures).toEqual([outage]);

      clock.tick();
      await until(() => failures.length === 2);
      stop.abort();
      await running;
    });
  });
});

/** Every store call a pass makes, by name, shared by the recording fakes below. */
class Calls {
  readonly #counts = new Map<string, number>();

  note(name: string): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1);
  }

  of(name: string): number {
    return this.#counts.get(name) ?? 0;
  }

  all(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }

  reset(): void {
    this.#counts.clear();
  }
}

/** The fake log, counting each call that would be a round trip to the store; `down` fails `latestAnswers`. */
class RecordingLog extends FakeDecisionLog {
  readonly #calls: Calls;
  down: Error | undefined;

  constructor(calls: Calls) {
    super();
    this.#calls = calls;
  }

  override appendAnswer(entry: AnswerEntry): Promise<void> {
    this.#calls.note("appendAnswer");
    return super.appendAnswer(entry);
  }

  override latestAnswer(key: RecordKey): Promise<AnswerEntry | undefined> {
    this.#calls.note("latestAnswer");
    return super.latestAnswer(key);
  }

  override latestAnswers(keys: readonly RecordKey[]): Promise<ReadonlyMap<RecordKey, AnswerEntry>> {
    this.#calls.note("latestAnswers");
    return this.down === undefined ? super.latestAnswers(keys) : Promise.reject(this.down);
  }

  override history(key: RecordKey): Promise<readonly LogEntry[]> {
    this.#calls.note("history");
    return super.history(key);
  }
}

/**
 * The fake connector, counting each call; `failWrites` refuses that many writes, as a dropped
 * connection, and `beforeWrite` runs just before a write reaches the database.
 */
class RecordingConnector extends FakeConnector {
  readonly #calls: Calls;
  failWrites = 0;
  beforeWrite: (() => void) | undefined;

  constructor(database: FakeDatabase, calls: Calls) {
    super(database);
    this.#calls = calls;
  }

  override claim(limit: number): Promise<readonly RecordKey[]> {
    this.#calls.note("claim");
    return super.claim(limit);
  }

  override read(keys: readonly RecordKey[]): ReturnType<FakeConnector["read"]> {
    this.#calls.note("read");
    return super.read(keys);
  }

  override write(...args: Parameters<FakeConnector["write"]>): ReturnType<FakeConnector["write"]> {
    this.#calls.note("write");
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      return Promise.reject(new Error("connection reset"));
    }
    this.beforeWrite?.();
    return super.write(...args);
  }

  override ack(keys: readonly RecordKey[]): Promise<void> {
    this.#calls.note("ack");
    return super.ack(keys);
  }

  override release(keys: readonly RecordKey[]): Promise<void> {
    this.#calls.note("release");
    return super.release(keys);
  }
}

/** An unlimited gate that counts its calls. */
function recordingGate(calls: Calls): SpendingGate {
  const note = (name: string) => {
    calls.note(name);
    return Promise.resolve();
  };
  return {
    allowsWork: () => note("allowsWork").then(() => true),
    admit: () => note("admit").then(() => "reservation"),
    settle: () => note("settle"),
    record: () => note("record"),
    finish: () => note("finish"),
  };
}

/** The rig with every store dependency counting its calls into one `Calls`. */
async function recordingRig(provider: ScriptedProvider = ScriptedProvider.always(SURE_YES)) {
  const calls = new Calls();
  const db = new FakeDatabase({ fields: ["body"] });
  const connector = new RecordingConnector(db, calls);
  await connector.install();
  const log = new RecordingLog(calls);
  const deps: WorkerDeps = {
    connector,
    provider,
    log,
    reviews: new FakeReviews(),
    actions: [],
    clock: new FakeClock(),
    limits: DEFAULT_WORKER_LIMITS,
    questionSet,
    version: 3,
    spending: recordingGate(calls),
  };
  return { db, calls, connector, log, provider, deps };
}

describe("round trips per record", () => {
  it("a batch of 20 records answered for the first time costs one latestAnswers, and per record exactly admit, appendAnswer, write and finish", async () => {
    const test = await recordingRig();
    for (let index = 0; index < 20; index += 1) {
      test.db.edit(`k${index}`, { body: `listing ${index}` });
    }

    const report = await createWorker(test.deps).runOnce();

    expect(report.written).toHaveLength(20);
    // No logged answer means no person's decision either, so the log is not read after the append.
    expect(test.calls.all()).toEqual({
      allowsWork: 1,
      claim: 1,
      read: 1,
      latestAnswers: 1,
      admit: 20,
      appendAnswer: 20,
      write: 20,
      finish: 20,
      ack: 1,
    });
    expect(test.calls.of("latestAnswer")).toBe(0);
    expect(test.calls.of("history")).toBe(0);
    expect(test.calls.of("settle")).toBe(0);
    expect(test.calls.of("record")).toBe(0);
  });

  it("a batch of 20 records answered before and changed since also reads each record's log twice", async () => {
    const test = await recordingRig();
    const worker = createWorker(test.deps);
    for (let index = 0; index < 20; index += 1) {
      test.db.edit(`k${index}`, { body: `listing ${index}` });
    }
    await worker.runOnce();
    for (let index = 0; index < 20; index += 1) {
      test.db.edit(`k${index}`, { body: `listing ${index}, edited` });
    }
    test.calls.reset();

    const report = await worker.runOnce();

    expect(report.written).toHaveLength(20);
    expect(test.calls.all()).toEqual({
      allowsWork: 1,
      claim: 1,
      read: 1,
      latestAnswers: 1,
      // Per record: one read to see whether a review waits on the old state, one after the append
      // so a person's decision on this state stands.
      history: 40,
      admit: 20,
      appendAnswer: 20,
      write: 20,
      finish: 20,
      ack: 1,
    });
  });

  it("a record whose model call fails costs admit and settle only", async () => {
    const test = await recordingRig(
      new ScriptedProvider(() => Promise.reject(new Error("529: overloaded"))),
    );
    test.db.edit("a", { body: "hello" });

    const report = await createWorker(test.deps).runOnce();

    expect(report.failures.map((failure) => failure.stage)).toEqual(["ask"]);
    expect(test.calls.all()).toEqual({
      allowsWork: 1,
      claim: 1,
      read: 1,
      latestAnswers: 1,
      admit: 1,
      settle: 1,
      release: 1,
    });
  });

  it("a batch whose answers cannot be read goes back to the queue whole, as a failed pass", async () => {
    const test = await recordingRig();
    const down = new Error("the log is unreachable");
    test.log.down = down;
    test.db.edit("a", { body: "hello" });
    test.db.edit("b", { body: "world" });

    const report = await createWorker(test.deps).runOnce();

    expect(report.claimed).toBe(2);
    expect(report.failures).toEqual([{ key: null, stage: "record", error: down }]);
    expect(test.provider.requests).toEqual([]);
    expect(test.db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(test.db.jobs.size).toBe(2);
  });

  it("keeps running when the answers cannot be read: it waits out the poll, then answers once the log is back", async () => {
    const clock = new ManualClock();
    const test = await recordingRig();
    test.log.down = new Error("the log is unreachable");
    test.db.edit("a", { body: "hello" });
    const stop = new AbortController();
    const failures: unknown[] = [];
    const running = createWorker({ ...test.deps, clock }).run(stop.signal, (report) => {
      failures.push(...report.failures.map((failure) => failure.error));
    });

    await until(() => failures.length === 1);
    await flush();
    // One failed pass, then a wait for the poll: no tight loop against a down log.
    expect(test.calls.of("latestAnswers")).toBe(1);
    expect(clock.requested).toEqual([2000]);

    test.log.down = undefined;
    clock.tick();
    await until(() => test.db.decisionOf("a") !== null);
    stop.abort();
    await running;
    expect(test.db.decisionOf("a")?.status).toBe("done");
  });
});

describe("a record already answered at its state", () => {
  it("a re-queue after a successful pass is not asked or paid for again, and runs the actions again, at least once, as before", async () => {
    const test = await recordingRig();
    const journal: string[] = [];
    const worker = createWorker({ ...test.deps, actions: [journalStep(journal)] });
    test.db.edit("a", { body: "Cheap phone, pay by gift card" });
    await worker.runOnce();
    const decided = test.db.decisionOf("a");

    // A backfill that read the log before the worker answered queues the record again.
    await test.deps.connector.enqueue(["a"]);
    test.calls.reset();
    const report = await worker.runOnce();

    expect(report.alreadyAnswered).toEqual(["a"]);
    expect(report.written).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.calls.all()).toEqual({
      allowsWork: 1,
      claim: 1,
      read: 1,
      latestAnswers: 1,
      history: 1,
      write: 1,
      ack: 1,
    });
    expect(test.db.decisionOf("a")).toEqual(decided);
    // The worker cannot tell this from a write that never landed, so the actions follow the write.
    expect(journal).toEqual(["action a", "action a"]);
    expect(test.db.jobs.size).toBe(0);
  });

  it("brings a row whose write failed after its answer was logged up to the log, and runs its actions exactly once", async () => {
    const test = await recordingRig();
    const journal: string[] = [];
    const worker = createWorker({ ...test.deps, actions: [journalStep(journal)] });
    test.db.edit("a", { body: "Cheap phone, pay by gift card" });
    test.connector.failWrites = 1;

    const first = await worker.runOnce();
    expect(first.failures.map((failure) => failure.stage)).toEqual(["record"]);
    expect(test.db.decisionOf("a")).toBeNull();
    expect(test.db.jobs.get("a")).toEqual({ claimedBy: null });
    // The answer is logged, but its write threw: no action ran for it.
    expect(await test.log.history("a")).toHaveLength(1);
    expect(journal).toEqual([]);

    const second = await worker.runOnce();

    expect(second.alreadyAnswered).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.db.decisionOf("a")).toEqual({
      decisions: { scam: { kind: "decided", value: true, probabilityOrConfidence: SURE_YES } },
      status: "done",
    });
    expect(journal).toEqual(["action a"]);
    expect(test.db.jobs.size).toBe(0);
  });

  it("runs nothing when the record changed before its rewrite landed, and asks it again with the new state", async () => {
    const test = await recordingRig();
    const journal: string[] = [];
    const worker = createWorker({ ...test.deps, actions: [journalStep(journal)] });
    test.db.edit("a", { body: "first" });
    await worker.runOnce();
    await test.deps.connector.enqueue(["a"]);
    // The rewrite is refused: the state changes between the read and the write.
    test.connector.beforeWrite = () => {
      test.connector.beforeWrite = undefined;
      test.db.edit("a", { body: "second" });
    };

    const report = await worker.runOnce();

    expect(report.alreadyAnswered).toEqual([]);
    expect(report.discarded).toEqual(["a"]);
    expect(journal).toEqual(["action a"]);
    expect(test.db.jobs.get("a")).toEqual({ claimedBy: null });

    const next = await worker.runOnce();
    expect(next.written).toEqual(["a"]);
    expect(test.provider.requests.map((request) => request.state)).toEqual([
      { body: "first" },
      { body: "second" },
    ]);
    expect(journal).toEqual(["action a", "action a"]);
  });

  it("keeps a person's decision on this state when the record is queued again", async () => {
    const test = await recordingRig(ScriptedProvider.always(UNSURE));
    const worker = createWorker(test.deps);
    test.db.edit("a", { body: "borderline" });
    await worker.runOnce();
    const hash = stateHash(["body"], { body: "borderline" });
    const stored = test.db.decisionOf("a");
    const answer = (await test.log.latestAnswer("a"))?.answers;
    if (stored === null || answer === undefined) {
      throw new Error("the first pass should have written and logged the record");
    }
    await applyHumanDecision(
      {
        kind: "human",
        key: "a",
        question: "scam",
        value: false,
        reviewer: "maya",
        stateHash: hash,
        version: 3,
        at: new Date("2026-10-31T12:00:00Z"),
      },
      {
        key: "a",
        hash,
        status: "needs_review",
        questions: [scam],
        decisions: stored.decisions,
        answers: answer,
      },
      test.log,
      (key, decision, expected) => test.deps.connector.write(key, decision, expected),
    );

    await test.deps.connector.enqueue(["a"]);
    const report = await worker.runOnce();

    expect(report.alreadyAnswered).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(1);
    expect(test.db.decisionOf("a")?.status).toBe("done");
    expect(test.db.decisionOf("a")?.decisions["scam"]).toMatchObject({
      kind: "decided",
      value: false,
    });
  });

  it("is asked again when its answer was logged under another question-set version", async () => {
    const test = await recordingRig();
    test.db.edit("a", { body: "hello" });
    await createWorker(test.deps).runOnce();

    await test.deps.connector.enqueue(["a"]);
    const report = await createWorker({ ...test.deps, version: 4 }).runOnce();

    expect(report.alreadyAnswered).toEqual([]);
    expect(report.written).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(2);
    expect((await test.log.latestAnswer("a"))?.version).toBe(4);
  });

  it("is asked again when its logged answer lacks a question of the set", async () => {
    const test = await recordingRig();
    await test.log.appendAnswer({
      kind: "answer",
      key: "a",
      version: 3,
      model: "jev-1.14.0",
      stateHash: stateHash(["body"], { body: "hello" }),
      answers: {},
      usage: { inputTokens: 90, outputTokens: 2 },
      at: new Date("2026-10-31T12:00:00Z"),
    });
    test.db.edit("a", { body: "hello" });

    const report = await createWorker(test.deps).runOnce();

    expect(report.alreadyAnswered).toEqual([]);
    expect(report.written).toEqual(["a"]);
    expect(test.provider.requests).toHaveLength(1);
  });
});

describe("telling the alerts module", () => {
  /** Remembers what the worker told it; a test can make it fail. */
  function signalsFake(failWith?: Error): { signals: AlertSignals; told: string[] } {
    const told: string[] = [];
    const tell = (what: string): Promise<void> => {
      told.push(what);
      return failWith === undefined ? Promise.resolve() : Promise.reject(failWith);
    };
    return {
      told,
      signals: {
        modelCall: (ok) => tell(`call ${ok ? "ok" : "failed"}`),
        beat: () => tell("beat"),
        backfillFinished: () => tell("backfill finished"),
        backfillFailed: () => tell("backfill failed"),
      },
    };
  }

  it("beats on every pass, empty or not, and reports each model call's outcome", async () => {
    const outage = new Error("529: overloaded");
    const test = await rig({
      provider: new ScriptedProvider((request) =>
        request.state["body"] === "bad"
          ? Promise.reject(outage)
          : Promise.resolve(response(SURE_YES)),
      ),
    });
    const { signals, told } = signalsFake();
    const worker = createWorker({ ...test.deps, alerts: signals });

    await worker.runOnce();
    expect(told).toEqual(["beat"]);

    test.db.edit("a", { body: "bad" });
    test.db.edit("b", { body: "good" });
    told.length = 0;
    await worker.runOnce();
    expect(told.filter((entry) => entry === "beat")).toHaveLength(1);
    expect(told.filter((entry) => entry.startsWith("call")).sort()).toEqual([
      "call failed",
      "call ok",
    ]);
  });

  it("hands a failing alert back as a failure without touching the record", async () => {
    const test = await rig();
    const boom = new Error("alert store is down");
    const worker = createWorker({ ...test.deps, alerts: signalsFake(boom).signals });
    test.db.edit("a", { body: "hello" });

    const report = await worker.runOnce();

    expect(report.written).toEqual(["a"]);
    expect(report.failures.filter((failure) => failure.stage !== "alert")).toEqual([]);
    expect(report.failures.map((failure) => failure.stage)).toEqual(["alert", "alert"]);
    expect(report.failures[0]?.key).toBeNull();
    expect(test.db.decisionOf("a")).not.toBeNull();
  });
});

describe("action conditions", () => {
  const record: ActionRecord = { key: "a", state: { body: "x" }, status: "done" };
  const decisions = {
    scam: { kind: "decided", value: true, probabilityOrConfidence: 0.8 },
    urgency: { kind: "needs_review" },
  } as const;

  it("matches a question equal to its decided value and the record's status", () => {
    expect(conditionHolds({ scam: true }, record, decisions)).toBe(true);
    expect(conditionHolds({ scam: false }, record, decisions)).toBe(false);
    expect(conditionHolds({ status: "done" }, record, decisions)).toBe(true);
    expect(conditionHolds({ status: "needs_review" }, record, decisions)).toBe(false);
  });

  it("requires every term, and a question with no decision never matches", () => {
    expect(conditionHolds({ scam: true, status: "done" }, record, decisions)).toBe(true);
    expect(conditionHolds({ scam: true, status: "pending" }, record, decisions)).toBe(false);
    expect(conditionHolds({ urgency: "high" }, record, decisions)).toBe(false);
    expect(conditionHolds({ missing: true }, record, decisions)).toBe(false);
  });

  it("tests a probability or confidence inclusively", () => {
    expect(conditionHolds({ "scam.probability": { atLeast: 0.8 } }, record, decisions)).toBe(true);
    expect(conditionHolds({ "scam.confidence": { atLeast: 0.81 } }, record, decisions)).toBe(false);
    expect(conditionHolds({ "urgency.confidence": { atLeast: 0 } }, record, decisions)).toBe(false);
  });

  it("skips an action whose condition fails and has no else", async () => {
    const action = new FakeAction<{ label: string }>();
    const step = configureAction("github.label", action, {
      label: "scam",
      when: { scam: false },
    });

    await step.run(record, decisions);

    expect(action.calls).toEqual([]);
  });

  it("passes the action its own fields, without the condition", async () => {
    const action = new FakeAction<{ label: string }>();
    const step = configureAction("github.label", action, { label: "scam", when: { scam: true } });

    await step.run(record, decisions);

    expect(action.calls[0]?.config).toEqual({ label: "scam" });
  });
});

describe("the outage policy in the worker", () => {
  /** A hand-written policy: the worker only needs its three verdicts, not the arithmetic. */
  function scriptedPolicy(verdict: "error" | "unchecked"): OutagePolicy & {
    readonly held: Set<RecordKey>;
    nextDue: RecordKey[];
  } {
    const held = new Set<RecordKey>();
    return {
      held,
      nextDue: [],
      failed(key) {
        held.add(key);
        return verdict;
      },
      succeeded(key) {
        // As the real policy: the answered record is no longer held; the rest come back now.
        held.delete(key);
        const all = [...held];
        held.clear();
        return all;
      },
      due() {
        const due = this.nextDue;
        this.nextDue = [];
        for (const key of due) {
          held.delete(key);
        }
        return due;
      },
      hold(keys) {
        for (const key of keys) {
          held.add(key);
        }
      },
    };
  }

  it("marks a record unchecked when the window is spent, re-queues it on recovery, and answers it to done", async () => {
    let down = true;
    const provider = new ScriptedProvider(() =>
      down
        ? Promise.reject(new Error("the model is overloaded (529)"))
        : Promise.resolve(response(SURE_YES)),
    );
    const test = await rig({ provider });
    const outage = scriptedPolicy("unchecked");
    const worker = createWorker({ ...test.deps, outage });
    test.db.edit("a", { body: "a listing" });

    const first = await worker.runOnce();
    expect(first.held).toEqual([{ key: "a", status: "unchecked" }]);
    expect(test.db.decisionOf("a")).toEqual({ decisions: {}, status: "unchecked" });
    expect(test.db.jobs.size).toBe(0);

    // The model returns; the next successful call ends the outage and queues "a" again.
    down = false;
    test.db.edit("b", { body: "another listing" });
    const second = await worker.runOnce();
    expect(second.requeued).toEqual(["a"]);
    expect(test.db.jobs.has("a")).toBe(true);

    const third = await worker.runOnce();
    expect(third.written).toEqual(["a"]);
    expect(test.db.decisionOf("a")?.status).toBe("done");
  });

  it("marks a record error when the source holds, and asks it again when the policy says it is due", async () => {
    let down = true;
    const provider = new ScriptedProvider(() =>
      down
        ? Promise.reject(new Error("the model is overloaded (529)"))
        : Promise.resolve(response(UNSURE)),
    );
    const test = await rig({ provider });
    const outage = scriptedPolicy("error");
    const worker = createWorker({ ...test.deps, outage });
    test.db.edit("a", { body: "a listing" });

    await worker.runOnce();
    expect(test.db.decisionOf("a")?.status).toBe("error");

    down = false;
    outage.nextDue = ["a"];
    // Due records are queued before the claim, so the same pass asks them.
    const retry = await worker.runOnce();
    expect(retry.requeued).toEqual(["a"]);
    expect(retry.written).toEqual(["a"]);
    expect(test.db.decisionOf("a")?.status).toBe("needs_review");
  });

  it("hands a record back to the policy when the queue refuses it, so a retry stays scheduled", async () => {
    class RefusingConnector extends FakeConnector {
      refuse = false;
      override enqueue(keys: readonly RecordKey[]): Promise<void> {
        return this.refuse ? Promise.reject(new Error("the queue is down")) : super.enqueue(keys);
      }
    }
    let connector: RefusingConnector | undefined;
    const provider = new ScriptedProvider(() => Promise.reject(new Error("overloaded")));
    const test = await rig({
      provider,
      connector: (db) => {
        connector = new RefusingConnector(db);
        return connector;
      },
    });
    const outage = scriptedPolicy("error");
    const worker = createWorker({ ...test.deps, outage });
    test.db.edit("a", { body: "a listing" });
    await worker.runOnce();
    expect(outage.held.has("a")).toBe(true);

    outage.nextDue = ["a"];
    if (connector !== undefined) {
      connector.refuse = true;
    }
    const report = await worker.runOnce();

    expect(report.requeued).toEqual([]);
    expect(report.failures.map(({ key }) => key)).toEqual([null]);
    // Not stranded: the policy holds it again and will offer it at the next retry.
    expect(outage.held.has("a")).toBe(true);
    expect(test.db.decisionOf("a")?.status).toBe("error");
  });

  it("keeps retrying through the queue while the policy says retry", async () => {
    const provider = new ScriptedProvider(() => Promise.reject(new Error("overloaded")));
    const test = await rig({ provider });
    const outage: OutagePolicy = {
      failed: () => "retry",
      succeeded: () => [],
      due: () => [],
      hold: () => {},
    };
    test.db.edit("a", { body: "a listing" });

    const report = await createWorker({ ...test.deps, outage }).runOnce();

    expect(report.held).toEqual([]);
    expect(report.failures.map(({ key }) => key)).toEqual(["a"]);
    expect(test.db.decisionOf("a")).toBeNull();
    expect(test.db.jobs.get("a")).toEqual({ claimedBy: null });
  });
});
