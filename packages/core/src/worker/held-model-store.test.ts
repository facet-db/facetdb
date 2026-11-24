import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
  FakeVersionModels,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type {
  ModelProvider,
  ProbeClaim,
  ProviderRequest,
  ProviderResponse,
} from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import { reviewsOf } from "../review/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { holdModel, MODEL_CHANGED_PROBE_EVERY_MS, ModelChangedError } from "./held-model.ts";
import { createWorker, DEFAULT_WORKER_LIMITS } from "./worker.ts";

/**
 * A source's model-changed hold is kept in the store, not in one worker's memory. A worker that
 * opens while its source is held starts held (it claims nothing and sends no request until a probe
 * is claimed), the store's claim lets one probe go per 5 minutes among every worker, and a probe
 * answered by the held model releases the source for every worker. Two workers here are two loops
 * over one fake store, one fake database and one model server.
 */

const SOURCE_ID = "marketplace:listings";
const VERSION = 3;
const HELD = "jev-1.14.0";
/** The publisher's Strands Decider server answers under its own name, whatever is asked. */
const OTHER = "strands-decider-7b";
const MINUTE = 60_000;
const SET: QuestionSet = {
  questions: [{ type: "noul", name: "scam", instructions: "A scam?", stakes: "low" }],
  read: ["body"],
  model: HELD,
  thresholds: {},
};

/** No cap: every request may go. */
const UNLIMITED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("unlimited"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

/** The model server every worker reaches: it answers under the name it serves now. */
type Server = { served: string };

/** One worker's view of the server, remembering the requests this worker sent. */
class ServedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return Promise.resolve({
      model: this.#server.served,
      answers: { scam: { type: "noul", probability: 0.95 } },
      usage: { inputTokens: 100, outputTokens: 1 },
    });
  }
}

async function rig(models = new FakeVersionModels()) {
  const clock = new FakeClock(1_000_000);
  const db = new FakeDatabase({ fields: ["body"], clock });
  const log = new FakeDecisionLog();
  const server: Server = { served: HELD };
  let installed = false;
  /** A worker's loop as the CLI opens one: its hold read from the store before its first claim. */
  const open = async () => {
    const connector = new FakeConnector(db);
    if (!installed) {
      await connector.install();
      installed = true;
    }
    const provider = new ServedProvider(server);
    const heldModel = await holdModel(models, SOURCE_ID, VERSION, clock);
    const worker = createWorker({
      connector,
      provider,
      log,
      reviews: reviewsOf(new FakeReviewQueue(), SOURCE_ID),
      actions: [],
      clock,
      limits: DEFAULT_WORKER_LIMITS,
      questionSet: SET,
      version: VERSION,
      heldModel,
      spending: UNLIMITED,
    });
    return { worker, heldModel, provider };
  };
  const edit = (keys: readonly string[]) => {
    for (const key of keys) {
      db.edit(key, { body: key });
    }
  };
  return { clock, db, models, server, open, edit };
}

/** Passes until one claims nothing. */
async function untilQuiet(worker: { runOnce(): Promise<{ readonly claimed: number }> }) {
  let claimed: number;
  do {
    ({ claimed } = await worker.runOnce());
  } while (claimed > 0);
}

/** A rig whose first worker has answered once under the held model and is then held by a swap. */
async function heldByTheFirst(models?: FakeVersionModels) {
  const r = await rig(models);
  const first = await r.open();
  r.edit(["a"]);
  expect((await first.worker.runOnce()).written).toEqual(["a"]);
  r.server.served = OTHER;
  r.edit(["b"]);
  await first.worker.runOnce();
  expect(first.heldModel.holding).toBeInstanceOf(ModelChangedError);
  return { ...r, first, heldAt: r.clock.now() };
}

