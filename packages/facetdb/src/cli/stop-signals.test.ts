import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { processDeps } from "./main.ts";
import { runEnding } from "./pipe.ts";

/**
 * The worker asks for its stop signal per bind and per reload, and every ask used to add a SIGINT
 * and a SIGTERM listener, so ten reloads printed `MaxListenersExceededWarning`. The run now has one
 * controller and one `listen`, made at the first ask; every ask hands out that signal.
 */

/** A process as `listen` sees it: Node's `once` on the two stop signals, nothing else. */
function fakeProcess(): { readonly emitter: EventEmitter; listen(abort: () => void): void } {
  const emitter = new EventEmitter();
  return {
    emitter,
    listen: (abort) => {
      emitter.once("SIGINT", abort);
      emitter.once("SIGTERM", abort);
    },
  };
}

describe("the run's stop signal", () => {
  it("listens once for a hundred asks and hands out one signal", () => {
    const host = fakeProcess();
    let listens = 0;
    const ending = runEnding({
      exit: () => {},
      listen: (abort) => {
        listens += 1;
        host.listen(abort);
      },
    });
    const signals = Array.from({ length: 100 }, () => ending.stopSignal());
    expect(listens).toBe(1);
    expect(new Set(signals).size).toBe(1);
    expect(host.emitter.listenerCount("SIGINT")).toBe(1);
    expect(host.emitter.listenerCount("SIGTERM")).toBe(1);
  });

  it("listens not at all until a signal is asked for", () => {
    let listens = 0;
    runEnding({
      exit: () => {},
      listen: () => {
        listens += 1;
      },
    });
    expect(listens).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"])("reaches every caller with one %s", (name) => {
    const host = fakeProcess();
    const ending = runEnding({ exit: () => {}, listen: host.listen });
    const signals = Array.from({ length: 20 }, () => ending.stopSignal());
    const heard: number[] = [];
    signals.forEach((signal, index) => {
      signal.addEventListener("abort", () => heard.push(index));
    });
    host.emitter.emit(name);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(heard).toHaveLength(20);
    expect(ending.pipeClosed()).toBe(false);
    // A caller asking after the stop is handed the stopped signal, not a fresh one.
    expect(ending.stopSignal().aborted).toBe(true);
  });

  it("ends a run that handed out no signal at once, with exit", () => {
    let exits = 0;
    let listens = 0;
    const ending = runEnding({
      exit: () => {
        exits += 1;
      },
      listen: () => {
        listens += 1;
      },
    });
    ending.end();
    expect(exits).toBe(1);
    expect(listens).toBe(0);
    expect(ending.pipeClosed()).toBe(true);
  });

  it("ends a run that handed out its signal by aborting it, without exit", () => {
    let exits = 0;
    const host = fakeProcess();
    const ending = runEnding({
      exit: () => {
        exits += 1;
      },
      listen: host.listen,
    });
    const signals = Array.from({ length: 10 }, () => ending.stopSignal());
    ending.end();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(exits).toBe(0);
    expect(ending.pipeClosed()).toBe(true);
  });

  it("gives a command with no closed-pipe guard one listener per stop signal for the process", () => {
    // `processDeps()` with no run: its stop signal listens on the real process. The listeners it
    // adds are read off and removed here, so nothing stays on the test's process.
    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    const added = (name: "SIGINT" | "SIGTERM") =>
      process.listeners(name).filter((listener) => !before[name].has(listener));
    try {
      const signals = Array.from({ length: 100 }, () => processDeps().stopSignal());
      expect(new Set(signals).size).toBe(1);
      expect(added("SIGINT")).toHaveLength(1);
      expect(added("SIGTERM")).toHaveLength(1);
    } finally {
      for (const name of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of added(name)) {
          process.removeListener(name, listener as () => void);
        }
      }
    }
  });

  it("takes an abort listener from every overlapping delivery without a leak warning", async () => {
    // Each in-flight channel delivery listens for `abort` on the one shared signal
    // (plugin/channel-host.ts), and alerts go to their channels in parallel. Node sets no listener
    // cap on an AbortSignal (22.22 and 24.22 both report 0), so fifty print nothing; a plain
    // EventTarget, capped at ten, shows the warning would be heard here if that ever changed.
    const leaks: string[] = [];
    const heard = (warning: Error) => {
      if (warning.name === "MaxListenersExceededWarning") {
        leaks.push(warning.message);
      }
    };
    const fiftyListeners = (target: EventTarget, type: string) => {
      for (let index = 0; index < 50; index += 1) {
        target.addEventListener(type, () => {}, { once: true });
      }
    };
    // Node emits a warning on the next tick: let it arrive before reading.
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
    process.on("warning", heard);
    try {
      fiftyListeners(runEnding({ exit: () => {}, listen: () => {} }).stopSignal(), "abort");
      await nextTurn();
      expect(leaks).toEqual([]);

      fiftyListeners(new EventTarget(), "abort");
      await nextTurn();
      expect(leaks).toHaveLength(1);
    } finally {
      process.removeListener("warning", heard);
    }
  });
});
