import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pipedAnswers } from "./piped.ts";

/**
 * The answers of a run with no terminal: `printf 'url\ntable\nyes\n' | facetdb init` gives each
 * question the next line, in order, whatever chunks the pipe delivers them in, and says when none
 * is left.
 */

describe("answers read from a pipe", () => {
  it("hands out the lines in order, across chunks, then says none is left", async () => {
    const piped = pipedAnswers(Readable.from(["postgres://u:p@h/db\nlist", "ings\n", "yes\n"]));
    expect(await piped.left()).toBe(true);
    expect(await piped.next()).toBe("postgres://u:p@h/db");
    expect(await piped.next()).toBe("listings");
    expect(await piped.left()).toBe(true);
    expect(await piped.next()).toBe("yes");
    expect(await piped.left()).toBe(false);
    expect(await piped.next()).toBeUndefined();
  });

  it("keeps an empty line as an answer (Enter), and reads a last line with no newline", async () => {
    const piped = pipedAnswers(Readable.from(["\nlast"]));
    expect(await piped.next()).toBe("");
    expect(await piped.next()).toBe("last");
    expect(await piped.left()).toBe(false);
  });

  it("waits for a line still to come, and reads nothing before the first question", async () => {
    const input = new PassThrough();
    const piped = pipedAnswers(input);
    // Nothing reads the input yet: a command that asks nothing never holds it open.
    expect(input.listenerCount("data")).toBe(0);
    const answer = piped.next();
    input.write("later\n");
    expect(await answer).toBe("later");
    const none = piped.left();
    input.end();
    expect(await none).toBe(false);
  });
});
