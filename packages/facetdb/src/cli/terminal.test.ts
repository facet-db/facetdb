import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { processTerminal, type Timer } from "./terminal.ts";

/**
 * The raw-key terminal of `facetdb review` on streams that stand in for a TTY: nothing here touches
 * the process's real terminal, and no real timer runs: the key reader is given a timer that fires
 * when the test says so, and the tests yield to the stream with `setImmediate`.
 */

/** A timer that fires only when told to: the waits it was asked for, and what is still pending. */
class ManualTimer {
  readonly asked: number[] = [];
  readonly #pending = new Map<number, () => void>();
  #next = 0;

  readonly timer: Timer = (ms, fire) => {
    const id = this.#next++;
    this.asked.push(ms);
    this.#pending.set(id, fire);
    return () => {
      this.#pending.delete(id);
    };
  };

  /** Lets the waits pending now run out. */
  fire(): void {
    for (const [id, fire] of [...this.#pending]) {
      this.#pending.delete(id);
      fire();
    }
  }

  get pending(): number {
    return this.#pending.size;
  }
}

/** Lets the stream deliver what was written to it. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeTty extends PassThrough {
  isTTY = true;
  columns?: number;
  raw: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.raw.push(mode);
    return this;
  }
}

function terminalOn(
  options: { columns?: number; env?: Record<string, string>; timer?: Timer } = {},
) {
  const input = new FakeTty();
  const output = new FakeTty();
  if (options.columns !== undefined) {
    output.columns = options.columns;
  }
  const terminal = processTerminal(
    { input, output, env: options.env ?? {} },
    options.timer ?? new ManualTimer().timer,
  );
  return { input, output, terminal };
}

describe("the process's terminal", () => {
  it("is interactive only when input and output are both terminals", () => {
    const both = terminalOn();
    expect(both.terminal.interactive()).toBe(true);
    both.output.isTTY = false;
    expect(both.terminal.interactive()).toBe(false);
    const piped = terminalOn();
    piped.input.isTTY = false;
    expect(piped.terminal.interactive()).toBe(false);
    expect(piped.terminal.color()).toBe(false);
  });

  it("wraps at the terminal's width, within a readable range", () => {
    expect(terminalOn({ columns: 70 }).terminal.columns()).toBe(70);
    expect(terminalOn({ columns: 10 }).terminal.columns()).toBe(40);
    expect(terminalOn({ columns: 300 }).terminal.columns()).toBe(100);
    expect(terminalOn().terminal.columns()).toBe(80);
  });

  it("colours unless NO_COLOR is set or the terminal is dumb", () => {
    expect(terminalOn().terminal.color()).toBe(true);
    expect(terminalOn({ env: { NO_COLOR: "1" } }).terminal.color()).toBe(false);
    expect(terminalOn({ env: { TERM: "dumb" } }).terminal.color()).toBe(false);
  });

  it("reads single keys in raw mode and gives the terminal back on close", async () => {
    const { input, terminal } = terminalOn();
    const keys = terminal.open();
    expect(input.raw).toEqual([true]);

    input.write("y");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "y" });
    input.write("7");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "7" });
    input.write(":");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: ":" });
    input.write("\r");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "enter" });
    input.write("\u0003");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "ctrl-c" });
    input.write("\u0004");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "ctrl-d" });

    keys.close();
    expect(input.raw).toEqual([true, false]);
  });

  it("does not deliver arrows, function keys or alt combinations", async () => {
    const { input, terminal } = terminalOn();
    const keys = terminal.open();

    input.write("\u001b[A");
    input.write("\u001bOP");
    input.write("\u001bx");
    input.write("s");

    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "s" });
    keys.close();
  });

  it("says idle when no key comes within the wait, and end when the input ends", async () => {
    const timers = new ManualTimer();
    const { input, terminal } = terminalOn({ timer: timers.timer });
    const keys = terminal.open();

    const waiting = keys.next(60_000);
    expect(timers.asked).toEqual([60_000]);
    timers.fire();
    expect(await waiting).toEqual({ kind: "idle" });
    input.end();
    expect(await keys.next(1_000)).toEqual({ kind: "end" });
    expect(await keys.next(1_000)).toEqual({ kind: "end" });
    keys.close();
  });

  it("drops the keys typed before a flush", async () => {
    const timers = new ManualTimer();
    const { input, terminal } = terminalOn({ timer: timers.timer });
    const keys = terminal.open();

    input.write("yy");
    await settle();
    keys.flush();

    const waiting = keys.next(5);
    timers.fire();
    expect(await waiting).toEqual({ kind: "idle" });
    keys.close();
  });

  it("cancels the wait when a key arrives first", async () => {
    const timers = new ManualTimer();
    const { input, terminal } = terminalOn({ timer: timers.timer });
    const keys = terminal.open();

    const waiting = keys.next(60_000);
    expect(timers.pending).toBe(1);
    input.write("n");
    expect(await waiting).toEqual({ kind: "key", key: "n" });
    expect(timers.pending).toBe(0);
    keys.close();
  });

  it("reads a line of text with raw mode off meanwhile, then reads keys again", async () => {
    const { input, output, terminal } = terminalOn();
    const keys = terminal.open();
    output.resume();

    const typed = keys.line("Note: ");
    await settle();
    input.write("seller verified\r");
    expect(await typed).toBe("seller verified");

    input.write("q");
    expect(await keys.next(1_000)).toEqual({ kind: "key", key: "q" });
    keys.close();
    // On for the keys, off for the line, on again, off for good.
    expect(input.raw.at(0)).toBe(true);
    expect(input.raw.at(-1)).toBe(false);
  });
});
