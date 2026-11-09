import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, RECORD_STATUSES } from "./index.ts";

describe("core vocabulary", () => {
  it("exposes exactly the three question types, and never box", () => {
    expect([...QUESTION_TYPES]).toEqual(["noul", "choice", "score"]);
  });
  it("knows the six record statuses", () => {
    expect(RECORD_STATUSES).toHaveLength(6);
    expect(RECORD_STATUSES).toContain("unchecked");
  });
});
