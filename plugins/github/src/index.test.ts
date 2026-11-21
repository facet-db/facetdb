import { fileURLToPath } from "node:url";
import { definePlugin } from "facetdb/plugin";
import { describe, expect, it } from "vitest";

describe("@facetdb/github scaffold", () => {
  it("reaches the plugin SDK through the facetdb package's exports, from source", () => {
    expect(typeof definePlugin).toBe("function");
    const resolved = fileURLToPath(import.meta.resolve("facetdb/plugin"));
    expect(resolved).toMatch(/packages[\\/]facetdb[\\/]src[\\/]plugin[\\/]index\.ts$/);
  });
});
