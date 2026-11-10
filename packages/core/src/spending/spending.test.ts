import { FakeClock, FakeConnector, FakeDatabase, FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  type ActiveAlert,
  type AlertEvent,
  type AlertOutcome,
  type AlertStore,
  type Alerts,
  type BoundChannel,
  createAlerts,
} from "../alerts/index.ts";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  RecordKey,
} from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { createWorker, DEFAULT_WORKER_LIMITS } from "../worker/index.ts";
import {
  createSpending,
  monthOf,
  RESERVATION_LEASE_MS,
  type Spending,
  type SpendingAlertKind,
  type SpendingCap,
  type SpendingGate,
  spendingGate,
  type UsageStore,
} from "./index.ts";

const PROJECT = "market";
const OCT_15 = Date.UTC(2026, 9, 15, 9);
const OCT_31_NOON = Date.UTC(2026, 9, 31, 12);
const NOV_1 = Date.UTC(2026, 10, 1, 0);
const HOUR = 3_600_000;
const POLL_MS = 2_000;
const SURE_YES = 0.95;

const PAUSE_AT_1000: SpendingCap = { inputTokens: 1_000, onCapReached: "pause" };
const CONTINUE_AT_1000: SpendingCap = { inputTokens: 1_000, onCapReached: "continue" };

/**
 * Keeps the totals, the reservations and the alerts claimed, as the database would. Every process in a
 * test that shares one instance shares its reservations, as processes on one database do.
 */
class MemoryUsageStore implements UsageStore {
  readonly #totals = new Map<string, number>();
  readonly #reservations = new Map<
    string,
    { projectId: string; month: string; tokens: number; expiresAt: number }
  >();
  readonly #claimed = new Set<string>();
  #issued = 0;

  add(projectId: string, month: string, inputTokens: number): Promise<void> {
    const key = [projectId, month].join("|");
    this.#totals.set(key, (this.#totals.get(key) ?? 0) + inputTokens);
    return Promise.resolve();
  }

  total(projectId: string, month: string): Promise<number> {
    return Promise.resolve(this.#totals.get([projectId, month].join("|")) ?? 0);
  }

  reserve(
    projectId: string,
    month: string,
    requestTokens: number,
    limit: number | undefined,
    now: number,
    expiresAt: number,
  ): Promise<string | undefined> {
    // The check and the reservation are one synchronous step, as the store's conditional update is.
    const counted = this.#totals.get([projectId, month].join("|")) ?? 0;
    let open = 0;
    for (const held of this.#reservations.values()) {
      if (held.projectId === projectId && held.month === month && held.expiresAt > now) {
        open += held.tokens;
      }
    }
    if (limit !== undefined && counted + open >= limit) {
      return Promise.resolve(undefined);
    }
    this.#issued += 1;
    const id = `reservation-${this.#issued}`;
    this.#reservations.set(id, { projectId, month, tokens: requestTokens, expiresAt });
    return Promise.resolve(id);
  }

  release(projectId: string, reservation: string): Promise<void> {
    if (this.#reservations.get(reservation)?.projectId === projectId) {
      this.#reservations.delete(reservation);
    }
    return Promise.resolve();
  }

  claimAlert(projectId: string, month: string, kind: SpendingAlertKind): Promise<boolean> {
    const key = [projectId, month, kind].join("|");
    if (this.#claimed.has(key)) {
      return Promise.resolve(false);
    }
    this.#claimed.add(key);
    return Promise.resolve(true);
  }

  releaseAlert(projectId: string, month: string, kind: SpendingAlertKind): Promise<void> {
    this.#claimed.delete([projectId, month, kind].join("|"));
    return Promise.resolve();
  }
}

/** A usage store that refuses its next `failAdds` writes, as a database that is briefly down does. */
class FlakyUsageStore extends MemoryUsageStore {
  failAdds = 0;

  override add(projectId: string, month: string, inputTokens: number): Promise<void> {
    if (this.failAdds > 0) {
      this.failAdds -= 1;
      return Promise.reject(new Error("usage store down"));
    }
    return super.add(projectId, month, inputTokens);
  }
}

/** A usage store whose writes wait until the test lets them through, oldest first. */
class HeldUsageStore extends FlakyUsageStore {
  holdWrites = false;
  readonly #held: Array<() => void> = [];

