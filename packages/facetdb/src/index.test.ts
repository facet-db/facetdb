import { describe, expect, it } from "vitest";
import { VERSION } from "./index.ts";

describe("facetdb package", () => {
  it("has a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
