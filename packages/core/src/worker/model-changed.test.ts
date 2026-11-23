import {
  FakeAlertStore,
  FakeChannel,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  FakeVersionModels,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createAlerts, eventKey, modelNameWords } from "../alerts/index.ts";
import { createBackfill } from "../backfill/index.ts";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { ActionNotQueued } from "./action-pipeline.ts";
import {
  type HeldModel,
  holdModel,
  MODEL_CHANGED_PROBE_EVERY_MS,
  ModelChangedError,
  withoutProbe,
} from "./held-model.ts";
import {
  createWorker,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_WORKER_LIMITS,
  type WorkerDeps,
} from "./worker.ts";

/**
 * A response naming another model than the one that first answered its question-set version is a
 * failed call, paid and counted, never logged or written, and it holds the source: one record is
 * asked again every 5 minutes, the others wait in the queue with no model call, and all are asked
 * again once the held model answers or a new version starts.
 */

const SOURCE_ID = "marketplace:listings";
const SCOPE = {
  project: "marketplace",
  source: "listings",
  link: "https://docs.facetdb.dev/fix/model",
};
const HELD = "jev-1.14.0";
/** The publisher's Strands Decider server answers under its own name, whatever is asked. */
const OTHER = "strands-decider-7b";
const TOKENS = 100;
const MINUTE = 60_000;

const scam: Question = { type: "noul", name: "scam", instructions: "A scam?", stakes: "low" };
const spam: Question = { type: "noul", name: "spam", instructions: "Spam?", stakes: "low" };
const SCAM_ONLY: QuestionSet = { questions: [scam], read: ["body"], model: HELD, thresholds: {} };
const SCAM_AND_SPAM: QuestionSet = { ...SCAM_ONLY, questions: [scam, spam] };

/** Model changed's words: what happened under `version`, and what FacetDB did, with the fix. */
const what = (version: number) =>
  `The model answered as ${OTHER}, not ${HELD}, the model that first answered question-set version ${version}.`;
const DID = `None of its answers was written, and the source is held: one record is asked again every 5 minutes, the others wait without a model call. Serve ${HELD} again at the provider's address, or set a new model in facetdb.config.ts, which starts a new version; every waiting record is then asked again.`;
const PLACE = "Project marketplace, source listings, all questions.";
const raised = (version: number) => `${what(version)} ${PLACE} FacetDB: ${DID}`;
const RAISED = raised(3);
const RESOLVED = `Resolved: ${what(3)} ${PLACE}`;
const CHANGED_KEY = eventKey({ kind: "model_changed", ...SCOPE, question: null });

/** A model server that answers under the name it serves now, whatever the request names. */
class ServedProvider implements ModelProvider {
  served = HELD;
  readonly requests: ProviderRequest[] = [];

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const answers: Record<string, ProviderResponse["answers"][string]> = {};
    for (const question of request.questions) {
      answers[question.name] = { type: "noul", probability: 0.95 };
    }
    return Promise.resolve({
      model: this.served,
      answers,
      usage: { inputTokens: TOKENS, outputTokens: 1 },
    });
  }
}

/** A gate with no cap that remembers every count: a changed model's call is paid all the same. */
function countingGate(): SpendingGate & { readonly counted: number[] } {
  const counted: number[] = [];
  return {
    counted,
    allowsWork: () => Promise.resolve(true),
    admit: () => Promise.resolve("reservation"),
    settle: () => Promise.resolve(),
    record: (tokens) => {
      counted.push(tokens);
      return Promise.resolve();
    },
    finish: (_reservation, tokens) => {
      counted.push(tokens);
      return Promise.resolve();
    },
  };
}

