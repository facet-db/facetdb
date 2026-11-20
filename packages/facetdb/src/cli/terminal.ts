import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import type { Readable } from "node:stream";

/**
 * The terminal as `facetdb review` sees it: single keys in raw mode through `readline`, a line for
 * a note, the width to wrap at and whether to colour. The composition root passes the process's
 * (`processTerminal`), a test a scripted one, so no test needs a real terminal or a real timer. A
 * key is the character typed, or `enter`, `ctrl-c` or `ctrl-d`; any other key (arrows, function
 * keys, alt combinations) is not delivered.
 */

/** What waiting for a key ended with: a key, the time to do something else, or no more input. */
export type KeyEvent =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "idle" }
  | { readonly kind: "end" };

/** Raw keys, from `open()` until `close()`. */
export type KeySession = {
  /** The next key; `idle` once `waitMs` have passed without one (the lock's renewal is due). */
  next(waitMs: number): Promise<KeyEvent>;
  /**
   * Drops the keys typed since the last one was read: a second tap of `y` made while the first was
   * being written must not decide the next question.
   */
  flush(): void;
  /** A line of text with the terminal's own editing, raw mode off meanwhile; undefined when cancelled. */
  line(question: string): Promise<string | undefined>;
  /** Gives the terminal back: raw mode off, nothing left listening. */
  close(): void;
};

export type ReviewTerminal = {
  /** Whether keys can be read and a card drawn: standard input and output are both a terminal. */
  interactive(): boolean;
  /** The width a card is wrapped at. */
  columns(): number;
  /** Whether a card may use colour (never when `NO_COLOR` is set or the terminal is dumb). */
  color(): boolean;
  open(): KeySession;
};

/** The process's streams, as `processTerminal` needs them. */
export type TerminalStreams = {
  readonly input: Readable & {
    readonly isTTY?: boolean;
    setRawMode(mode: boolean): unknown;
  };
  readonly output: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * What a test or a program that never reviews passes for the terminal: reaching for it fails the
 * run in words, as every other dependency a test leaves out does.
 */
export const NO_TERMINAL: ReviewTerminal = {
  interactive: () => {
    throw new Error("this test gave the command no terminal");
  },
  columns: () => {
    throw new Error("this test gave the command no terminal");
  },
  color: () => {
    throw new Error("this test gave the command no terminal");
  },
  open: () => {
    throw new Error("this test gave the command no terminal");
  },
};

const DEFAULT_COLUMNS = 80;
const MIN_COLUMNS = 40;
// A card read at 200 columns is a wall of text; a wide terminal gets a readable measure.
const MAX_COLUMNS = 100;

/** The key a keypress is, or undefined when it is not one a review uses. */
function keyOf(text: string | undefined, key: Key | undefined): string | undefined {
  if (key?.meta === true) {
    return undefined;
  }
  if (key?.ctrl === true) {
    if (key.name === "c") {
      return "ctrl-c";
    }
    return key.name === "d" ? "ctrl-d" : undefined;
  }
  if (key?.name === "return" || key?.name === "enter") {
    return "enter";
  }
  if (text !== undefined && [...text].length === 1 && text >= " " && text !== "\u007f") {
    return text;
  }
  return undefined;
}

/** Calls `fire` after `ms` milliseconds; the returned function cancels it. */
export type Timer = (ms: number, fire: () => void) => () => void;

/** The real timer: the only one in the process, at the edge. A test passes its own. */
const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export function processTerminal(
  streams: TerminalStreams,
  timer: Timer = realTimer,
): ReviewTerminal {
  const { input, output, env } = streams;
  const interactive = () => input.isTTY === true && output.isTTY === true;
  return {
    interactive,
    columns: () => Math.min(Math.max(output.columns ?? DEFAULT_COLUMNS, MIN_COLUMNS), MAX_COLUMNS),
    color: () => interactive() && (env["NO_COLOR"] ?? "") === "" && env["TERM"] !== "dumb",
    open() {
      const queue: KeyEvent[] = [];
      let waiter: ((event: KeyEvent) => void) | undefined;
      let ended = false;

      const deliver = (event: KeyEvent) => {
        if (waiter === undefined) {
          queue.push(event);
          return;
        }
        const resolve = waiter;
        waiter = undefined;
        resolve(event);
      };
      const onKeypress = (text: string | undefined, key: Key | undefined) => {
        const typed = keyOf(text, key);
        if (typed !== undefined) {
          deliver({ kind: "key", key: typed });
        }
      };
      const onEnd = () => {
        ended = true;
        deliver({ kind: "end" });
      };
      const attach = () => {
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.on("keypress", onKeypress);
        input.resume();
      };
      const detach = () => {
        input.off("keypress", onKeypress);
        input.setRawMode(false);
        input.pause();
      };
      attach();
      input.on("end", onEnd);

      return {
        next(waitMs) {
          const queued = queue.shift();
          if (queued !== undefined) {
            return Promise.resolve(queued);
          }
          if (ended) {
            return Promise.resolve({ kind: "end" });
          }
          return new Promise((resolve) => {
            const cancel = timer(waitMs, () => {
              waiter = undefined;
              resolve({ kind: "idle" });
            });
            waiter = (event) => {
              cancel();
              resolve(event);
            };
          });
        },
        flush() {
          queue.length = 0;
        },
        async line(question) {
          detach();
          queue.length = 0;
          const lines = createInterface({ input, output, terminal: true });
          try {
            return await new Promise<string | undefined>((resolve) => {
              // Ctrl+C and a closed input close the interface: the note is cancelled.
              lines.once("close", () => resolve(undefined));
              lines.question(question, resolve);
            });
          } finally {
            lines.close();
            attach();
          }
        },
        close() {
          input.off("end", onEnd);
          detach();
        },
      };
    },
  };
}
