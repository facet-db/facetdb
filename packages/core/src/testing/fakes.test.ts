import { describe, expect, it } from "vitest";
import { FakeAction, FakeChannel, FakeClock } from "./index.ts";

describe("FakeClock", () => {
  it("moves only when told to, and a sleep advances it by exactly its duration", async () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.sleep(250);
    await clock.sleep(750);
    expect(clock.now()).toBe(2_000);
    expect(clock.sleeps).toEqual([250, 750]);
    clock.advance(5);
    expect(clock.now()).toBe(2_005);
  });

  it("refuses a negative or non-finite duration instead of moving backwards", async () => {
    const clock = new FakeClock();
    await expect(clock.sleep(-1)).rejects.toThrow();
    expect(() => clock.advance(Number.NaN)).toThrow();
  });
});

describe("FakeAction and FakeChannel", () => {
  it("record every call and reject exactly once when told to fail", async () => {
    const action = new FakeAction<{ add: string[] }>();
    const record = { key: "r1", state: { title: "x" }, status: "done" as const };
    await action.run(record, {}, { add: ["Not Priority"] });
    expect(action.calls).toHaveLength(1);
    expect(action.calls[0]?.config).toEqual({ add: ["Not Priority"] });

    action.failNextWith(new Error("label API down"));
    await expect(action.run(record, {}, { add: [] })).rejects.toThrow("label API down");
    await expect(action.run(record, {}, { add: [] })).resolves.toBeUndefined();
  });

  it("keep every delivered message and reject exactly once when told to fail", async () => {
    const channel = new FakeChannel<{ channel: string }>();
    const message = {
      kind: "system-alert" as const,
      severity: "critical" as const,
      text: "worker down",
    };
    await channel.deliver(message, { channel: "#ops" });
    expect(channel.delivered).toEqual([{ message, config: { channel: "#ops" } }]);

    channel.failNextWith(new Error("Slack 500"));
    await expect(channel.deliver(message, { channel: "#ops" })).rejects.toThrow("Slack 500");
    await expect(channel.deliver(message, { channel: "#ops" })).resolves.toBeUndefined();
  });
});