async function rig() {
  const clock = new FakeClock(1_000_000);
  const db = new FakeDatabase({ fields: ["body"], clock });
  const connector = new FakeConnector(db);
  await connector.install();
  const log = new FakeDecisionLog();
  const provider = new ServedProvider();
  const models = new FakeVersionModels();
  const alertStore = new FakeAlertStore(clock);
  const channel = new FakeChannel<null>();
  const alerts = createAlerts({
    store: alertStore,
    clock,
    channels: [{ name: "ops", deliver: (message) => channel.deliver(message, null) }],
  });
  const spend = countingGate();
  /** A source's loop under `version`: its worker and the held model it shares, as the CLI opens one. */
  const loopAt = (
    version: number,
    questionSet = SCAM_ONLY,
    options: { readonly actions?: WorkerDeps["actions"]; readonly heldModel?: HeldModel } = {},
  ) => {
    const heldModel = options.heldModel ?? holdModel(models, SOURCE_ID, version, clock);
    const worker = createWorker({
      connector,
      provider,
      log,
      reviews: reviewsOf(new FakeReviewQueue(), SOURCE_ID),
      actions: options.actions ?? [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet,
      version,
      heldModel,
      alerts: alerts.signals(SCOPE),
      spending: spend,
    });
    return { worker, heldModel };
  };
  const delivered = () => channel.delivered.map((delivery) => delivery.message.text);
  const edit = (keys: readonly string[]) => {
    for (const key of keys) {
      db.edit(key, { body: key });
    }
  };
  return {
    clock,
    db,
    connector,
    log,
    provider,
    models,
    alertStore,
    alerts,
    spend,
    loopAt,
    delivered,
    edit,
  };
}

/** Records `k00`, `k01`, … */
const keysOf = (count: number) =>
  Array.from({ length: count }, (_, n) => `k${String(n).padStart(2, "0")}`);

/** Passes until one claims nothing, as the worker's loop goes on at once after a clean pass. */
async function untilQuiet(worker: { runOnce(): Promise<{ readonly claimed: number }> }) {
  let claimed: number;
  do {
    ({ claimed } = await worker.runOnce());
  } while (claimed > 0);
}

describe("a response naming another model than its version's", () => {
  it("never reaches the log or the record, and the record waits in the queue for the held model", async () => {
    const r = await rig();
    const { worker, heldModel } = r.loopAt(3);
    r.edit(["a"]);
    expect((await worker.runOnce()).written).toEqual(["a"]);
    // The version's first answer named the model it is held to.
    expect(r.models.held.get(`${SOURCE_ID}@v3`)).toBe(HELD);

    r.provider.served = OTHER;
    r.edit(["b"]);
    const changed = await worker.runOnce();

    expect(changed.written).toEqual([]);
    expect(changed.failures).toHaveLength(1);
    const [failure] = changed.failures;
    expect(failure?.stage).toBe("ask");
    expect(failure?.error).toBeInstanceOf(ModelChangedError);
    expect(failure?.error).toMatchObject({ version: 3, held: HELD, named: OTHER });
    // Nothing it answered reached the log or a column, and the record is back in the queue, unmarked.
    expect(await r.log.history("b")).toEqual([]);
    expect(r.db.decisionOf("b")).toBeNull();
    expect(r.db.jobs.get("b")).toMatchObject({ claimedBy: null });
    // Paid for, so counted, as every answered call is.
    expect(changed.tokens).toBe(TOKENS);
    expect(r.spend.counted).toEqual([TOKENS, TOKENS]);
    expect(heldModel.holding).toMatchObject({ held: HELD, named: OTHER });

    // The held model answers the next probe, 5 minutes on: the record is written as it should be.
    r.provider.served = HELD;
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);
    expect((await worker.runOnce()).written).toEqual(["b"]);
    expect(heldModel.holding).toBeUndefined();
    expect(await r.log.history("b")).toMatchObject([{ kind: "answer", version: 3, model: HELD }]);
    expect(r.db.decisionOf("b")?.status).toBe("done");
  });

  it("@timing holds the source: one paid call per 5 minutes while 30 wait, all asked once the held model answers", async () => {
    const r = await rig();
    const { worker } = r.loopAt(3);
    r.edit(["a"]);
    await worker.runOnce();

    r.provider.served = OTHER;
    const keys = keysOf(30);
    r.edit(keys);
    const first = await worker.runOnce();
    // The calls already in flight when the first changed answer came back are paid; the rest of the
    // batch waits, unasked.
    const burst = r.provider.requests.length - 1;
    expect(burst).toBeGreaterThan(0);
    expect(burst).toBeLessThanOrEqual(DEFAULT_MAX_IN_FLIGHT);
    expect(first.failures).toHaveLength(burst);
    expect(first.waiting).toHaveLength(DEFAULT_WORKER_LIMITS.claimBatch - burst);
    expect(r.delivered()).toEqual([RAISED]);

    // Three intervals, a pass a minute: one probe per interval, each paid, nothing else asked.
    for (let interval = 0; interval < 3; interval += 1) {
      const before = r.provider.requests.length;
      for (let minute = 0; minute < 5; minute += 1) {
        r.clock.advance(MINUTE);
        const pass = await worker.runOnce();
        expect(pass.written).toEqual([]);
        // Nothing is claimed between probes; a probe's batch asks one record and the rest wait.
        expect(pass.waiting).toHaveLength(Math.max(0, pass.claimed - 1));
        // Still held: the report says when the next probe is due, within the next 5 minutes.
        expect(pass.heldUntil).toBeGreaterThan(r.clock.now());
        expect(pass.heldUntil).toBeLessThanOrEqual(r.clock.now() + MODEL_CHANGED_PROBE_EVERY_MS);
      }
      expect(r.provider.requests.length - before).toBe(1);
    }
    expect(r.spend.counted).toHaveLength(r.provider.requests.length);
    // One alert while it lasts: the probes' changed answers fall inside its 30 minutes.
    expect(r.delivered()).toEqual([RAISED]);
    expect(await r.log.count()).toBe(1);
    for (const key of keys) {
      expect(r.db.decisionOf(key)).toBeNull();
      expect(r.db.jobs.has(key)).toBe(true);
    }

    // The held model is served again: the next probe releases the source, and every waiting record
    // is asked at once, each one time.
    r.provider.served = HELD;
    const before = r.provider.requests.length;
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);
    const released = await worker.runOnce();
    expect(released.written.length).toBeGreaterThan(0);
    expect(released.heldUntil).toBeNull();
    await untilQuiet(worker);
    expect(r.provider.requests.length - before).toBe(keys.length);
    for (const key of keys) {
      expect(r.db.decisionOf(key)?.status).toBe("done");
    }
    expect(r.db.jobs.size).toBe(0);
    await r.alerts.drain();
    expect(r.alertStore.active.has(CHANGED_KEY)).toBe(false);
    expect(r.delivered()).toEqual([RAISED, RESOLVED]);
    expect(r.alertStore.history.map((line) => [line.phase, line.severity])).toEqual([
      ["raised", "critical"],
      ["resolved", "information"],
    ]);
  });

  it("asks every waiting record when a reload starts the loop under a new version, which holds its own name", async () => {
    const r = await rig();
    const old = r.loopAt(3);
    r.edit(["a"]);
    await old.worker.runOnce();
    r.provider.served = OTHER;
    const keys = keysOf(12);
    r.edit(keys);
    await old.worker.runOnce();
    expect(old.heldModel.holding).toBeDefined();
    expect(r.alertStore.active.has(CHANGED_KEY)).toBe(true);

    // The fix the alert names: facetdb.config.ts names the model the server serves, and the reload
    // opens the source's loop under a new version, with nothing handed over but the queue.
    const reloaded = r.loopAt(4, { ...SCAM_ONLY, model: OTHER });
    const before = r.provider.requests.length;
    // Every waiting record, the ones asked once already among them.
    await untilQuiet(reloaded.worker);
    expect(r.provider.requests.length - before).toBe(keys.length);
    for (const key of keys) {
      expect(r.db.decisionOf(key)?.status).toBe("done");
      expect(await r.log.history(key)).toMatchObject([{ version: 4, model: OTHER }]);
    }
    expect(r.models.held.get(`${SOURCE_ID}@v4`)).toBe(OTHER);
    expect(r.models.held.get(`${SOURCE_ID}@v3`)).toBe(HELD);
    // The source runs under the new version: Model changed is resolved.
    await r.alerts.drain();
    expect(r.alertStore.active.has(CHANGED_KEY)).toBe(false);
    expect(r.delivered()).toEqual([RAISED, RESOLVED]);
  });

  it("spends a probe only on a model request: a head record needing no call leaves it to the next", async () => {
    const r = await rig();
    // The store refuses the action rows of `a`: answered once, it is released and claimed again at
    // every pass, settled each time from the log with no model call.
    const refusing: WorkerDeps["actions"][number] = {
      name: "notify",
      run: (record) =>
        record.key === "a"
          ? Promise.reject(new ActionNotQueued("the store refused the action row"))
          : Promise.resolve(),
    };
    const { worker, heldModel } = r.loopAt(3, SCAM_ONLY, { actions: [refusing] });
    r.edit(["a"]);
    expect((await worker.runOnce()).written).toEqual(["a"]);
    r.provider.served = OTHER;
    r.edit(["b"]);
    await worker.runOnce();
    expect(heldModel.holding).toBeDefined();
    expect(r.db.jobs.has("a") && r.db.jobs.has("b")).toBe(true);

    // The held model is back. At the probe, `a` needs no call and spends nothing; `b` is asked.
    r.provider.served = HELD;
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);
    const before = r.provider.requests.length;
    const probe = await worker.runOnce();
    expect(probe.alreadyAnswered).toEqual([]);
    expect(probe.written).toEqual(["b"]);
    expect(r.provider.requests.length - before).toBe(1);
    expect(heldModel.holding).toBeUndefined();
    expect(probe.heldUntil).toBeNull();
  });

  it("lets a check call see the hold and never take the loop's probe", async () => {
    const r = await rig();
    const loop = r.loopAt(3);
    r.edit(["a"]);
    await loop.worker.runOnce();
    r.provider.served = OTHER;
    r.edit(["b"]);
    await loop.worker.runOnce();
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);
    const before = r.provider.requests.length;

    // A check call's worker over the loop's held model, at the very time its probe is due.
    const check = r.loopAt(3, SCAM_ONLY, { heldModel: withoutProbe(loop.heldModel) });
    const pass = await check.worker.runOnce();
    expect(pass.claimed).toBe(0);
    expect(pass.heldUntil).toBe(loop.heldModel.probeAt);
    expect(r.provider.requests.length).toBe(before);
    expect(loop.heldModel.probeDue()).toBe(true);

    // The probe is still the loop's to ask.
    await loop.worker.runOnce();
    expect(r.provider.requests.length).toBe(before + 1);
  });

  it("passes a response naming the held model with no extra request and no store call after the first", async () => {
    const r = await rig();
    const { worker } = r.loopAt(3);
    r.edit(["a", "b", "c", "d", "e"]);
    // Five lanes answer at once: their first answers share the one store call.
    expect((await worker.runOnce()).written).toHaveLength(5);
    r.edit(["f"]);
    expect((await worker.runOnce()).written).toEqual(["f"]);

    expect(r.provider.requests).toHaveLength(6);
    expect(r.models.calls).toBe(1);
  });

  it("is checked by the backfill of an added question, which holds the loop and asks nothing while held", async () => {
    const r = await rig();
    const keys = ["a", "b", "c"];
    r.edit(keys);
    await r.loopAt(3).worker.runOnce();
    // The added question's version 4 was first answered by the held model, which is now swapped.
    r.models.held.set(`${SOURCE_ID}@v4`, HELD);
    r.provider.served = OTHER;
    const loop = r.loopAt(4, SCAM_AND_SPAM);
    const before = keys.map((key) => r.db.decisionOf(key));
    const logged = await r.log.count();
    const asked = r.provider.requests.length;
    const backfill = () =>
      createBackfill({
        project: SCOPE.project,
        source: SCOPE.source,
        connector: r.connector,
        worker: r.provider,
        clock: r.clock,
        cursorStore: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
        log: r.log,
        questionSet: SCAM_AND_SPAM,
        version: 4,
        // A studio backfill job checks through its loop's held model.
        heldModel: loop.heldModel,
        alerts: r.alerts.signals(SCOPE),
        spending: r.spend,
        reviews: reviewsOf(new FakeReviewQueue(), SOURCE_ID),
      }).run({ onlyQuestions: ["spam"], maxInFlight: 1, onEstimate: () => true });

    const report = await backfill();

    expect(report.status).toBe("stopped");
    expect(report.answered).toEqual([]);
    // The first changed answer ends the run: nothing more is asked.
    expect(r.provider.requests).toHaveLength(asked + 1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toMatchObject({
      version: 4,
      held: HELD,
      named: OTHER,
      message: `${what(4)} ${DID}`,
    });
    expect(await r.log.count()).toBe(logged);
    expect(keys.map((key) => r.db.decisionOf(key))).toEqual(before);
    expect(r.db.jobs.size).toBe(0);
    // The same alert, in the same words, beside the backfill's own.
    expect(r.delivered()).toContain(raised(4));

    // The loop is held with it: a change made now waits, and a second run asks nothing at all.
    r.edit(["d"]);
    expect((await loop.worker.runOnce()).claimed).toBe(0);
    const again = await backfill();
    expect(again.status).toBe("stopped");
    expect(again.failures[0]?.error).toBeInstanceOf(ModelChangedError);
    expect(r.provider.requests).toHaveLength(asked + 1);
  });

  it("quotes a server's name as plain text: no markup, emphasis or link, cut at 80 characters, never inside one", () => {
    expect(modelNameWords(HELD)).toBe(HELD);
    expect(modelNameWords("meta-llama/Llama-3.1-8B:latest")).toBe("meta-llama/Llama-3.1-8B:latest");
    expect(modelNameWords("qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
    const override = String.fromCodePoint(0x202e);
    expect(modelNameWords(`evil\u0000<!channel>${override}model\n*bold* @here`)).toBe(
      "evilchannelmodelbold here",
    );
    // A link and emphasis in Slack and email: defanged and stripped, so neither renders.
    expect(modelNameWords("https://evil.example/x")).toBe("https[:]//evil[.]example/x");
    expect(modelNameWords("_x_")).toBe("x");
    expect(modelNameWords("10.0.0.1:8080/x")).toBe("10[.]0[.]0[.]1:8080/x");
    // 78 letters and three letters outside the basic plane: 81 characters, cut to 79 and "…".
    const script = String.fromCodePoint(0x1d49c);
    expect(modelNameWords(`${"a".repeat(78)}${script.repeat(3)}`)).toBe(
      `${"a".repeat(78)}${script}…`,
    );
    expect(modelNameWords("<>*")).toBe("(a name with nothing printable)");
  });
});
