import { describe, expect, it } from "vitest";
import { addCommand, registryFailure } from "./words.ts";

/**
 * Two of the Plugins page's words: the command a gallery entry offers, made from a short name
 * alone, and why the registry could not be read, with "the registry" said once.
 */

describe("the command a gallery entry offers", () => {
  it("is `facetdb add` and a short name, and nothing for any other name", () => {
    expect(addCommand("github")).toBe("facetdb add github");
    expect(addCommand("google-sheets")).toBe("facetdb add google-sheets");
    for (const name of ["@facetdb/github", "Github", "evil; rm -rf /", "a b", "-x", "x-", ""]) {
      expect(addCommand(name)).toBeNull();
    }
  });
});

describe("why the registry could not be read", () => {
  it("is no answer, within the time it was given or at all, whatever the worker adds", () => {
    expect(
      registryFailure(
        "the registry did not answer within 10 seconds; FACETDB_REGISTRY sets another address",
      ),
    ).toEqual({ kind: "no-answer", seconds: 10 });
    expect(registryFailure("the registry could not be reached")).toEqual({
      kind: "no-answer",
      seconds: null,
    });
  });

  it("is otherwise the worker's words with the registry left to the address beside them", () => {
    const words = (why: string) => {
      const failure = registryFailure(why);
      return failure.kind === "other" ? failure.words : failure.kind;
    };
    expect(words("the registry answered with HTTP status 503")).toBe(
      "it answered with HTTP status 503",
    );
    expect(words("the registry's answer could not be read to the end")).toBe(
      "its answer could not be read to the end",
    );
    expect(words("the registry file does not exist")).toBe("it does not exist");
    expect(words("the registry's index could not be read.")).toBe("its index could not be read");
  });
});