  override async add(projectId: string, month: string, inputTokens: number): Promise<void> {
    if (this.holdWrites) {
      await new Promise<void>((resolve) => this.#held.push(resolve));
    }
    await super.add(projectId, month, inputTokens);
  }

  /** Lets the oldest held write reach the store. */
  letThrough(): void {
    this.#held.shift()?.();
  }
}

/** The active alerts the real alerts module keeps, in memory. */
class MemoryAlertStore implements AlertStore {
  readonly #active = new Map<string, ActiveAlert>();
  readonly #beats = new Map<string, number>();

  getActive(key: string): Promise<ActiveAlert | undefined> {
    return Promise.resolve(this.#active.get(key));
  }
  setActive(key: string, alert: ActiveAlert): Promise<void> {
    this.#active.set(key, alert);
    return Promise.resolve();
  }
  clearActive(key: string): Promise<void> {
    this.#active.delete(key);
    return Promise.resolve();
  }
  append(): Promise<void> {
    return Promise.resolve();
  }
  lastHeartbeat(project: string): Promise<number | undefined> {
    return Promise.resolve(this.#beats.get(project));
  }
  saveHeartbeat(project: string, at: number): Promise<void> {
    this.#beats.set(project, at);
    return Promise.resolve();
  }
}

/**
 * Remembers every alert it was asked to raise; the real alerts module has its own tests. With
 * `outage` set, every channel refuses each alert (`refuse`) or the raise itself fails (`throw`).
 */
class FakeAlerts implements Pick<Alerts, "raise"> {
  readonly events: AlertEvent[] = [];
  outage: "none" | "refuse" | "throw" = "none";

  raise(event: AlertEvent): Promise<AlertOutcome> {
    this.events.push(event);
    if (this.outage === "throw") {
      return Promise.reject(new Error("alert store unreachable"));
    }
    const failures =
      this.outage === "refuse"
        ? [
            { channel: "email", error: new Error("smtp down") },
            { channel: "slack", error: new Error("webhook 503") },
          ]
        : [];
    return Promise.resolve({ status: "sent", failures });
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }
}

function setup(start = OCT_15) {
  const clock = new FakeClock(start);
  const usage = new MemoryUsageStore();
  const alerts = new FakeAlerts();
  const spending = createSpending({
    usageStore: usage,
    clock,
    alerts,
    capLink: (project) => `https://app.facetdb.test/projects/${project}/settings#spending`,
  });
  return { clock, usage, alerts, spending };
}

describe("spending: a count whose write failed", () => {
  it("is written by the next admission, so the cap still holds and nothing is counted twice", async () => {
    const clock = new FakeClock(OCT_15);
    const usage = new FlakyUsageStore();
    const spending = createSpending({
      usageStore: usage,
      clock,
      alerts: new FakeAlerts(),
      capLink: (project) => `https://app.facetdb.test/projects/${project}/settings#spending`,
    });

    usage.failAdds = 1;
    await expect(spending.record(PROJECT, 1_000)).rejects.toThrow("usage store down");

    // The store is back: the admission writes the held 1,000 first, which puts the project at its cap.
    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 50)).toBeUndefined();
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_000);

    await spending.record(PROJECT, 50);
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_050);
  });

  // Known gap, closed once `facetdb.usage` exists in the store. The held count lives in this
  // process's memory, so a restart before the store takes it loses a paid answer. This test asserts
  // the required behaviour, so it fails on the current code and `it.fails` passes; when the store
  // persists the count it turns red, and that is the signal to change `it.fails` to `it`.
  it.fails("known gap: a count whose write failed survives a restart before the store takes it", async () => {
    const clock = new FakeClock(OCT_15);
    const usage = new FlakyUsageStore();
    const capLink = (project: string) =>
      `https://app.facetdb.test/projects/${project}/settings#spending`;
    const before = createSpending({ usageStore: usage, clock, alerts: new FakeAlerts(), capLink });

    usage.failAdds = 1;
    await expect(before.record(PROJECT, 1_000)).rejects.toThrow("usage store down");

    // The process dies here; a new one starts on the same usage store and must still see the 1,000.
    const after = createSpending({ usageStore: usage, clock, alerts: new FakeAlerts(), capLink });
    expect(await after.monthlyTotal(PROJECT)).toBe(1_000);
  });

