import { describe, expect, it } from "vitest";
import { API_VERSION, WEBHOOK_SIGNATURE_HEADER } from "./index.ts";

describe("server vocabulary", () => {
  it("versions its API and names its signature header", () => {
    expect(API_VERSION).toBe("v1");
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("facetdb-signature");
  });
});
