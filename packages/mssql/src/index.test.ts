import { describe, expect, expectTypeOf, it } from "vitest";
import { ENGINE_NAME, URL_VARIABLES, type UrlVariable } from "./index.ts";

describe("mssql barrel", () => {
  it("names the engine and the variable of its test server", () => {
    expect(ENGINE_NAME).toBe("mssql");
    expect(URL_VARIABLES).toEqual(["MSSQL_URL"]);
    expectTypeOf<UrlVariable>().toEqualTypeOf<"MSSQL_URL">();
  });
});