  it("a record resolves only once its own count is in the store, even while another call writes it", async () => {
    const clock = new FakeClock(OCT_15);
    const usage = new HeldUsageStore();
    const spending = createSpending({
      usageStore: usage,
      clock,
      alerts: new FakeAlerts(),
      capLink: (project) => `https://app.facetdb.test/projects/${project}/settings#spending`,
    });
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    // 600 is held (its write failed); 500 is the answer whose record is under test.
    usage.failAdds = 1;
    await expect(spending.record(PROJECT, 600)).rejects.toThrow("usage store down");
    usage.holdWrites = true;
    let answerDone = false;
    const answer = spending.record(PROJECT, 500).then(() => {
      answerDone = true;
    });
    // A second call takes the 500 out of the held list and starts writing it.
    const other = spending.monthlyTotal(PROJECT);
    await flush(); // the store is now holding the first write

    usage.letThrough(); // the 600 reaches the store
    await flush();
    // The record may not report done while its own 500 is still on its way to the store.
    expect(answerDone).toBe(false);

    // An admission made now must see the 500 too: 600 + 500 is over the cap, so no request goes out.
    const admitted = spending.admit(PROJECT, PAUSE_AT_1000, 50);
    usage.letThrough(); // the 500 reaches the store
    expect(await admitted).toBeUndefined();
    await answer;
    expect(await other).toBe(1_100);
  });
});

/** Admits one request that must go; the test has no use for a refusal here. */
async function admitted(spending: Spending, requestTokens: number): Promise<string> {
  const reservation = await spending.admit(PROJECT, PAUSE_AT_1000, requestTokens);
  if (reservation === undefined) {
    throw new Error(`a request of ${requestTokens} tokens was refused`);
  }
  return reservation;
}

describe("spending: a reservation whose request died in flight", () => {
  // The objection this guards: a process that dies with a request in flight never settles it. Without a
  // lease the headroom stayed reserved for good, so once it reached the cap nothing was admitted again.
  it("gives the headroom back once the lease has passed, and holds it until then", async () => {
    const { clock, spending } = setup();
    // Two requests of 600 fill past the 1,000 cap; the process that admitted them then dies, unsettled.
    await admitted(spending, 600);
    await admitted(spending, 600);
    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeUndefined();

    clock.advance(RESERVATION_LEASE_MS - 1);
    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeUndefined();

    clock.advance(1);
    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeDefined();
  });

  // A reservation names its month. October's open reservations do not hold November's headroom, even
  // inside their lease.
  it("counts only for its own month", async () => {
    const { clock, spending } = setup(Date.UTC(2026, 9, 31, 23, 55));
    await admitted(spending, 600);
    await admitted(spending, 600);
    clock.advance(6 * 60_000); // 00:01 on the 1st: both October reservations are still inside their lease

    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeDefined();
  });

  // Each reservation is its own: settling one whose lease has passed must not release a newer one.
  it("settling a reservation whose lease has passed leaves the newer reservations in place", async () => {
    const { clock, spending } = setup();
    const old = await admitted(spending, 600);
    clock.advance(RESERVATION_LEASE_MS);
    await admitted(spending, 600);
    await admitted(spending, 600);
    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeUndefined();

    await spending.settle(PROJECT, old);

    expect(await spending.admit(PROJECT, PAUSE_AT_1000, 600)).toBeUndefined();
  });
});

