import { describe, expect, expectTypeOf, it } from "vitest";
import { ENGINE_NAME, URL_VARIABLES, type UrlVariable } from "./index.ts";

describe("mongodb barrel", () => {
  it("names the engine and the variable of its test server", () => {
    expect(ENGINE_NAME).toBe("mongodb");
    expect(URL_VARIABLES).toEqual(["MONGODB_URL"]);
    expectTypeOf<UrlVariable>().toEqualTypeOf<"MONGODB_URL">();
  });
});
