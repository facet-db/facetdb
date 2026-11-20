import { describe, expect, it } from "vitest";
// The server's own list, read from its source for this test alone: the studio does not depend on
// @facetdb/server, so the page keeps a copy, and this test holds the copy to the original.
import {
  INSTALL_NOTHING_RAN as SERVER_NOTHING_RAN,
  INSTALL_STOPPED as SERVER_STOPPED,
} from "../../../../../packages/server/src/sources/index.ts";
import { ApiError } from "../../api/index.ts";
import { INSTALL_NOTHING_RAN, INSTALL_STOPPED, installFailure } from "./outcome.ts";

describe("what a failed install left", () => {
  it("knows the codes that ran nothing as the server lists them", () => {
    expect(INSTALL_NOTHING_RAN).toEqual(SERVER_NOTHING_RAN);
    expect(INSTALL_STOPPED).toBe(SERVER_STOPPED);
  });

  it("calls anything else unknown: a network failure, an unreadable answer, an unknown code", () => {
    expect(installFailure(new TypeError("Failed to fetch")).kind).toBe("unknown");
    expect(installFailure(new ApiError(502, "unreadable", "not JSON", "reload")).kind).toBe(
      "unknown",
    );
    expect(installFailure(new ApiError(502, "install_outcome_unknown", "m", "f")).kind).toBe(
      "unknown",
    );
    expect(installFailure(new ApiError(409, "database_changed", "m", "f")).kind).toBe(
      "nothing-ran",
    );
    expect(installFailure(new ApiError(409, "install_stopped", "m", "f")).kind).toBe("stopped");
  });
});