describe("spending: counting and the month", () => {
  it("the count equals the sum of the input tokens recorded, per project", async () => {
    const { spending } = setup();
    await spending.record(PROJECT, 120);
    await spending.record(PROJECT, 45);
    await spending.record(PROJECT, 300);
    await spending.record("orders", 999);

    expect(await spending.monthlyTotal(PROJECT)).toBe(465);
    expect(await spending.monthlyTotal("orders")).toBe(999);
  });

  it("reads the month in UTC and names it as YYYY-MM", () => {
    expect(monthOf(OCT_31_NOON)).toBe("2026-10");
    expect(monthOf(NOV_1)).toBe("2026-11");
  });

  it("@timing the month boundary resets the count at 00:00 UTC", async () => {
    const { clock, spending } = setup(OCT_31_NOON);
    await spending.record(PROJECT, 700);
    expect(await spending.monthlyTotal(PROJECT)).toBe(700);

    clock.advance(12 * HOUR - 1);
    expect(await spending.monthlyTotal(PROJECT)).toBe(700);
    clock.advance(1);
    expect(await spending.monthlyTotal(PROJECT)).toBe(0);
  });
});

describe("spending: the 80% warning and the cap", () => {
  it("is ok below 80% and warns at exactly 80%, with no comparison rounded", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 799);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("ok");
    expect(alerts.events).toEqual([]);

    await spending.record(PROJECT, 1);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("warned");
    expect(alerts.kinds()).toEqual(["spending_80"]);
    expect(alerts.events[0]).toMatchObject({
      kind: "spending_80",
      project: PROJECT,
      source: "all sources",
      question: null,
      link: "https://app.facetdb.test/projects/market/settings#spending",
    });
    expect(alerts.events[0]?.what).toContain("800 of 1000 input tokens");
  });

  it("warns once per month, however many answers follow", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 800);
    await spending.status(PROJECT, PAUSE_AT_1000);
    await spending.record(PROJECT, 50);
    await spending.status(PROJECT, PAUSE_AT_1000);
    await spending.status(PROJECT, PAUSE_AT_1000);

    expect(alerts.kinds()).toEqual(["spending_80"]);
  });

  it("pauses at exactly the cap, and a jump past both levels raises each alert once", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 999);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("warned");

    await spending.record(PROJECT, 1);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);

    const { spending: jump, alerts: jumpAlerts } = setup();
    await jump.record(PROJECT, 1_500);
    expect(await jump.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(jumpAlerts.kinds()).toEqual(["spending_80", "spending_paused"]);
  });

  it("continue keeps the project answering at 100%, with no pause alert", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 1_000);
    expect(await spending.status(PROJECT, CONTINUE_AT_1000)).toBe("continuing");
    expect(alerts.kinds()).toEqual(["spending_80"]);
    expect(alerts.events[0]?.did).toContain("keeps answering");
  });

  it("@timing a new month resets the status, and the next month's warning goes out again", async () => {
    const { clock, spending, alerts } = setup(OCT_31_NOON);
    await spending.record(PROJECT, 1_000);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");

    clock.advance(12 * HOUR);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("ok");
    await spending.record(PROJECT, 800);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("warned");
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused", "spending_80"]);
  });

  it("an alert every channel refused is raised again on the next check, not lost for the month", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 1_000);
    alerts.outage = "refuse";
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);

    alerts.outage = "none";
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(alerts.kinds()).toEqual([
      "spending_80",
      "spending_paused",
      "spending_80",
      "spending_paused",
    ]);

    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(alerts.kinds()).toHaveLength(4);
  });

  it("an alert whose raise fails gives its claim back, and the error still reaches the caller", async () => {
    const { spending, alerts } = setup();
    await spending.record(PROJECT, 800);
    alerts.outage = "throw";
    await expect(spending.status(PROJECT, PAUSE_AT_1000)).rejects.toThrow(
      "alert store unreachable",
    );

    alerts.outage = "none";
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("warned");
    expect(alerts.kinds()).toEqual(["spending_80", "spending_80"]);
  });

  it("with every channel down, each alert is attempted at each check until a channel takes it, then holds for the month", async () => {
    const clock = new FakeClock(OCT_15);
    const usage = new MemoryUsageStore();
    let channelDown = true;
    let attempts = 0;
    const channels: BoundChannel[] = [
      {
        name: "email",
        deliver: () => {
          attempts += 1;
          return channelDown ? Promise.reject(new Error("smtp down")) : Promise.resolve();
        },
      },
    ];
    const alerts = createAlerts({ store: new MemoryAlertStore(), clock, channels });
    const spending = createSpending({
      usageStore: usage,
      clock,
      alerts,
      capLink: (project) => `https://app.facetdb.test/projects/${project}/settings#spending`,
    });
    await spending.record(PROJECT, 1_000);
    const poll = async (): Promise<void> => {
      expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
      clock.advance(POLL_MS);
    };

    // Each poll tries both alerts again: the alerts module retries at the next raise, and a refused
    // alert gives its claim back.
    await poll();
    await poll();
    await poll();
    expect(attempts).toBe(6);

    // A channel that is back takes the next attempt, and the claim then holds for the month.
    channelDown = false;
    await poll();
    expect(attempts).toBe(8);
    await poll();
    await poll();
    expect(attempts).toBe(8);
  });

  it("a changed cap takes effect at once: raising it resumes a paused project", async () => {
    const { spending } = setup();
    await spending.record(PROJECT, 1_000);
    expect(await spending.status(PROJECT, PAUSE_AT_1000)).toBe("paused");
    expect(await spending.status(PROJECT, { inputTokens: 5_000, onCapReached: "pause" })).toBe(
      "ok",
    );
  });
});