describe("the model-changed hold kept in the store", () => {
  it("@timing starts held a worker opened while its source is held: it claims nothing and asks nothing until its probe is due", async () => {
    const r = await heldByTheFirst();
    // The store holds the version under the name the changed response gave, and the probe time.
    expect(r.models.holds.get(`${SOURCE_ID}@v${VERSION}`)).toEqual({
      named: OTHER,
      probeAt: r.heldAt + MODEL_CHANGED_PROBE_EVERY_MS,
    });
    r.edit(["c", "d", "e"]);

    // A restarted or second worker opens: held before its first claim, with the store's probe time.
    const answeredBy = r.models.calls;
    const second = await r.open();
    expect(second.heldModel.holding).toMatchObject({ version: VERSION, held: HELD, named: OTHER });
    expect(second.heldModel.probeAt).toBe(r.heldAt + MODEL_CHANGED_PROBE_EVERY_MS);

    // Four minutes of passes: nothing claimed, no model request, every record still queued.
    for (let minute = 0; minute < 4; minute += 1) {
      r.clock.advance(MINUTE);
      const pass = await second.worker.runOnce();
      expect(pass.claimed).toBe(0);
      expect(pass.heldUntil).toBe(r.heldAt + MODEL_CHANGED_PROBE_EVERY_MS);
    }
    expect(second.provider.requests).toEqual([]);
    for (const key of ["b", "c", "d", "e"]) {
      expect(r.db.jobs.get(key)).toEqual({ claimedBy: null });
    }

    // At the probe time, one record is asked, as the probe; the server still answers as another.
    r.clock.advance(MINUTE);
    const probe = await second.worker.runOnce();
    expect(second.provider.requests).toHaveLength(1);
    expect(probe.written).toEqual([]);
    expect(second.heldModel.holding).toBeDefined();
    // The name held came with the hold: the second worker asked the store for it nowhere else.
    expect(r.models.calls).toBe(answeredBy);
  });

  it("@timing lets one probe go per 5 minutes among workers that each met the changed model", async () => {
    const r = await rig();
    const one = await r.open();
    const two = await r.open();
    r.edit(["a"]);
    await one.worker.runOnce();

    // The server is swapped while both run: each pays its own changed answers once, and both hold.
    r.server.served = OTHER;
    r.edit(["b", "c", "d", "e", "f", "g"]);
    await one.worker.runOnce();
    const heldAt = r.clock.now();
    r.clock.advance(MINUTE);
    r.edit(["h", "i"]);
    await two.worker.runOnce();
    expect(one.heldModel.holding).toBeDefined();
    expect(two.heldModel.holding).toBeDefined();
    // The second hold, a minute later, kept the first's probe time: the fleet keeps one.
    expect(one.heldModel.probeAt).toBe(heldAt + MODEL_CHANGED_PROBE_EVERY_MS);
    expect(two.heldModel.probeAt).toBe(heldAt + MODEL_CHANGED_PROBE_EVERY_MS);
    const asked = () => one.provider.requests.length + two.provider.requests.length;

    // Three intervals, a pass a minute from each worker, in turns: one probe per interval in all.
    for (let interval = 0; interval < 3; interval += 1) {
      const before = asked();
      for (let minute = 0; minute < 5; minute += 1) {
        r.clock.advance(MINUTE);
        const order = interval % 2 === 0 ? [one, two] : [two, one];
        for (const { worker } of order) {
          expect((await worker.runOnce()).written).toEqual([]);
        }
      }
      expect(asked() - before).toBe(1);
    }
    // The probe went to whichever worker claimed it first; the other was told the next time.
    expect(r.models.holdCalls.filter((call) => call === "claim").length).toBeGreaterThanOrEqual(3);
  });

  it("is released for every worker by one probe the held model answers", async () => {
    const r = await heldByTheFirst();
    const second = await r.open();
    expect(second.heldModel.holding).toBeDefined();

    // The held model is served again. The first worker's probe (`b`) is answered by it: written,
    // and the store lets the version go.
    r.server.served = HELD;
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);
    const probe = await r.first.worker.runOnce();
    expect(probe.written).toEqual(["b"]);
    expect(r.first.heldModel.holding).toBeUndefined();
    expect(r.models.holds.size).toBe(0);

    // The second worker, still held in its own memory, learns it from the store at its probe
    // time, and asks every record once, with no store write of its own.
    const keys = ["c", "d", "e", "f"];
    r.edit(keys);
    await untilQuiet(second.worker);
    expect(second.heldModel.holding).toBeUndefined();
    expect(second.provider.requests).toHaveLength(4);
    for (const key of ["b", ...keys]) {
      expect(r.db.decisionOf(key)?.status).toBe("done");
    }
    expect(r.db.jobs.size).toBe(0);
    expect(r.models.holdCalls.filter((call) => call === "clear")).toHaveLength(1);
    expect(r.models.holdCalls.at(-1)).toBe("claim");
  });

  it("never asks when the store cannot claim the probe: the record waits and the next one claims again", async () => {
    let refuse = true;
    const models = new (class extends FakeVersionModels {
      override claimProbe(
        sourceId: string,
        version: number,
        now: number,
        next: number,
      ): Promise<ProbeClaim> {
        if (refuse) {
          return Promise.reject(new Error("the store is unreachable"));
        }
        return super.claimProbe(sourceId, version, now, next);
      }
    })();
    const r = await heldByTheFirst(models);
    const asked = r.first.provider.requests.length;
    r.clock.advance(MODEL_CHANGED_PROBE_EVERY_MS);

    const failed = await r.first.worker.runOnce();
    expect(r.first.provider.requests).toHaveLength(asked);
    expect(failed.failures.map((failure) => String(failure.error))).toContain(
      "Error: the store is unreachable",
    );
    expect(r.db.jobs.get("b")).toEqual({ claimedBy: null });

    // The store answers again: the probe is claimed and asked at once, not 5 minutes later.
    refuse = false;
    await r.first.worker.runOnce();
    expect(r.first.provider.requests).toHaveLength(asked + 1);
  });
});
