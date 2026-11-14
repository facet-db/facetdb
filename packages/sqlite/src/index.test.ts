import { describe, expect, expectTypeOf, it } from "vitest";
import { ENGINE_NAME, URL_VARIABLES, type UrlVariable } from "./index.ts";

describe("sqlite barrel", () => {
  it("names the engine and the variable of its libSQL test server", () => {
    expect(ENGINE_NAME).toBe("sqlite");
    expect(URL_VARIABLES).toEqual(["LIBSQL_URL"]);
    expectTypeOf<UrlVariable>().toEqualTypeOf<"LIBSQL_URL">();
  });
});