/** A provider whose answers wait until the test releases them, so requests overlap in flight. */
class HeldProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #answers: Array<() => void> = [];

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.#answers.push(() =>
        resolve({
          model: "jev-1.14.0",
          answers: { scam: { type: "noul", probability: SURE_YES } },
          usage: { inputTokens: 120, outputTokens: 8 },
        }),
      );
    });
  }

  answerAll(): void {
    for (const answer of this.#answers.splice(0)) {
      answer();
    }
  }
}

/**
 * One worker per gate, all on one database queue (as separate worker processes share one), each
 * claiming a single record. Records `a`, `b`, `c` are queued.
 */
async function workersOnOneQueue(
  gates: readonly SpendingGate[],
  provider: ModelProvider,
  clock: FakeClock,
) {
  const db = new FakeDatabase({ fields: ["body"] });
  const log = new FakeDecisionLog([]);
  await new FakeConnector(db).install();
  const workers = gates.map((gate) =>
    createWorker({
      connector: new FakeConnector(db),
      provider,
      log,
      reviews: { withdraw: () => Promise.resolve() },
      actions: [],
      clock,
      limits: { ...DEFAULT_WORKER_LIMITS, claimBatch: 1 },
      questionSet,
      version: 1,
      spending: gate,
    }),
  );
  for (const key of ["a", "b", "c"] satisfies RecordKey[]) {
    db.edit(key, { body: `listing ${key}` });
  }
  return { db, workers };
}

/** A provider that counts its input tokens per call, so a test can compare the sum. */
class CountingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #inputTokensFor: (call: number) => number;

  constructor(inputTokensFor: (call: number) => number) {
    this.#inputTokensFor = inputTokensFor;
  }

  ask(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const inputTokens = this.#inputTokensFor(this.requests.length);
    return Promise.resolve({
      model: "jev-1.14.0",
      answers: { scam: { type: "noul", probability: SURE_YES } },
      usage: { inputTokens, outputTokens: 8 },
    });
  }
}

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};

