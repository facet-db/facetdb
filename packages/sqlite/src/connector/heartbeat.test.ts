import { describe, expect, it } from "vitest";
import { LOCK_HEARTBEAT_MS, repeatEvery } from "./heartbeat.ts";
import { LOCK_FRESH_MS } from "./index.ts";

/**
 * The lock's heartbeat on real timers: what the worker's process runs. The connector's own tests
 * drive the beat through `FakeRepeat` under the fake clock.
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("repeatEvery", () => {
  it("beats four times to the lock's freshness, so three missed beats never free it", () => {
    expect(LOCK_FRESH_MS / LOCK_HEARTBEAT_MS).toBe(4);
  });

  it("@timing beats on its interval until stopped, and never runs a beat while the last one runs", async () => {
    let started = 0;
    let running = 0;
    let most = 0;
    const stop = repeatEvery(5, async () => {
      started += 1;
      running += 1;
      most = Math.max(most, running);
      await wait(20);
      running -= 1;
    });
    await wait(150);
    stop();
    const atStop = started;
    expect(atStop).toBeGreaterThanOrEqual(2);
    // A beat of 20 ms on a 5 ms interval: the due beats in between are dropped, not queued.
    expect(most).toBe(1);
    await wait(40);
    expect(started).toBe(atStop);
  });
});
