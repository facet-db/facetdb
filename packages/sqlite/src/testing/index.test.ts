import { describe, expect, it } from "vitest";
import * as testing from "./index.ts";

const { serverUrl } = testing;

const UNSET =
  "environment, not code: LIBSQL_URL is unset (point it at a libSQL server (sqld); scripts/test-databases.sh up libsql starts one)";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { LIBSQL_URL: "http://127.0.0.1:8080" };
    expect(serverUrl("LIBSQL_URL", env)).toBe("http://127.0.0.1:8080");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { LIBSQL_URL: "" }]) {
      expect(() => serverUrl("LIBSQL_URL", env)).toThrow(UNSET);
    }
  });

  it("fails the same when another engine's variable is set: the package's one server never skips", () => {
    for (const env of [
      { MYSQL_URL: "mysql://x" },
      { LIBSQL_URL: "", DATABASE_URL: "postgres://x", MSSQL_URL: "mssql://x" },
    ]) {
      expect(() => serverUrl("LIBSQL_URL", env)).toThrow(UNSET);
    }
    // No skip helper to reach for: the db suite reads its URL through serverUrl.
    expect(Object.keys(testing)).not.toContain("skipUnless");
  });
});
