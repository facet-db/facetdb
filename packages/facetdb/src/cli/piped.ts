import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * Answers read from a pipe: when standard input is not a terminal (`printf 'url\ntable\n'
 * | facetdb init`, a script, a coding agent), each question takes the next line, in the order a
 * terminal would ask, and `left` says whether one more line will come, so a question with a safe
 * default takes it only once the pipe is empty or closed. One reader for the whole run: a reader
 * per question would drop the lines the first one buffered. It is made on the first question only,
 * so a command that asks nothing never holds standard input open, and it pauses between answers.
 */
export type PipedAnswers = {
  /** The next line, or undefined once the input has ended. */
  next(): Promise<string | undefined>;
  /** Whether a line is left to read; it waits for one, or for the end of the input. */
  left(): Promise<boolean>;
};

export function pipedAnswers(input: Readable): PipedAnswers {
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  let reader: ReturnType<typeof createInterface> | undefined;

  const open = () => {
    if (reader !== undefined) {
      return reader;
    }
    const made = createInterface({ input, terminal: false, crlfDelay: Number.POSITIVE_INFINITY });
    made.on("line", (line) => {
      const taker = waiting.shift();
      if (taker === undefined) {
        lines.push(line);
        made.pause();
      } else {
        taker(line);
      }
    });
    made.on("close", () => {
      ended = true;
      for (const taker of waiting.splice(0)) {
        taker(undefined);
      }
    });
    reader = made;
    return made;
  };

  const next = (): Promise<string | undefined> => {
    const ready = lines.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    if (ended) {
      return Promise.resolve(undefined);
    }
    const made = open();
    return new Promise((resolve) => {
      waiting.push((line) => {
        // A closed reader cannot pause (ERR_USE_AFTER_CLOSE): the end of the input needs none.
        if (line !== undefined) {
          made.pause();
        }
        resolve(line);
      });
      made.resume();
    });
  };

  return {
    next,
    async left() {
      const line = await next();
      if (line === undefined) {
        return false;
      }
      lines.unshift(line);
      return true;
    },
  };
}
