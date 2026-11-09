import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { RequestRejectedError, RetryableError, UnexpectedStatusError } from "../errors.ts";
import { createFakeProvider } from "../fake/fake-provider.ts";
import { createInFlightLimiter, DEFAULT_IN_FLIGHT, RECOVER_AFTER_MS } from "./limiter.ts";
import {
  createOutagePolicy,
  DEFAULT_RETRY_EVERY_MS,
  DEFAULT_RETRY_WINDOW_MS,
  type OutageEvent,
} from "./outage.ts";
import { createBackoff, DEFAULT_MAX_ATTEMPTS } from "./policy.ts";
import { createResilientProvider } from "./resilient.ts";

const noJitter = (): number => 0;
const fullJitter = (): number => 1;

const request = {
  model: "jev-1.14.0",
  state: { id: "a", body: "a listing" },
  questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
} as const;

describe("backoff delays: 429 and 529 back off", () => {
  it("@timing grows from 500 ms by a factor of 2 and caps at 30 s, with no jitter when random gives 0", () => {
    const backoff = createBackoff({ clock: new FakeClock(), random: noJitter, maxAttempts: 20 });
    const overloaded = new RetryableError(529, undefined);
    const delays = Array.from({ length: 8 }, (_, attempt) => backoff.delayMs(attempt, overloaded));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("takes at most the jitter share off a delay, from the injected random source", () => {
    const backoff = createBackoff({ clock: new FakeClock(), random: fullJitter, jitter: 0.2 });
    expect(backoff.delayMs(0, new RetryableError(429, undefined))).toBe(400);
  });

  it("honours retry-after exactly: neither capped nor jittered", () => {
    const backoff = createBackoff({ clock: new FakeClock(), random: fullJitter, maxMs: 1000 });
    expect(backoff.delayMs(0, new RetryableError(429, 45_000))).toBe(45_000);
  });

  it.each([400, 401, 413, 415, 422])(
    "never retries a %i: the same request cannot change it",
    (status) => {
      const backoff = createBackoff({ clock: new FakeClock(), random: noJitter });
      expect(
        backoff.delayMs(0, new RequestRejectedError(status, "rejected", undefined)),
      ).toBeUndefined();
    },
  );

  it("does not retry a status the API reference does not list, nor an unreachable model", () => {
    const backoff = createBackoff({ clock: new FakeClock(), random: noJitter });
    expect(backoff.delayMs(0, new UnexpectedStatusError(503))).toBeUndefined();
    expect(backoff.delayMs(0, new Error("socket hang up"))).toBeUndefined();
  });

  it("gives up after the attempts are used: the default is 6, so 5 waits", () => {
    const backoff = createBackoff({ clock: new FakeClock(), random: noJitter });
    const limited = new RetryableError(429, undefined);
    expect(backoff.delayMs(DEFAULT_MAX_ATTEMPTS - 2, limited)).toBe(8000);
    expect(backoff.delayMs(DEFAULT_MAX_ATTEMPTS - 1, limited)).toBeUndefined();
  });

  it("@timing run sleeps the delay sequence on the clock and throws the last error as it came", async () => {
    const clock = new FakeClock();
    const backoff = createBackoff({ clock, random: noJitter, maxAttempts: 3 });
    const fake = createFakeProvider({
      failures: { 0: { kind: "529" }, 1: { kind: "429", retryAfterMs: 250 }, 2: { kind: "503" } },
    });

    await expect(backoff.run(() => fake.ask(request))).rejects.toBeInstanceOf(
      UnexpectedStatusError,
    );

    expect(clock.sleeps).toEqual([500, 250]);
    expect(fake.callCount).toBe(3);
  });

  it("refuses a nonsense configuration plainly", () => {
    const clock = new FakeClock();
    expect(() => createBackoff({ clock, random: noJitter, baseMs: 0 })).toThrow(/baseMs/);
    expect(() => createBackoff({ clock, random: noJitter, jitter: 2 })).toThrow(/jitter/);
    expect(() => createBackoff({ clock, random: noJitter, maxAttempts: 0 })).toThrow(/attempt/);
  });
});

describe("the in-flight limiter: at most 8 per worker, fewer after a 429", () => {
  it("starts at 8 and runs no more than the limit at once", async () => {
    const clock = new FakeClock();
    const limiter = createInFlightLimiter({ clock });
    expect(limiter.limit).toBe(DEFAULT_IN_FLIGHT);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = Array.from({ length: 10 }, () => limiter.run(() => gate));
    await Promise.resolve();

    expect(limiter.inFlight).toBe(8);
    release();
    await Promise.all(tasks);
    expect(limiter.inFlight).toBe(0);
  });

  it("@timing halves after a 429, never below 1, and restores one step per quiet minute", () => {
    const clock = new FakeClock();
    const limiter = createInFlightLimiter({ clock });

    limiter.rateLimited();
    expect(limiter.limit).toBe(4);
    limiter.rateLimited();
    limiter.rateLimited();
    limiter.rateLimited();
    expect(limiter.limit).toBe(1);

    clock.advance(RECOVER_AFTER_MS - 1);
    expect(limiter.limit).toBe(1);
    clock.advance(1);
    expect(limiter.limit).toBe(2);
    clock.advance(RECOVER_AFTER_MS * 2);
    expect(limiter.limit).toBe(8);
  });

  it("@timing a 429 during recovery starts the quiet minute again", () => {
    const clock = new FakeClock();
    const limiter = createInFlightLimiter({ clock });
    limiter.rateLimited();
    clock.advance(RECOVER_AFTER_MS - 1);
    limiter.rateLimited();
    expect(limiter.limit).toBe(2);
    clock.advance(RECOVER_AFTER_MS - 1);
    expect(limiter.limit).toBe(2);
  });

  it("frees the slot when a task throws", async () => {
    const limiter = createInFlightLimiter({ clock: new FakeClock(), max: 1 });
    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(() => Promise.resolve("next"))).resolves.toBe("next");
  });
});

describe("the resilient provider (backoff and the limiter around a provider)", () => {
  it("@timing retries 429 and 529, halves the limit on the 429, and answers", async () => {
    const clock = new FakeClock();
    const limiter = createInFlightLimiter({ clock });
    const fake = createFakeProvider({
      defaults: { noul: 0.9 },
      failures: { 0: { kind: "429" }, 1: { kind: "529" } },
    });
    const provider = createResilientProvider(fake, {
      backoff: createBackoff({ clock, random: noJitter }),
      limiter,
    });

    const response = await provider.ask(request);

    expect(response.answers["scam"]?.type).toBe("noul");
    expect(fake.callCount).toBe(3);
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(limiter.limit).toBe(4);
    expect(limiter.inFlight).toBe(0);
  });

  it("throws what still fails after the attempts, as it came, never an answer", async () => {
    const clock = new FakeClock();
    const fake = createFakeProvider({
      failures: { 0: { kind: "529" }, 1: { kind: "529" }, 2: { kind: "529" } },
    });
    const provider = createResilientProvider(fake, {
      backoff: createBackoff({ clock, random: noJitter, maxAttempts: 3 }),
      limiter: createInFlightLimiter({ clock }),
    });

    await expect(provider.ask(request)).rejects.toBeInstanceOf(RetryableError);
    expect(fake.callCount).toBe(3);
  });

  it("passes a rejected request straight through, with no retry and no halving", async () => {
    const clock = new FakeClock();
    const limiter = createInFlightLimiter({ clock });
    const fake = createFakeProvider({ failures: { 0: { kind: "timeout" } } });
    const provider = createResilientProvider(fake, {
      backoff: createBackoff({ clock, random: noJitter }),
      limiter,
    });

    await expect(provider.ask(request)).rejects.toThrow(/could not be reached/);
    expect(fake.callCount).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(limiter.limit).toBe(8);
  });
});

describe("the outage policy: 10-minute window, error or unchecked, every 5 minutes", () => {
  const down = new RetryableError(529, undefined);

  it("@timing keeps retrying inside the window, then holds the record as error", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "hold", clock });

    expect(policy.failed("r1", down)).toBe("retry");
    clock.advance(DEFAULT_RETRY_WINDOW_MS - 1);
    expect(policy.failed("r1", down)).toBe("retry");
    clock.advance(1);
    expect(policy.failed("r1", down)).toBe("error");
    expect(policy.held).toEqual(["r1"]);
  });

  it("@timing releases the record as unchecked when the source says so", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "release", clock, retryWindowMs: 0 });
    expect(policy.failed("r1", down)).toBe("unchecked");
  });

  it("@timing offers a held record again every 5 minutes, once per due time", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: 0 });
    policy.failed("r1", down);

    clock.advance(DEFAULT_RETRY_EVERY_MS - 1);
    expect(policy.due()).toEqual([]);
    clock.advance(1);
    expect(policy.due()).toEqual(["r1"]);
    expect(policy.due()).toEqual([]);

    // Still down at the retry: held again for another 5 minutes.
    expect(policy.failed("r1", down)).toBe("error");
    expect(policy.held).toEqual(["r1"]);
  });

  it("@timing declares an outage when every call in a minute failed, clears it on the first success, and re-queues every held record", () => {
    const clock = new FakeClock();
    const events: OutageEvent[] = [];
    const policy = createOutagePolicy({
      onOutage: "release",
      clock,
      retryWindowMs: 0,
      onEvent: (event) => events.push(event),
    });

    policy.failed("r1", down);
    policy.failed("r2", down);
    expect(policy.declared).toBe(true);
    expect(events).toEqual([{ type: "outage", state: "declared", at: 0 }]);

    clock.advance(1000);
    expect(policy.succeeded("r3")).toEqual(["r1", "r2"]);
    expect(policy.declared).toBe(false);
    expect(events.at(-1)).toEqual({ type: "outage", state: "cleared", at: 1000 });
    expect(policy.held).toEqual([]);
    expect(policy.due()).toEqual([]);
  });

  it("@timing holds again what the worker could not queue, for the next retry", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: 0 });
    policy.failed("r1", down);
    clock.advance(DEFAULT_RETRY_EVERY_MS);
    expect(policy.due()).toEqual(["r1"]);
    expect(policy.held).toEqual([]);

    policy.hold(["r1"]);

    expect(policy.held).toEqual(["r1"]);
    expect(policy.due()).toEqual([]);
    clock.advance(DEFAULT_RETRY_EVERY_MS);
    expect(policy.due()).toEqual(["r1"]);
  });

  it("is not an outage while some calls still succeed", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "hold", clock });
    policy.succeeded("ok");
    policy.failed("r1", down);
    expect(policy.declared).toBe(false);
  });

  it("holds a rejected request as error at once: no window cures a 422, and it is no outage", () => {
    const clock = new FakeClock();
    const policy = createOutagePolicy({ onOutage: "release", clock });
    const verdict = policy.failed(
      "r1",
      new RequestRejectedError(422, "bad question", "questions.scam"),
    );
    expect(verdict).toBe("error");
    expect(policy.declared).toBe(false);
    clock.advance(DEFAULT_RETRY_EVERY_MS);
    expect(policy.due()).toEqual(["r1"]);
  });

  it("refuses a negative window or a zero cadence", () => {
    const clock = new FakeClock();
    expect(() => createOutagePolicy({ onOutage: "hold", clock, retryWindowMs: -1 })).toThrow();
    expect(() => createOutagePolicy({ onOutage: "hold", clock, retryEveryMs: 0 })).toThrow();
  });
});