const questionSet: QuestionSet = {
  questions: [scam],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** A worker over one database, with the given spending gate; records `a`, `b`, `c` are queued. */
async function workerWith(
  gate: SpendingGate,
  provider: ModelProvider,
  clock: FakeClock,
  limits: typeof DEFAULT_WORKER_LIMITS = DEFAULT_WORKER_LIMITS,
) {
  const db = new FakeDatabase({ fields: ["body"] });
  const connector = new FakeConnector(db);
  await connector.install();
  const worker = createWorker({
    connector,
    provider,
    log: new FakeDecisionLog([]),
    reviews: { withdraw: () => Promise.resolve() },
    actions: [],
    clock,
    limits,
    questionSet,
    version: 1,
    spending: gate,
  });
  for (const key of ["a", "b", "c"] satisfies RecordKey[]) {
    db.edit(key, { body: `listing ${key}` });
  }
  return { db, worker };
}

describe("spending in the worker", () => {
  it("a paused project claims nothing: no model call, the queue is the same size, every record stays pending", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 1_000);
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000));
    const { db, worker } = await workerWith(gate, provider, clock);
    const queuedBefore = db.jobs.entries().length;

    const report = await worker.runOnce();

    expect(report.paused).toBe(true);
    expect(report.claimed).toBe(0);
    expect(report.failures).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(db.jobs.entries().length).toBe(queuedBefore);
    expect(db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(db.decisionOf("a")).toBeNull();
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);
  });

  it("an unreadable cap fails closed: nothing is claimed and the failure is reported", async () => {
    const { clock, spending } = setup();
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.reject(new Error("cap unreadable")));
    const { db, worker } = await workerWith(gate, provider, clock);

    const report = await worker.runOnce();

    expect(report.claimed).toBe(0);
    expect(report.failures).toMatchObject([{ stage: "spending", key: null }]);
    expect(provider.requests).toEqual([]);
    expect(db.jobs.entries().length).toBe(3);
  });

  it("a continuing project keeps answering, and the count equals the sum of usage.input_tokens", async () => {
    const { clock, spending } = setup();
    const provider = new CountingProvider((call) => 100 * call);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(CONTINUE_AT_1000));
    const { db, worker } = await workerWith(gate, provider, clock);

    const report = await worker.runOnce();

    expect(report.paused).toBe(false);
    expect([...report.written].sort()).toEqual(["a", "b", "c"]);
    expect(provider.requests).toHaveLength(3);
    // Each answer carried 100, 200 and 300 input tokens.
    expect(await spending.monthlyTotal(PROJECT)).toBe(600);
    expect(db.decisionOf("a")).not.toBeNull();
  });

  it("a paused project resumes on the next pass once the cap is raised", async () => {
    const { clock, spending } = setup();
    await spending.record(PROJECT, 1_000);
    let cap: SpendingCap = PAUSE_AT_1000;
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(cap));
    const { worker } = await workerWith(gate, provider, clock);

    expect((await worker.runOnce()).claimed).toBe(0);
    cap = { inputTokens: 5_000, onCapReached: "pause" };

    const resumed = await worker.runOnce();
    expect(resumed.paused).toBe(false);
    expect(resumed.written).toHaveLength(3);
  });

  it("a pass that crosses the cap stops asking at the cap: the rest of the batch stays queued and pending", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 999);
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000));
    // One request in flight keeps the order fixed: `a` is asked and crosses the cap, so `b` and `c`
    // in the same claimed batch must not reach the model.
    const { db, worker } = await workerWith(gate, provider, clock, {
      ...DEFAULT_WORKER_LIMITS,
      maxInFlight: 1,
    });

    const report = await worker.runOnce();

    expect(report.claimed).toBe(3);
    expect(report.paused).toBe(true);
    expect(report.written).toEqual(["a"]);
    expect(report.failures).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_119);
    expect(db.decisionOf("b")).toBeNull();
    expect(db.decisionOf("c")).toBeNull();
    expect(db.jobs.entries().length).toBe(2);
    expect(db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);
  });

  it("with the shipped in-flight limit, a pass that crosses the cap sends only the request that fits", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 999);
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000));
    // The lanes start together. Without the reservation each one reads 999, passes, and all three
    // records reach the model; with it, `a` holds its share of the cap and `b` and `c` are refused.
    const { db, worker } = await workerWith(gate, provider, clock);
    expect(DEFAULT_WORKER_LIMITS.maxInFlight).toBeGreaterThan(1);

    const report = await worker.runOnce();

    expect(report.claimed).toBe(3);
    expect(report.paused).toBe(true);
    expect(report.written).toEqual(["a"]);
    expect(report.failures).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_119);
    expect(db.decisionOf("b")).toBeNull();
    expect(db.decisionOf("c")).toBeNull();
    expect(db.jobs.entries().length).toBe(2);
    expect(db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);
  });

  it("an alert store outage at the warning still holds the cap: a pass that crosses it sends only the request that fits", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 999);
    // At 999 of 1000 the status is `warned`, so the alert that fails is the warning; before the fix
    // the failed status skipped the reservation, and all three lanes read 999 and all three were sent.
    alerts.outage = "throw";
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000));
    const { db, worker } = await workerWith(gate, provider, clock);

    const report = await worker.runOnce();

    expect(report.written).toEqual(["a"]);
    expect(provider.requests).toHaveLength(1);
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_119);
    expect(db.decisionOf("b")).toBeNull();
    expect(db.decisionOf("c")).toBeNull();
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((failure) => failure.stage === "alert")).toBe(true);
  });

  it("a failed count is reported, and the paid answer is still written", async () => {
    const { clock } = setup();
    const provider = new CountingProvider(() => 120);
    const failing: SpendingGate = {
      allowsWork: () => Promise.resolve(true),
      admit: () => Promise.resolve("unlimited"),
      settle: () => Promise.resolve(),
      record: () => Promise.reject(new Error("usage store down")),
    };
    const { db, worker } = await workerWith(failing, provider, clock);
    db.edit("d", { body: "one more" });

    const report = await worker.runOnce();

    expect(report.written).toHaveLength(4);
    expect(report.failures).toHaveLength(4);
    expect(report.failures.every((failure) => failure.stage === "spending")).toBe(true);
    expect(db.decisionOf("a")).not.toBeNull();
  });

  it("an alert store outage at the warning does not stop a continuing project answering", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 800);
    alerts.outage = "throw";
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(CONTINUE_AT_1000));
    const { db, worker } = await workerWith(gate, provider, clock);

    const report = await worker.runOnce();

    expect(report.paused).toBe(false);
    expect([...report.written].sort()).toEqual(["a", "b", "c"]);
    expect(provider.requests).toHaveLength(3);
    expect(await spending.monthlyTotal(PROJECT)).toBe(1_160);
    expect(db.decisionOf("a")).not.toBeNull();
    // The outage is reported as an alert failure, never as a cap failure.
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((failure) => failure.stage === "alert")).toBe(true);
  });

  it("two processes on one usage store share the headroom: one request crosses the cap, the other is refused", async () => {
    // Two worker processes: each has its own createSpending, and both use the one database (usage store).
    const { clock, usage, alerts, spending: processA } = setup();
    const processB = createSpending({
      usageStore: usage,
      clock,
      alerts,
      capLink: (project) => `https://app.facetdb.test/projects/${project}/settings#spending`,
    });
    await processA.record(PROJECT, 999);
    const provider = new HeldProvider();
    const gates = [processA, processB].map((spending) =>
      spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000)),
    );
    const { db, workers } = await workersOnOneQueue(gates, provider, clock);

    const passes = Promise.all(workers.map((worker) => worker.runOnce()));
    // Both lanes reach the admission, while the first request is still in flight.
    for (let tick = 0; tick < 1_000; tick += 1) {
      await Promise.resolve();
    }
    expect(provider.requests).toHaveLength(1);
    provider.answerAll();
    const reports = await passes;

    expect(provider.requests).toHaveLength(1);
    expect(reports.flatMap((report) => report.written)).toHaveLength(1);
    expect(reports.filter((report) => report.paused)).toHaveLength(1);
    expect(await processB.monthlyTotal(PROJECT)).toBe(1_119);
    // The refused record is released, not lost: two jobs stay queued and pending.
    expect(db.jobs.entries().length).toBe(2);
    expect(db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(alerts.kinds()).toEqual(["spending_80", "spending_paused"]);
  });

  it("an alert store outage at the cap still pauses a pausing project, with nothing claimed", async () => {
    const { clock, spending, alerts } = setup();
    await spending.record(PROJECT, 1_000);
    alerts.outage = "throw";
    const provider = new CountingProvider(() => 120);
    const gate = spendingGate(spending, PROJECT, () => Promise.resolve(PAUSE_AT_1000));
    const { db, worker } = await workerWith(gate, provider, clock);

    const report = await worker.runOnce();

    expect(report.paused).toBe(true);
    expect(report.claimed).toBe(0);
    expect(provider.requests).toEqual([]);
    expect(db.jobs.entries().every(([, job]) => job.claimedBy === null)).toBe(true);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((failure) => failure.stage === "alert")).toBe(true);
  });
});
