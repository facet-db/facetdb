import { describe, expect, expectTypeOf, it } from "vitest";
import { ENGINE_NAME, URL_VARIABLES, type UrlVariable } from "./index.ts";

describe("sql-polling barrel", () => {
  it("names the engine and the variables of its two test servers", () => {
    expect(ENGINE_NAME).toBe("polling");
    expect(URL_VARIABLES).toEqual(["COCKROACH_URL", "ORACLE_URL"]);
    expectTypeOf<UrlVariable>().toEqualTypeOf<"COCKROACH_URL" | "ORACLE_URL">();
  });
});
