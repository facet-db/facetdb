import { describe, expect, it } from "vitest";
import { FACETDB_PREFIX, FACETDB_SCHEMA } from "./index.ts";

describe("postgres vocabulary", () => {
  it("owns one schema and one column prefix", () => {
    expect(FACETDB_SCHEMA).toBe("facetdb");
    expect(FACETDB_PREFIX).toBe("facetdb_");
  });
});
