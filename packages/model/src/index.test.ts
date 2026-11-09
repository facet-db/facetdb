import { describe, expect, it } from "vitest";
import { PINNED_MODEL_RE, SYSTEMONE_PATH } from "./index.ts";

describe("model vocabulary", () => {
  it("serves the System One path", () => {
    expect(SYSTEMONE_PATH).toBe("/v1/systemone");
  });
  it("accepts pinned versions and refuses aliases", () => {
    expect(PINNED_MODEL_RE.test("jev-1.14.0")).toBe(true);
    expect(PINNED_MODEL_RE.test("jev-latest")).toBe(false);
    expect(PINNED_MODEL_RE.test("jev-preview")).toBe(false);
  });
});
