import type { Repeat } from "../connector/index.ts";

/** The clock a `FakeRepeat` moves: core's `FakeClock`, or any clock a test steps by hand. */
type SteppedClock = {
  now(): number;
  advance(ms: number): void;
};

type Timer = {
  readonly every: number;
  due: number;
  readonly beat: () => Promise<void>;
  stopped: boolean;
};

/**
 * The lock's heartbeat under a fake clock: the connector's `repeat`, whose beats run only when the
 * test moves the clock with `advance`, each at its own time and awaited in turn, so a test reads
 * the lock exactly as a worker 30 seconds, or 3 minutes, into a pass left it.
 */
export class FakeRepeat {
  readonly #clock: SteppedClock;
  readonly #timers: Timer[] = [];

  constructor(clock: SteppedClock) {
    this.#clock = clock;
  }

  readonly repeat: Repeat = (ms, beat) => {
    const timer: Timer = { every: ms, due: this.#clock.now() + ms, beat, stopped: false };
    this.#timers.push(timer);
    return () => {
      timer.stopped = true;
    };
  };

  /** The intervals asked for, one per repeat started, stopped or not. */
  get intervals(): readonly number[] {
    return this.#timers.map((timer) => timer.every);
  }

  /** How many repeats still run. */
  get running(): number {
    return this.#timers.filter((timer) => !timer.stopped).length;
  }

  /** Moves the clock by `ms`, running every beat that falls due on the way, at its time, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.#clock.now() + ms;
    for (;;) {
      const [next] = this.#timers
        .filter((timer) => !timer.stopped && timer.due <= end)
        .sort((a, b) => a.due - b.due);
      if (next === undefined) {
        break;
      }
      this.#clock.advance(Math.max(0, next.due - this.#clock.now()));
      next.due += next.every;
      await next.beat();
    }
    this.#clock.advance(Math.max(0, end - this.#clock.now()));
  }

  /** A worker killed without `close`: its timers die with its process, and its lock stays. */
  kill(): void {
    for (const timer of this.#timers) {
      timer.stopped = true;
    }
  }
}
