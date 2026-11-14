import { describe, expect, expectTypeOf, it } from "vitest";
import { ENGINE_NAME, URL_VARIABLES, type UrlVariable } from "./index.ts";

describe("mysql barrel", () => {
  it("names the engine and the variables of its two test servers", () => {
    expect(ENGINE_NAME).toBe("mysql");
    expect(URL_VARIABLES).toEqual(["MYSQL_URL", "MARIADB_URL"]);
    expectTypeOf<UrlVariable>().toEqualTypeOf<"MYSQL_URL" | "MARIADB_URL">();
  });
});
