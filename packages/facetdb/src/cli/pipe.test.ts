import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type OutputStream, quietOnClosedPipe, runEnding } from "./pipe.ts";

/**
 * `facetdb worker | head -1`: once the reader has gone, a write fails with EPIPE, and the process
 * ends quietly, once, with nothing more written, whether the write throws or the stream reports it
 * as an error event; the worker first stops through its stop signal, as on Ctrl+C (`runEnding`);
 * any other error still fails loudly.
 */

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** A stream that records what it is given and throws `failWith` from the write after `okWrites`. */
class FakeStream extends EventEmitter implements OutputStream {
  readonly written: string[] = [];
  readonly #okWrites: number;
  readonly #failWith: Error;

  constructor(okWrites: number, failWith: Error) {
    super();
    this.#okWrites = okWrites;
    this.#failWith = failWith;
  }

  write(text: string): boolean {
    if (this.written.length >= this.#okWrites) {
      throw this.#failWith;
    }
    this.written.push(text);
    return true;
  }
}

describe("a closed pipe", () => {
  it("ends the run once when a write throws EPIPE, and drops every print after it", () => {
    const stdout = new FakeStream(1, errorWithCode("EPIPE"));
    const stderr = new FakeStream(10, errorWithCode("EPIPE"));
    let ends = 0;
    const writers = quietOnClosedPipe({ stdout, stderr }, () => {
      ends += 1;
    });
    writers.stdout("listings: answered 1\n");
    expect(() => writers.stdout("listings: answered 2\n")).not.toThrow();
    writers.stdout("listings: answered 3\n");
    writers.stderr("warning: after the end\n");
    expect(ends).toBe(1);
    expect(stdout.written).toEqual(["listings: answered 1\n"]);
    expect(stderr.written).toEqual([]);
  });

  it("ends the run when the stream reports EPIPE as an error event, as a real pipe does", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, done) {
        done(errorWithCode("EPIPE"));
      },
    });
    const stderr = new FakeStream(10, errorWithCode("EPIPE"));
    const ended = new Promise<void>((resolve) => {
      const writers = quietOnClosedPipe({ stdout, stderr }, resolve);
      writers.stdout("one line\n");
    });
    // Unheard, the error event would fail the test as an uncaught exception.
    await ended;
    expect(stdout.listenerCount("error")).toBeGreaterThan(0);
  });

  it("covers a write made to the stream directly, a prompt's or an engine's warning", () => {
    const stdout = new FakeStream(10, errorWithCode("EPIPE"));
    const stderr = new FakeStream(10, errorWithCode("EPIPE"));
    let ends = 0;
    quietOnClosedPipe({ stdout, stderr }, () => {
      ends += 1;
    });
    stderr.emit("error", errorWithCode("EPIPE"));
    stdout.emit("error", errorWithCode("EPIPE"));
    expect(ends).toBe(1);
  });

  it("stops a command that took a stop signal as Ctrl+C does, instead of exiting at once", () => {
    let exits = 0;
    const listened: (() => void)[] = [];
    const ending = runEnding({
      exit: () => {
        exits += 1;
      },
      listen: (abort) => {
        listened.push(abort);
      },
    });
    const signal = ending.stopSignal();
    expect(listened).toHaveLength(1);
    expect(ending.pipeClosed()).toBe(false);
    ending.end();
    expect(signal.aborted).toBe(true);
    expect(exits).toBe(0);
    expect(ending.pipeClosed()).toBe(true);
  });

  it("exits at once when no command took a stop signal, and Ctrl+C still aborts one that did", () => {
    let exits = 0;
    const ending = runEnding({
      exit: () => {
        exits += 1;
      },
      listen: () => {},
    });
    ending.end();
    expect(exits).toBe(1);

    const listened: (() => void)[] = [];
    const signals = runEnding({ exit: () => {}, listen: (abort) => listened.push(abort) });
    const signal = signals.stopSignal();
    for (const abort of listened) {
      abort();
    }
    expect(signal.aborted).toBe(true);
    expect(signals.pipeClosed()).toBe(false);
  });

  it("lets any other error fail loudly", () => {
    const stdout = new FakeStream(0, errorWithCode("EIO"));
    const stderr = new FakeStream(10, errorWithCode("EIO"));
    let ends = 0;
    const writers = quietOnClosedPipe({ stdout, stderr }, () => {
      ends += 1;
    });
    expect(() => writers.stdout("text\n")).toThrow("write EIO");
    expect(() => stderr.emit("error", errorWithCode("EIO"))).toThrow("write EIO");
    expect(ends).toBe(0);
  });
});
